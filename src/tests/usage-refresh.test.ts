// `_claude/usage/refresh` — the account quota windows on demand.
//
// Zeo calls it on every hover of the context ring, whose tooltip shows the
// windows (five-hour, weekly, model-scoped). Contract:
//   params `{ sessionId }`, result `{ refreshed }`; the windows themselves arrive
//   as the usual `usage_update` frames, one per window, before the answer;
//   concurrent calls share one control request; a shared sample younger than
//   USAGE_REFRESH_MAX_SAMPLE_AGE_MS is reused; skipped during a turn; a missing
//   report answers `false` and is logged, never thrown; an unknown session is
//   invalid params, like the `_claude/tasks` methods.
//
// Sessions are installed directly (no `newSession`), so the only usage request a
// test sees is the one the method under test issues.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  ClaudeAcpAgent,
  runAcp,
  USAGE_CAPABILITY_KEY,
  USAGE_CAPABILITY_VERSION,
  USAGE_REFRESH_MAX_SAMPLE_AGE_MS,
  USAGE_REFRESH_METHOD,
  type AcpClient,
} from "../acp-agent.js";
import { quotaCachePath, writeLimits } from "../quota-cache.js";
import { nodeToWebReadable, nodeToWebWritable, Pushable } from "../utils.js";
import { NO_PLAN_RATE_LIMITS } from "./helpers.js";
import { mockSessionState, wrapQuery } from "./session-doubles.js";

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const SESSION_ID = "usage-refresh-session";

/** A plan report with three windows: five-hour, weekly, and one model-scoped. */
function planReport(fiveHour = 12) {
  return {
    ...NO_PLAN_RATE_LIMITS,
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: fiveHour, resets_at: null },
      seven_day: { utilization: 40, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: 25, resets_at: null }],
    },
  };
}

function quotaPayloads(notifications: SessionNotification[]): Record<string, any>[] {
  return notifications
    .filter((n) => (n.update as any)?.sessionUpdate === "usage_update")
    .map((n) => (n.update as any)?._meta?.["_claude/rateLimit"])
    .filter(Boolean);
}

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let runtimeDir: string;
let savedRuntimeDir: string | undefined;
let savedApiKey: string | undefined;

beforeEach(async () => {
  // A private XDG_RUNTIME_DIR, so the shared sample is this test's and not the
  // one this machine's real adapters are writing.
  savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
  runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "usage-refresh-"));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  // An API key disables the shared sample; a developer shell may carry one.
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  if (savedRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
  // The sample is written fire-and-forget; see account-usage-cadence.test.ts.
  await fsp.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function setup(usage: ReturnType<typeof vi.fn>) {
  const notifications: SessionNotification[] = [];
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (n: SessionNotification) => {
        notifications.push(n);
      },
    } as unknown as AcpClient,
    { log: push, error: push },
  );
  const query = Object.assign(wrapQuery((async function* () {})()), { [USAGE_METHOD]: usage });
  agent.sessions[SESSION_ID] = mockSessionState(
    { query, input: new Pushable<any>() },
    agent,
    SESSION_ID,
  );
  return { agent, notifications, lines, session: agent.sessions[SESSION_ID]! };
}

