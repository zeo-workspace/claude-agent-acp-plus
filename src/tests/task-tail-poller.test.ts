// Story 041, task 2.2 — the TailPoller and the Bash-result hook (R1.1, R1.4, R1.5, R1.6, R1.7;
// Q4, Q13).
//
// Part 1 drives `TailPoller` alone (design.md §`TailPoller`): `new TailPoller(feed, publisher,
// timers, readTailFn)`, `kick()`, `dispose()`. Time is vitest's fake clock; files are real, in a
// private temp directory. The `timers` object handed to the poller and the publisher delegates to
// the (faked) globals and offers both timeouts and intervals, so whichever the implementation uses
// is driven by the fake clock. `setImmediate` is left real so file I/O can complete between ticks.
//
// Part 2 runs a real session over a scripted SDK query (task-feed-harness.ts): the Bash tool_use,
// `task_started`, and the Bash tool_result carrying the CLI's background notice arrive exactly as
// the SDK streams them, and assertions read only what reaches the client. Real timers.
//
// Hostile halves first: an idle file must publish nothing while a growing one publishes; a file
// that SHRINKS is a change; the notice naming another task's file (`b2.output` for `b1`) gives no
// tail even while that file grows; an ending whose output_file is missing, empty or a directory
// must not claim hasOutput while a readable one does; a read error is logged once, not per tick.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { TailPoller, TaskFeed, TaskFeedPublisher } from "../task-feed.js";
import { readTail } from "../task-output.js";
import { AcpClient, ClaudeAcpAgent, TASKS_META_KEY } from "../acp-agent.js";
import {
  idle,
  lastScriptedQuery,
  result,
  running,
  taskNotification,
  taskStarted,
  waitFor,
} from "./task-feed-harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { scriptedQuery } = await import("./task-feed-harness.js");
  return { ...actual, query: vi.fn(scriptedQuery) };
});

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "task-tail-poller-test-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

// ---- Part 1: the poller alone, fake clock -------------------------------------------------

const timers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: any) => clearTimeout(handle),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (handle: any) => clearInterval(handle),
};

/**
 * Yields to the real event loop for `ms` of real time (`performance` is not faked). A count of
 * `setImmediate` turns is not a duration: under a loaded machine (the whole suite on every core)
 * 30 turns pass before one file read completes, and the next fake tick then lands on a busy poller.
 */
async function settleIo(ms = 25) {
  const until = performance.now() + ms;
  while (performance.now() < until) await new Promise((r) => setImmediate(r));
}

/** Advances the fake clock one step at a time, letting I/O settle after each step. */
async function advance(ms: number, step = 250) {
  for (let done = 0; done < ms; done += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - done));
    await settleIo();
  }
}

function rig(options: { readTailFn?: (path: string) => Promise<string[]> } = {}) {
  const sent: { at: number; tasks: any[] }[] = [];
  const feed = new TaskFeed(() => Date.now(), {}, "poller-session");
  const publisher = new TaskFeedPublisher(
    feed,
    async (snapshot) => {
      sent.push({ at: Date.now(), tasks: JSON.parse(JSON.stringify(snapshot.tasks)) });
    },
    timers,
  );
  const reads = vi.fn(options.readTailFn ?? ((path: string) => readTail(path)));
  const poller = new TailPoller(feed, publisher, timers as any, reads);
  const startShell = (id: string, path: string) => {
    publisher.notify(
      feed.onStarted({
        type: "system",
        subtype: "task_started",
        task_id: id,
        tool_use_id: `toolu_${id}`,
        description: `task ${id}`,
        task_type: "local_bash",
        is_backgrounded: true,
        uuid: randomUUID(),
        session_id: "poller-session",
      } as any),
    );
    publisher.notify(feed.onOutputPath(id, path));
    poller.kick();
  };
  const tailOf = (id: string) => sent.at(-1)?.tasks.find((t) => t.id === id)?.tail;
  const entryOf = (id: string) => sent.at(-1)?.tasks.find((t) => t.id === id);
  return { feed, publisher, poller, reads, sent, startShell, tailOf, entryOf };
}

