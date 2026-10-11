// Story 041, task 2.3 — `_claude/tasks/output` and capability version 2 (R2.1, R2.2, R2.3, R2.4,
// R2.5, R2.7, R2.8, R2.9; Q4, Q13, Q15).
//
// Exercised two ways, as `task-actions.test.ts` does for stop and background: directly on the
// agent (`ClaudeAcpAgent.taskOutput`) for the outcomes, and through `runAcp`'s real JSON-RPC
// dispatcher over in-memory streams for registration, param parsing and error codes. Sessions come
// from the real `newSession` over a scripted SDK query, and each output file is a real file the
// task's `task_notification.output_file` names — the only way the adapter learns a path here.
//
// Contract (design.md §`_claude/tasks/output` handler): `TASKS_OUTPUT_METHOD`,
// `parseTasksOutputRequest(params)` throwing `RequestError.invalidParams`, `taskOutput({ sessionId,
// taskId, maxBytes })` resolving `{ content, totalBytes, truncated }`; unknown session and no
// recorded output → -32602; a recorded file that is gone → -32603 "no longer available (<code>)".
//
// Hostile halves first: a request carrying `path: "/etc/hostname"` must be served the recorded
// file, never that one; two sessions each holding a task `t1` must each be served their own file;
// a missing or malformed `maxBytes` must be refused while a valid one is served.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import {
  AcpClient,
  ClaudeAcpAgent,
  TASKS_META_KEY,
  TASKS_OUTPUT_METHOD,
  parseTasksOutputRequest,
  runAcp,
} from "../acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";
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

const OUTPUT = "_claude/tasks/output";
const STOP = "_claude/tasks/stop";
const SECRET = "TOP-SECRET-OUTPUT";
const MIB = 1_048_576;

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "task-output-request-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capturingLogger() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, logger: { log: push, error: push } };
}

const outputLines = (lines: string[]) => lines.filter((l) => l.includes("[tasks/output]"));

function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=(\S*)/g)) out[m[1]] = m[2];
  return out;
}

const errorText = (e: any) => `${e?.message ?? ""} ${JSON.stringify(e?.data ?? null)}`;

/** A client that records the task snapshots, so a test can wait for an ending to be published. */
function recordingClient() {
  const snapshots: any[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      const meta = notification.update._meta as Record<string, any> | undefined;
      if (notification.update.sessionUpdate === "session_info_update" && meta?.[TASKS_META_KEY]) {
        snapshots.push(meta[TASKS_META_KEY]);
      }
    },
  } as unknown as AcpClient;
  return { client, snapshots };
}

function newAgent() {
  const { lines, logger } = capturingLogger();
  const { client, snapshots } = recordingClient();
  const agent = new ClaudeAcpAgent(client, logger);
  return { agent, lines, snapshots };
}

/**
 * A session whose feed saw: `taskId` ended with its output in `file` (holding `content`), and
 * `running1` still running with no known output. Waits until the ending was published, so the
 * ended task has left the table and is served from the ended-output registry.
 */
async function sessionWithOutput(
  agent: ClaudeAcpAgent,
  snapshots: any[] | null,
  { taskId = "b1", content = `line 1\nline 2 ${SECRET}\nline 3\n`, name = "" } = {},
) {
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const file = join(dir, `${name}${taskId}.output`);
  await writeFile(file, content);
  const query = lastScriptedQuery();
  const response = agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
  query.out.push(running(sessionId));
  query.out.push(taskStarted(sessionId, taskId));
  query.out.push(taskStarted(sessionId, "running1"));
  query.out.push(taskNotification(sessionId, taskId, { output_file: file }));
  query.out.push(result(sessionId));
  query.out.push(idle(sessionId));
  await response;
  if (snapshots) {
    await waitFor(
      () =>
        snapshots.some((s) =>
          s.tasks.some(
            (t: any) => t.id === taskId && t.status !== "running" && t.hasOutput === true,
          ),
        ),
      `${taskId}'s ending published with hasOutput`,
    );
  } else {
    await new Promise((r) => setTimeout(r, 300));
  }
  return { sessionId, file, content, query };
}

