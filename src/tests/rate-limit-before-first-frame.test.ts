import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { NO_PLAN_RATE_LIMITS } from "./helpers.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * Upstream claude-agent-acp#1534, ported. With partial messages on, the SDK
 * sends `rate_limit_event` BEFORE the turn's first assistant frame, while the
 * turn has no context total yet. The forwarding guard (`lastAssistantTotalUsage
 * !== null`) then dropped the event, and since the SDK sends it once per turn,
 * a client such as Zeo's `0011` usage panel never saw the live, measured
 * window mid-turn — only the derived ones at the turn borders.
 *
 * The fix keeps the event and attaches it to the turn's next `usage_update`,
 * once. These cases pin that, and that an event arriving after usage exists is
 * still sent at once, unchanged (the R1.8 path in account-usage-cadence).
 */

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const SESSION_ID = "test-session";

/** A measured status no derived window can produce, so it is unmistakable. */
const LIVE_RATE_LIMIT_INFO = {
  status: "rejected" as const,
  rateLimitType: "five_hour" as const,
  resetsAt: 1788436800,
  utilization: 0.9,
};

/** A report with no windows: the derived path stays silent, so every
 *  `_claude/rateLimit` the client sees comes from the live event. */
function emptyReport() {
  return { ...NO_PLAN_RATE_LIMITS, subscription_type: "max", rate_limits_available: false };
}

function rateLimitEvent() {
  return {
    type: "rate_limit_event",
    rate_limit_info: LIVE_RATE_LIMIT_INFO,
    uuid: randomUUID(),
    session_id: SESSION_ID,
  };
}

/** An assistant frame carrying usage, which gives the turn a context total. */
function assistantMessage() {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      id: "msg-rate-limit-early",
      model: "claude-sonnet-4-6",
      role: "assistant",
      type: "message",
      stop_reason: null,
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

/** Every `usage_update` that carried the live payload, in order. */
function liveCarriers(notifications: SessionNotification[]) {
  const wanted = JSON.stringify(LIVE_RATE_LIMIT_INFO);
  return notifications
    .map((notification) => notification.update as Record<string, any>)
    .filter(
      (update) =>
        update?.sessionUpdate === "usage_update" &&
        JSON.stringify(update._meta?.["_claude/rateLimit"]) === wanted,
    );
}

function usageUpdates(notifications: SessionNotification[]) {
  return notifications
    .map((notification) => notification.update as Record<string, any>)
    .filter((update) => update?.sessionUpdate === "usage_update");
}

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: () =>
      makeMockQuery({
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              description: "Balanced",
              supportsAutoMode: true,
            },
          ],
        }),
        [USAGE_METHOD]: async () => emptyReport(),
      }),
  };
});

vi.mock("../tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools.js")>();
  return { ...actual, registerHookCallback: vi.fn() };
});

describe("a rate_limit_event before the turn's first assistant frame (#1534)", () => {
  let notifications: SessionNotification[];
  let agent: ClaudeAcpAgent;
  let runtimeDir: string;
  let savedRuntimeDir: string | undefined;
  let savedPollEnv: string | undefined;

  async function* oneTurn(input: Pushable<any>, extra: unknown[]) {
    const iterator = input[Symbol.asyncIterator]();
    const { value: userMessage } = await iterator.next();
    yield userEcho(userMessage);
    for (const message of extra) {
      yield message;
    }
    yield successfulResultMessage();
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }

  async function runTurnWith(extra: unknown[]) {
    const input = new Pushable<any>();
    const query = Object.assign(wrapQuery(oneTurn(input, extra)), {
      [USAGE_METHOD]: vi.fn(async () => emptyReport()),
    });
    agent.sessions[SESSION_ID] = mockSessionState({ query, input }, agent);
    const response = await agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "hello" }],
    });
    await agent.sessions[SESSION_ID]?.consumer;
    return response;
  }

  beforeEach(async () => {
    // Same isolation as account-usage-cadence: the machine's poll interval and
    // its shared quota sample must not leak into what is measured here.
    savedPollEnv = process.env.CLAUDE_ACP_QUOTA_POLL_MS;
    delete process.env.CLAUDE_ACP_QUOTA_POLL_MS;
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rate-limit-early-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    notifications = [];
    const client = {
      sessionUpdate: async (notification: SessionNotification) => {
        notifications.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
    agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  });

  afterEach(async () => {
    for (const session of Object.values(agent.sessions)) {
      if (session?.accountUsageTimer) {
        clearInterval(session.accountUsageTimer);
        session.accountUsageTimer = undefined;
      }
    }
    if (savedPollEnv === undefined) delete process.env.CLAUDE_ACP_QUOTA_POLL_MS;
    else process.env.CLAUDE_ACP_QUOTA_POLL_MS = savedPollEnv;
    if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
    // Retries for the fire-and-forget quota write; see account-usage-cadence.
    await fsp.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("rides the turn's first usage_update, once", async () => {
    await runTurnWith([rateLimitEvent(), assistantMessage()]);

    const carriers = liveCarriers(notifications);
    expect(carriers).toHaveLength(1);
    // It is the FIRST usage_update of the turn, not a later one.
    expect(usageUpdates(notifications)[0]).toBe(carriers[0]);
  });

  it("keeps the update's own numbers beside it", async () => {
    await runTurnWith([rateLimitEvent(), assistantMessage()]);

    const [carrier] = liveCarriers(notifications);
    // The result's usage_update is the carrier here; its context total is the
    // assistant frame's, so the payload did not displace the numbers.
    expect(carrier.used).toBe(15);
  });

  it("is still sent at once when usage already exists", async () => {
    await runTurnWith([assistantMessage(), rateLimitEvent()]);

    const carriers = liveCarriers(notifications);
    expect(carriers).toHaveLength(1);
    expect(carriers[0].used).toBe(15);
  });
});