describe("TailPoller — publishing on growth (R1.4)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });

  it("publishes the new tail within 2 s of a write, and again when the file grows", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "");
    const r = rig();
    r.startShell("b1", path);

    await appendFile(path, "line 1\n");
    const writtenAt = Date.now();
    await advance(2_000);
    expect(r.tailOf("b1")).toEqual(["line 1"]);
    expect(r.entryOf("b1").hasOutput).toBe(true);
    const firstTail = r.sent.find((s) => s.tasks.some((t) => t.id === "b1" && t.tail?.length))!;
    expect(firstTail.at - writtenAt).toBeLessThanOrEqual(2_000);

    await appendFile(path, "line 2\n");
    await advance(2_000);
    expect(r.tailOf("b1")).toEqual(["line 1", "line 2"]);
    r.poller.dispose();
  });

  // Hostile: an idle file must cost no read and publish nothing.
  it("reads nothing and publishes nothing while the file's size does not change", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "line 1\n");
    const r = rig();
    r.startShell("b1", path);
    await advance(2_000);
    expect(r.tailOf("b1")).toEqual(["line 1"]);

    const reads = r.reads.mock.calls.length;
    const sends = r.sent.length;
    await advance(5_000);
    expect(r.reads.mock.calls.length).toBe(reads);
    expect(r.sent.length).toBe(sends);
    r.poller.dispose();
  });

  // Converse: a file that shrinks (truncated and rewritten shorter) is a change.
  it("treats a shrunk file as changed and publishes its new tail", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "a long first line of output\n");
    const r = rig();
    r.startShell("b1", path);
    await advance(2_000);

    await truncate(path, 0);
    await writeFile(path, "short\n");
    await advance(2_000);
    expect(r.tailOf("b1")).toEqual(["short"]);
    r.poller.dispose();
  });

  it("keeps publishing at most once per second while the file grows constantly", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "");
    const r = rig();
    r.startShell("b1", path);
    for (let i = 0; i < 40; i++) {
      await appendFile(path, `line ${i}\n`);
      await advance(100, 100);
    }
    await advance(2_000);
    const times = r.sent.map((s) => s.at);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1_000);
    }
    expect(r.tailOf("b1")).toContain("line 39");
    r.poller.dispose();
  });

  // Hostile (wrong collapse): only t1's file grows; t10's tail is its own.
  it("updates only the task whose file grew", async () => {
    const p1 = join(dir, "t1.output");
    const p10 = join(dir, "t10.output");
    await writeFile(p1, "one\n");
    await writeFile(p10, "ten\n");
    const r = rig();
    r.startShell("t1", p1);
    r.startShell("t10", p10);
    await advance(2_000);

    await appendFile(p1, "one more\n");
    await advance(2_000);
    expect(r.tailOf("t1")).toEqual(["one", "one more"]);
    expect(r.tailOf("t10")).toEqual(["ten"]);
    r.poller.dispose();
  });
});

