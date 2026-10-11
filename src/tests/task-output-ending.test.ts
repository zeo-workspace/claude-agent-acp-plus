// Story 041 — regressions from the group 2 tech review (R1.6, R1.7, R2.1).
//
// 1. The CLI queues a shell's terminal `task_updated` BEFORE its `task_notification`. The ending
//    must still be published with `hasOutput: true` when the recorded file reads, and the output
//    must still be served afterwards.
// 2. A FIFO planted at the recorded path must be refused at once, never block a read.
// 3. A foreground shell promoted to the background keeps the output path recorded while it was
//    held: a promotion is the same life, not a new one.
// 4. A publish that lands while the ending's check is pending must not carry the ending with
//    `hasOutput: false` — the check finishes before the ending enters the feed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent, TASKS_META_KEY } from "../acp-agent.js";
import { FOREGROUND_SHELL_HOLD_MS, TailPoller, TaskFeed, TaskFeedPublisher } from "../task-feed.js";
import { OutputUnavailable, readOutput, readTail } from "../task-output.js";
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
  dir = await mkdtemp(join(tmpdir(), "task-output-ending-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const taskUpdated = (sessionId: string, taskId: string, patch: Record<string, unknown>) => ({
  type: "system",
  subtype: "task_updated",
  task_id: taskId,
  patch,
  uuid: randomUUID(),
  session_id: sessionId,
});

async function startSession() {
  const published: any[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      const meta = notification.update._meta as Record<string, any> | undefined;
      if (notification.update.sessionUpdate === "session_info_update" && meta?.[TASKS_META_KEY]) {
        published.push(JSON.parse(JSON.stringify(meta[TASKS_META_KEY])));
      }
    },
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const query = lastScriptedQuery();
  const endings = (id: string) =>
    published.flatMap((s) => s.tasks).filter((t: any) => t.id === id && t.status !== "running");
  return { agent, sessionId, query, endings };
}

