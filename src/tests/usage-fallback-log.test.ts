import { describe, it, expect, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { randomUUID } from "crypto";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * Story 011, task 1.2 - a `/usage` turn that is not rendered is never silent
 * (R2.1), says so once (R2.2), and a cancelled one says nothing (R2.3).
 *
 * WHAT COUNTS AS A FALLBACK LINE. The wording is the implementer's; what this
 * file pins is that the line names the `/usage` command and carries one of the
 * five reasons R2.1 lists, each recognisable on its own:
 *
 *   timed out            /timed? ?-?out/            ("timed out", "timeout")
 *   incompatible         /incompatible/
 *   request failed       /\bfail(ed|ure)\b/
 *   no turn resolved     /no (active|owning|matching)? turn | turn not resolved | unresolved turn/
 *   output not intercepted  /not intercepted | unintercepted | never intercepted/
 *
 * Every fallback line must match EXACTLY ONE of them - that is what makes the
 * five reasons distinguishable in a log. A line from the account-usage reader
 * ("structured usage report unavailable") does not name the command, so it is
 * not a fallback line, and it is stubbed out below anyway.
 *
 * Two of the five paths are silent in adapter 0.22.1 - output not intercepted,
 * and no turn resolved - and the timeout is silent through the synthetic frame
 * the current CLI uses. A fourth defect is the converse: a request that fails at
 * turn activation logs its fallback even when the turn is later cancelled.
 *
 * Hostile halves first: the cases where a fallback line would fire WRONGLY (a
 * rendered turn, another command, a model turn, a cancelled turn, a trailing
 * copy of an output already rendered) come before the five reasons.
 */

/** A trimmed copy of the terminal text CLI 2.1.280 printed for `/usage`. */
const RAW = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 7% used · resets Sep 29, 11:39pm (America/Sao_Paulo)",
  "Current week (all models): 5% used · resets Sep 30, 1:59am (America/Sao_Paulo)",
].join("\n");
const RAW_FIRST_LINE = "You are currently using your subscription";

/** A structured report the renderer reads: it yields a heading, a table row and
 *  progress bars, which is what R3.4's reproduction counts. */
const usageResponse = {
  session: {
    total_cost_usd: 0.33,
    total_api_duration_ms: 20_000,
    total_duration_ms: 69_000,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {
      "claude-opus-4-1": {
        inputTokens: 4,
        outputTokens: 872,
        cacheReadInputTokens: 98_700,
        cacheCreationInputTokens: 25_300,
        webSearchRequests: 0,
        costUSD: 0.33,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
  },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 7, resets_at: "2026-09-30T02:39:59.000Z" },
    seven_day: { utilization: 5, resets_at: "2026-09-30T04:59:59.000Z" },
    model_scoped: [{ display_name: "Fable", utilization: 2, resets_at: null }],
  },
  behaviors: {
    day: {
      request_count: 34,
      session_count: 3,
      behaviors: [],
      agents: [],
      skills: [],
      plugins: [],
      mcp_servers: [],
    },
    week: {
      request_count: 43,
      session_count: 5,
      behaviors: [],
      agents: [],
      skills: [],
      plugins: [],
      mcp_servers: [],
    },
  },
} as unknown as SDKControlGetUsageResponse;

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * The synthetic assistant frame CLI 2.1.280 emits for a local command, field
 * for field as captured on 2026-09-29. `run` is `local_command_run`; pass
 * `null` for a synthetic frame that carries no such marker.
 */