describe("TailPoller — errors, busy ticks and lifetime (R1.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });

  it("publishes tail null and hasOutput false when the file goes, and recovers when it returns", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "line 1\n");
    const r = rig();
    r.startShell("b1", path);
    await advance(2_000);
    expect(r.entryOf("b1")).toMatchObject({ hasOutput: true, tail: ["line 1"] });

    await unlink(path);
    await advance(2_000);
    expect(r.entryOf("b1")).toMatchObject({ hasOutput: false, tail: null });

    await writeFile(path, "back\n");
    await advance(2_000);
    expect(r.entryOf("b1")).toMatchObject({ hasOutput: true, tail: ["back"] });
    r.poller.dispose();
  });

  it("never starts a tick while the previous read is still pending", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "line 1\n");
    let release: (lines: string[]) => void = () => {};
    const r = rig({
      readTailFn: () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    });
    r.startShell("b1", path);
    await advance(1_000);
    await appendFile(path, "line 2\n");
    await advance(1_000);
    await appendFile(path, "line 3\n");
    await advance(3_000);
    expect(r.reads).toHaveBeenCalledTimes(1);
    release(["line 1"]);
    await advance(1_000);
    r.poller.dispose();
  });

  it("reads nothing before any output is known, and nothing after dispose", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "line 1\n");
    const r = rig();
    r.poller.kick();
    await advance(3_000);
    expect(r.reads).not.toHaveBeenCalled();

    r.startShell("b1", path);
    await advance(2_000);
    const reads = r.reads.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    const sends = r.sent.length;

    r.poller.dispose();
    await appendFile(path, "after dispose\n");
    await advance(5_000);
    expect(r.reads.mock.calls.length).toBe(reads);
    expect(r.sent.length).toBe(sends);
  });

  it("stops polling a task once it ended", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "line 1\n");
    const r = rig();
    r.startShell("b1", path);
    await advance(2_000);

    r.publisher.notify(
      r.feed.onNotification({
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        tool_use_id: "toolu_b1",
        status: "completed",
        output_file: path,
        summary: "done",
        uuid: randomUUID(),
        session_id: "poller-session",
      } as any),
    );
    r.poller.kick();
    await advance(2_000);
    const reads = r.reads.mock.calls.length;
    await appendFile(path, "after the end\n");
    await advance(5_000);
    // The ending's one existence check may read once more; polling may not.
    expect(r.reads.mock.calls.length - reads).toBeLessThanOrEqual(1);
    for (const s of r.sent) {
      const b1 = s.tasks.find((t) => t.id === "b1");
      if (b1 && b1.status !== "running") expect(b1.tail).toBeNull();
    }
    r.poller.dispose();
  });
});

// ---- Part 2: a live session, real timers --------------------------------------------------

const SECRET = "SECRET-OUTPUT-TEXT";

