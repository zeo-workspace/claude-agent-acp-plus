// Story 065, Tasks 2.1 and 2.2 — each Agent-tool subagent becomes a child
// session (R1.1, R1.2, R2.1–R2.5).
//
// Integration: the real `ClaudeAcpAgent` over a scripted SDK stream; the
// assertions read the ACP wire only (child-sessions-harness.ts).
//
// The child's id is a derived value — the SDK agent id, `task_started.task_id`
// (design.md, Data Models) — so the hostile cases come first: two subagents
// must never collapse into one child, one subagent must never split into two,
// and a third id on the same stream (the Agent call's tool use id, a shell's
// task id) must never be mistaken for a child.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  agentEnded,
  agentStarted,
  agentTextOn,
  agentToolUse,
  announcedChildren,
  announcement,
  assistant,
  kind,
  lastCaptured,
  type Launch,
  readToolUse,
  statesOf,
  subagentUpdates,
  tick,
  toolCallNotifications,
  toolResult,
  waitFor,
} from "./child-sessions-harness.js";
import {
  connect,
  disconnectAll,
  NESTED_CAPABILITIES,
  RFD_CAPABILITIES,
} from "./child-sessions-connection.js";
import { taskStarted } from "./task-feed-harness.js";

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
  prompt: "Find where the config parser lives and name its file.",
};
// Same role, same description: only the ids tell the two apart.
const TWIN: Launch = {
  ...PARSER,
  toolUseId: "toolu_01TwinLaunch",
  agentId: "b8e2d4f6a1c3e5d7",
  name: "parser-finder",
  prompt: "Find where the config parser lives and name its file.",
};

const u = (n: SessionNotification) => n.update as Record<string, any>;
/** True once a `_claude/tasks` snapshot carries the task: `task_started` was processed. */
const taskInFeed = (updates: SessionNotification[], taskId: string) =>
  updates.some((n) =>
    (u(n)._meta?.["_claude/tasks"]?.tasks ?? []).some((t: { id: string }) => t.id === taskId),
  );
const indexOf = (updates: SessionNotification[], pred: (n: SessionNotification) => boolean) =>
  updates.findIndex(pred);

/** Runs one turn on `s` that launches `launches` in one assistant message,
 *  lets `during` push the children's traffic, ends every child, and returns
 *  the prompt's response. */
async function launchTurn(
  s: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["open"]>>,
  launches: Launch[],
  during: () => void = () => {},
) {
  const response = s.prompt();
  s.push(assistant(s.sessionId, launches.map(agentToolUse)));
  for (const launch of launches) s.push(agentStarted(s.sessionId, launch));
  during();
  for (const launch of launches) {
    s.push(agentEnded(s.sessionId, launch));
    s.push(toolResult(s.sessionId, launch.toolUseId, `${launch.description}: done`));
  }
  s.endTurn();
  return response;
}

