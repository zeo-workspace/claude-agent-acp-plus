// Story 065, Task 2 tech review (round 1): the routing cases the launch/route
// suite does not reach through the scripted stream — updates the conversion
// never stamps, nested subagents, a resumed subagent, and a tool call that
// went out before its launch was known.

import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { ChildSessionRouter, type ChildLaunch } from "../child-sessions.js";

const PARENT = "parent-session";

function router() {
  const sent: SessionNotification[] = [];
  const lines: string[] = [];
  const r = new ChildSessionRouter(
    async (n) => {
      sent.push(n);
    },
    (line) => lines.push(line),
  );
  return { r, sent, lines };
}

const launch = (over: Partial<ChildLaunch> = {}): ChildLaunch => ({
  parentSessionId: PARENT,
  toolUseId: "toolu_launch",
  agentId: "agent-a",
  title: "parser-finder",
  description: "Find the parser",
  prompt: "Find it.",
  cancellable: true,
  ...over,
});

const toolCall = (toolCallId: string, parentToolUseId?: string): SessionNotification => ({
  sessionId: PARENT,
  update: {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Read",
    ...(parentToolUseId ? { _meta: { claudeCode: { parentToolUseId } } } : {}),
  },
});

const progress = (toolCallId: string): SessionNotification => ({
  sessionId: PARENT,
  update: { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" },
});

const u = (n: SessionNotification) => n.update as Record<string, any>;

describe("ChildSessionRouter", () => {
  it("sends an unstamped update of a child's tool call (a progress beat, an edit diff) to that child", async () => {
    const { r } = router();
    await r.launch(launch());
    expect(r.route(toolCall("toolu_read", "toolu_launch")).sessionId).toBe("agent-a");
    expect(r.route(progress("toolu_read")).sessionId).toBe("agent-a");
  });

  it("keeps a tool call nested once it went out before its launch was known", async () => {
    const { r, lines } = router();
    expect(r.route(toolCall("toolu_early", "toolu_launch")).sessionId).toBe(PARENT);
    expect(lines.some((l) => l.includes("reason=unknown_launch"))).toBe(true);
    await r.launch(launch());
    const earlyUpdate: SessionNotification = {
      sessionId: PARENT,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_early",
        status: "in_progress",
        _meta: { claudeCode: { parentToolUseId: "toolu_launch" } },
      },
    };
    expect(r.route(earlyUpdate).sessionId).toBe(PARENT);
    // A new call of the same child is routed.
    expect(r.route(toolCall("toolu_late", "toolu_launch")).sessionId).toBe("agent-a");
  });

  it("keeps an unstamped tool call that beat its launch on the parent, with its later stamped updates", async () => {
    const { r } = router();
    expect(r.route(toolCall("toolu_raced")).sessionId).toBe(PARENT);
    await r.launch(launch());
    const stamped: SessionNotification = {
      sessionId: PARENT,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_raced",
        status: "in_progress",
        _meta: { claudeCode: { parentToolUseId: "toolu_launch" } },
      },
    };
    expect(r.route(stamped).sessionId).toBe(PARENT);
  });

  it("still sends an unstamped update of a child's tool call to the child after the child settled", async () => {
    const { r } = router();
    await r.launch(launch());
    r.route(toolCall("toolu_read", "toolu_launch"));
    await r.settle("agent-a", "end_turn");
    expect(r.route(progress("toolu_read")).sessionId).toBe("agent-a");
  });

  it("leaves an update without a stamp or a known tool call on its session", async () => {
    const { r } = router();
    await r.launch(launch());
    expect(r.route(progress("toolu_parent_own")).sessionId).toBe(PARENT);
    const onChild = { ...progress("toolu_read"), sessionId: "agent-a" };
    expect(r.route(onChild)).toBe(onChild);
  });

  it("announces a nested subagent on the child that launched it, and routes its stream by its own launch", async () => {
    const { r, sent } = router();
    await r.launch(launch());
    await r.launch(
      launch({ agentId: "agent-b", toolUseId: "toolu_nested", launcherTaskId: "agent-a" }),
    );
    const nested = sent.filter(
      (n) => u(n).sessionId === "agent-b" || u(n).recipientSessionId === "agent-b",
    );
    expect(nested.map((n) => n.sessionId)).toEqual(["agent-a", "agent-a"]);
    expect(u(nested[1]!).senderSessionId).toBe("agent-a");
    expect(r.route(toolCall("toolu_b_read", "toolu_nested")).sessionId).toBe("agent-b");
    await r.settle("agent-b", "end_turn");
    expect(sent.at(-1)?.sessionId).toBe("agent-a");
  });

  it("routes a resumed subagent's new run to the same child and sends that run's prompt as a new message", async () => {
    const { r, sent } = router();
    await r.launch(launch());
    await r.settle("agent-a", "end_turn");
    await r.launch(launch({ toolUseId: "toolu_resume", prompt: "Now fix it." }));

    expect(r.route(toolCall("toolu_fix", "toolu_resume")).sessionId).toBe("agent-a");
    const prompts = sent.filter((n) => u(n).sessionUpdate === "session_message");
    expect(prompts.map((n) => u(n).content[0].text)).toEqual(["Find it.", "Now fix it."]);
    expect(new Set(prompts.map((n) => u(n).messageId)).size).toBe(2);
    const titled = sent.filter((n) => u(n).sessionUpdate === "subagent_update" && u(n).title);
    expect(titled).toHaveLength(1);
    expect(u(sent.filter((n) => u(n).sessionUpdate === "subagent_update").at(-1)!).state).toEqual({
      state: "running",
    });
  });

  it("does not advertise cancel for a subagent the SDK cannot stop", async () => {
    const { r, sent } = router();
    await r.launch(launch({ cancellable: false }));
    expect(u(sent[0]!).capabilities).toBeUndefined();
  });
});