describe("_claude/usage/refresh — outcomes", () => {
  it("publishes one usage_update per window and answers refreshed: true", async () => {
    const usage = vi.fn(async () => planReport());
    const { agent, notifications } = setup(usage);

    await expect(agent.refreshUsage({ sessionId: SESSION_ID })).resolves.toEqual({
      refreshed: true,
    });

    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
    const payloads = quotaPayloads(notifications);
    // One frame per window, never an aggregate: the client merges by kind.
    expect(payloads.map((p) => p.rateLimitType)).toEqual([
      "five_hour",
      "seven_day",
      "model_scoped",
    ]);
    expect(payloads[0]).toMatchObject({ utilization: 0.12 });
    expect(payloads[2]).toMatchObject({ utilization: 0.25 });
    // The same frame the turn end publishes: `usage_update` with both numbers.
    const frame = notifications[0].update as any;
    expect(frame).toMatchObject({ sessionUpdate: "usage_update", used: 0, size: 200000 });
    expect(notifications.every((n) => n.sessionId === SESSION_ID)).toBe(true);
  });

  it("issues ONE control request for two concurrent calls, and both see the result", async () => {
    const gate = deferred<void>();
    const usage = vi.fn(async () => {
      await gate.promise;
      return planReport();
    });
    const { agent, notifications } = setup(usage);

    const first = agent.refreshUsage({ sessionId: SESSION_ID });
    const second = agent.refreshUsage({ sessionId: SESSION_ID });
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { refreshed: true },
      { refreshed: true },
    ]);
    expect(usage).toHaveBeenCalledTimes(1);
    // Joined, not repeated: three windows published once, not twice.
    expect(quotaPayloads(notifications)).toHaveLength(3);
  });

  it("issues a new request once the previous one has settled", async () => {
    const usage = vi.fn(async () => planReport());
    const { agent } = setup(usage);

    await agent.refreshUsage({ sessionId: SESSION_ID });
    // The shared sample written by the first call is fresh; age it out so this
    // case measures the in-flight bookkeeping, not the cache.
    await vi.waitFor(async () =>
      expect(await fsp.readFile(quotaCachePath(), "utf8")).toContain('"utilization":12'),
    );
    await writeLimits(planReport(1) as never, Date.now() - 60_000);
    await agent.refreshUsage({ sessionId: SESSION_ID });

    expect(usage).toHaveBeenCalledTimes(2);
  });

  it("reuses a shared sample younger than the refresh window", async () => {
    const usage = vi.fn(async () => planReport());
    const { agent, notifications } = setup(usage);
    // Another process sampled the account 2 s ago, at 77% of the five-hour window.
    await writeLimits(planReport(77) as never, Date.now() - 2_000);

    await expect(agent.refreshUsage({ sessionId: SESSION_ID })).resolves.toEqual({
      refreshed: true,
    });

    expect(usage).not.toHaveBeenCalled();
    expect(quotaPayloads(notifications)[0]).toMatchObject({
      rateLimitType: "five_hour",
      utilization: 0.77,
    });
  });

  it("fetches when the shared sample is older than the refresh window", async () => {
    const usage = vi.fn(async () => planReport());
    const { agent, notifications } = setup(usage);
    // Fresh enough for the idle poll (27 s at the default), too old for a hover.
    await writeLimits(
      planReport(77) as never,
      Date.now() - (USAGE_REFRESH_MAX_SAMPLE_AGE_MS + 1_000),
    );

    await agent.refreshUsage({ sessionId: SESSION_ID });

    expect(usage).toHaveBeenCalledTimes(1);
    expect(quotaPayloads(notifications)[0]).toMatchObject({ utilization: 0.12 });
    // ...and shares what it paid for, for the other processes.
    await vi.waitFor(async () =>
      expect(await fsp.readFile(quotaCachePath(), "utf8")).toContain('"utilization":12'),
    );
  });

  it("names a five-second window", () => {
    expect(USAGE_REFRESH_MAX_SAMPLE_AGE_MS).toBe(5_000);
  });

  it("answers refreshed: false and logs when the report fails, without throwing", async () => {
    const usage = vi.fn(async () => {
      throw new Error("usage report went away");
    });
    const { agent, notifications, lines } = setup(usage);

    await expect(agent.refreshUsage({ sessionId: SESSION_ID })).resolves.toEqual({
      refreshed: false,
    });

    expect(quotaPayloads(notifications)).toEqual([]);
    expect(lines.some((l) => l.includes("structured usage report unavailable"))).toBe(true);
    expect(lines.some((l) => l.includes("[usage/refresh]") && l.includes("outcome=nothing"))).toBe(
      true,
    );
  });

  it("answers refreshed: false for a session with no plan windows (API key)", async () => {
    const usage = vi.fn(async () => ({ ...NO_PLAN_RATE_LIMITS }));
    const { agent, notifications } = setup(usage);

    await expect(agent.refreshUsage({ sessionId: SESSION_ID })).resolves.toEqual({
      refreshed: false,
    });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(quotaPayloads(notifications)).toEqual([]);
  });

  it("skips during a turn without a control request, answering refreshed: false", async () => {
    // Control requests are serialized: one queued here would sit in front of
    // the interrupt a Stop press sends (upstream #1216).
    const usage = vi.fn(async () => planReport());
    const { agent, session } = setup(usage);
    const turn = { settled: false } as never;
    session.turnQueue = [turn];
    session.activeTurn = turn;

    await expect(agent.refreshUsage({ sessionId: SESSION_ID })).resolves.toEqual({
      refreshed: false,
    });
    expect(usage).not.toHaveBeenCalled();
  });

  it("answers refreshed: false on a session whose stream has ended", async () => {
    const usage = vi.fn(async () => planReport());
    const { agent, session } = setup(usage);
    session.queryClosed = true;

    await expect(agent.refreshUsage({ sessionId: SESSION_ID })).resolves.toEqual({
      refreshed: false,
    });
    expect(usage).not.toHaveBeenCalled();
  });

  it("rejects an unknown session with invalid params naming it", async () => {
    const usage = vi.fn(async () => planReport());
    const { agent } = setup(usage);

    const error = await agent.refreshUsage({ sessionId: "no-such-session" }).catch((e) => e);
    expect(error?.code).toBe(-32602);
    expect(`${error?.message} ${JSON.stringify(error?.data ?? null)}`).toContain("no-such-session");
    expect(usage).not.toHaveBeenCalled();
  });
});

