import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

/**
 * Story 008, R4.6 / R4.7 — surviving upstream's context-window rework (#894).
 *
 * Upstream DELETED the live context-window probe the fork still calls, and
 * reshaped the model-catalog accessor around it. Git sees a delete against a
 * modify, which does not always surface as a text conflict: the merge can land
 * clean and still leave the model picker reading an UNFILTERED catalog, so the
 * deprecation filter (story 006, R4.2) silently stops applying. That is a
 * regression no type-checker reports, which is why it is asserted behaviorally
 * here — through a real `session/new`, not through the filter helper in
 * isolation.
 *
 * Two things are therefore pinned:
 *  - R4.6: the fork's own probe is gone, so the window comes from upstream's
 *    post-#894 mechanism rather than an extra round-trip the fork re-added;
 *  - R4.7: the picker rows a session reports still exclude deprecated models
 *    after the accessor's signature changed.
 */

const DEPRECATED_MODEL = "claude-opus-3";

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
              description: "Balanced",
              supportsAutoMode: true,
            },
            {
              value: "claude-opus-4-8",
              displayName: "Claude Opus",
              description: "Most capable",
            },
            {
              value: DEPRECATED_MODEL,
              displayName: "Claude Opus 3 (Deprecated)",
              description: "Legacy model",
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

describe("model picker keeps receiving the deprecation-filtered catalog (R4.7)", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

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
    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;
    agent = new ClaudeAcpAgent(createMockClient());
  });

  it("omits deprecated rows from the model option a new session reports", async () => {
    const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    const modelOption = response.configOptions?.find((option) => option.id === "model");
    expect(modelOption).toBeDefined();

    const values = (modelOption as { options: Array<{ value: string }> }).options.map(
      (option) => option.value,
    );
    expect(values).not.toContain(DEPRECATED_MODEL);
    // Not over-filtering: the active rows must all survive, otherwise "no
    // deprecated models" would be trivially satisfiable by an empty picker.
    expect(values).toEqual(expect.arrayContaining(["claude-sonnet-4-6", "claude-opus-4-8"]));
  });

  it("records a usable context window on the created session (R4.6)", async () => {
    const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    const sessions = (
      agent as unknown as { sessions: Record<string, { contextWindowSize: number }> }
    ).sessions;
    const session = sessions[response.sessionId];

    expect(session).toBeDefined();
    expect(session.contextWindowSize).toBeGreaterThan(0);
    // Sanity on the wiring: the session was really built through the mocked
    // SDK query above, not through some default path that skipped it.
    expect(capturedOptions).toBeDefined();
  });
});

describe("the fork's own context-window probe is gone (R4.6)", () => {
  it("no longer defines or calls fetchContextWindowSize in acp-agent.ts", () => {
    // Upstream deleted this helper in #894 and derives the window from its own
    // mechanism. Keeping the fork's copy would reintroduce the round-trip the
    // sync exists to remove — and, being a delete/modify, it can survive a
    // clean-looking merge untouched.
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "acp-agent.ts"),
      "utf8",
    );

    expect(source).not.toContain("fetchContextWindowSize");
  });
});