describe("parseTasksOutputRequest (R2.2, R2.5)", () => {
  // Hostile first: every malformed maxBytes is refused, naming the field.
  it("refuses an absent, zero, negative, fractional, string or unsafe maxBytes, naming maxBytes", () => {
    for (const maxBytes of [undefined, 0, -1, 1.5, "10", Number.NaN, 2 ** 53, null]) {
      let error: any;
      try {
        parseTasksOutputRequest({ sessionId: "s", taskId: "t", maxBytes });
      } catch (e) {
        error = e;
      }
      expect(error?.code, String(maxBytes)).toBe(-32602);
      expect(errorText(error)).toContain("maxBytes");
    }
  });

  it("refuses a missing or empty id, naming the field", () => {
    for (const [params, field] of [
      [{ taskId: "t", maxBytes: 10 }, "sessionId"],
      [{ sessionId: "", taskId: "t", maxBytes: 10 }, "sessionId"],
      [{ sessionId: "s", maxBytes: 10 }, "taskId"],
      [{ sessionId: "s", taskId: "", maxBytes: 10 }, "taskId"],
    ] as const) {
      let error: any;
      try {
        parseTasksOutputRequest(params);
      } catch (e) {
        error = e;
      }
      expect(error?.code).toBe(-32602);
      expect(errorText(error)).toContain(field);
    }
  });

  it("accepts a positive integer and ignores every extra key, path included", () => {
    expect(
      parseTasksOutputRequest({
        sessionId: "s",
        taskId: "t",
        maxBytes: 1,
        path: "/etc/hostname",
        x: 1,
      }),
    ).toEqual({ sessionId: "s", taskId: "t", maxBytes: 1 });
  });
});

describe("_claude/tasks/output — outcomes (R2.1, R2.3, R2.5, R2.6)", () => {
  it("serves an ended task's whole output after it left the snapshot", async () => {
    const { agent, snapshots } = newAgent();
    const { sessionId, content } = await sessionWithOutput(agent, snapshots);

    await expect(agent.taskOutput({ sessionId, taskId: "b1", maxBytes: MIB })).resolves.toEqual({
      content,
      totalBytes: Buffer.byteLength(content),
      truncated: false,
    });
  });

  it("serves the last maxBytes at a line boundary when the output is longer", async () => {
    const { agent, snapshots } = newAgent();
    const { sessionId, content } = await sessionWithOutput(agent, snapshots, {
      content: "first line that goes\nsecond\nthird\n",
    });

    const out = await agent.taskOutput({ sessionId, taskId: "b1", maxBytes: 14 });
    expect(out).toEqual({
      content: "second\nthird\n",
      totalBytes: Buffer.byteLength(content),
      truncated: true,
    });
  });

  it("serves at most 1 MiB whatever maxBytes asks for (R2.3)", async () => {
    const { agent, snapshots } = newAgent();
    const big = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const { sessionId } = await sessionWithOutput(agent, snapshots, { content: big });

    const out = await agent.taskOutput({ sessionId, taskId: "b1", maxBytes: 50 * MIB });
    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBe(Buffer.byteLength(big));
    expect(Buffer.byteLength(out.content)).toBeLessThanOrEqual(MIB);
    expect(big.endsWith(out.content)).toBe(true);
  });

  // Hostile (R2.5): the request names a path; the recorded file is served, never that path.
  it("ignores a path the request carries and reads only the recorded file", async () => {
    const { agent, snapshots } = newAgent();
    const { sessionId, content } = await sessionWithOutput(agent, snapshots);
    const elsewhere = join(dir, "elsewhere.txt");
    await writeFile(elsewhere, "NOT THE TASK'S OUTPUT\n");

    const out = await agent.taskOutput({
      sessionId,
      taskId: "b1",
      maxBytes: MIB,
      path: elsewhere,
    } as any);
    expect(out.content).toBe(content);
    expect(out.content).not.toContain("NOT THE TASK'S OUTPUT");
  });

  // Hostile (wrong collapse across sessions): the same task id in two sessions is two files.
  it("serves each session its own t1", async () => {
    const { agent } = newAgent();
    const a = await sessionWithOutput(agent, null, {
      taskId: "t1",
      name: "a-",
      content: "from A\n",
    });
    const b = await sessionWithOutput(agent, null, {
      taskId: "t1",
      name: "b-",
      content: "from B\n",
    });

    const outA = await agent.taskOutput({ sessionId: a.sessionId, taskId: "t1", maxBytes: MIB });
    const outB = await agent.taskOutput({ sessionId: b.sessionId, taskId: "t1", maxBytes: MIB });
    expect(outA.content).toBe("from A\n");
    expect(outB.content).toBe("from B\n");
  });
});

