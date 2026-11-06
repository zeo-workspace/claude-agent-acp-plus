// Story 065, Task 3.1 — a child is cancelled alone (R3.1, R3.2, R3.3).
//
// Integration: the real `ClaudeAcpAgent` over a scripted SDK stream; the
// assertions read the ACP wire and the SDK calls the agent makes
// (`stopTask`, `interrupt`). An interrupt of the query is what stops the
// parent's turn, so a child cancel must never send one.
//
// The cancel resolves a session id to a target, so the hostile halves come
// first in each pair: a cancel naming one child must not reach its sibling or
// its parent, and a cancel naming the parent must not reach its background
// children; only then does the named target stop.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  agentEnded,
  agentStarted,
  agentToolUse,
  announcedChildren,
  assistant,
  lastCaptured,
  type Launch,
  readToolUse,
  statesOf,
  tick,
  toolCallNotifications,
  toolResult,
  waitFor,
} from "./child-sessions-harness.js";
import { connect, disconnectAll, RFD_CAPABILITIES } from "./child-sessions-connection.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { capturingQuery } = await import("./child-sessions-harness.js");
  return { ...actual, query: vi.fn(capturingQuery) };
});

afterEach(disconnectAll);

const PARSER: Launch = {
  toolUseId: "toolu_01ParserLaunch",
  agentId: "a3f9c1d2e4b5a6c7",
  name: "parser-finder",
  subagentType: "Explore",
  description: "Find the parser",
  prompt: "Find where the config parser lives.",
};
const TWIN: Launch = { ...PARSER, toolUseId: "toolu_01TwinLaunch", agentId: "b8e2d4f6a1c3e5d7" };
const WATCHER: Launch = {
  toolUseId: "toolu_01WatcherLaunch",
  agentId: "c5d7e9f1a3b5c7d9",
  name: "watcher",
  subagentType: "general-purpose",
  description: "Watch the build",
  prompt: "Watch the build and report when it ends.",
  background: true,
};

const u = (n: SessionNotification) => n.update as Record<string, any>;
const taskInFeed = (updates: SessionNotification[], taskId: string) =>
  updates.some((n) =>
    (u(n)._meta?.["_claude/tasks"]?.tasks ?? []).some((t: { id: string }) => t.id === taskId),
  );

/** A session whose turn has started PARSER and TWIN in the foreground. */
async function twoChildren() {
  const c = await connect(RFD_CAPABILITIES);
  const s = await c.open();
  const response = s.prompt();
  s.push(assistant(s.sessionId, [agentToolUse(PARSER), agentToolUse(TWIN)]));
  s.push(agentStarted(s.sessionId, PARSER), agentStarted(s.sessionId, TWIN));
  await waitFor(
    () => taskInFeed(c.updates, PARSER.agentId) && taskInFeed(c.updates, TWIN.agentId),
    "both subagent tasks in the feed",
  );
  /** Ends the turn the way the SDK does once both children are done. */
  const finish = (parserStatus: "completed" | "stopped") => {
    s.push(agentEnded(s.sessionId, PARSER, parserStatus));
    s.push(toolResult(s.sessionId, PARSER.toolUseId, parserStatus));
    s.push(agentEnded(s.sessionId, TWIN));
    s.push(toolResult(s.sessionId, TWIN.toolUseId, "done"));
    s.endTurn();
  };
  return { c, s, response, finish };
}