describe("child sessions — launch (R2.1, R2.2)", () => {
  it("announces two subagents with the same role and description as two children, each under its own agent id", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    const response = await launchTurn(s, [PARSER, TWIN]);
    expect(response.stopReason).toBe("end_turn");

    expect(announcedChildren(c.updates, s.sessionId)).toEqual([PARSER.agentId, TWIN.agentId]);
  });

  it("announces one subagent once, though its launch reaches the adapter as a tool call, a task and a stream", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER], () => {
      s.push(assistant(s.sessionId, [{ type: "text", text: "Looking." }], PARSER.toolUseId));
      s.push(assistant(s.sessionId, [readToolUse("toolu_01ChildRead")], PARSER.toolUseId));
      s.push(toolResult(s.sessionId, "toolu_01ChildRead", "contents", PARSER.toolUseId));
    });

    const titled = subagentUpdates(c.updates).filter(
      (n) => u(n).sessionId === PARSER.agentId && u(n).title !== undefined,
    );
    expect(titled).toHaveLength(1);
    expect(announcedChildren(c.updates, s.sessionId)).toEqual([PARSER.agentId]);
  });

  it("never announces the Agent call's tool use id, or a shell task's id, as a child", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER], () => {
      s.push(
        taskStarted(s.sessionId, "bsh7k2m9q", {
          tool_use_id: "toolu_01Shell",
          task_type: "local_bash",
          is_backgrounded: true,
        }),
      );
    });

    const children = announcedChildren(c.updates, s.sessionId);
    expect(children).not.toContain(PARSER.toolUseId);
    expect(children).not.toContain("bsh7k2m9q");
    expect(children).toEqual([PARSER.agentId]);
  });

  it("announces the child on the parent with title, description, a stop capability and running, before anything of the child", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER], () => {
      s.push(assistant(s.sessionId, [readToolUse("toolu_01ChildRead")], PARSER.toolUseId));
    });

    const first = announcement(c.updates, PARSER.agentId);
    expect(first?.sessionId).toBe(s.sessionId);
    const update = u(first!);
    expect(typeof update.title).toBe("string");
    expect(update.title.trim()).not.toBe("");
    // The short description of the Agent call, never its prompt.
    expect(update.description).toBe(PARSER.description);
    // SubagentSessionCapabilities.cancel: an object (`{}`) means supported.
    expect(update.capabilities?.cancel).toBeTypeOf("object");
    expect(update.capabilities?.cancel).not.toBeNull();
    expect(update.state).toEqual({ state: "running" });

    const announced = c.updates.indexOf(first!);
    const firstChildTraffic = indexOf(c.updates, (n) => n.sessionId === PARSER.agentId);
    expect(firstChildTraffic).toBeGreaterThan(announced);
  });

  it("sends the prompt as the parent's session_message to the child, after the announcement and before the child's traffic", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER], () => {
      s.push(assistant(s.sessionId, [readToolUse("toolu_01ChildRead")], PARSER.toolUseId));
    });

    const announced = c.updates.indexOf(announcement(c.updates, PARSER.agentId)!);
    const message = indexOf(
      c.updates,
      (n) =>
        n.sessionId === s.sessionId &&
        kind(n) === "session_message" &&
        u(n).recipientSessionId === PARSER.agentId,
    );
    expect(message).toBeGreaterThan(announced);
    expect(u(c.updates[message]!).content).toEqual([{ type: "text", text: PARSER.prompt }]);

    const childTool = indexOf(
      c.updates,
      (n) => n.sessionId === PARSER.agentId && kind(n) === "tool_call",
    );
    expect(childTool).toBeGreaterThan(message);
  });

  it("sends no session_message for a launch that carries no prompt", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    const silent: Launch = { ...PARSER, prompt: undefined };
    await launchTurn(s, [silent]);

    expect(announcedChildren(c.updates, s.sessionId)).toEqual([PARSER.agentId]);
    expect(
      c.updates.filter(
        (n) => kind(n) === "session_message" && u(n).recipientSessionId === PARSER.agentId,
      ),
    ).toEqual([]);
  });

  it("announces subagents in every session of the connection that asked (R1.1)", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const first = await c.open();
    await launchTurn(first, [PARSER]);
    const second = await c.open();
    await launchTurn(second, [TWIN]);

    expect(announcedChildren(c.updates, first.sessionId)).toEqual([PARSER.agentId]);
    expect(announcedChildren(c.updates, second.sessionId)).toEqual([TWIN.agentId]);
  });

  it("sends no subagent_update or session_message, and nests the child's work in the parent, for a client that did not ask (R1.2)", async () => {
    const c = await connect(NESTED_CAPABILITIES);
    const s = await c.open();
    const response = await launchTurn(s, [PARSER], () => {
      s.push(assistant(s.sessionId, [readToolUse("toolu_01ChildRead")], PARSER.toolUseId));
      s.push(toolResult(s.sessionId, "toolu_01ChildRead", "contents", PARSER.toolUseId));
    });
    expect(response.stopReason).toBe("end_turn");

    expect(
      c.updates.filter((n) => ["subagent_update", "session_message"].includes(kind(n))),
    ).toEqual([]);
    expect(c.updates.every((n) => n.sessionId === s.sessionId)).toBe(true);
    const childCall = toolCallNotifications(c.updates, "toolu_01ChildRead");
    expect(childCall.length).toBeGreaterThan(0);
    expect(u(childCall[0]!)._meta?.claudeCode?.parentToolUseId).toBe(PARSER.toolUseId);
  });
});