function bashToolUse(sessionId: string, toolUseId: string) {
  return {
    type: "assistant",
    message: {
      id: `msg_${toolUseId}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: {
            command: "for i in 1 2 3; do echo line $i; sleep 1; done",
            run_in_background: true,
            description: "Count",
          },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** The Bash tool_result of a backgrounded command, as the CLI sends it. */
function bashBackgroundResult(sessionId: string, toolUseId: string, taskId: string, path: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [
            {
              type: "text",
              text: `Command running in background with ID: ${taskId}. Output is being written to: ${path}`,
            },
          ],
        },
      ],
    },
    tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: taskId },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

async function startSession() {
  const published: any[] = [];
  const lines: string[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      const meta = notification.update._meta as Record<string, any> | undefined;
      if (notification.update.sessionUpdate === "session_info_update" && meta?.[TASKS_META_KEY]) {
        published.push(JSON.parse(JSON.stringify(meta[TASKS_META_KEY])));
      }
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } as unknown as AcpClient;
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  const agent = new ClaudeAcpAgent(client, { log: push, error: push });
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const query = lastScriptedQuery();

  async function turn(...messages: unknown[]) {
    const response = agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    query.out.push(running(sessionId));
    for (const message of messages) query.out.push(message);
    query.out.push(result(sessionId));
    query.out.push(idle(sessionId));
    return response;
  }
  const entries = (id: string) => published.flatMap((s) => s.tasks).filter((t: any) => t.id === id);
  const latest = (id: string) => entries(id).at(-1);
  return { agent, sessionId, query, published, lines, turn, entries, latest };
}

/** Starts background shell `taskId` whose notice names `noticePath`. */
async function backgroundShell(
  s: Awaited<ReturnType<typeof startSession>>,
  taskId: string,
  noticePath: string,
) {
  const toolUseId = `toolu_${taskId}`;
  await s.turn(
    bashToolUse(s.sessionId, toolUseId),
    taskStarted(s.sessionId, taskId, {
      tool_use_id: toolUseId,
      task_type: "local_bash",
      is_backgrounded: true,
    }),
    bashBackgroundResult(s.sessionId, toolUseId, taskId, noticePath),
  );
}

describe("Bash-result hook in a live session (R1.1, R1.4, R1.6)", () => {
  it("publishes a growing tail for the task the notice names", async () => {
    const s = await startSession();
    const path = join(dir, "b1.output");
    await writeFile(path, "line 1\n");
    await backgroundShell(s, "b1", path);

    await waitFor(
      () => s.latest("b1")?.tail?.includes("line 1") === true,
      "b1's first tail",
      3_000,
    );
    expect(s.latest("b1").hasOutput).toBe(true);

    await appendFile(path, "line 2\n");
    // R1.4: within 2 s, plus a little real-time slack for the event loop.
    await waitFor(
      () => s.latest("b1")?.tail?.includes("line 2") === true,
      "b1's grown tail",
      2_600,
    );
  });

  // Hostile: the notice names ANOTHER task's file; that file grows, and b1 still gets no tail.
  it("publishes no tail when the notice names a file other than <task id>.output", async () => {
    const s = await startSession();
    const other = join(dir, "b2.output");
    await writeFile(other, "not b1's output\n");
    await backgroundShell(s, "b1", other);
    await waitFor(() => s.entries("b1").length > 0, "b1 published");

    await appendFile(other, "still not b1's\n");
    await new Promise((r) => setTimeout(r, 2_500));
    for (const entry of s.entries("b1")) expect(entry.tail).toBeNull();
  });

  it("publishes no tail for a relative path in the notice", async () => {
    const s = await startSession();
    await backgroundShell(s, "b1", "tasks/b1.output");
    await waitFor(() => s.entries("b1").length > 0, "b1 published");
    await new Promise((r) => setTimeout(r, 1_500));
    for (const entry of s.entries("b1"))
      expect(entry).toMatchObject({ tail: null, hasOutput: false });
  });

  it("logs one warn line per task when the file becomes unreadable, with ids and code only", async () => {
    const s = await startSession();
    const path = join(dir, "b1.output");
    await writeFile(path, `${SECRET}\n`);
    await backgroundShell(s, "b1", path);
    await waitFor(() => (s.latest("b1")?.tail?.length ?? 0) > 0, "b1's tail");

    await unlink(path);
    await waitFor(() => s.latest("b1")?.hasOutput === false, "b1 unreadable", 3_000);
    expect(s.latest("b1").tail).toBeNull();
    await new Promise((r) => setTimeout(r, 2_500));

    const warns = s.lines.filter((l) => l.includes("[tasks/tail]"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("level=warn");
    expect(warns[0]).toContain(`sessionId=${s.sessionId}`);
    expect(warns[0]).toContain("taskId=b1");
    expect(warns[0]).toContain("code=ENOENT");
    for (const line of s.lines) expect(line).not.toContain(SECRET);
  }, 10_000);
});

describe("the ending's output check (R1.7)", () => {
  async function endWith(outputFile: string) {
    const s = await startSession();
    await s.turn(taskStarted(s.sessionId, "b1"));
    await waitFor(() => s.entries("b1").length > 0, "b1 running");
    s.query.out.push(taskNotification(s.sessionId, "b1", { output_file: outputFile }));
    await waitFor(() => s.entries("b1").some((t: any) => t.status === "completed"), "b1's ending");
    return s.entries("b1").find((t: any) => t.status === "completed");
  }

  // Hostile first: missing, empty and directory output_file never claim output.
  it("publishes hasOutput false in the ending when output_file is missing, empty or a directory", async () => {
    const asDir = join(dir, "d1.output");
    await mkdir(asDir);
    for (const outputFile of [join(dir, "gone.output"), "", asDir]) {
      const ending = await endWith(outputFile);
      expect(ending, outputFile).toMatchObject({ hasOutput: false, tail: null });
    }
  });

  it("publishes hasOutput true in the snapshot that carries the ending of a readable file", async () => {
    const path = join(dir, "b1.output");
    await writeFile(path, "all done\n");
    const ending = await endWith(path);
    expect(ending).toMatchObject({ hasOutput: true, tail: null });
  });
});
