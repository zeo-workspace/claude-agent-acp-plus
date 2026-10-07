import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import type { Pushable } from "../utils.js";

/**
 * Story 016, Task 7.1 (R1.1, R1.2, R1.4, R1.5, R2.1, R2.5, R2.6, R3.1, R4.1,
 * R4.2, Q4). Session-level contract check: the real agent, the real hooks it
 * registers, the real frame handler and registry, and a mocked ACP client.
 * The mocked SDK replays what the CLI does for one classifier denial — the
 * `permission_denied` frame and the `PermissionDenied` hook, in either order —
 * then the model's retry through the PreToolUse hooks.
 */
type Order = "frame-first" | "hook-first" | "frame-only" | "hook-then-late-frame";
type Scenario = {
  order: Order;
  subagent?: boolean;
  toolResultAfterHook?: boolean;
};

const CMD = "make deploy ENV=staging";
const REASON = "Classifier: deploys to a shared environment";
let scenario: Scenario = { order: "frame-first" };
let observed: { hookOutput?: unknown; retries: unknown[]; frameAt?: number } = { retries: [] };
let hookAbort = new AbortController();

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: Pushable<any>; options: Options }) =>
      Object.assign(cliTurn(prompt, options), {
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
        interrupt: vi.fn(async () => {
          hookAbort.abort();
          return undefined;
        }),
        close: vi.fn(),
      }),
  };
});

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assistantToolUse(id: string, input: Record<string, unknown>, parent: string | null) {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: "sdk-session",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "tool_use", id, name: "Bash", input }],
    },
  };
}

function frame(agentId?: string) {
  return {
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "toolu_denied",
    decision_reason_type: "classifier",
    decision_reason: REASON,
    message: "Permission to use Bash has been denied.",
    ...(agentId ? { agent_id: agentId } : {}),
    uuid: randomUUID(),
    session_id: "sdk-session",
  };
}

function deniedToolResult(parent: string | null) {
  return {
    type: "user",
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: "sdk-session",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_denied",
          content: `Permission for this action has been denied. Reason: ${REASON}. You may retry.`,
          is_error: true,
        },
      ],
    },
  };
}

