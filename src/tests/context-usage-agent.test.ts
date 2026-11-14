import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { CONTEXT_USAGE_CAPABILITY_KEY } from "../context-usage.js";
import { mockSessionState } from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: vi.fn(() => {
      throw new Error("Unexpected real SDK call");
    }),
  };
});

const usage = {
  categories: [{ id: "messages", name: "Messages", tokens: 10, color: "red", kind: "used" }],
  totalTokens: 10,
  maxTokens: 200000,
  percentage: 0,
  model: "m",
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
};

function createAgent() {
  const client = { sessionUpdate: vi.fn(async () => {}) } as unknown as AcpClient;
  return new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
}

describe("_claude/context/usage", () => {
  it("is advertised in initialize", async () => {
    const response = await createAgent().initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(response.agentCapabilities?._meta?.[CONTEXT_USAGE_CAPABILITY_KEY]).toEqual({
      version: 1,
    });
  });

  it("asks for the full breakdown on an idle session", async () => {
    const agent = createAgent();
    const getContextUsage = vi.fn(async () => usage);
    agent.sessions["s1"] = mockSessionState({ query: { getContextUsage } }, undefined, "s1");

    const report = await agent.contextUsage({ sessionId: "s1" });

    expect(getContextUsage).toHaveBeenCalledWith({ detail: "full" });
    expect(report).toMatchObject({ status: "ok", detail: "full", totalTokens: 10 });
  });

  it("asks only for the local estimate while a turn runs", async () => {
    // A full breakdown makes token-count calls, and SDK control requests are
    // serialized: an interrupt queued behind it would delay the Stop button.
    const agent = createAgent();
    const getContextUsage = vi.fn(async () => usage);
    agent.sessions["s1"] = mockSessionState(
      { query: { getContextUsage }, activeTurn: { settled: false } },
      undefined,
      "s1",
    );

    const report = await agent.contextUsage({ sessionId: "s1" });

    expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    expect(report).toMatchObject({ status: "ok", detail: "summary" });
  });

  it("answers unavailable for an ended session", async () => {
    const agent = createAgent();
    const getContextUsage = vi.fn();
    agent.sessions["s1"] = mockSessionState(
      { query: { getContextUsage }, queryClosed: true },
      undefined,
      "s1",
    );

    expect((await agent.contextUsage({ sessionId: "s1" })).status).toBe("unavailable");
    expect(getContextUsage).not.toHaveBeenCalled();
  });

  it("refuses an unknown session", async () => {
    await expect(createAgent().contextUsage({ sessionId: "nope" })).rejects.toThrow(
      /unknown session/,
    );
  });
});
