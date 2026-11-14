import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { BTW_CAPABILITY_KEY } from "../side-question.js";
import { mockSessionState } from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const refused = () => {
    throw new Error("Unexpected real SDK call");
  };
  return {
    ...actual,
    query: vi.fn(refused),
    getSessionMessages: vi.fn(async () => []),
    forkSession: vi.fn(refused),
  };
});

function createAgent() {
  const sessionUpdate = vi.fn(async () => {});
  const client = { sessionUpdate } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  return { agent, sessionUpdate };
}

function chunkTexts(sessionUpdate: ReturnType<typeof vi.fn>): string[] {
  return sessionUpdate.mock.calls
    .map((call: any[]) => call[0].update)
    .filter((update: any) => update.sessionUpdate === "agent_message_chunk")
    .map((update: any) => update.content.text);
}

describe("_claude/btw", () => {
  it("is advertised in initialize", async () => {
    const { agent } = createAgent();
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(response.agentCapabilities?._meta?.[BTW_CAPABILITY_KEY]).toEqual({ version: 1 });
  });

  it("answers through the session's query without enqueueing a turn", async () => {
    const { agent, sessionUpdate } = createAgent();
    const askSideQuestion = vi.fn(async () => ({ response: "It parses.", synthetic: false }));
    const session = mockSessionState({ query: { askSideQuestion } });
    agent.sessions["test-session"] = session;

    const result = await agent.sideQuestion({ sessionId: "test-session", question: "what?" });

    expect(result).toEqual({ status: "answered", answer: "It parses.", synthetic: false });
    expect(askSideQuestion).toHaveBeenCalledWith("what?", { signal: undefined });
    expect(session.turnQueue ?? []).toHaveLength(0);
    expect(session.activeTurn ?? null).toBeNull();
    // The ext method answers the caller only; nothing reaches the thread.
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("answers while a turn is running", async () => {
    const { agent } = createAgent();
    const askSideQuestion = vi.fn(async () => ({ response: "yes", synthetic: false }));
    const activeTurn = { settled: false };
    const session = mockSessionState({ query: { askSideQuestion }, activeTurn });
    agent.sessions["test-session"] = session;

    const result = await agent.sideQuestion({ sessionId: "test-session", question: "still ok?" });

    expect(result.status).toBe("answered");
    expect(session.activeTurn).toBe(activeTurn);
  });

  it("refuses an unknown session", async () => {
    const { agent } = createAgent();
    await expect(agent.sideQuestion({ sessionId: "nope", question: "q" })).rejects.toThrow(
      /unknown session/,
    );
  });

  it("answers failed for an ended session, without calling the query", async () => {
    const { agent } = createAgent();
    const askSideQuestion = vi.fn();
    agent.sessions["test-session"] = mockSessionState({
      query: { askSideQuestion },
      queryClosed: true,
    });

    const result = await agent.sideQuestion({ sessionId: "test-session", question: "q" });

    expect(result.status).toBe("failed");
    expect(askSideQuestion).not.toHaveBeenCalled();
  });
});

describe("/btw typed into the composer", () => {
  it("answers as an aside and ends the prompt without a turn", async () => {
    const { agent, sessionUpdate } = createAgent();
    const askSideQuestion = vi.fn(async () => ({ response: "It parses.", synthetic: false }));
    const session = mockSessionState({ query: { askSideQuestion } });
    agent.sessions["test-session"] = session;

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/btw what does foo do?" }],
    });

    expect(response).toEqual({ stopReason: "end_turn" });
    expect(askSideQuestion).toHaveBeenCalledWith("what does foo do?", { signal: undefined });
    expect(chunkTexts(sessionUpdate)).toEqual([
      "**By the way** (not added to the conversation)\n\nIt parses.",
    ]);
    expect(session.turnQueue ?? []).toHaveLength(0);
  });

  it("explains its usage for a bare /btw", async () => {
    const { agent, sessionUpdate } = createAgent();
    const askSideQuestion = vi.fn();
    agent.sessions["test-session"] = mockSessionState({ query: { askSideQuestion } });

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/btw" }] });

    expect(askSideQuestion).not.toHaveBeenCalled();
    expect(chunkTexts(sessionUpdate)[0]).toMatch(/^Usage: `\/btw <question>`/);
  });
});