function hookInput(
  event: "PermissionDenied" | "PreToolUse",
  id: string,
  input: unknown,
  agentId?: string,
) {
  return {
    hook_event_name: event,
    session_id: "sdk-session",
    // Story 029: the escalation and its grants live in auto mode.
    permission_mode: "auto",
    transcript_path: "/tmp/t.jsonl",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: input,
    tool_use_id: id,
    ...(event === "PermissionDenied" ? { reason: REASON } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
  } as Parameters<HookCallback>[0];
}

/** Run every matcher's hooks for `event`, like the CLI, and return the outputs. */
async function runHooks(
  options: Options,
  event: "PermissionDenied" | "PreToolUse",
  input: any,
  id: string,
) {
  const outputs: unknown[] = [];
  for (const matcher of options.hooks?.[event] ?? []) {
    for (const hook of matcher.hooks)
      outputs.push(await hook(input, id, { signal: hookAbort.signal }));
  }
  return outputs;
}

const isAllow = (outs: unknown[]) =>
  outs.some((o: any) => o?.hookSpecificOutput?.permissionDecision === "allow");

async function* cliTurn(input: Pushable<any>, options: Options) {
  const { value: user } = await input[Symbol.asyncIterator]().next();
  if (!user) return;
  yield {
    type: "user",
    message: user.message,
    parent_tool_use_id: null,
    uuid: user.uuid,
    session_id: "sdk-session",
    isReplay: true,
  };

  const agentId = scenario.subagent ? "agent-1" : undefined;
  const parent = scenario.subagent ? "toolu_agent" : null;
  if (scenario.subagent) {
    yield {
      type: "system",
      subtype: "task_started",
      task_id: "agent-1",
      tool_use_id: "toolu_agent",
      subagent_type: "general-purpose",
      uuid: randomUUID(),
      session_id: "sdk-session",
    };
  }
  const deniedInput = { command: CMD, description: "Deploy to staging" };
  yield assistantToolUse("toolu_denied", deniedInput, parent);

  // The CLI ran the PreToolUse hooks before the classifier: no grant yet.
  await runHooks(
    options,
    "PreToolUse",
    hookInput("PreToolUse", "toolu_denied", deniedInput, agentId),
    "toolu_denied",
  );

  const callHook = () =>
    runHooks(
      options,
      "PermissionDenied",
      hookInput("PermissionDenied", "toolu_denied", deniedInput, agentId),
      "toolu_denied",
    );

  switch (scenario.order) {
    case "frame-first": {
      yield frame(agentId);
      observed.hookOutput = (await callHook()).at(-1);
      break;
    }
    case "hook-first": {
      const pending = callHook();
      await sleep(20);
      yield frame(agentId);
      observed.hookOutput = (await pending).at(-1);
      break;
    }
    case "frame-only": {
      observed.frameAt = Date.now();
      yield frame(agentId);
      await sleep(5600);
      break;
    }
    case "hook-then-late-frame": {
      observed.hookOutput = (await callHook()).at(-1); // gives up after 5 s without a frame
      yield frame(agentId);
      await sleep(5600);
      break;
    }
    default:
      throw new Error(`unknown scenario order: ${String(scenario.order)}`);
  }
  if (scenario.toolResultAfterHook) yield deniedToolResult(parent);

  // The model retries the same command under a new id, with a rewritten description.
  for (const id of ["toolu_retry_1", "toolu_retry_2"]) {
    const retryInput = { command: CMD, description: "Retry the deploy" };
    observed.retries.push(
      isAllow(
        await runHooks(options, "PreToolUse", hookInput("PreToolUse", id, retryInput, agentId), id),
      ),
    );
  }

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

type Answer = "Yes" | "Yes for this session" | "No" | "cancel";

describe("classifier escalation — hook, registry and frame handler agree", () => {
  let agent: ClaudeAcpAgentType;
  let updates: SessionNotification["update"][];
  let updateTimes: number[];
  let requests: { params: RequestPermissionRequest; updatesBefore: number }[];
  let answer: Answer;

  beforeEach(async () => {
    vi.resetModules();
    scenario = { order: "frame-first" };
    observed = { retries: [] };
    hookAbort = new AbortController();
    updates = [];
    updateTimes = [];
    requests = [];
    answer = "Yes";
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        updates.push(n.update);
        updateTimes.push(Date.now());
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        requests.push({ params, updatesBefore: updates.length });
        if (answer === "cancel") {
          await agent.cancel({ sessionId: params.sessionId });
          return { outcome: { outcome: "cancelled" } };
        }
        const option = params.options.find((o) => o.name === answer);
        if (!option) throw new Error(`option ${answer} not offered`);
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      },
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
    agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  });

  async function turn() {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const response = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "deploy" }] });
    return response;
  }

  const forDenied = () =>
    updates.filter(
      (u): u is Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }> =>
        u.sessionUpdate === "tool_call_update" &&
        (u as any).toolCallId === "toolu_denied" &&
        !!(u as any).status,
    );
  const lastStatus = () => forDenied().at(-1);
  const RETRY = { hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } };

  for (const order of ["frame-first", "hook-first"] as const) {
    describe(`${order}`, () => {
      beforeEach(() => {
        scenario = { order };
      });

      it("asks once with exactly the three answers, the command and the classifier reason (R1.1, R1.2)", async () => {
        await turn();
        expect(requests).toHaveLength(1);
        const { params } = requests[0]!;
        expect(params.toolCall.toolCallId).toBe("toolu_denied");
        expect(params.options.map((o) => o.name)).toEqual(["Yes", "Yes for this session", "No"]);
        expect(params.options.map((o) => o.kind)).not.toContain("allow_always");
        const shown = JSON.stringify(params.toolCall);
        expect(shown).toContain(CMD);
        expect(shown).toContain(REASON);
      });

      it("leaves the call pending, not failed, until the operator answers (R1.5)", async () => {
        await turn();
        const before = updates.slice(0, requests[0]!.updatesBefore);
        expect(
          before.some(
            (u: any) =>
              u.sessionUpdate === "tool_call_update" &&
              u.toolCallId === "toolu_denied" &&
              u.status === "failed",
          ),
        ).toBe(false);
      });

      it("Yes: retry hint, approved update, the matching retry runs once (R2.1, R2.2, R2.5, R2.6)", async () => {
        answer = "Yes";
        await turn();
        expect(observed.hookOutput).toEqual(RETRY);
        expect(lastStatus()).toMatchObject({ status: "completed" });
        expect(JSON.stringify(lastStatus()!.content)).toMatch(/approved/i);
        expect(observed.retries).toEqual([true, false]);
      });

      it("Yes for this session: every matching retry runs (R3.1)", async () => {
        answer = "Yes for this session";
        await turn();
        expect(observed.hookOutput).toEqual(RETRY);
        expect(lastStatus()).toMatchObject({ status: "completed" });
        expect(observed.retries).toEqual([true, true]);
      });

      it("No: today's failed update with the classifier reason, no retry hint, no grant (R4.1)", async () => {
        answer = "No";
        await turn();
        expect(observed.hookOutput).toEqual({});
        const failed = forDenied().filter((u) => u.status === "failed");
        expect(failed.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(failed[0]!.content)).toContain(`Permission denied: ${REASON}`);
        expect(forDenied().some((u) => u.status === "completed")).toBe(false);
        expect(observed.retries).toEqual([false, false]);
      });

      it("cancel while the question is pending: no grant, the call does not finish as approved (R4.2)", async () => {
        answer = "cancel";
        await turn();
        expect(requests).toHaveLength(1); // asked, then withdrawn
        expect(observed.hookOutput).toEqual({});
        expect(lastStatus()).toBeDefined();
        expect(["failed", "cancelled"]).toContain(lastStatus()!.status);
        expect(observed.retries).toEqual([false, false]);
      });
    });
  }

  // The CLI's own tool_result for the denied call follows the hook. An approval
  // must not be flipped back to a failure by it (R2.5).
  it("an approved call stays approved when the CLI's denial tool_result follows (R2.5)", async () => {
    scenario = { order: "frame-first", toolResultAfterHook: true };
    answer = "Yes";
    await turn();
    expect(lastStatus()).toMatchObject({ status: "completed" });
  });

  it("a subagent's denial is asked inside the subagent's transcript (R1.4)", async () => {
    scenario = { order: "frame-first", subagent: true };
    await turn();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params.toolCall.toolCallId).toBe("toolu_denied");
    expect((requests[0]!.params.toolCall._meta as any)?.claudeCode?.parentToolUseId).toBe(
      "toolu_agent",
    );
  });

  describe("fallback: never left pending (R1.5, Q4)", () => {
    it("a classifier frame whose hook never fires gets today's failed update", async () => {
      scenario = { order: "frame-only" };
      await turn();
      expect(requests).toHaveLength(0);
      const failed = forDenied().filter((u) => u.status === "failed");
      expect(failed).toHaveLength(1);
      expect(JSON.stringify(failed[0]!.content)).toContain(`Permission denied: ${REASON}`);
      // The frame handler leaves it to the registry's 5 s deadline, so a hook
      // that is merely late can still claim the call.
      const failedAt = updateTimes[updates.indexOf(failed[0]!)]!;
      expect(failedAt - observed.frameAt!).toBeGreaterThanOrEqual(4500);
    }, 20_000);

    it("a frame arriving after the hook gave up gets today's failed update, and nothing is asked", async () => {
      scenario = { order: "hook-then-late-frame" };
      await turn();
      expect(observed.hookOutput).toEqual({});
      expect(requests).toHaveLength(0);
      expect(forDenied().filter((u) => u.status === "failed")).toHaveLength(1);
      expect(observed.retries).toEqual([false, false]);
    }, 30_000);
  });
});
