import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { EscalationRegistry } from "../classifier-escalation.js";
import { Pushable } from "../utils.js";
import { mockSessionState, wrapQuery } from "./session-doubles.js";

/**
 * Story 016, Task 4.2 (R1.3, R1.4, R1.5). The `permission_denied` frame handler
 * notes every frame in the session's EscalationRegistry; for a classifier
 * denial it sends no `failed` update itself (the escalation owns the outcome),
 * and for every other reason type it keeps today's update byte for byte.
 *
 * Kept in its own file so materialization never overwrites acp-agent.test.ts;
 * the helpers mirror that file's `describe("permission_denied")` block.
 */
type ToolCallUpdate = Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>;

async function run(messages: any[], escalations: any) {
  const updates: SessionNotification["update"][] = [];
  const client = {
    sessionUpdate: async (n: SessionNotification) => void updates.push(n.update),
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  const input = new Pushable<any>();
  async function* gen() {
    const { value, done } = await input[Symbol.asyncIterator]().next();
    if (!done && value) {
      yield {
        type: "user",
        message: value.message,
        parent_tool_use_id: null,
        uuid: value.uuid,
        session_id: "test-session",
        isReplay: true,
      };
    }
    yield* messages;
    yield {
      type: "result",
      subtype: "success",
      stop_reason: null,
      is_error: false,
      result: "",
      usage: {},
      uuid: randomUUID(),
      session_id: "test-session",
    };
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }
  agent.sessions["test-session"] = mockSessionState({
    query: wrapQuery(gen()),
    input,
    escalations,
  });
  await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });
  return updates;
}

function toolUse(id: string, parent: string | null = null) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "make deploy" } }],
      usage: {},
    },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: "test-session",
  };
}

function denial(id: string, extra: Record<string, any> = {}) {
  return {
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: id,
    decision_reason_type: "classifier",
    decision_reason: "Classifier: deploys to production",
    message: "Permission to use Bash has been denied.",
    uuid: randomUUID(),
    session_id: "test-session",
    ...extra,
  };
}

const failedFor = (updates: SessionNotification["update"][], id: string) =>
  updates.filter(
    (u): u is ToolCallUpdate =>
      u.sessionUpdate === "tool_call_update" && u.toolCallId === id && u.status === "failed",
  );

function registryDouble() {
  return {
    noteFrame: vi.fn(),
    awaitReasonType: vi.fn(async () => undefined),
    claim: vi.fn(),
    abandon: vi.fn(),
    resolve: vi.fn(),
    isEscalated: vi.fn(() => false),
  };
}

describe("permission_denied frame handler — classifier escalation", () => {
  // Hostile half first: a classifier branch that swallows every denial.
  it("still fails a non-classifier denial with today's update, next to a classifier one (R1.3)", async () => {
    const escalations = registryDouble();
    const updates = await run(
      [
        toolUse("toolu_rule"),
        denial("toolu_rule", {
          decision_reason_type: "rule",
          decision_reason: "deny Bash(make:*)",
        }),
        toolUse("toolu_cls"),
        denial("toolu_cls"),
      ],
      escalations,
    );
    const sent = failedFor(updates, "toolu_rule");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      content: [
        {
          type: "content",
          content: { type: "text", text: "Permission denied: deny Bash(make:*)" },
        },
      ],
    });
    expect((sent[0]!._meta as any).claudeCode).toMatchObject({
      toolName: "Bash",
      toolResponse: { decisionReasonType: "rule" },
    });
    expect(failedFor(updates, "toolu_cls")).toHaveLength(0);
  });

  it.each(["mode", "asyncAgent", "hook"])(
    "keeps today's failed update for %s denials",
    async (t) => {
      const updates = await run(
        [toolUse("toolu_x"), denial("toolu_x", { decision_reason_type: t })],
        registryDouble(),
      );
      expect(failedFor(updates, "toolu_x")).toHaveLength(1);
    },
  );

  it("sends no failed update for a classifier denial: the call stays pending (R1.5)", async () => {
    const updates = await run([toolUse("toolu_cls"), denial("toolu_cls")], registryDouble());
    expect(failedFor(updates, "toolu_cls")).toHaveLength(0);
    expect(
      updates.filter(
        (u) =>
          u.sessionUpdate === "tool_call_update" &&
          (u as ToolCallUpdate).toolCallId === "toolu_cls" &&
          JSON.stringify((u as ToolCallUpdate).content ?? "").includes("Permission denied"),
      ),
    ).toHaveLength(0);
  });

  it("notes every frame with its id, reason type and today's reason text", async () => {
    const escalations = registryDouble();
    await run(
      [
        toolUse("toolu_cls"),
        denial("toolu_cls"),
        toolUse("toolu_rule"),
        denial("toolu_rule", { decision_reason_type: "rule", decision_reason: undefined }),
      ],
      escalations,
    );
    const frames = escalations.noteFrame.mock.calls.map((c: any[]) => c[0]);
    expect(frames).toContainEqual(
      expect.objectContaining({
        toolUseId: "toolu_cls",
        reasonType: "classifier",
        reason: "Classifier: deploys to production",
      }),
    );
    // reason = decision_reason ?? message, exactly what today's update shows.
    expect(frames).toContainEqual(
      expect.objectContaining({
        toolUseId: "toolu_rule",
        reasonType: "rule",
        reason: "Permission to use Bash has been denied.",
      }),
    );
  });

  it("carries a subagent's agent_id to the registry (R1.4)", async () => {
    const escalations = registryDouble();
    await run(
      [
        {
          type: "system",
          subtype: "task_started",
          task_id: "agent-1",
          tool_use_id: "toolu_agent",
          subagent_type: "general-purpose",
          uuid: randomUUID(),
          session_id: "test-session",
        },
        toolUse("toolu_inner", "toolu_agent"),
        denial("toolu_inner", { agent_id: "agent-1" }),
      ],
      escalations,
    );
    expect(escalations.noteFrame).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: "toolu_inner", agentId: "agent-1" }),
    );
  });
});

describe("EscalationRegistry interface", () => {
  it("exposes the design's methods", () => {
    for (const method of [
      "noteFrame",
      "awaitReasonType",
      "claim",
      "abandon",
      "resolve",
      "isEscalated",
    ]) {
      expect(typeof (EscalationRegistry.prototype as any)[method]).toBe("function");
    }
  });
});