/** Tracks whether a promise has settled, and with what. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  promise.then((value) => Object.assign(state, { settled: true, value }));
  return state;
}

describe("child sessions — cancel (R3.1, R3.2, R3.3)", () => {
  it("a cancel naming one child leaves its sibling and the parent's turn running", async () => {
    const { c, s, response, finish } = await twoChildren();
    expect(announcedChildren(c.updates, s.sessionId)).toEqual([PARSER.agentId, TWIN.agentId]);
    const interrupts = s.query.interrupts;

    await c.agent.cancel({ sessionId: PARSER.agentId });

    expect(s.query.script.stopTaskCalls).not.toContain(TWIN.agentId);
    expect(s.query.interrupts).toBe(interrupts);
    s.push(assistant(s.sessionId, [readToolUse("toolu_01TwinRead")], TWIN.toolUseId));
    s.push(toolResult(s.sessionId, "toolu_01TwinRead", "contents", TWIN.toolUseId));
    finish("stopped");
    expect((await response).stopReason).toBe("end_turn");

    const twinRead = toolCallNotifications(c.updates, "toolu_01TwinRead");
    expect(new Set(twinRead.map((n) => n.sessionId))).toEqual(new Set([TWIN.agentId]));
    expect(statesOf(c.updates, TWIN.agentId).map((st) => st.stopReason)).not.toContain("cancelled");
    expect(statesOf(c.updates, TWIN.agentId).at(-1)).toMatchObject({
      state: "idle",
      stopReason: "end_turn",
    });
  });

  it("a cancel naming a child stops that child's task and reports it idle and cancelled", async () => {
    const { c, s, response, finish } = await twoChildren();

    await c.agent.cancel({ sessionId: PARSER.agentId });

    expect(s.query.script.stopTaskCalls).toEqual([PARSER.agentId]);
    finish("stopped");
    await response;
    expect(statesOf(c.updates, PARSER.agentId).at(-1)).toMatchObject({
      state: "idle",
      stopReason: "cancelled",
    });
  });

  it("a cancel of a child answers the child's open permission request and leaves the parent's open", async () => {
    const { c, s, response, finish } = await twoChildren();
    const canUseTool = lastCaptured().options.canUseTool;
    s.push(
      assistant(
        s.sessionId,
        [{ type: "tool_use", id: "toolu_01ChildBash", name: "Bash", input: { command: "ls" } }],
        PARSER.toolUseId,
      ),
    );
    const childAsk = track(
      canUseTool(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "toolu_01ChildBash",
          agentID: PARSER.agentId,
        },
      ),
    );
    s.push(
      assistant(s.sessionId, [
        { type: "tool_use", id: "toolu_01ParentBash", name: "Bash", input: { command: "pwd" } },
      ]),
    );
    const parentAsk = track(
      canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          toolUseID: "toolu_01ParentBash",
        },
      ),
    );
    await waitFor(() => c.permissions.length === 2, "both permission requests");

    // The client answers neither request.
    await c.agent.cancel({ sessionId: PARSER.agentId });
    await tick(100);

    expect(parentAsk.settled).toBe(false);
    expect(childAsk.settled).toBe(true);
    expect((childAsk.value as { behavior?: string } | undefined)?.behavior).toBe("deny");

    const parentRequest = c.permissions.find(
      (p) => p.params.toolCall.toolCallId === "toolu_01ParentBash",
    )!;
    const allow = parentRequest.params.options.find((o) => o.kind.startsWith("allow"))!;
    parentRequest.answer({ outcome: { outcome: "selected", optionId: allow.optionId } });
    finish("stopped");
    await response;
  });

  it("a cancel naming the parent keeps its background subagent running", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    const response = s.prompt();
    s.push(assistant(s.sessionId, [agentToolUse(WATCHER)]));
    s.push(agentStarted(s.sessionId, WATCHER));
    s.push(toolResult(s.sessionId, WATCHER.toolUseId, "Async agent launched successfully."));
    await waitFor(() => taskInFeed(c.updates, WATCHER.agentId), "the background subagent task");
    expect(announcedChildren(c.updates, s.sessionId)).toEqual([WATCHER.agentId]);

    await c.agent.cancel({ sessionId: s.sessionId });
    s.endTurn();
    expect((await response).stopReason).toBe("cancelled");

    expect(s.query.script.stopTaskCalls).toEqual([]);
    expect(statesOf(c.updates, WATCHER.agentId).some((st) => st.state === "idle")).toBe(false);
    s.push(
      assistant(s.sessionId, [{ type: "text", text: "Build still running." }], WATCHER.toolUseId),
    );
    s.push(agentEnded(s.sessionId, WATCHER));
    await waitFor(
      () => statesOf(c.updates, WATCHER.agentId).some((st) => st.state === "idle"),
      "the background subagent's own end",
    ).catch(() => {});
    const text = c.updates.filter(
      (n) =>
        u(n).sessionUpdate === "agent_message_chunk" &&
        u(n).content?.text === "Build still running.",
    );
    expect(text.map((n) => n.sessionId)).toEqual([WATCHER.agentId]);
    expect(statesOf(c.updates, WATCHER.agentId).at(-1)).toMatchObject({
      state: "idle",
      stopReason: "end_turn",
    });
  });

  it("a stopTask that fails is answered with the error, keeps the child's state, and is logged with both ids", async () => {
    const { c, s, response, finish } = await twoChildren();
    s.query.script.stopTaskImpl = async () => {
      throw new Error("task not found");
    };

    await expect(c.agent.cancel({ sessionId: PARSER.agentId })).rejects.toThrow();

    expect(statesOf(c.updates, PARSER.agentId).some((st) => st.state === "idle")).toBe(false);
    expect(
      c.lines.some((line) => line.includes(PARSER.agentId) && line.includes(s.sessionId)),
    ).toBe(true);
    finish("completed");
    await response;
  });
});
