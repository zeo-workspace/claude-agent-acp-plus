import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * Port of upstream #1153's "the SDK session id of a fresh Claude context".
 *
 * After a clear-context restart (the "clear context" option on every plan
 * approval) the new SDK query runs under a random id, not the ACP one
 * (`publicSessionId ? randomUUID() : sessionId`). The consumer loop used to
 * forward `message.session_id` as the ACP `sessionId`, so usage, compaction,
 * tool progress, notices and background-task updates went to a session Zed
 * does not know — it logs "unknown session" and drops them for the rest of the
 * session. Before the fix this test saw four updates on the wrong session.
 */
describe("the SDK session id of a fresh Claude context", () => {
  it("sends every update to the ACP session", async () => {
    const updates: SessionNotification[] = [];
    const agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (n: SessionNotification) => {
          updates.push(n);
        },
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );
    const sdkSessionId = "sdk-session-after-clear";
    const input = new Pushable<any>();
    async function* messages() {
      const { value } = await input[Symbol.asyncIterator]().next();
      yield { ...userEcho(value), session_id: sdkSessionId };
      yield {
        type: "tool_progress",
        tool_use_id: "toolu_slow",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 3,
        uuid: randomUUID(),
        session_id: sdkSessionId,
      };
      yield {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", resetsAt: 1700000000, utilization: 0.9 },
        uuid: randomUUID(),
        session_id: sdkSessionId,
      };
      yield {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 1000, post_tokens: 100 },
        uuid: randomUUID(),
        session_id: sdkSessionId,
      };
      yield {
        type: "system",
        subtype: "local_command_output",
        content: "Local output",
        uuid: randomUUID(),
        session_id: sdkSessionId,
      };
      yield successfulResultMessage({ session_id: sdkSessionId });
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messages()),
      input,
      emittedToolCalls: new Set(["toolu_slow"]),
    } as any);
    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "go" }] });
    const wrong = updates
      .filter((u) => u.sessionId !== "test-session")
      .map((u) => `${u.sessionId}:${u.update.sessionUpdate}`);
    expect(wrong).toEqual([]);
  });
});