describe("_claude/tasks/output — errors (R2.4)", () => {
  it("refuses an unknown session with invalid params naming it", async () => {
    const { agent, snapshots } = newAgent();
    await sessionWithOutput(agent, snapshots);
    const error = await agent
      .taskOutput({ sessionId: "no-such-session", taskId: "b1", maxBytes: MIB })
      .catch((e) => e);
    expect(error?.code).toBe(-32602);
    expect(errorText(error)).toContain("no-such-session");
  });

  it("refuses a task with no recorded output, naming the task and the reason", async () => {
    const { agent, snapshots } = newAgent();
    const { sessionId } = await sessionWithOutput(agent, snapshots);
    for (const taskId of ["ghost", "running1"]) {
      const error = await agent.taskOutput({ sessionId, taskId, maxBytes: MIB }).catch((e) => e);
      expect(error?.code, taskId).toBe(-32602);
      expect(errorText(error)).toContain(taskId);
      expect(errorText(error)).toContain("no recorded output");
    }
  });

  it("answers an internal error naming the task and the code when the recorded file is gone", async () => {
    const { agent, snapshots } = newAgent();
    const { sessionId, file } = await sessionWithOutput(agent, snapshots);
    await unlink(file);

    const error = await agent
      .taskOutput({ sessionId, taskId: "b1", maxBytes: MIB })
      .catch((e) => e);
    expect(error?.code).toBe(-32603);
    expect(errorText(error)).toContain("b1");
    expect(errorText(error)).toContain("no longer available");
    expect(errorText(error)).toContain("ENOENT");
  });
});

describe("_claude/tasks/output — one log line, no output text (R2.7, Q13)", () => {
  it("logs method, ids, bytes, truncated and outcome=ok as key=value, once", async () => {
    const { agent, lines, snapshots } = newAgent();
    const { sessionId } = await sessionWithOutput(agent, snapshots, {
      content: "first line that goes\nsecond\nthird\n",
    });
    const before = outputLines(lines).length;

    const out = await agent.taskOutput({ sessionId, taskId: "b1", maxBytes: 14 });

    const logged = outputLines(lines).slice(before);
    expect(logged).toHaveLength(1);
    const tokens = logged[0]
      .slice(logged[0].indexOf("[tasks/output]") + "[tasks/output]".length)
      .trim()
      .split(/\s+/);
    for (const token of tokens) expect(token).toMatch(/^\w+=\S*$/);
    expect(fields(logged[0])).toMatchObject({
      method: OUTPUT,
      sessionId,
      taskId: "b1",
      bytes: String(Buffer.byteLength(out.content)),
      truncated: "true",
      outcome: "ok",
    });
  });

  it("logs outcome=error with a reason for a refused request", async () => {
    const { agent, lines, snapshots } = newAgent();
    const { sessionId } = await sessionWithOutput(agent, snapshots);
    const before = outputLines(lines).length;

    await agent.taskOutput({ sessionId, taskId: "ghost", maxBytes: MIB }).catch(() => {});

    const logged = outputLines(lines).slice(before);
    expect(logged).toHaveLength(1);
    expect(fields(logged[0])).toMatchObject({
      method: OUTPUT,
      sessionId,
      taskId: "ghost",
      outcome: "error",
    });
    expect(fields(logged[0]).reason?.length ?? 0).toBeGreaterThan(0);
  });

  it("never writes the output text into any log line", async () => {
    const { agent, lines, snapshots } = newAgent();
    const { sessionId, file } = await sessionWithOutput(agent, snapshots);
    await agent.taskOutput({ sessionId, taskId: "b1", maxBytes: MIB });
    await unlink(file);
    await agent.taskOutput({ sessionId, taskId: "b1", maxBytes: MIB }).catch(() => {});

    expect(outputLines(lines).length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).not.toContain(SECRET);
  });

  it("keeps a client id from forging a field in the line", async () => {
    const { agent, lines, snapshots } = newAgent();
    const { sessionId } = await sessionWithOutput(agent, snapshots);
    await agent
      .taskOutput({ sessionId, taskId: "x outcome=ok\nforged=1", maxBytes: MIB })
      .catch(() => {});
    const logged = outputLines(lines).at(-1)!;
    expect(logged).not.toContain("\n");
    expect(fields(logged).outcome).toBe("error");
    expect(fields(logged).forged).toBeUndefined();
  });
});

