// Zeo next proposal §6.4 (ask 24), the live half: during a turn, the agent's reply chunks carry
// `_meta.claudeCode.timestamp`, the time plus sent them, stamped by the prompt loop's funnel.
// The replay half and the helper are in message-timestamp.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const SESSION_ID = "test-session";
const NOW = new Date("2026-11-10T09:15:00.000Z");

function emptyReport() {
  return { ...NO_PLAN_RATE_LIMITS, subscription_type: "max", rate_limits_available: false };
}

function assistantMessage() {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      id: "msg-live-time",
      model: "claude-sonnet-4-6",
      role: "assistant",
      type: "message",
      stop_reason: null,
      content: [{ type: "text", text: "Fixed." }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
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

describe("message timestamps on a live turn (§6.4)", () => {
  let notifications: SessionNotification[];
  let agent: ClaudeAcpAgent;
  let runtimeDir: string;
  let savedRuntimeDir: string | undefined;

  async function* oneTurn(input: Pushable<any>) {
    const iterator = input[Symbol.asyncIterator]();
    const { value: userMessage } = await iterator.next();
    yield userEcho(userMessage);
    yield assistantMessage();
    yield successfulResultMessage();
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "message-time-live-"));
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
    vi.useRealTimers();
    for (const session of Object.values(agent.sessions)) {
      if (session?.accountUsageTimer) {
        clearInterval(session.accountUsageTimer);
        session.accountUsageTimer = undefined;
      }
    }
    if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
    await fsp.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("stamps the reply's chunks with the time plus sent them", async () => {
    const input = new Pushable<any>();
    const query = Object.assign(wrapQuery(oneTurn(input)), {
      [USAGE_METHOD]: vi.fn(async () => emptyReport()),
    });
    agent.sessions[SESSION_ID] = mockSessionState({ query, input }, agent);

    await agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "hello" }] });
    await agent.sessions[SESSION_ID]?.consumer;

    const reply = notifications
      .map((notification) => notification.update as Record<string, any>)
      .filter((update) => update.sessionUpdate === "agent_message_chunk");
    expect(reply.length).toBeGreaterThan(0);
    for (const chunk of reply) {
      expect(chunk._meta?.claudeCode?.timestamp).toBe(NOW.toISOString());
    }
  });
});
