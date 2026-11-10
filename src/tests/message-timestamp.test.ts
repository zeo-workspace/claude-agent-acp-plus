// Zeo next proposal §6.4 (ask 24): message times. Every user and agent message chunk carries
// `_meta.claudeCode.timestamp`, an ISO 8601 string, so a client can show when a message was sent
// and how long a turn took. Live, it is the time plus sends the chunk; on replay, the time the
// transcript recorded (SDK getSessionMessages returns `timestamp` at runtime, undeclared in its
// SessionMessage type). A chunk that already carries one keeps it.
import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAcpAgent,
  stampMessageTime,
  toAcpNotifications,
  type AcpClient,
} from "../acp-agent.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, getSessionMessages: vi.fn(actual.getSessionMessages) };
});

const SENT = "2026-11-10T09:15:00.000Z";
const LATER = "2026-11-10T09:16:30.000Z";

function timestampOf(update: SessionNotification["update"]): unknown {
  return (update as { _meta?: { claudeCode?: { timestamp?: unknown } } })._meta?.claudeCode
    ?.timestamp;
}

describe("message timestamps (§6.4)", () => {
  it("toAcpNotifications stamps the given time on an agent message chunk", () => {
    const [notification] = toAcpNotifications(
      "Done.",
      "assistant",
      "s1",
      {},
      {} as AcpClient,
      console,
      { timestamp: SENT },
    );

    expect(notification?.update.sessionUpdate).toBe("agent_message_chunk");
    expect(timestampOf(notification!.update)).toBe(SENT);
  });

  it("toAcpNotifications stamps a user message chunk too", () => {
    const [notification] = toAcpNotifications(
      "Fix the build",
      "user",
      "s1",
      {},
      {} as AcpClient,
      console,
      { timestamp: SENT },
    );

    expect(notification?.update.sessionUpdate).toBe("user_message_chunk");
    expect(timestampOf(notification!.update)).toBe(SENT);
  });

  it("stampMessageTime keeps the time a chunk already carries, and its other meta", () => {
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
      _meta: { claudeCode: { parentToolUseId: "toolu_1", timestamp: SENT } },
    } as SessionNotification["update"];

    stampMessageTime(update, LATER);

    expect(timestampOf(update)).toBe(SENT);
    expect(
      (update as unknown as { _meta: { claudeCode: { parentToolUseId: string } } })._meta.claudeCode
        .parentToolUseId,
    ).toBe("toolu_1");
  });

  it("stampMessageTime leaves updates that are not message chunks alone", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_1",
      title: "Read",
    } as SessionNotification["update"];

    stampMessageTime(update, LATER);

    expect(timestampOf(update)).toBeUndefined();
  });

  it("replay carries the transcript's time on each message", async () => {
    const updates: SessionNotification[] = [];
    const client = {
      sessionUpdate: async (u: SessionNotification) => {
        updates.push(u);
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });

    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: "user",
        uuid: "u1",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: SENT,
        message: { role: "user", content: [{ type: "text", text: "Fix the build" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: LATER,
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "Fixed." }],
        },
      },
    ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);

    await (
      agent as unknown as { replaySessionHistory(sessionId: string): Promise<void> }
    ).replaySessionHistory("s1");

    const user = updates.find((u) => u.update.sessionUpdate === "user_message_chunk");
    const reply = updates.find((u) => u.update.sessionUpdate === "agent_message_chunk");
    expect(user && timestampOf(user.update)).toBe(SENT);
    expect(reply && timestampOf(reply.update)).toBe(LATER);
  });
});
