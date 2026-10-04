// Tests for the progress-summaries opt-in (story 012, R3.1, R3.2).
//
// `CLAUDE_ACP_PROGRESS_SUMMARIES` decides whether sessions start with the SDK's
// `agentProgressSummaries` option: "1" or "true" turn it on, anything else
// leaves it off. An explicit `_meta.claudeCode.options.agentProgressSummaries`
// still wins over the environment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

let capturedOptions: Options | undefined;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Options }) => {
      capturedOptions = args.options;
      return makeMockQuery({
        initializationResult: async () => ({
          models: [
            { value: "claude-sonnet-4-6", displayName: "Sonnet", description: "d", supportsAutoMode: true },
          ],
        }),
      });
    },
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return { ...actual, registerHookCallback: vi.fn() };
});

describe("progress summaries opt-in", () => {
  let acp: typeof import("../acp-agent.js");
  let agent: ClaudeAcpAgentType;

  beforeEach(async () => {
    capturedOptions = undefined;
    vi.resetModules();
    acp = await import("../acp-agent.js");
    agent = new acp.ClaudeAcpAgent({
      sessionUpdate: async () => {},
    } as unknown as AcpClient);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function optionsWith(env: string | undefined, meta?: Record<string, unknown>) {
    if (env === undefined) {
      vi.stubEnv("CLAUDE_ACP_PROGRESS_SUMMARIES", undefined as unknown as string);
      delete process.env.CLAUDE_ACP_PROGRESS_SUMMARIES;
    } else {
      vi.stubEnv("CLAUDE_ACP_PROGRESS_SUMMARIES", env);
    }
    await agent.newSession({ cwd: process.cwd(), mcpServers: [], ...(meta ? { _meta: meta } : {}) });
    return capturedOptions!;
  }

  it("starts sessions without progress summaries when the variable is unset (R3.1)", async () => {
    expect((await optionsWith(undefined)).agentProgressSummaries).toBeFalsy();
  });

  it("starts sessions with progress summaries on for \"1\" (R3.2)", async () => {
    expect((await optionsWith("1")).agentProgressSummaries).toBe(true);
  });

  it("starts sessions with progress summaries on for \"true\" (R3.2)", async () => {
    expect((await optionsWith("true")).agentProgressSummaries).toBe(true);
  });

  it.each(["0", "false", "", "yes", "on", "2", " 1x"])(
    "leaves progress summaries off for %j (R3.1)",
    async (value) => {
      expect((await optionsWith(value)).agentProgressSummaries).toBeFalsy();
    },
  );

  it("lets an explicit client option turn summaries off even when the variable is on", async () => {
    const options = await optionsWith("1", {
      claudeCode: { options: { agentProgressSummaries: false } },
    });
    expect(options.agentProgressSummaries).toBe(false);
  });

  it("lets an explicit client option turn summaries on when the variable is unset", async () => {
    const options = await optionsWith(undefined, {
      claudeCode: { options: { agentProgressSummaries: true } },
    });
    expect(options.agentProgressSummaries).toBe(true);
  });

  it("exposes the parsed switch as progressSummariesEnabled()", () => {
    vi.stubEnv("CLAUDE_ACP_PROGRESS_SUMMARIES", "true");
    expect(acp.progressSummariesEnabled()).toBe(true);
    vi.stubEnv("CLAUDE_ACP_PROGRESS_SUMMARIES", "0");
    expect(acp.progressSummariesEnabled()).toBe(false);
  });
});
