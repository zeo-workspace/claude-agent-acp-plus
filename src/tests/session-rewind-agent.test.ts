import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { FORK_AT_META_KEY, REWIND_CAPABILITY_KEY } from "../session-rewind.js";
import { mockSessionState } from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: vi.fn(() => {
      throw new Error("Unexpected real SDK call");
    }),
    getSessionMessages: vi.fn(async () => []),
    forkSession: vi.fn(async () => ({ sessionId: "forked-session" })),
  };
});

function row(type: "user" | "assistant", uuid: string, text: string) {
  return {
    type,
    uuid,
    parent_tool_use_id: null,
    message: { role: type, content: [{ type: "text", text }] },
  };
}

const transcript = [
  row("user", "p1", "first"),
  row("assistant", "a1", "one"),
  row("user", "p2", "second"),
  row("assistant", "a2", "two"),
];

function createAgent() {
  const client = { sessionUpdate: vi.fn(async () => {}) } as unknown as AcpClient;
  return new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
}

beforeEach(() => {
  vi.mocked(sdk.getSessionMessages).mockResolvedValue(transcript as any);
  vi.mocked(sdk.forkSession).mockClear();
});

describe("_claude/rewind", () => {
  it("is advertised in initialize", async () => {
    const agent = createAgent();
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(response.agentCapabilities?._meta?.[REWIND_CAPABILITY_KEY]).toEqual({ version: 1 });
  });

  it("restores files, copies the kept turns and answers the new session id", async () => {
    const agent = createAgent();
    const rewindFiles = vi.fn(async () => ({ canRewind: true }));
    agent.sessions["s1"] = mockSessionState({ query: { rewindFiles } }, undefined, "s1");

    const result = await agent.rewind({ sessionId: "s1", at: { turn: 1 }, restoreFiles: true });

    expect(result).toEqual({
      status: "rewound",
      sessionId: "forked-session",
      droppedTurns: 1,
      filesRestored: true,
    });
    expect(rewindFiles).toHaveBeenCalledWith("p2");
    expect(sdk.forkSession).toHaveBeenCalledWith("s1", { upToMessageId: "a1" });
    expect(agent.sessions["s1"].rewindInFlight).toBeFalsy();
  });

  it("answers busy while a turn is running, touching nothing", async () => {
    const agent = createAgent();
    const rewindFiles = vi.fn();
    agent.sessions["s1"] = mockSessionState(
      { query: { rewindFiles }, activeTurn: { settled: false } },
      undefined,
      "s1",
    );

    expect(await agent.rewind({ sessionId: "s1", at: { turn: 1 }, restoreFiles: true })).toEqual({
      status: "busy",
    });
    expect(rewindFiles).not.toHaveBeenCalled();
    expect(sdk.forkSession).not.toHaveBeenCalled();
  });

  it("refuses an unknown session", async () => {
    await expect(
      createAgent().rewind({ sessionId: "nope", at: { turn: 1 }, restoreFiles: false }),
    ).rejects.toThrow(/unknown session/);
  });
});

describe("session/fork with a cut point", () => {
  it("resumes a copy cut at the named turn", async () => {
    const agent = createAgent();
    agent.sessions["s1"] = mockSessionState({}, undefined, "s1");
    const createSession = vi
      .spyOn(agent as any, "createSession")
      .mockResolvedValue({ sessionId: "forked-session" });

    await agent.unstable_forkSession({
      sessionId: "s1",
      cwd: "/test",
      mcpServers: [],
      _meta: { [FORK_AT_META_KEY]: { turn: 1 } },
    });

    expect(sdk.forkSession).toHaveBeenCalledWith("s1", { upToMessageId: "a1" });
    expect(createSession).toHaveBeenCalledWith(expect.anything(), {
      resume: "forked-session",
      forkSession: false,
    });
  });

  it("keeps the full-copy fork without a cut point", async () => {
    const agent = createAgent();
    const createSession = vi
      .spyOn(agent as any, "createSession")
      .mockResolvedValue({ sessionId: "forked-session" });

    await agent.unstable_forkSession({ sessionId: "s1", cwd: "/test", mcpServers: [] });

    expect(sdk.forkSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(expect.anything(), {
      resume: "s1",
      forkSession: true,
    });
  });

  it("rejects a cursorId it did not issue with -32602 and copies nothing (#1655)", async () => {
    const agent = createAgent();
    const createSession = vi
      .spyOn(agent as any, "createSession")
      .mockResolvedValue({ sessionId: "forked-session" });

    await expect(
      agent.unstable_forkSession({ sessionId: "s1", cwd: "/test", mcpServers: [], cursorId: "c1" }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(createSession).not.toHaveBeenCalled();
    expect(sdk.forkSession).not.toHaveBeenCalled();
  });
});
