// Integration tests for the task action requests (story 012, R2.1–R2.6).
//
// `_claude/tasks/stop` and `_claude/tasks/background` are exercised two ways:
// through `runAcp`'s real JSON-RPC dispatcher over in-memory streams (method
// registration, param parsing, error codes on the wire), and directly on the
// agent for the outcomes. Sessions come from the real `newSession` over a
// scripted SDK query, so the task a test stops is one the feed actually saw.

import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent, runAcp } from "../acp-agent.js";
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

const STOP = "_claude/tasks/stop";
const BACKGROUND = "_claude/tasks/background";
const COMMAND_LINE = "sleep 20 && echo TOP-SECRET-COMMAND";
const DESCRIPTION = "Private description text";

/** Every log line the agent wrote, from either level. */
function capturingLogger() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, logger: { log: push, error: push } };
}

const actionLines = (lines: string[]) => lines.filter((l) => l.includes("[tasks/action]"));

/** `key=value` fields of a `[tasks/action]` line (values without spaces). */
function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=(\S*)/g)) out[m[1]] = m[2];
  return out;
}

/** An error's text as a client could see it: message plus data. */
const errorText = (e: any) => `${e?.message ?? ""} ${JSON.stringify(e?.data ?? null)}`;

/** A live session whose feed holds: b1 running (background shell), f1 running
 *  (foreground subagent), done ended. The command line is in the SDK message so
 *  a leak would be visible. */
async function sessionWithTasks(agent: ClaudeAcpAgent) {
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const query = lastScriptedQuery();
  const response = agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
  query.out.push(running(sessionId));
  query.out.push(taskStarted(sessionId, "b1", { description: DESCRIPTION, prompt: COMMAND_LINE }));
  query.out.push(
    taskStarted(sessionId, "f1", {
      task_type: "local_agent",
      is_backgrounded: false,
      tool_use_id: "toolu_foreground",
      description: DESCRIPTION,
    }),
  );
  query.out.push(taskStarted(sessionId, "done", { description: DESCRIPTION }));
  query.out.push(taskNotification(sessionId, "done"));
  query.out.push(result(sessionId));
  query.out.push(idle(sessionId));
  await response;
  return { sessionId, query };
}

function newAgent() {
  const { lines, logger } = capturingLogger();
  const agent = new ClaudeAcpAgent(
    { sessionUpdate: async () => {} } as unknown as AcpClient,
    logger,
  );
  return { agent, lines };
}

describe("_claude/tasks/stop — outcomes (R2.1, R2.2)", () => {
  it("asks the SDK to stop a running task and answers success", async () => {
    const { agent } = newAgent();
    const { sessionId, query } = await sessionWithTasks(agent);

    await expect(agent.stopTask({ sessionId, taskId: "b1" })).resolves.toEqual({});
    expect(query.stopTaskCalls).toEqual(["b1"]);
  });

  it("rejects an unknown session with invalid params naming the session id", async () => {
    const { agent } = newAgent();
    await sessionWithTasks(agent);

    const error = await agent
      .stopTask({ sessionId: "no-such-session", taskId: "b1" })
      .catch((e) => e);
    expect(error?.code).toBe(-32602);
    expect(errorText(error)).toContain("no-such-session");
  });

  it("rejects an unknown task with invalid params naming the task id, and stops nothing", async () => {
    const { agent } = newAgent();
    const { sessionId, query } = await sessionWithTasks(agent);

    const error = await agent.stopTask({ sessionId, taskId: "ghost-task" }).catch((e) => e);
    expect(error?.code).toBe(-32602);
    expect(errorText(error)).toContain("ghost-task");
    expect(query.stopTaskCalls).toEqual([]);
  });

  // Hostile half: an ended task and a running one look alike (same
  // description); only the running one may be stopped.
  it("rejects a task that already ended while still stopping a running look-alike", async () => {
    const { agent } = newAgent();
    const { sessionId, query } = await sessionWithTasks(agent);

    const error = await agent.stopTask({ sessionId, taskId: "done" }).catch((e) => e);
    expect(error?.code).toBe(-32602);
    expect(errorText(error)).toContain("done");
    expect(query.stopTaskCalls).toEqual([]);

    await expect(agent.stopTask({ sessionId, taskId: "b1" })).resolves.toEqual({});
    expect(query.stopTaskCalls).toEqual(["b1"]);
  });
});