// ---- Over the wire ----------------------------------------------------------

/** `runAcp` on in-memory streams; see task-actions.test.ts for the stdio swap. */
function wire() {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
  Object.defineProperty(process, "stdin", { value: toAgent, configurable: true });
  Object.defineProperty(process, "stdout", { value: fromAgent, configurable: true });
  let started: ReturnType<typeof runAcp>;
  try {
    started = runAcp({ log: () => {}, error: () => {} });
  } finally {
    Object.defineProperty(process, "stdin", stdin);
    Object.defineProperty(process, "stdout", stdout);
  }
  const notifications: SessionNotification[] = [];
  const connection = acpClient({ name: "usage-refresh-test" })
    .onNotification(methods.client.session.update, (ctx: any) => {
      notifications.push(ctx.params);
    })
    .connect(ndJsonStream(nodeToWebWritable(toAgent), nodeToWebReadable(fromAgent)));
  return {
    request: (method: string, params: unknown) => connection.agent.request(method, params as any),
    agent: started.agent,
    notifications,
  };
}

describe("_claude/usage over JSON-RPC", () => {
  it("exports the wire names", () => {
    expect(USAGE_REFRESH_METHOD).toBe("_claude/usage/refresh");
    expect(USAGE_CAPABILITY_KEY).toBe("_claude/usage");
    expect(USAGE_CAPABILITY_VERSION).toBe(1);
  });

  it('initialize advertises agentCapabilities._meta["_claude/usage"] = { version: 1 }', async () => {
    const w = wire();
    const response: any = await w.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    expect(response?.agentCapabilities?._meta?.["_claude/usage"]).toEqual({ version: 1 });
    // Beside, not instead of, the task feed.
    expect(response?.agentCapabilities?._meta?.["_claude/tasks"]).toBeDefined();
  });

  it("routes the method, delivers the frames, and answers { refreshed }", async () => {
    const w = wire();
    const usage = vi.fn(async () => planReport());
    const query = Object.assign(wrapQuery((async function* () {})()), { [USAGE_METHOD]: usage });
    w.agent.sessions[SESSION_ID] = mockSessionState(
      { query, input: new Pushable<any>() },
      w.agent,
      SESSION_ID,
    );

    await expect(w.request(USAGE_REFRESH_METHOD, { sessionId: SESSION_ID })).resolves.toEqual({
      refreshed: true,
    });
    await vi.waitFor(() => expect(quotaPayloads(w.notifications)).toHaveLength(3));
  });

  it("answers invalid params for an unknown session and for a missing sessionId", async () => {
    const w = wire();

    const unknown: any = await w
      .request(USAGE_REFRESH_METHOD, { sessionId: "no-such-session" })
      .catch((e: any) => e);
    expect(unknown?.code).toBe(-32602);

    const missing: any = await w.request(USAGE_REFRESH_METHOD, {}).catch((e: any) => e);
    expect(missing?.code).toBe(-32602);
  });
});
