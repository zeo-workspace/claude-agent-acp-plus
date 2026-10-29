import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpClient } from "../acp-agent.js";
import { resumedModelFromTranscript } from "../resumed-session.js";

/** The SDK double for the changed-resume tests below: every `query()` call is
 *  recorded, and a resume's initialization fails with `resumeFailure`. */
const sdkDouble = vi.hoisted(() => ({
  calls: [] as Array<{ options: import("@anthropic-ai/claude-agent-sdk").Options }>,
  resumeFailure: undefined as Error | undefined,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: (args: { prompt: AsyncIterable<any>; options: Options }) => {
      sdkDouble.calls.push({ options: args.options });
      const failure = args.options.resume !== undefined ? sdkDouble.resumeFailure : undefined;
      return makeMockQuery({
        initializationResult: async () => {
          if (failure) throw failure;
          return {
            models: [
              {
                value: "claude-opus-4-8",
                displayName: "Claude Opus",
                description: "Most capable",
              },
            ],
          };
        },
        applyFlagSettings: async () => {},
        setPermissionMode: async () => {},
      });
    },
  };
});

function assistant(
  model: unknown,
  nesting: Pick<SessionMessage, "parent_tool_use_id" | "parent_agent_id"> = {
    parent_tool_use_id: null,
    parent_agent_id: null,
  },
): SessionMessage {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    session_id: "session-id",
    ...nesting,
    message: { model },
  };
}

describe("resumedModelFromTranscript", () => {
  it("returns the last real assistant model", () => {
    expect(
      resumedModelFromTranscript([assistant("claude-sonnet-5"), assistant("claude-opus-5")]),
    ).toBe("claude-opus-5");
  });

  it("skips synthetic assistant records after the real response", () => {
    expect(resumedModelFromTranscript([assistant("claude-opus-5"), assistant("<synthetic>")])).toBe(
      "claude-opus-5",
    );
  });

  it("skips nested assistant records that can use a different model", () => {
    expect(
      resumedModelFromTranscript([
        assistant("claude-opus-5"),
        assistant("claude-haiku-4-5", {
          parent_tool_use_id: "task-tool-use",
          parent_agent_id: null,
        }),
      ]),
    ).toBe("claude-opus-5");
  });

  it("returns undefined when the transcript has no real assistant model", () => {
    expect(resumedModelFromTranscript([assistant("<synthetic>")])).toBeUndefined();
  });
});

// Story 062, R3 (upstream 0c8de13, #1353): a session/resume or session/load
// that changes a live session's fingerprint tears its query down and resumes.
// Claude Code writes the conversation only at the first prompt, so a session
// never prompted has nothing to resume, and the client lost a session it had
// a moment before. Observed through the ACP surface and the options `query()`
// is called with.
describe("a changed resume of a live session never prompted", () => {
  const calls = sdkDouble.calls;

  let ClaudeAcpAgent: typeof import("../acp-agent.js").ClaudeAcpAgent;
  let configDir: string;
  let cwdA: string;
  let cwdB: string;
  let savedConfigDir: string | undefined;

  beforeAll(async () => {
    await import("../acp-agent.js");
  }, 30_000);

  beforeEach(async () => {
    calls.length = 0;
    sdkDouble.resumeFailure = undefined;
    configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "changed-resume-"));
    cwdA = path.join(configDir, "a");
    cwdB = path.join(configDir, "b");
    await fs.promises.mkdir(cwdA, { recursive: true });
    await fs.promises.mkdir(cwdB, { recursive: true });
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    vi.resetModules();
    ({ ClaudeAcpAgent } = await import("../acp-agent.js"));
  });

  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    await fs.promises.rm(configDir, { recursive: true, force: true });
  });

  function startAgent() {
    return new ClaudeAcpAgent(
      {
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );
  }

  it("starts a fresh query under the same public id, keeping the mode (R3.1)", async () => {
    const agent = startAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await agent.newSession({ cwd: cwdA, mcpServers: [] });
    await agent.setSessionMode({ sessionId, modeId: "plan" });
    sdkDouble.resumeFailure = new Error(`No conversation found with session ID: ${sessionId}`);

    const response = await agent.loadSession({ sessionId, cwd: cwdB, mcpServers: [] });

    expect(response.modes?.currentModeId).toBe("plan");
    const last = calls.at(-1)!.options;
    expect(last.resume).toBeUndefined();
    expect(last.sessionId).toBe(sessionId);
    expect(last.cwd).toBe(cwdB);
    expect(agent.sessions[sessionId]).toBeDefined();
  });

  it("returns any other resume error, with no fresh query (R3.2)", async () => {
    const agent = startAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await agent.newSession({ cwd: cwdA, mcpServers: [] });
    sdkDouble.resumeFailure = new Error("spawn claude ENOENT");
    const before = calls.length;

    await expect(agent.loadSession({ sessionId, cwd: cwdB, mcpServers: [] })).rejects.toThrow(
      "spawn claude ENOENT",
    );
    const after = calls.slice(before);
    expect(after.map((c) => c.options.resume)).toEqual([sessionId]);
  });

  // Hostile half of R3.1: an id that is not live here is really unknown, and a
  // fresh query would invent a session the client never had.
  it("still fails for a session that is not live here (R3.2)", async () => {
    const agent = startAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const sessionId = "6f0c5f0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    sdkDouble.resumeFailure = new Error(`No conversation found with session ID: ${sessionId}`);

    await expect(agent.loadSession({ sessionId, cwd: cwdB, mcpServers: [] })).rejects.toThrow();
    expect(calls.map((c) => c.options.resume)).toEqual([sessionId]);
    expect(agent.sessions[sessionId]).toBeUndefined();
  });
});