describe("_claude/tasks/stop — the SDK refuses", () => {
  it("answers an internal error carrying the SDK's message when query.stopTask rejects", async () => {
    const { agent } = newAgent();
    const { sessionId, query } = await sessionWithTasks(agent);
    query.stopTaskImpl = async () => {
      throw new Error("No task found with ID: b1");
    };

    const error = await agent.stopTask({ sessionId, taskId: "b1" }).catch((e) => e);
    expect(error?.code).toBe(-32603);
    expect(errorText(error)).toContain("No task found with ID: b1");
  });
});

describe("_claude/tasks/background — outcomes (R2.3, R2.4)", () => {
  it("asks the SDK to background the tool call and answers backgrounded: true", async () => {
    const { agent } = newAgent();
    const { sessionId, query } = await sessionWithTasks(agent);

    await expect(
      agent.backgroundTask({ sessionId, toolCallId: "toolu_foreground" }),
    ).resolves.toEqual({ backgrounded: true });
    expect(query.backgroundTasksCalls).toEqual(["toolu_foreground"]);
  });

  it("answers backgrounded: false when the SDK moved nothing", async () => {
    const { agent } = newAgent();
    const { sessionId, query } = await sessionWithTasks(agent);
    query.backgroundTasksImpl = async () => false;

    await expect(
      agent.backgroundTask({ sessionId, toolCallId: "toolu_unmatched" }),
    ).resolves.toEqual({ backgrounded: false });
    expect(query.backgroundTasksCalls).toEqual(["toolu_unmatched"]);
  });

  it("answers an internal error carrying the SDK's reason when background tasks are disabled", async () => {
    const { agent } = newAgent();
    const { sessionId, query } = await sessionWithTasks(agent);
    query.backgroundTasksImpl = async () => {
      throw new Error("Background tasks are disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)");
    };

    const error = await agent
      .backgroundTask({ sessionId, toolCallId: "toolu_foreground" })
      .catch((e) => e);
    expect(error?.code).toBe(-32603);
    expect(errorText(error)).toContain("Background tasks are disabled");
  });

  it("rejects an unknown session naming its id", async () => {
    const { agent } = newAgent();
    await sessionWithTasks(agent);

    const error = await agent
      .backgroundTask({ sessionId: "no-such-session", toolCallId: "toolu_foreground" })
      .catch((e) => e);
    expect(error?.code).toBe(-32602);
    expect(errorText(error)).toContain("no-such-session");
  });
});

describe("task actions — one structured log line each (R2.6, Q13)", () => {
  it("logs method, session id, task id and outcome=ok as key=value, once", async () => {
    const { agent, lines } = newAgent();
    const { sessionId } = await sessionWithTasks(agent);
    const before = actionLines(lines).length;

    await agent.stopTask({ sessionId, taskId: "b1" });

    const logged = actionLines(lines).slice(before);
    expect(logged).toHaveLength(1);
    const tokens = logged[0]
      .slice(logged[0].indexOf("[tasks/action]") + "[tasks/action]".length)
      .trim()
      .split(/\s+/);
    for (const token of tokens) expect(token).toMatch(/^\w+=\S*$/);
    expect(fields(logged[0])).toMatchObject({
      method: STOP,
      sessionId,
      taskId: "b1",
      outcome: "ok",
    });
  });

  it("logs an error outcome with the session id for a rejected action", async () => {
    const { agent, lines } = newAgent();
    const { sessionId } = await sessionWithTasks(agent);
    const before = actionLines(lines).length;

    await agent.stopTask({ sessionId, taskId: "ghost-task" }).catch(() => {});

    const logged = actionLines(lines).slice(before);
    expect(logged).toHaveLength(1);
    expect(fields(logged[0])).toMatchObject({
      method: STOP,
      sessionId,
      taskId: "ghost-task",
      outcome: "error",
    });
  });

  it("logs the background action with its tool call id", async () => {
    const { agent, lines } = newAgent();
    const { sessionId } = await sessionWithTasks(agent);
    const before = actionLines(lines).length;

    await agent.backgroundTask({ sessionId, toolCallId: "toolu_foreground" });

    const logged = actionLines(lines).slice(before);
    expect(logged).toHaveLength(1);
    expect(fields(logged[0])).toMatchObject({ method: BACKGROUND, sessionId, outcome: "ok" });
    expect(logged[0]).toContain("toolu_foreground");
  });

  it("never logs the task's command line or description", async () => {
    const { agent, lines } = newAgent();
    const { sessionId } = await sessionWithTasks(agent);

    await agent.stopTask({ sessionId, taskId: "b1" });
    await agent.stopTask({ sessionId, taskId: "done" }).catch(() => {});
    await agent.backgroundTask({ sessionId, toolCallId: "toolu_foreground" });

    expect(actionLines(lines).length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line).not.toContain("TOP-SECRET-COMMAND");
      expect(line).not.toContain(DESCRIPTION);
    }
  });
});

