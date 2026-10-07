import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import type { Pushable } from "../utils.js";

/**
 * Story 029, Task 2.2 (R1.1, R1.2, R1.4, R3.1; Constraints). Session level:
 * the real agent, the grant hook it really registers, a mocked CLI. The mode a
 * grant is judged by is the one the CLI puts on the hook input
 * (`permission_mode`), never the adapter's own session mode, which can lag a
 * switch. Both directions are hostile: the session saying `auto` must not open
 * the gate for an input saying `default`, and the session saying `default`
 * must not shut it for an input saying `auto`.
 */
const captured: Options[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: Pushable<any>; options: Options }) => {
      captured.push(options);
      return Object.assign(turns(prompt), {
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-6",
              displayName: "Sonnet",
              description: "",
              supportsAutoMode: true,
            },
          ],
        }),
        setModel: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
        supportedAgents: vi.fn(async () => []),
        supportedCommands: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({ totalTokens: 0, rawMaxTokens: 200000 })),
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(),
      });
    },
  };
});

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

async function* turns(input: Pushable<any>) {
  for await (const message of input) {
    yield {
      type: "user",
      message: message.message,
      parent_tool_use_id: null,
      uuid: message.uuid,
      session_id: "sdk-session",
      isReplay: true,
    };
    yield {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
      result: "",
      errors: [],
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: "sdk-session",
    };
    yield {
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: randomUUID(),
      session_id: "sdk-session",
    };
  }
}

const ALLOW_REASON = "approved by the operator after a classifier denial";
const CMD = "git push --force origin main";

/** Every PreToolUse hook the session registered, run like the CLI runs them. */
async function preToolUse(options: Options, id: string, mode: string | undefined) {
  const outputs: unknown[] = [];
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      outputs.push(
        await (hook as HookCallback)(
          {
            hook_event_name: "PreToolUse",
            session_id: "sdk-session",
            transcript_path: "/tmp/t.jsonl",
            cwd: process.cwd(),
            ...(mode === undefined ? {} : { permission_mode: mode }),
            tool_name: "Bash",
            tool_input: { command: CMD, description: "Push" },
            tool_use_id: id,
          } as Parameters<HookCallback>[0],
          id,
          { signal: new AbortController().signal },
        ),
      );
    }
  }
  return outputs;
}

const allowed = (outs: unknown[]) =>
  outs.some(
    (o: any) =>
      o?.hookSpecificOutput?.permissionDecision === "allow" &&
      o?.hookSpecificOutput?.permissionDecisionReason === ALLOW_REASON,
  );

describe("classifier grant — the mode comes from the hook input, not the session", () => {
  let agent: ClaudeAcpAgentType;
  let mod: typeof import("../classifier-escalation.js");

  beforeEach(async () => {
    captured.length = 0;
    vi.resetModules();
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    mod = await import("../classifier-escalation.js");
    agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (_: SessionNotification) => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );
  });

  async function newSession(mode?: "auto" | "default") {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    if (mode) {
      await agent.setSessionConfigOption({ sessionId, configId: "mode", value: mode });
    }
    const session = (agent.sessions as any)[sessionId];
    return { sessionId, session, options: captured.at(-1)! };
  }

  const fp = () => mod.fingerprint("Bash", { command: CMD })!;

  // Hostile: the session's own state says auto; the CLI says default.
  it("session in auto, input in default: no allow, and the once grant stays for auto (R1.1, R1.2)", async () => {
    const { session, options } = await newSession("auto");
    expect(session.modes.currentModeId).toBe("auto");
    session.classifierGrants.grantOnce(fp());
    expect(allowed(await preToolUse(options, "toolu_1", "default"))).toBe(false);
    expect(allowed(await preToolUse(options, "toolu_2", "plan"))).toBe(false);
    expect(allowed(await preToolUse(options, "toolu_3", undefined))).toBe(false);
    expect(allowed(await preToolUse(options, "toolu_4", "auto"))).toBe(true);
    expect(allowed(await preToolUse(options, "toolu_5", "auto"))).toBe(false);
  });

  // Hostile, converse: the session's own state lags at default; the CLI says auto.
  it("session in default, input in auto: the grant is honoured (R1.4, R3.1)", async () => {
    const { session, options } = await newSession("default");
    expect(session.modes.currentModeId).toBe("default");
    session.classifierGrants.grantSession(fp());
    expect(allowed(await preToolUse(options, "toolu_1", "auto"))).toBe(true);
    expect(allowed(await preToolUse(options, "toolu_2", "auto"))).toBe(true);
  });

  it("a session grant made in auto is dormant after a switch to default and honoured after switching back (R1.4)", async () => {
    const { sessionId, session, options } = await newSession("auto");
    session.classifierGrants.grantSession(fp());
    expect(allowed(await preToolUse(options, "toolu_1", "auto"))).toBe(true);

    await agent.setSessionConfigOption({ sessionId, configId: "mode", value: "default" });
    expect(allowed(await preToolUse(options, "toolu_2", "default"))).toBe(false);

    await agent.setSessionConfigOption({ sessionId, configId: "mode", value: "auto" });
    expect(allowed(await preToolUse(options, "toolu_3", "auto"))).toBe(true);
  });

  it("session and input both in auto: the grant is honoured (R3.1)", async () => {
    const { session, options } = await newSession("auto");
    session.classifierGrants.grantOnce(fp());
    expect(allowed(await preToolUse(options, "toolu_1", "auto"))).toBe(true);
  });
});
