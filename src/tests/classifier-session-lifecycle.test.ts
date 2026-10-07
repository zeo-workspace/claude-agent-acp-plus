import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { HookCallback, HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import type { Pushable } from "../utils.js";

/**
 * Story 016, Task 6.2 (R2.4, R3.2, R3.3). Both hooks are registered after the
 * user's own, every session owns its own grant store and escalation registry,
 * an unused "Yes" grant dies with its turn, and every grant dies with the session.
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

/** One successful turn per pushed prompt. */
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

function grantHook(options: Options): HookCallback {
  const hook = options.hooks?.PreToolUse?.at(-1)?.hooks.at(-1);
  if (!hook) throw new Error("no PreToolUse hook registered");
  return hook;
}

async function preToolUse(options: Options, id: string, command: string) {
  return grantHook(options)(
    {
      hook_event_name: "PreToolUse",
      session_id: "sdk-session",
      transcript_path: "/tmp/t.jsonl",
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: id,
    } as Parameters<HookCallback>[0],
    id,
    { signal: new AbortController().signal },
  );
}

const allowed = (out: unknown) =>
  (out as any)?.hookSpecificOutput?.permissionDecision === "allow" &&
  (out as any)?.hookSpecificOutput?.permissionDecisionReason === ALLOW_REASON;

describe("classifier escalation — registration and session lifecycle", () => {
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

  async function newSession(hooks?: Record<string, HookCallbackMatcher[]>) {
    const { sessionId } = await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      ...(hooks ? { _meta: { claudeCode: { options: { hooks } } } } : {}),
    });
    return { sessionId, options: captured.at(-1)! };
  }

  const fp = (command: string) => mod.fingerprint("Bash", { command })!;

  it("registers PermissionDenied (timeout 600) and the grant PreToolUse hook after the user's hooks", async () => {
    const userPre = { hooks: [async () => ({})] } as HookCallbackMatcher;
    const userDenied = { hooks: [async () => ({})] } as HookCallbackMatcher;
    const { options } = await newSession({ PreToolUse: [userPre], PermissionDenied: [userDenied] });
    const pre = options.hooks!.PreToolUse!;
    const denied = options.hooks!.PermissionDenied!;
    expect(pre[0]).toBe(userPre);
    expect(pre.length).toBeGreaterThanOrEqual(2);
    expect(denied[0]).toBe(userDenied);
    expect(denied).toHaveLength(2);
    expect(denied[1]!.timeout).toBe(600);
  });

  it("registers PermissionDenied with timeout 600 when the user supplied no hooks", async () => {
    const { options } = await newSession();
    expect(options.hooks!.PermissionDenied).toHaveLength(1);
    expect(options.hooks!.PermissionDenied![0]!.timeout).toBe(600);
    expect(options.hooks!.PreToolUse!.length).toBeGreaterThanOrEqual(1);
  });

  it("gives every session its own grant store and escalation registry", async () => {
    const a = await newSession();
    const b = await newSession();
    const sa = (agent.sessions as any)[a.sessionId];
    const sb = (agent.sessions as any)[b.sessionId];
    expect(sa.classifierGrants).toBeInstanceOf(mod.GrantStore);
    expect(sa.escalations).toBeInstanceOf(mod.EscalationRegistry);
    expect(sa.classifierGrants).not.toBe(sb.classifierGrants);
    expect(sa.escalations).not.toBe(sb.escalations);
  });

  // Hostile half first: a grant leaking across sessions.
  it("a grant made in one session has no effect on another (R3.3)", async () => {
    const a = await newSession();
    const b = await newSession();
    (agent.sessions as any)[a.sessionId].classifierGrants.grantSession(fp("make deploy"));
    expect(allowed(await preToolUse(b.options, "toolu_b", "make deploy"))).toBe(false);
    expect(allowed(await preToolUse(a.options, "toolu_a", "make deploy"))).toBe(true);
  });

  it("an unused Yes grant is discarded when the turn ends; a session grant survives (R2.4)", async () => {
    const a = await newSession();
    const store = (agent.sessions as any)[a.sessionId].classifierGrants;
    store.grantOnce(fp("make once"));
    store.grantSession(fp("make always"));
    const response = await agent.prompt({
      sessionId: a.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(response.stopReason).toBe("end_turn");
    expect(allowed(await preToolUse(a.options, "toolu_1", "make once"))).toBe(false);
    expect(allowed(await preToolUse(a.options, "toolu_2", "make always"))).toBe(true);
  });

  it("closing a session discards every grant it holds, and only its own (R3.2)", async () => {
    const a = await newSession();
    const b = await newSession();
    const storeA = (agent.sessions as any)[a.sessionId].classifierGrants;
    (agent.sessions as any)[b.sessionId].classifierGrants.grantSession(fp("make deploy"));
    storeA.grantSession(fp("make deploy"));
    storeA.grantOnce(fp("make once"));
    await agent.closeSession({ sessionId: a.sessionId });
    expect(storeA.consume(fp("make deploy"))).toBeUndefined();
    expect(storeA.consume(fp("make once"))).toBeUndefined();
    expect(allowed(await preToolUse(a.options, "toolu_a", "make deploy"))).toBe(false);
    expect(allowed(await preToolUse(b.options, "toolu_b", "make deploy"))).toBe(true);
  });
});
