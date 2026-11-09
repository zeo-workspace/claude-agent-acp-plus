import { describe, expect, it } from "vitest";
import { toAcpNotifications, type AcpClient } from "../acp-agent.js";

// Upstream #1247: an advisor result settles its server tool call. Encrypted advice is never
// rendered; an error result fails the call.
describe("advisor_tool_result", () => {
  it.each([
    {
      content: { type: "advisor_result", text: "Check the queue ordering." },
      status: "completed",
      text: "Check the queue ordering.",
    },
    {
      content: { type: "advisor_redacted_result", encrypted_content: "opaque-advice" },
      status: "completed",
      text: "Advisor guidance applied server-side.",
    },
    {
      content: { type: "advisor_tool_result_error", error_code: "overloaded" },
      status: "failed",
      text: "Advisor error: overloaded",
    },
  ] as const)("settles the call for a $content.type result", ({ content, status, text }) => {
    const id = "srvtoolu_advisor";
    const toolUseCache = {};
    const logger = { log: () => {}, error: () => {} };
    toAcpNotifications(
      [{ type: "server_tool_use", id, name: "advisor", input: {} }] as any,
      "assistant",
      "test-session",
      toolUseCache,
      {} as AcpClient,
      logger,
    );
    const notifications = toAcpNotifications(
      [{ type: "advisor_tool_result", tool_use_id: id, content }] as any,
      "assistant",
      "test-session",
      toolUseCache,
      {} as AcpClient,
      logger,
    );

    const terminal = notifications.filter(
      (n) => n.update.sessionUpdate === "tool_call_update" && n.update.toolCallId === id,
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0].update).toMatchObject({ status });
    expect(JSON.stringify(terminal[0])).toContain(text);
    expect(JSON.stringify(notifications)).not.toContain("opaque-advice");
  });
});
