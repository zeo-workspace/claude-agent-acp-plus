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
 * Story 011, task 1.1 - `/usage` renders from the synthetic frame the current
 * Claude Code CLI emits (R1.1, R1.2, R1.3), and nothing that is not that frame
 * is rewritten (R4.1-R4.5).
 *
 * THE SHAPE UNDER TEST. Driven in `stream-json` mode with the single message
 * `/usage`, the bundled CLI 2.1.280 answers with ONE top-level assistant frame
 * whose `message.model` is `"<synthetic>"`, whose content is an ARRAY holding one
 * text block, whose `output_tokens` is 0, and which carries
 * `local_command_run: { command: "usage", args: "" }` - followed by a `result`
 * with `num_turns: 0` and `local_command: "usage"` repeating the same text.
 * Adapter 0.22.1 published that frame as ordinary assistant text and never
 * requested the render: the regression this file pins.
 *
 * Hostile halves come first. The render is keyed on the prompt being exactly
 * `/usage` AND the frame being marked as `/usage` output, so the cases that
 * would make the rule fire WRONGLY - another command's frame, an unmarked frame,
 * a prompt that only mentions `/usage`, a second `/usage` turn whose output is
 * byte-identical to the first - are authored before the case where it holds.
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

/**
 * One session driven by scripted SDK messages, one script per prompt, with the
 * real `ClaudeAcpAgent` in between. `report` is the structured `/usage` control
 * request.
 */
function session(turns: TurnScript[], report: () => Promise<unknown> = async () => usageResponse) {
  const updates: SessionNotification[] = [];
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (notification: SessionNotification) => {
        updates.push(notification);
      },
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
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

  const chunkText = (from = 0, to = updates.length) =>
    updates
      .slice(from, to)
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.update as any).content.text as string)
      .join("");

  return {
    agent,
    updates,
    chunkText,
    prompt: (prompt: string | PromptBlock[]) =>
      agent.prompt({
        sessionId: "test-session",
        prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
      }),
  };
}