describe("child sessions — route (R2.3, R2.4, R2.5)", () => {
  it("keeps each child's tool call on its own child, never on its sibling or the parent", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER, TWIN], () => {
      s.push(assistant(s.sessionId, [readToolUse("toolu_01ParserRead")], PARSER.toolUseId));
      s.push(assistant(s.sessionId, [readToolUse("toolu_01TwinRead")], TWIN.toolUseId));
      s.push(toolResult(s.sessionId, "toolu_01ParserRead", "a", PARSER.toolUseId));
      s.push(toolResult(s.sessionId, "toolu_01TwinRead", "b", TWIN.toolUseId));
    });

    const parserCall = toolCallNotifications(c.updates, "toolu_01ParserRead");
    const twinCall = toolCallNotifications(c.updates, "toolu_01TwinRead");
    expect(parserCall.length).toBeGreaterThan(0);
    expect(twinCall.length).toBeGreaterThan(0);
    expect(new Set(parserCall.map((n) => n.sessionId))).toEqual(new Set([PARSER.agentId]));
    expect(new Set(twinCall.map((n) => n.sessionId))).toEqual(new Set([TWIN.agentId]));
  });

  it("sends a child's text on the child's session, not the parent's", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER], () => {
      s.push(
        assistant(
          s.sessionId,
          [{ type: "text", text: "The parser is config.rs." }],
          PARSER.toolUseId,
        ),
      );
    });

    expect(agentTextOn(c.updates, PARSER.agentId)).toContain("The parser is config.rs.");
    expect(agentTextOn(c.updates, s.sessionId)).not.toContain("The parser is config.rs.");
  });

  it("keeps a message whose parent_tool_use_id names no Agent call nested in the parent", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER], () => {
      s.push(assistant(s.sessionId, [readToolUse("toolu_01Stray")], "toolu_01NoSuchLaunch"));
    });

    const stray = toolCallNotifications(c.updates, "toolu_01Stray");
    expect(stray.length).toBeGreaterThan(0);
    expect(new Set(stray.map((n) => n.sessionId))).toEqual(new Set([s.sessionId]));
    expect(announcedChildren(c.updates, s.sessionId)).toEqual([PARSER.agentId]);
  });

  it("keeps the parent's Agent tool call and its result in the parent's transcript (R2.5)", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    await launchTurn(s, [PARSER]);

    const launchCall = toolCallNotifications(c.updates, PARSER.toolUseId);
    expect(announcedChildren(c.updates, s.sessionId)).toEqual([PARSER.agentId]);
    expect(launchCall.some((n) => kind(n) === "tool_call")).toBe(true);
    expect(new Set(launchCall.map((n) => n.sessionId))).toEqual(new Set([s.sessionId]));
    expect(launchCall.some((n) => u(n).status === "completed")).toBe(true);
  });

  it("sends a child's permission request on the child's session and a parent's on the parent's", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    const response = s.prompt();
    s.push(assistant(s.sessionId, [agentToolUse(PARSER)]));
    s.push(agentStarted(s.sessionId, PARSER));
    await waitFor(() => taskInFeed(c.updates, PARSER.agentId), "the subagent task in the feed");

    const canUseTool = lastCaptured().options.canUseTool;
    s.push(
      assistant(
        s.sessionId,
        [{ type: "tool_use", id: "toolu_01ChildBash", name: "Bash", input: { command: "ls" } }],
        PARSER.toolUseId,
      ),
    );
    const childAsk = canUseTool(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_01ChildBash",
        agentID: PARSER.agentId,
      },
    );
    s.push(
      assistant(s.sessionId, [
        { type: "tool_use", id: "toolu_01ParentBash", name: "Bash", input: { command: "pwd" } },
      ]),
    );
    const parentAsk = canUseTool(
      "Bash",
      { command: "pwd" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_01ParentBash",
      },
    );
    await waitFor(() => c.permissions.length === 2, "both permission requests");

    const byTool = (id: string) => c.permissions.find((p) => p.params.toolCall.toolCallId === id)!;
    expect(byTool("toolu_01ChildBash").params.sessionId).toBe(PARSER.agentId);
    expect(byTool("toolu_01ParentBash").params.sessionId).toBe(s.sessionId);

    for (const p of c.permissions) {
      const allow = p.params.options.find((o) => o.kind.startsWith("allow"))!;
      p.answer({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    await Promise.all([childAsk, parentAsk]);
    s.push(agentEnded(s.sessionId, PARSER));
    s.push(toolResult(s.sessionId, PARSER.toolUseId, "done"));
    s.endTurn();
    await response;
  });

  it("reports requires_action while a child's request is open, running once it is answered, then idle with end_turn", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    const response = s.prompt();
    s.push(assistant(s.sessionId, [agentToolUse(PARSER)]));
    s.push(agentStarted(s.sessionId, PARSER));
    await waitFor(() => taskInFeed(c.updates, PARSER.agentId), "the subagent task in the feed");

    s.push(
      assistant(
        s.sessionId,
        [{ type: "tool_use", id: "toolu_01ChildBash", name: "Bash", input: { command: "ls" } }],
        PARSER.toolUseId,
      ),
    );
    const ask = lastCaptured().options.canUseTool(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_01ChildBash",
        agentID: PARSER.agentId,
      },
    );
    await waitFor(() => c.permissions.length === 1, "the child's permission request");
    await tick();
    expect(statesOf(c.updates, PARSER.agentId).map((st) => st.state)).toContain("requires_action");

    const p = c.permissions[0]!;
    const allow = p.params.options.find((o) => o.kind.startsWith("allow"))!;
    p.answer({ outcome: { outcome: "selected", optionId: allow.optionId } });
    await ask;
    s.push(agentEnded(s.sessionId, PARSER));
    s.push(toolResult(s.sessionId, PARSER.toolUseId, "done"));
    s.endTurn();
    await response;

    const states = statesOf(c.updates, PARSER.agentId).map((st) => st.state);
    const asked = states.indexOf("requires_action");
    expect(states.slice(asked + 1)).toContain("running");
    expect(statesOf(c.updates, PARSER.agentId).at(-1)).toMatchObject({
      state: "idle",
      stopReason: "end_turn",
    });
  });

  it("reports a failed child as idle with an error stop reason, not end_turn", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    const response = s.prompt();
    s.push(assistant(s.sessionId, [agentToolUse(PARSER)]));
    s.push(agentStarted(s.sessionId, PARSER));
    s.push(agentEnded(s.sessionId, PARSER, "failed"));
    s.push(toolResult(s.sessionId, PARSER.toolUseId, "failed"));
    s.endTurn();
    await response;

    expect(statesOf(c.updates, PARSER.agentId).at(-1)).toMatchObject({
      state: "idle",
      stopReason: "error",
    });
  });
});