describe("the CLI's ending order: task_updated, then task_notification (R1.7)", () => {
  it("publishes the ending with hasOutput true and still serves the output", async () => {
    const s = await startSession();
    const file = join(dir, "b1.output");
    await writeFile(file, "line 1\nline 2\n");

    const response = s.agent.prompt({
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    s.query.out.push(running(s.sessionId));
    s.query.out.push(taskStarted(s.sessionId, "b1"));
    s.query.out.push(taskUpdated(s.sessionId, "b1", { status: "completed" }));
    s.query.out.push(taskNotification(s.sessionId, "b1", { output_file: file }));
    s.query.out.push(result(s.sessionId));
    s.query.out.push(idle(s.sessionId));
    await response;
    await waitFor(() => s.endings("b1").length > 0, "b1's ending");

    // Converse: without a path known at the patch, the ending cannot claim output.
    expect(s.endings("b1")[0]).toMatchObject({ status: "completed", tail: null });
    expect(s.endings("b1")).toHaveLength(1);
  });

  it("claims hasOutput at the patch when the Bash result named the file", async () => {
    const s = await startSession();
    const file = join(dir, "b1.output");
    await writeFile(file, "line 1\n");

    const response = s.agent.prompt({
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    s.query.out.push(running(s.sessionId));
    s.query.out.push(taskStarted(s.sessionId, "b1"));
    // What the Bash-result hook records for a backgrounded call.
    const session = (s.agent as any).sessions[s.sessionId];
    await waitFor(() => session.taskFeed.isRunning("b1"), "b1 running");
    session.taskFeed.onOutputPath("b1", file);
    s.query.out.push(taskUpdated(s.sessionId, "b1", { status: "completed" }));
    s.query.out.push(taskNotification(s.sessionId, "b1", { output_file: file }));
    s.query.out.push(result(s.sessionId));
    s.query.out.push(idle(s.sessionId));
    await response;
    await waitFor(() => s.endings("b1").length > 0, "b1's ending");

    expect(s.endings("b1")[0]).toMatchObject({ status: "completed", hasOutput: true, tail: null });
    await expect(
      s.agent.taskOutput({ sessionId: s.sessionId, taskId: "b1", maxBytes: 1_048_576 }),
    ).resolves.toMatchObject({ content: "line 1\n", truncated: false });
  });
});

describe("a FIFO at the recorded path", () => {
  it("is refused at once by readTail and readOutput, never waited on", async () => {
    const fifo = join(dir, "b1.output");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    const tail = await readTail(fifo).catch((e) => e);
    const output = await readOutput(fifo, 100).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(tail).toBeInstanceOf(OutputUnavailable);
    expect(tail.code).toBe("not_regular");
    expect(output).toBeInstanceOf(OutputUnavailable);
    expect(output.code).toBe("not_regular");
  });
});

describe("a held shell's output path", () => {
  it("survives its promotion to the background", () => {
    let now = 1_000_000;
    const feed = new TaskFeed(() => now);
    feed.onStarted(taskStarted("s", "b1", { is_backgrounded: false }) as any);
    feed.onOutputPath("b1", "/tmp/x/b1.output");
    now += FOREGROUND_SHELL_HOLD_MS;
    expect(feed.promoteDue()).toBe("progress");
    expect(feed.outputPathFor("b1")).toBe("/tmp/x/b1.output");
    expect(feed.runningOutputs()).toEqual([{ taskId: "b1", path: "/tmp/x/b1.output" }]);
  });

  it("is dropped when the held shell ends unseen, and a new life starts without it", () => {
    const now = 1_000_000;
    const feed = new TaskFeed(() => now);
    feed.onStarted(taskStarted("s", "b1", { is_backgrounded: false }) as any);
    feed.onOutputPath("b1", "/tmp/x/b1.output");
    feed.onNotification(taskNotification("s", "b1") as any);
    expect(feed.outputPathFor("b1")).toBeNull();
  });
});

describe("a publish during the ending's check (R1.7)", () => {
  it("never carries the ending without the check's answer", async () => {
    const sent: any[] = [];
    const feed = new TaskFeed(() => Date.now());
    const publisher = new TaskFeedPublisher(feed, async (snapshot) => {
      sent.push(JSON.parse(JSON.stringify(snapshot)));
    });
    let release: () => void = () => {};
    const poller = new TailPoller(
      feed,
      publisher,
      undefined,
      (path) =>
        new Promise<string[]>((resolve) => {
          release = () => resolve([path]);
        }),
    );
    publisher.notify(feed.onStarted(taskStarted("s", "b1") as any));
    feed.onOutputPath("b1", "/tmp/x/b1.output");
    // b2's start arms the trailing publish that lands while b1's check is pending.
    publisher.notify(feed.onStarted(taskStarted("s", "b2") as any));

    const path = feed.endingOutputPath("b1");
    expect(path).toBe("/tmp/x/b1.output");
    const check = poller.checkOutput(path!);
    await new Promise((r) => setTimeout(r, 1_200));
    release();
    const readable = await check;
    const change = feed.onNotification(taskNotification("s", "b1") as any);
    feed.setTail("b1", null, readable);
    publisher.notify(change);
    await waitFor(() =>
      sent.some((s) => s.tasks.some((t: any) => t.id === "b1" && t.status !== "running")),
    );

    const endings = sent
      .flatMap((s) => s.tasks)
      .filter((t: any) => t.id === "b1" && t.status !== "running");
    expect(endings).toEqual([expect.objectContaining({ hasOutput: true })]);
    poller.dispose();
    publisher.dispose();
  });
});

describe("a stale poller read after the ending", () => {
  it("cannot take back hasOutput from an ended task", () => {
    const feed = new TaskFeed(() => 1_000_000);
    feed.onStarted(taskStarted("s", "b1") as any);
    feed.onOutputPath("b1", "/tmp/x/b1.output");
    feed.onNotification(taskNotification("s", "b1") as any);
    feed.setTail("b1", null, true);

    expect(feed.setTail("b1", null, false)).toBe("none");
    const b1 = feed.snapshot().snapshot.tasks.find((t) => t.id === "b1");
    expect(b1).toMatchObject({ status: "completed", hasOutput: true, tail: null });
  });
});