function syntheticFrame(
  text: string,
  run: { command: string; args: string } | null = { command: "usage", args: "" },
) {
  return {
    type: "assistant",
    message: {
      diagnostics: null,
      id: randomUUID(),
      container: null,
      model: "<synthetic>",
      role: "assistant",
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      usage: {
        ...ZERO_USAGE,
        output_tokens_details: null,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      },
      content: [{ type: "text", text }],
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: "test-session",
    uuid: randomUUID(),
    timestamp: "2026-09-29T22:14:11.960Z",
    ...(run
      ? {
          local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
          local_command_run: run,
        }
      : {}),
    ...(run?.command === "usage"
      ? {
          usage_report: {
            session: {
              total_cost_usd: 0,
              total_api_duration_ms: 0,
              total_duration_ms: 3137,
              total_lines_added: 0,
              total_lines_removed: 0,
              model_usage: {},
            },
            rate_limits: { limits: [] },
          },
        }
      : {}),
  };
}

/** The `result` that follows a local command: zero turns, zero output tokens,
 *  and the command's text repeated in `result`. */
function localCommandResult(text: string, command = "usage") {
  return successfulResultMessage({
    result: text,
    num_turns: 0,
    stop_reason: null,
    local_command: command,
    usage: ZERO_USAGE,
  });
}

/** A real model answer: a named model and non-zero output tokens. */
function modelFrame(text: string) {
  return {
    type: "assistant",
    message: {
      id: randomUUID(),
      model: "claude-opus-4-1",
      role: "assistant",
      type: "message",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { ...ZERO_USAGE, input_tokens: 12, output_tokens: 9 },
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    session_id: "test-session",
    uuid: randomUUID(),
  };
}

const idle = { type: "system", subtype: "session_state_changed", state: "idle" };

type TurnScript = (user: any) => AsyncGenerator<any> | Iterable<any>;
type PromptBlock = { type: "text"; text: string };

const REASONS = {
  timedOut: /\btimed? ?-?out\b/i,
  incompatible: /\bincompatible\b/i,
  failed: /\bfail(?:ed|ure)\b/i,
  noTurn:
    /\bno (?:active |owning |matching )?turn\b|\bturn (?:was )?not resolved\b|\bunresolved turn\b/i,
  notIntercepted: /\bnot intercepted\b|\bunintercepted\b|\bnever intercepted\b/i,
} as const;
type Reason = keyof typeof REASONS;

function reasonsOf(line: string): Reason[] {
  return (Object.keys(REASONS) as Reason[]).filter((reason) => REASONS[reason].test(line));
}

/**
 * One session driven by scripted SDK messages, one script per prompt, with the
 * real `ClaudeAcpAgent` in between and every logger call captured. `report` is
 * the structured `/usage` control request.
 */
function session(turns: TurnScript[], report: () => Promise<unknown> = async () => usageResponse) {
  const updates: SessionNotification[] = [];
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (notification: SessionNotification) => {
        updates.push(notification);
      },
    } as unknown as AcpClient,
    { log: capture, error: capture },
  );
  // Isolation, as in context-compaction.test.ts: a turn reaching its result
  // publishes an account-usage sample shared on disk across vitest workers.
  (agent as unknown as { publishAccountUsage: () => Promise<void> }).publishAccountUsage =
    async () => {};
  (agent as unknown as { armAccountUsagePolling: () => void }).armAccountUsagePolling = () => {};

  const input = new Pushable<any>();
  async function* messages() {
    const iterator = input[Symbol.asyncIterator]();
    for (const turn of turns) {
      const user = await iterator.next();
      if (user.done) {
        return;
      }
      yield* turn(user.value);
    }
  }
  const query = wrapQuery(messages());
  query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = vi.fn(report);
  agent.sessions["test-session"] = mockSessionState({ query, input });

  return {
    agent,
    chunkText: () =>
      updates
        .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
        .map((update) => (update.update as any).content.text as string)
        .join(""),
    /** Lines that name the command and carry one of the five reasons. */
    fallbackLines: () =>
      lines.filter((line) => line.includes("/usage") && reasonsOf(line).length > 0),
    prompt: (prompt: string | PromptBlock[]) =>
      agent.prompt({
        sessionId: "test-session",
        prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
      }),
  };
}

/** Let anything the consumer still has to drain (a trailing frame after the
 *  prompt resolved, a log written after the publish) land before asserting. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Exactly one fallback line, naming exactly one reason - the expected one. */
function expectOneFallback(h: ReturnType<typeof session>, reason: Reason | Reason[]) {
  const fallback = h.fallbackLines();
  expect(fallback).toHaveLength(1);
  const named = reasonsOf(fallback[0]);
  expect(named).toHaveLength(1);
  expect(Array.isArray(reason) ? reason : [reason]).toContain(named[0]);
}

const rendered: TurnScript = (user) => [
  userEcho(user),
  syntheticFrame(RAW),
  localCommandResult(RAW),
  idle,
];
const failing = async () => {
  throw new Error("control request rejected");
};