// ---- Over the wire ----------------------------------------------------------

type Wire = { request: (method: string, params: unknown) => Promise<any>; agent: ClaudeAcpAgent };
/** Start `runAcp` on in-memory streams and connect a client to it. `runAcp`
 *  binds `process.stdin`/`process.stdout` when called, so they are swapped for
 *  the duration of that call only. The streams are left open on purpose:
 *  ending them closes both connections and rejects their `closed` promises,
 *  which nobody awaits here. */
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
  const connection = acpClient({ name: "task-actions-test" })
    .onNotification(methods.client.session.update, () => {})
    .connect(ndJsonStream(nodeToWebWritable(toAgent), nodeToWebReadable(fromAgent)));
  return {
    request: (method, params) => connection.agent.request(method, params as any),
    agent: started.agent,
  };
}

describe("task feed capability (R2.7)", () => {
  it('initialize advertises agentCapabilities._meta["_claude/tasks"] = { version: 1 }', async () => {
    const { agent } = newAgent();
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    expect((response.agentCapabilities as any)?._meta?.["_claude/tasks"]).toEqual({ version: 1 });
  });

  it("advertises it over the wire, where Zeo reads it", async () => {
    const w = wire();
    const response = await w.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    expect(response?.agentCapabilities?._meta?.["_claude/tasks"]?.version).toBe(1);
  });
});

describe("task actions over JSON-RPC (R2.1, R2.2, R2.5)", () => {
  it("routes _claude/tasks/stop to the agent and answers {}", async () => {
    const w = wire();
    const { sessionId, query } = await sessionWithTasks(w.agent);

    await expect(w.request(STOP, { sessionId, taskId: "b1" })).resolves.toEqual({});
    await waitFor(() => query.stopTaskCalls.length === 1, "stopTask reached the SDK");
    expect(query.stopTaskCalls).toEqual(["b1"]);
  });

  it("routes _claude/tasks/background and answers { backgrounded }", async () => {
    const w = wire();
    const { sessionId } = await sessionWithTasks(w.agent);

    await expect(
      w.request(BACKGROUND, { sessionId, toolCallId: "toolu_foreground" }),
    ).resolves.toEqual({ backgrounded: true });
  });

  it("answers invalid params for a missing or empty field, before reaching the agent", async () => {
    const w = wire();
    const { sessionId, query } = await sessionWithTasks(w.agent);

    for (const params of [{ sessionId, taskId: "" }, { sessionId }, { taskId: "b1" }]) {
      const error = await w.request(STOP, params).catch((e) => e);
      expect(error?.code).toBe(-32602);
    }
    for (const params of [{ sessionId, toolCallId: "" }, { sessionId }]) {
      const error = await w.request(BACKGROUND, params).catch((e) => e);
      expect(error?.code).toBe(-32602);
    }
    expect(query.stopTaskCalls).toEqual([]);
    expect(query.backgroundTasksCalls).toEqual([]);
  });

  it("answers an error naming the unknown session over the wire", async () => {
    const w = wire();
    await sessionWithTasks(w.agent);

    const error = await w
      .request(STOP, { sessionId: "no-such-session", taskId: "b1" })
      .catch((e) => e);
    expect(error?.code).toBe(-32602);
    expect(errorText(error)).toContain("no-such-session");
  });

  it("answers method not found for any other _claude/tasks/* method, while stop and background are registered", async () => {
    const w = wire();
    const { sessionId } = await sessionWithTasks(w.agent);

    for (const method of ["_claude/tasks/pause", "_claude/tasks/resume", "_claude/tasks/list"]) {
      const error = await w.request(method, { sessionId, taskId: "b1" }).catch((e) => e);
      expect(error?.code).toBe(-32601);
    }
    // The two real methods are not "method not found".
    const stop = await w.request(STOP, { sessionId, taskId: "" }).catch((e) => e);
    expect(stop?.code).not.toBe(-32601);
    const background = await w.request(BACKGROUND, { sessionId, toolCallId: "" }).catch((e) => e);
    expect(background?.code).not.toBe(-32601);
  });
});