// ---- Over the wire ------------------------------------------------------------------------

type Wire = { request: (method: string, params: unknown) => Promise<any>; agent: ClaudeAcpAgent };

/** `runAcp` on in-memory streams, as `task-actions.test.ts` builds it. */
function wire(): Wire {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
  Object.defineProperty(process, "stdin", { value: toAgent, configurable: true });
  Object.defineProperty(process, "stdout", { value: fromAgent, configurable: true });
  let started: ReturnType<typeof runAcp>;
  try {
    started = runAcp({ log: () => {}, error: () => {} });
  } finally {
    Object.defineProperty(process, "stdin", stdin);
    Object.defineProperty(process, "stdout", stdout);
  }
  const connection = acpClient({ name: "task-output-test" })
    .onNotification(methods.client.session.update, () => {})
    .connect(ndJsonStream(nodeToWebWritable(toAgent), nodeToWebReadable(fromAgent)));
  return {
    request: (method, params) => connection.agent.request(method, params as any),
    agent: started.agent,
  };
}

describe("capability version 2 (R2.8)", () => {
  it("names the method", () => {
    expect(TASKS_OUTPUT_METHOD).toBe(OUTPUT);
  });

  it('initialize advertises agentCapabilities._meta["_claude/tasks"] = { version: 2 }', async () => {
    const { agent } = newAgent();
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect((response.agentCapabilities as any)?._meta?.["_claude/tasks"]).toEqual({ version: 2 });
  });

  it("advertises it over the wire", async () => {
    const w = wire();
    const response = await w.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(response?.agentCapabilities?._meta?.["_claude/tasks"]).toEqual({ version: 2 });
  });
});

describe("_claude/tasks/output over JSON-RPC (R2.1, R2.2, R2.9)", () => {
  it("routes the request to the agent and answers the output", async () => {
    const w = wire();
    const { sessionId, content } = await sessionWithOutput(w.agent, null);
    await waitFor(() => true, "settle");

    const out = await w.request(OUTPUT, { sessionId, taskId: "b1", maxBytes: MIB });
    expect(out).toEqual({ content, totalBytes: Buffer.byteLength(content), truncated: false });
  });

  it("answers invalid params for a malformed maxBytes before reaching the agent", async () => {
    const w = wire();
    const { sessionId } = await sessionWithOutput(w.agent, null);
    for (const maxBytes of [undefined, 0, "abc", 2.5]) {
      const error = await w.request(OUTPUT, { sessionId, taskId: "b1", maxBytes }).catch((e) => e);
      expect(error?.code, String(maxBytes)).toBe(-32602);
    }
  });

  // R2.9: the version 1 methods are untouched by the new one.
  it("leaves stop registered and working beside it", async () => {
    const w = wire();
    const { sessionId, query } = await sessionWithOutput(w.agent, null);
    await expect(w.request(STOP, { sessionId, taskId: "running1" })).resolves.toEqual({});
    await waitFor(() => query.stopTaskCalls.length === 1, "stopTask reached the SDK");
    const output = await w.request(OUTPUT, { sessionId, taskId: "", maxBytes: 1 }).catch((e) => e);
    expect(output?.code).not.toBe(-32601);
  });
});
