import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { quotaCachePath, writeLimits } from "../quota-cache.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, quotaPollIntervalMs, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { NO_PLAN_RATE_LIMITS } from "./helpers.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * Story 002, sub-task 1.4 — when the structured usage report is asked for.
 *
 * Contract (R1.1, R1.2, R1.7, R1.8): the report is requested once when the
 * session is established, so the bars are born filled rather than waiting for a
 * push that may never come, and once again at the end of each turn, which is
 * when consumption actually changed.
 *
 * A third moment was added later: an idle refresh on a timer. The two borders
 * above are both *consumption* events, and none of them is *time* — so a window
 * that resets while nobody is prompting kept showing the old utilization until
 * somebody sent a prompt. The tick stands down while a turn is in flight (that
 * turn's own end already refreshes) and dies with the query stream. A failed request leaves the session
 * running and reports nothing, and the live `rate_limit_event` forwarding — the
 * only source of a MEASURED status — keeps working alongside the new one.
 *
 * The SDK method is `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
 * (sdk.d.ts). The name is deliberately awful and deliberately pinned here: it
 * is the only name the real `Query` answers to, and a rename must fail loudly
 * rather than degrade to no report at all.
 */

// The interval's default parameter reads `process.env`, so a desktop that has
// CLAUDE_ACP_QUOTA_POLL_MS set — as this one does — silently changes what these
// tests measure. Cleared for every case in this file, and restored after, so the
// cadence under test is the code's and not the machine's.
let savedPollEnv: string | undefined;

beforeEach(() => {
  savedPollEnv = process.env.CLAUDE_ACP_QUOTA_POLL_MS;
  delete process.env.CLAUDE_ACP_QUOTA_POLL_MS;
});

afterEach(() => {
  if (savedPollEnv === undefined) {
    delete process.env.CLAUDE_ACP_QUOTA_POLL_MS;
  } else {
    process.env.CLAUDE_ACP_QUOTA_POLL_MS = savedPollEnv;
  }
});

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const SESSION_ID = "test-session";

/** The measured status a live `rate_limit_event` carries — a different window
 *  kind from the report fixture below, so the two payloads can never be
 *  confused for one another. */
const LIVE_RATE_LIMIT_INFO = {
  status: "rejected" as const,
  rateLimitType: "five_hour" as const,
  resetsAt: 1788436800,
  utilization: 0.9,
};

/** A report carrying exactly one window, at 42% of a weekly budget. */
function weeklyReport() {
  return {
    ...NO_PLAN_RATE_LIMITS,
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: { seven_day: { utilization: 42, resets_at: null } },
  };
}

/** Every `_meta["_claude/rateLimit"]` payload the client was sent. */
function quotaPayloads(notifications: SessionNotification[]): Record<string, unknown>[] {
  return notifications
    .map((notification) => (notification.update as Record<string, any>)?._meta)
    .map((meta) => meta?.["_claude/rateLimit"])
    .filter((payload): payload is Record<string, unknown> => Boolean(payload));
}

/** An assistant frame carrying usage, so the agent has a context total to
 *  attach to a subsequent notification. */
function assistantMessage() {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      id: "msg-account-usage",
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

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: () =>
      makeMockQuery({
        // A catalog with at least one model: `createSession` reads the current
        // model off it, so an empty one crashes before any usage request.
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
        [USAGE_METHOD]: () => sessionStartUsage(),
      }),
  };
});

vi.mock("../tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools.js")>();
  return { ...actual, registerHookCallback: vi.fn() };
});

let sessionStartUsage: () => Promise<unknown>;

describe("the structured usage report is requested at both borders, and while idle", () => {
  let notifications: SessionNotification[];
  let agent: ClaudeAcpAgent;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        notifications.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  /** One turn: echo the pushed prompt, emit `extra` frames, succeed, go idle. */
  async function* oneTurn(input: Pushable<any>, extra: unknown[] = []) {
    const iterator = input[Symbol.asyncIterator]();
    const { value: userMessage } = await iterator.next();
    yield userEcho(userMessage);
    for (const message of extra) {
      yield message;
    }
    yield successfulResultMessage();
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }

  /** Like `oneTurn`, but the stream stays OPEN afterwards, which is what the real
   *  long-lived consumer sees: it forwards background and between-turn output,
   *  so its query does not end when a turn does. The idle refresh lives entirely
   *  in that window, so a double that ends the stream closes the gap under test
   *  and would let a broken timer pass. */
  async function* turnsThenIdle(input: Pushable<any>, extra: unknown[] = []) {
    for await (const userMessage of input) {
      yield userEcho(userMessage);
      for (const message of extra) {
        yield message;
      }
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
  }

  /** Install a session whose stream outlives the turn (see `turnsThenIdle`). */
  function installLiveSession(usage: ReturnType<typeof vi.fn>, extra: unknown[] = []) {
    const input = new Pushable<any>();
    const query = Object.assign(wrapQuery(turnsThenIdle(input, extra)), {
      [USAGE_METHOD]: usage,
    });
    agent.sessions[SESSION_ID] = mockSessionState({ query, input }, agent);
    return input;
  }

  /** Install a session whose `Query` answers the usage request with `usage`. */
  function installSession(usage: ReturnType<typeof vi.fn>, extra: unknown[] = []) {
    const input = new Pushable<any>();
    const query = Object.assign(wrapQuery(oneTurn(input, extra)), { [USAGE_METHOD]: usage });
    agent.sessions[SESSION_ID] = mockSessionState({ query, input }, agent);
    return input;
  }

  /** A turn against a live stream. Unlike `runTurn` this does NOT await the
   *  consumer: a long-lived consumer only settles when the stream ends, so
   *  awaiting it here would hang. The prompt resolving is the turn ending; the
   *  refresh that follows is picked up with `waitFor`. */
  async function runTurnLive() {
    return agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "hello" }],
    });
  }

  async function runTurn() {
    const response = await agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "hello" }],
    });
    await agent.sessions[SESSION_ID]?.consumer;
    return response;
  }

  let runtimeDir: string;
  let savedRuntimeDir: string | undefined;

  beforeEach(async () => {
    // A private XDG_RUNTIME_DIR: without it these tests read the shared sample
    // this machine's real adapters are writing, and "did it fetch?" stops being
    // a question about the code.
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cadence-"));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    notifications = [];
    sessionStartUsage = async () => weeklyReport();
    agent = new ClaudeAcpAgent(createMockClient(), { log: () => {}, error: () => {} });
  });

  afterEach(async () => {
    // A session's poll timer outlives the test that armed it: nothing here closes
    // the session, and `clearInterval` lives in `closeQueryStream`. Left running,
    // a previous case's timer keeps ticking into the next one and overwrites the
    // shared sample under it — which is exactly how the reuse case failed in the
    // suite while passing alone.
    for (const session of Object.values(agent.sessions)) {
      if (session?.accountUsageTimer) {
        clearInterval(session.accountUsageTimer);
        session.accountUsageTimer = undefined;
      }
    }
    if (savedRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
    }
    // `rm` lists the directory, unlinks what it found, then rmdirs -- and the write
    // it races with is `void writeLimits(report)` in acp-agent.ts, fire-and-forget by
    // design, so no test can await it. A `rename` landing between the unlink and the
    // rmdir leaves the directory non-empty, and the teardown throws ENOTEMPTY on a
    // case whose every assertion passed. Reproduced 1 run in 8 locally; it is what
    // failed the 0.16.0 release PR on code that was green on main. The retries are
    // Node's own answer to exactly this -- ENOTEMPTY and EBUSY are in their contract.
    await fsp.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("issues exactly one request when the session is established (R1.1)", async () => {
    const usage = vi.fn(async () => weeklyReport());
    sessionStartUsage = usage;

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    // Waited for rather than asserted outright: the request may be issued
    // without blocking `session/new`, which R1.1 permits — it only forbids the
    // first prompt being answered before the report was asked for.
    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one request when a turn ends (R1.2)", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage);

    await runTurn();

    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    expect(usage).toHaveBeenCalledTimes(1);
    // The report was not merely fetched: its window reached the client, on the
    // 0..1 scale (R1.3).
    expect(quotaPayloads(notifications)).toContainEqual(
      expect.objectContaining({ rateLimitType: "seven_day", utilization: 0.42 }),
    );
  });

  it("survives a rejected request without emitting or throwing (R1.7)", async () => {
    const usage = vi.fn(async () => {
      throw new Error("get_usage is experimental and just changed shape");
    });
    installSession(usage);

    const response = await runTurn();

    // The request has to have been ISSUED for its failure to mean anything —
    // an adapter that never calls it also never emits and never throws.
    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    expect(response.stopReason).toBe("end_turn");
    expect(quotaPayloads(notifications)).toEqual([]);
  });

  it("keeps forwarding a live rate-limit event verbatim beside the derived windows (R1.8)", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage, [
      assistantMessage(),
      {
        type: "rate_limit_event",
        rate_limit_info: LIVE_RATE_LIMIT_INFO,
        uuid: randomUUID(),
        session_id: SESSION_ID,
      },
    ]);

    await runTurn();

    const payloads = quotaPayloads(notifications);
    // The measured payload passes through untouched: it is the only source of a
    // `rejected` status, and `0011` ranks by status before utilization.
    const measured = payloads.filter(
      (payload) => JSON.stringify(payload) === JSON.stringify(LIVE_RATE_LIMIT_INFO),
    );
    expect(measured).toHaveLength(1);

    // …and it did not REPLACE the derived windows, nor they it: the two sources
    // coexist and stay distinguishable.
    const derived = payloads.filter((payload) => payload.rateLimitType === "seven_day");
    expect(derived).toHaveLength(1);
    expect(derived[0]).toEqual(expect.objectContaining({ utilization: 0.42 }));
  });

  it("asks for the plan limits without the transcript scan", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage);

    await runTurn();

    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    // Nothing on this path reads `behaviors`, and filling it costs a scan of
    // every local transcript. Pinned as an argument rather than left to a
    // default so the cost cannot come back silently.
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
  });

  it("ticks while idle, and asks the polled path for a shared sample", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
    try {
      const usage = vi.fn(async () => weeklyReport());
      installLiveSession(usage);

      await runTurnLive();
      // Wait for the ARM, not just for the turn: it happens in the consumer's
      // `finally`, which settles after the prompt resolves.
      await vi.waitFor(() => expect(agent.sessions[SESSION_ID]?.accountUsageTimer).toBeDefined());

      // Asserted at the call, not at its effect. Everything the tick DOES now
      // begins with a filesystem read, and that promise settles on the
      // threadpool — outside what `advanceTimersByTimeAsync` drains — so an
      // assertion about the outcome races the work it is asserting. What this
      // case owns is narrower and stable: while idle, the timer fires, and it
      // asks for the SHARED sample rather than paying for its own.
      const polled = vi
        .spyOn(
          agent as unknown as { publishAccountUsage: () => Promise<boolean> },
          "publishAccountUsage",
        )
        .mockResolvedValue(false);

      await vi.advanceTimersByTimeAsync(30_000);

      // Nine tenths of the 30 s default: see `sharedSampleMaxAgeMs`.
      expect(polled).toHaveBeenCalledWith(SESSION_ID, expect.anything(), {
        cacheMaxAgeMs: 27_000,
      });
      polled.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops refreshing once the session's stream is closed", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installLiveSession(usage);

    await runTurnLive();
    // Armed is a FACT, not a timing outcome: it is set synchronously in the
    // consumer's `finally`. Asserting it — rather than counting the fetches a
    // tick produces — is what makes "stopped" distinguishable from "never
    // started" without depending on when a filesystem read lands. Counting was
    // tried and passed locally while failing on a CI runner.
    await vi.waitFor(() => expect(agent.sessions[SESSION_ID]?.accountUsageTimer).toBeDefined());

    const session = agent.sessions[SESSION_ID]!;
    await agent.closeSession({ sessionId: SESSION_ID });

    // A timer that outlives its stream does not fail loudly — it just asks a
    // dead session for a report every interval, forever. `closeQueryStream` is
    // the one point every teardown path passes through, which is why the
    // `clearInterval` lives there and nowhere else.
    expect(session.accountUsageTimer).toBeUndefined();
  });

  it("reuses a sample another process already paid for", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage);
    await runTurn();
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1));
    // This process shares its own sample fire-and-forget. Wait for that write to
    // land first: under load it arrived AFTER the one below and overwrote it, so
    // the poll read this process's 42% back instead of the other's 99% -- 2 of 4
    // full runs failed that way on 2026-09-26, and every run alone passed.
    await vi.waitFor(async () =>
      expect(await fsp.readFile(quotaCachePath(), "utf8")).toContain('"utilization":42'),
    );

    // A DIFFERENT adapter process publishes a sample. That is the whole point:
    // ten Zed windows asking one account the same question should cost one
    // request and — because they read one sample instead of each taking their
    // own at its own instant — should agree.
    //
    // 99, not 0.99: a raw report carries percentages (`weeklyReport()` says 42
    // for 42%) and `normalizeUtilization` divides by 100 on the way out.
    await writeLimits({
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 99 } },
    } as never);

    // The polled path, invoked directly. Driving it through the timer instead
    // made the assertion depend on fake-clock arithmetic rather than on the
    // contract, and it failed in the suite while passing alone. The timer's own
    // wiring is covered by the two cases around this one.
    const session = agent.sessions[SESSION_ID]!;
    await (
      agent as unknown as {
        publishAccountUsage: (
          id: string,
          s: typeof session,
          o: { cacheMaxAgeMs: number },
        ) => Promise<boolean>;
      }
    ).publishAccountUsage(SESSION_ID, session, { cacheMaxAgeMs: 27_000 });

    // No second request...
    expect(usage).toHaveBeenCalledTimes(1);
    // ...and not merely silence: it published the OTHER process's numbers.
    expect(quotaPayloads(notifications)).toContainEqual(
      expect.objectContaining({ rateLimitType: "seven_day", utilization: 0.99 }),
    );
  });

  it("still fetches once the shared sample has aged out", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage);
    await runTurn();
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1));
    // Same race as the case above: this process's fire-and-forget sample must be on
    // disk before the aged one is written, or it can land after it and leave a
    // FRESH sample behind -- then no fetch happens. It failed exactly that way in
    // the mirror's CI on 2026-09-26, after the case above had been fixed alone.
    await vi.waitFor(async () =>
      expect(await fsp.readFile(quotaCachePath(), "utf8")).toContain('"utilization":42'),
    );

    // A sample from two minutes ago: past the freshness window whatever the
    // interval, so the polled path must pay for a new one. Somebody has to, or
    // sharing would mean the account is never sampled again.
    await writeLimits(
      { rate_limits_available: true, rate_limits: { seven_day: { utilization: 7 } } } as never,
      Date.now() - 120_000,
    );

    // Invoked directly rather than driven through the timer. Deciding a miss
    // now takes a filesystem read, and that promise settles on the threadpool —
    // outside what `advanceTimersByTimeAsync` drains — so a timer-driven version
    // of this assertion races the fetch it is asserting. The timer's own
    // behaviour is covered by the two cases around this one: that it fires while
    // idle, and that it stops when the stream closes.
    const session = agent.sessions[SESSION_ID]!;
    await (
      agent as unknown as {
        publishAccountUsage: (
          id: string,
          s: typeof session,
          o: { cacheMaxAgeMs: number },
        ) => Promise<boolean>;
      }
    ).publishAccountUsage(SESSION_ID, session, { cacheMaxAgeMs: 27_000 });

    expect(usage).toHaveBeenCalledTimes(2);
  });

  it("does not let a fresh shared sample stand in for a turn's own refresh", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage);
    await writeLimits({
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 50 } },
    } as never);

    await runTurn();

    // R1.2: a turn ending is the moment THIS session's consumption changed, so
    // it asks for itself. Reading a sample taken before the turn would report
    // the account as it was before the tokens this turn just spent.
    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    expect(usage).toHaveBeenCalledTimes(1);
    // The share is fired and not awaited, so wait for it rather than assuming
    // it beat this assertion.
    await vi.waitFor(async () =>
      expect(await fsp.readFile(quotaCachePath(), "utf8")).toContain('"utilization":42'),
    );
  });
});

describe("the idle refresh interval is read from the environment", () => {
  it("defaults when unset or empty", () => {
    // 30 s since the quota tooltip (it was 60 s): the tooltip shows the windows
    // as numbers, so a minute-old reading was visible as one.
    expect(quotaPollIntervalMs(undefined)).toBe(30_000);
    expect(quotaPollIntervalMs("   ")).toBe(30_000);
  });

  it("treats exactly 0 as off, because that is the only way to ask", () => {
    expect(quotaPollIntervalMs("0")).toBe(0);
  });

  it("raises anything under the floor rather than honouring it", () => {
    // Each tick is a control request, and neither window moves fast enough for
    // a tighter loop to show something a 15-second one would miss.
    expect(quotaPollIntervalMs("1")).toBe(15_000);
    expect(quotaPollIntervalMs("20000")).toBe(20_000);
    // The env override still wins over the default, in both directions.
    expect(quotaPollIntervalMs("60000")).toBe(60_000);
  });

  it("falls back to the default on garbage, never to off", () => {
    // A typo must not silently restore the stale-bars behaviour this exists to
    // fix; only an explicit 0 may do that.
    expect(quotaPollIntervalMs("banana")).toBe(30_000);
    expect(quotaPollIntervalMs("-5")).toBe(30_000);
  });
});