describe("/usage fallback log - HOSTILE: no line where nothing fell back", () => {
  it("a rendered `/usage` turn logs no fallback line", async () => {
    const h = session([rendered]);

    await h.prompt("/usage");
    await drain();

    expect(h.fallbackLines()).toEqual([]);
  });

  it("a trailing copy of an output already rendered logs no fallback line", async () => {
    // Result first, then the frame: the frame arrives after its turn settled.
    // The render already went out, so nothing fell back - "no turn resolved"
    // would be a false report here.
    const h = session([
      (user) => [userEcho(user), localCommandResult(RAW), syntheticFrame(RAW), idle],
    ]);

    await h.prompt("/usage");
    await drain();

    expect(h.fallbackLines()).toEqual([]);
  });

  it("another local command logs no `/usage` line", async () => {
    const STATUS = "Version: 2.1.280";
    const h = session([
      (user) => [
        userEcho(user),
        syntheticFrame(STATUS, { command: "status", args: "" }),
        localCommandResult(STATUS, "status"),
        idle,
      ],
    ]);

    await h.prompt("/status");
    await drain();

    expect(h.fallbackLines()).toEqual([]);
  });

  it("`/usage` plus another block is a model turn and logs no `/usage` line", async () => {
    const ANSWER = "Those are your plan limits.";
    const h = session([
      (user) => [
        userEcho(user),
        modelFrame(ANSWER),
        successfulResultMessage({ result: ANSWER }),
        idle,
      ],
    ]);

    await h.prompt([
      { type: "text", text: "/usage" },
      { type: "text", text: "what do these numbers mean?" },
    ]);
    await drain();

    expect(h.fallbackLines()).toEqual([]);
  });

  it("R2.3 - a cancelled `/usage` turn logs nothing, even when its request had already failed", async () => {
    // The request is issued when the turn activates and fails at once. The
    // turn is then cancelled before any output arrives: nothing was published,
    // so nothing fell back.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let echoed!: () => void;
    const activated = new Promise<void>((resolve) => (echoed = resolve));
    const h = session(
      [
        async function* (user) {
          yield userEcho(user);
          echoed();
          await gate;
          yield syntheticFrame(RAW);
          yield localCommandResult(RAW);
          yield idle;
        },
      ],
      failing,
    );

    const outcome = h.prompt("/usage");
    await activated;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.agent.cancel({ sessionId: "test-session" });
    release();

    await expect(outcome).resolves.toMatchObject({ stopReason: "cancelled" });
    await drain();
    expect(h.fallbackLines()).toEqual([]);
  });

  it("R2.3 - a `/usage` turn cancelled while its render is pending logs nothing", async () => {
    let frameSent!: () => void;
    const sent = new Promise<void>((resolve) => (frameSent = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = session(
      [
        async function* (user) {
          yield userEcho(user);
          frameSent();
          yield syntheticFrame(RAW);
          await gate;
          yield localCommandResult(RAW);
          yield idle;
        },
      ],
      () => new Promise<never>(() => {}),
    );

    const outcome = h.prompt("/usage");
    await sent;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.agent.cancel({ sessionId: "test-session" });
    release();

    await expect(outcome).resolves.toMatchObject({ stopReason: "cancelled" });
    await drain();
    expect(h.fallbackLines()).toEqual([]);
  });
});

describe("/usage fallback log - one line, naming its reason (R2.1, R2.2)", () => {
  it("timed out - the report never arrives", async () => {
    const h = session([rendered], () => new Promise<never>(() => {}));

    await h.prompt("/usage");
    await drain();

    expect(h.chunkText()).toBe(RAW);
    expectOneFallback(h, "timedOut");
  }, 20_000);

  it("incompatible response", async () => {
    const h = session([rendered], async () => ({
      ...usageResponse,
      session: { total_cost_usd: "broken" },
    }));

    await h.prompt("/usage");
    await drain();

    expect(h.chunkText()).toBe(RAW);
    expectOneFallback(h, "incompatible");
  });

  it("request failed", async () => {
    const h = session([rendered], failing);

    await h.prompt("/usage");
    await drain();

    expect(h.chunkText()).toBe(RAW);
    expectOneFallback(h, "failed");
  });

  it("output not intercepted - the output reached the client through a shape nothing claimed", async () => {
    // A synthetic frame without the `usage` marker, and a result carrying no
    // text: the report was available, yet the turn published Claude Code's own
    // text. Silent in 0.22.1.
    const h = session([
      (user) => [userEcho(user), syntheticFrame(RAW, null), successfulResultMessage(), idle],
    ]);

    await h.prompt("/usage");
    await drain();

    expect(h.chunkText()).toBe(RAW);
    expectOneFallback(h, "notIntercepted");
  });

  it("no turn resolved - the output arrived after its turn had settled", async () => {
    // A result the adapter declines to forward (non-zero output tokens, no
    // text) settles the turn, and the frame marked `usage` arrives after it:
    // no turn owns it. The turn itself published nothing, so it has nothing
    // to report; the frame that finds no turn is the fallback. Silent in 0.22.1.
    const h = session([
      (user) => [
        userEcho(user),
        successfulResultMessage({
          result: "",
          num_turns: 0,
          usage: { ...ZERO_USAGE, output_tokens: 1 },
        }),
        syntheticFrame(RAW),
        idle,
      ],
    ]);

    await h.prompt("/usage");
    await vi.waitFor(() => expect(h.chunkText()).toContain(RAW_FIRST_LINE));
    await drain();

    expect(h.chunkText()).toBe(RAW);
    expectOneFallback(h, "noTurn");
  });

  it("R2.2 - two paths that could both fire still leave one line", async () => {
    // The request failed AND the output came through an unclaimed shape. Either
    // reason is true; two lines for one turn is what R2.2 forbids.
    const h = session(
      [(user) => [userEcho(user), syntheticFrame(RAW, null), successfulResultMessage(), idle]],
      failing,
    );

    await h.prompt("/usage");
    await drain();

    expect(h.chunkText()).toBe(RAW);
    expectOneFallback(h, ["failed", "notIntercepted"]);
  });

  it("R2.2 - one output through two shapes, one failed request: one line", async () => {
    // The frame and the result both carry the text; each reaches a site that
    // could report the same fallback.
    const h = session([rendered], failing);

    await h.prompt("/usage");
    await drain();

    expectOneFallback(h, "failed");
  });
});
