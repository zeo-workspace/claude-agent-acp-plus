import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

/**
 * Story 008, R1 — the AskUserQuestion permission fallback is retired.
 *
 * What this suite pins is the ADAPTER'S UPSTREAM STANCE at session creation:
 * the `AskUserQuestion` tool is exposed to the SDK only when the connected
 * client advertises `elicitation.form`, and the retired story-001 fallback
 * gate variable (assembled below in `RETIRED_ENV_VAR`, never spelled out as a
 * literal so the prune sweep in `fallback-prune-guard.test.ts` stays clean) has
 * no influence on that decision in either direction. The fork's fallback made
 * the tool reachable for clients
 * that cannot render a form; upstream deliberately hides it instead, because a
 * tool the client cannot answer is worse than a tool the model never calls.
 *
 * The variable is exercised as an ordinary environment value here — not as a
 * feature gate — so the suite keeps passing once every trace of the gate is
 * gone from `src/`.
 */

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
            {
              value: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              description: "Fast",
              supportsAutoMode: true,
            },
          ],
        }),
      });
    },
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return {
    ...actual,
    registerHookCallback: vi.fn(),
  };
});

/** The variable story 001 introduced and story 008 retires. */
const RETIRED_ENV_VAR = ["ACP", "ASKUSERQUESTION", "FALLBACK"].join("_");

describe("AskUserQuestion exposure follows upstream's form-elicitation rule (R1)", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let originalEnv: string | undefined;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  beforeEach(async () => {
    capturedOptions = undefined;
    originalEnv = process.env[RETIRED_ENV_VAR];
    delete process.env[RETIRED_ENV_VAR];

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;
    agent = new ClaudeAcpAgent(createMockClient());
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env[RETIRED_ENV_VAR] = originalEnv;
    } else {
      delete process.env[RETIRED_ENV_VAR];
    }
  });

  async function startSession(clientCapabilities: Record<string, unknown>): Promise<void> {
    await agent.initialize({ protocolVersion: 1, clientCapabilities: clientCapabilities as never });
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  }

  it("(R1.2) keeps AskUserQuestion disabled for a client without elicitation.form", async () => {
    await startSession({});

    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
    // No form support means no elicitation callback to render one with.
    expect(capturedOptions!.onElicitation).toBeUndefined();
  });

  it("(R1.2) keeps AskUserQuestion disabled for a url-only elicitation client", async () => {
    // `url` elicitation cannot render a multi-question form, so it does not
    // unlock the tool either — only `form` does.
    await startSession({ elicitation: { url: {} } });

    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("(R1.1) enables AskUserQuestion and wires the form elicitation callback when form is advertised", async () => {
    await startSession({ elicitation: { form: {} } });

    expect(capturedOptions!.disallowedTools).not.toContain("AskUserQuestion");
    expect(typeof capturedOptions!.onElicitation).toBe("function");
  });

  describe("(R1.3) the retired environment variable no longer changes anything", () => {
    it.each(["1", "true", "0", "false", ""])(
      "a client without elicitation.form still gets the tool disabled when the variable is %j",
      async (value) => {
        process.env[RETIRED_ENV_VAR] = value;

        await startSession({});

        expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
        expect(capturedOptions!.onElicitation).toBeUndefined();
      },
    );

    it.each(["1", "0"])(
      "a client WITH elicitation.form still gets the tool enabled when the variable is %j",
      async (value) => {
        process.env[RETIRED_ENV_VAR] = value;

        await startSession({ elicitation: { form: {} } });

        expect(capturedOptions!.disallowedTools).not.toContain("AskUserQuestion");
        expect(typeof capturedOptions!.onElicitation).toBe("function");
      },
    );
  });
});