/** What R3.4 counts in a rendered answer: a heading, a table row, a bar. */
function expectRendered(text: string) {
  expect(text).toMatch(/^#{1,3} \S/m);
  expect(text).toMatch(/^\|.*\|\s*$/m);
  expect(text).toMatch(/[█░]{20}/);
}

function countRenders(text: string): number {
  return text.match(/^## Usage\s*$/gm)?.length ?? 0;
}

describe("/usage from the synthetic frame - HOSTILE: nothing else is rewritten", () => {
  it("R4.3 - another local command's synthetic frame keeps its text byte-for-byte", async () => {
    const STATUS = "Version: 2.1.280\nModel: Opus 5.5\nAuth: subscription";
    const h = session([
      (user) => [
        userEcho(user),
        syntheticFrame(STATUS, { command: "status", args: "" }),
        localCommandResult(STATUS, "status"),
        idle,
      ],
    ]);

    await h.prompt("/status");

    expect(h.chunkText()).toBe(STATUS);
  });

  it("a frame marked `usage` in a turn whose prompt is not exactly `/usage` keeps its text", async () => {
    // `/usage now` is an argument form the renderer has no mapping for: the
    // frame says `usage`, but which turn owns a render is decided by the prompt.
    const h = session([
      (user) => [
        userEcho(user),
        syntheticFrame(RAW, { command: "usage", args: "now" }),
        localCommandResult(RAW),
        idle,
      ],
    ]);

    await h.prompt("/usage now");

    expect(h.chunkText()).toBe(RAW);
  });

  it("R4.2 - `/usage` plus another block is a model turn, answered unchanged", async () => {
    const ANSWER = "Those numbers are your plan limits for this week.";
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

    expect(h.chunkText()).toBe(ANSWER);
  });

  it("a synthetic frame WITHOUT the `usage` marker is not replaced, even in a `/usage` turn", async () => {
    // Synthetic frames also carry spend-limit and sign-in banners. The render
    // replaces the frame that says it is `/usage`'s output, not every synthetic
    // frame a `/usage` turn happens to contain.
    const BANNER = "No response requested.";
    const h = session([
      (user) => [userEcho(user), syntheticFrame(BANNER, null), successfulResultMessage(), idle],
    ]);

    await h.prompt("/usage");

    expect(h.chunkText()).toBe(BANNER);
  });

  it("HOSTILE (collapse) - two `/usage` turns with byte-identical output each get their own render", async () => {
    // A duplicate guard that remembers output across turns would take the
    // second turn's frame for a mirror of the first and publish nothing.
    const turn: TurnScript = (user) => [
      userEcho(user),
      syntheticFrame(RAW),
      localCommandResult(RAW),
      idle,
    ];
    const h = session([turn, turn]);

    await h.prompt("/usage");
    const secondTurnStart = h.updates.length;
    await h.prompt("/usage");

    const first = h.chunkText(0, secondTurnStart);
    const second = h.chunkText(secondTurnStart);
    expect(countRenders(first)).toBe(1);
    expect(countRenders(second)).toBe(1);
    expect(first).not.toContain(RAW_FIRST_LINE);
    expect(second).not.toContain(RAW_FIRST_LINE);
  });
});

describe("/usage from the synthetic frame - HOSTILE: one output, several shapes, one render", () => {
  it("R1.3 - frame then result (the CLI's order): the render once, no copy of the raw text", async () => {
    const h = session([
      (user) => [userEcho(user), syntheticFrame(RAW), localCommandResult(RAW), idle],
    ]);

    await h.prompt("/usage");

    const text = h.chunkText();
    expect(countRenders(text)).toBe(1);
    expect(text).not.toContain(RAW_FIRST_LINE);
  });

  it("R1.3 - result then a trailing frame: the render once, no copy of the raw text", async () => {
    // The converse order. The result settles the turn, so the frame arrives
    // after it - and must still be recognised as this turn's output, not
    // published as a raw copy under the render.
    const h = session([
      (user) => [userEcho(user), localCommandResult(RAW), syntheticFrame(RAW), idle],
    ]);

    await h.prompt("/usage");
    // The trailing frame is consumed after the prompt resolved.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const text = h.chunkText();
    expect(countRenders(text)).toBe(1);
    expect(text).not.toContain(RAW_FIRST_LINE);
  });
});

describe("/usage from the synthetic frame - the render", () => {
  it("R1.1/R1.2 - replays the 0.22.1 shape and publishes the Markdown render instead of the terminal text", async () => {
    const h = session([
      (user) => [userEcho(user), syntheticFrame(RAW), localCommandResult(RAW), idle],
    ]);

    const response = await h.prompt("/usage");

    expect(response.stopReason).toBe("end_turn");
    const text = h.chunkText();
    expectRendered(text);
    expect(text).not.toContain(RAW_FIRST_LINE);
  });
});

describe("/usage from the synthetic frame - unchanged behaviour", () => {
  it.each([
    [
      "the request fails",
      async () => {
        throw new Error("control request rejected");
      },
    ],
    [
      "the response is incompatible",
      async () => ({ ...usageResponse, session: { total_cost_usd: "x" } }),
    ],
  ])("R4.1 - %s: the original text, byte-for-byte and once", async (_label, report) => {
    const h = session(
      [(user) => [userEcho(user), syntheticFrame(RAW), localCommandResult(RAW), idle]],
      report,
    );

    await h.prompt("/usage");

    expect(h.chunkText()).toBe(RAW);
  });

  it("R4.1 - the report never arrives: the bounded wait publishes the original text byte-for-byte and once", async () => {
    const h = session(
      [(user) => [userEcho(user), syntheticFrame(RAW), localCommandResult(RAW), idle]],
      () => new Promise<never>(() => {}),
    );

    await h.prompt("/usage");

    expect(h.chunkText()).toBe(RAW);
  }, 20_000);

  it("R4.4 - a `/usage` turn cancelled while its render is pending publishes nothing", async () => {
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
    expect(h.chunkText()).toBe("");
  });

  describe("R4.5 - a failed `/compact` still consumes its one duplicate", () => {
    const compacting = {
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "compact-start",
      session_id: "test-session",
    };
    const compactFailed = {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "summary rejected",
      uuid: "compact-done",
      session_id: "test-session",
    };

    it("as local command output", async () => {
      const h = session([
        (user) => [
          userEcho(user),
          compacting,
          compactFailed,
          {
            type: "system",
            subtype: "local_command_output",
            content: "summary rejected",
            uuid: randomUUID(),
            session_id: "test-session",
          },
          successfulResultMessage(),
          idle,
        ],
      ]);

      await h.prompt("/compact");

      expect(h.chunkText()).not.toContain("summary rejected");
    });

    it("as a synthetic frame marked `compact`", async () => {
      const h = session([
        (user) => [
          userEcho(user),
          compacting,
          compactFailed,
          syntheticFrame("summary rejected", { command: "compact", args: "" }),
          successfulResultMessage(),
          idle,
        ],
      ]);

      await h.prompt("/compact");

      expect(h.chunkText()).not.toContain("summary rejected");
    });
  });
});
