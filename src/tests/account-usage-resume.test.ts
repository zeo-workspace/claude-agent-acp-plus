import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { NO_PLAN_RATE_LIMITS, makeMockQuery } from "./helpers.js";
import { successfulResultMessage, userEcho, wrapQuery } from "./session-doubles.js";

/**
 * Story 002 — defect B3 of the CROSS-LANGUAGE BOUNDARY REVIEW of 2026-09-03,
 * where this adapter's `usage_update` meets the Rust ring in
 * `crates/acp_thread/src/acp_thread.rs`.
 *
 * **A resumed session's context ring was reset to zero.** `publishAccountUsage`
 * sends `session.contextUsedTokens ?? 0`, and that field was written only
 * mid-turn or at a turn's end — never seeded when the session was created. The
 * consumer's `UsageUpdate` arm assigns `used`/`size` unconditionally and
 * CREATES the usage record where there was none, so once R1.1 started emitting
 * at session establishment, a `session/load` of a thread carrying 150k of
 * context painted the ring as `0 / 200k`. Before R1.1 the same thread showed no
 * figure at all: an absent value had become an actively false one, and only for
 * claude.ai subscribers, since the emission is gated on `rate_limits_available`.
 *
 * The fix reads the number the adapter was already throwing away.
 * `readResumedLiveModel` awaits one `getContextUsage` on every resumed session
 * — that is how the live model and the authoritative window are restored — and
 * kept only two of its three useful fields. So these tests pin the seeding AND
 * the request count: a second control request on the session/load path is the
 * cure that would be worse than the disease (issues #886/#880).
 *
 * Zero is deliberately NOT absence here. A report of `totalTokens: 0` is a
 * genuinely empty resumed session and is carried through as a measured 0; only
 * an unread report leaves the field undefined. The two look alike on the wire
 * (`?? 0`) and differ where it matters — the permission request's
 * `contextUsedPercent` shows nothing for undefined and 0% for a measured zero —
 * which is why the zero case asserts on the session field itself.
 */

const SESSION_ID = "test-session";
const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/** The occupancy a resumed thread comes back carrying, and the window it sits
 *  in. The window is deliberately NOT the 200k default, so a payload that
 *  merely echoed the fallbacks could not pass for one built from the report. */
const RESUMED_USED = 151_000;
const RESUMED_WINDOW = 1_000_000;

/** The catalog the mocked SDK advertises. One model, matching what the resumed
 *  report names, so `matchResumedModel` lands on it without fuzzy matching. */
const MODEL = {
  value: "claude-sonnet-4-6",
  displayName: "Claude Sonnet",
  description: "Balanced",
  supportsAutoMode: true,
};

const { querySpy, getSessionMessagesSpy } = vi.hoisted(() => ({
  querySpy: vi.fn(),
  getSessionMessagesSpy: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: querySpy, getSessionMessages: getSessionMessagesSpy };
});

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

/** A `getContextUsage` response: the occupancy, the window it fills, and the
 *  model the session is live on — the one response the resumed path reads. */
function contextUsage(totalTokens: number, rawMaxTokens = RESUMED_WINDOW) {
  return { totalTokens, rawMaxTokens, model: MODEL.value };
}

/** A structured `/usage` report carrying exactly one quota window, so every
 *  account-quota `usage_update` this suite reads has a known origin. Plan rate
 *  limits must be AVAILABLE: the emission is gated on them, which is why this
 *  defect only ever reached claude.ai subscribers. */
function weeklyReport() {
  return {
    ...NO_PLAN_RATE_LIMITS,
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: { seven_day: { utilization: 42, resets_at: null } },
  };
}

/** The `used`/`size` pair of every account-quota `usage_update` the client was
 *  sent, in order. Filtered on the `_meta` payload rather than on the update
 *  kind alone: a turn emits its own `usage_update`s without one, and this
 *  defect is about the notifications the quota path adds. */
function quotaUpdates(notifications: SessionNotification[]): { used: number; size: number }[] {
  return notifications
    .map((notification) => notification.update as Record<string, any>)
    .filter(
      (update) => update?.sessionUpdate === "usage_update" && update?._meta?.["_claude/rateLimit"],
    )
    .map((update) => ({ used: update.used as number, size: update.size as number }));
}

/** An assistant frame whose usage totals {@link TURN_USED} tokens. */
const TURN_USED = 32_000;
function assistantMessage() {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      id: "msg-resume-seed",
      model: MODEL.value,
      role: "assistant",
      type: "message",
      stop_reason: null,
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 30_000,
        output_tokens: 500,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 500,
      },
    },
  };
}

/** One turn: echo the pushed prompt, emit `extra` frames, succeed, go idle. */
async function* oneTurn(input: AsyncIterable<SDKUserMessage>, extra: unknown[] = []) {
  const iterator = input[Symbol.asyncIterator]();
  const { value: userMessage } = await iterator.next();
  yield userEcho(userMessage);
  for (const message of extra) {
    yield message;
  }
  yield successfulResultMessage();
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
}

describe("a resumed session's context ring starts where the session left off (B3)", () => {
  let tempDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;
  let originalModelEnv: string | undefined;
  let notifications: SessionNotification[];
  let loggedErrors: string[];

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

  async function makeAgent(): Promise<ClaudeAcpAgentType> {
    // Imported per test, after CLAUDE_CONFIG_DIR is pointed at the empty temp
    // dir: the agent reads that env var into a module-level const at import.
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    return new ClaudeAcpAgent(createMockClient(), {
      log: () => {},
      error: (...args: unknown[]) => loggedErrors.push(args.map(String).join(" ")),
    });
  }

  /** Install a non-iterating query — enough for a session/new or session/load,
   *  which never advance the stream. */
  function installQuery(overrides: Record<string, unknown> = {}) {
    querySpy.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({ models: [MODEL] }),
        [USAGE_METHOD]: async () => weeklyReport(),
        ...overrides,
      }),
    );
  }

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "account-usage-resume-"));
    projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });
    // Empty every settings tier this run can reach, and clear the env pin. A
    // model resolved from either would send session/load down the branch that
    // re-asserts the pin instead of reading the live model — a real case, and
    // the one covered separately below.
    await fs.promises.writeFile(path.join(tempDir, "settings.json"), "{}");
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    originalModelEnv = process.env.ANTHROPIC_MODEL;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    delete process.env.ANTHROPIC_MODEL;
    notifications = [];
    loggedErrors = [];
    querySpy.mockReset();
    getSessionMessagesSpy.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    if (originalModelEnv === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = originalModelEnv;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("reports the occupancy the resumed session came back with, not 0", async () => {
    const getContextUsage = vi.fn(async () => contextUsage(RESUMED_USED));
    installQuery({ getContextUsage });
    const agent = await makeAgent();

    await agent.loadSession({ sessionId: SESSION_ID, cwd: projectDir, mcpServers: [] });

    // The R1.1 report is issued without being awaited, so wait for its window
    // rather than asserting on a race. The wait itself is the first half of the
    // assertion: an adapter that emitted NOTHING here would time out, which is
    // the shape of the pre-R1.1 behaviour this defect replaced.
    await vi.waitFor(() => expect(quotaUpdates(notifications).length).toBeGreaterThan(0));
    expect(quotaUpdates(notifications)).toEqual([{ used: RESUMED_USED, size: RESUMED_WINDOW }]);

    // ...and it cost no extra IPC: ONE `getContextUsage` served the live model,
    // the window and the occupancy. A second call here would be the ~15s stall
    // of issues #886/#880 creeping back onto the load path.
    expect(getContextUsage).toHaveBeenCalledTimes(1);
  });

  it("still reports 0 for a fresh session, whatever the report would have said", async () => {
    // The stub answers with a large occupancy on purpose: session/new must
    // reach `used: 0` because it never reads the occupancy, not because the
    // answer was small. The report IS asked for once, unawaited, to refine a
    // guessed window (upstream #1186); it never answers here, so the window
    // stays the default and the occupancy is never taken from it.
    const getContextUsage = vi.fn(() => new Promise<never>(() => {}));
    installQuery({ getContextUsage });
    const agent = await makeAgent();

    await agent.newSession({ cwd: projectDir, mcpServers: [] });

    await vi.waitFor(() => expect(quotaUpdates(notifications).length).toBeGreaterThan(0));
    // 200_000 is the default window: a fresh session has neither an occupancy
    // nor an authoritative window until its first turn confirms one.
    expect(quotaUpdates(notifications)).toEqual([{ used: 0, size: 200_000 }]);
    expect(getContextUsage).toHaveBeenCalledOnce();
  });

  it("keeps a measured zero distinguishable from an unread report", async () => {
    const getContextUsage = vi.fn(async () => contextUsage(0));
    installQuery({ getContextUsage });
    const agent = await makeAgent();

    await agent.loadSession({ sessionId: SESSION_ID, cwd: projectDir, mcpServers: [] });

    // On the wire the two collapse (`contextUsedTokens ?? 0`), so the field is
    // where the distinction lives: `undefined` makes the permission request
    // omit `contextUsedPercent` entirely, a measured 0 makes it say 0%.
    expect(agent.sessions[SESSION_ID]?.contextUsedTokens).toBe(0);
    await vi.waitFor(() => expect(quotaUpdates(notifications).length).toBeGreaterThan(0));
    expect(quotaUpdates(notifications)).toEqual([{ used: 0, size: RESUMED_WINDOW }]);
  });

  it("lets the first turn's own accounting supersede the seed", async () => {
    const getContextUsage = vi.fn(async () => contextUsage(RESUMED_USED));
    querySpy.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      Object.assign(wrapQuery(oneTurn(prompt, [assistantMessage()])), {
        initializationResult: async () => ({ models: [MODEL] }),
        setPermissionMode: async () => {},
        supportedCommands: async () => [],
        getContextUsage,
        [USAGE_METHOD]: async () => weeklyReport(),
      }),
    );
    const agent = await makeAgent();

    await agent.loadSession({ sessionId: SESSION_ID, cwd: projectDir, mcpServers: [] });
    await vi.waitFor(() => expect(quotaUpdates(notifications).length).toBeGreaterThan(0));

    await agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "hello" }] });
    await agent.sessions[SESSION_ID]?.consumer;

    // Two reports, two borders (R1.1 then R1.2): the seed is a starting value,
    // not a floor. The turn's own measurement replaces it — including when it
    // is far lower, which is what a compacted or short-history thread looks
    // like — and the seed is never re-applied afterwards.
    await vi.waitFor(() => expect(quotaUpdates(notifications).length).toBe(2));
    expect(quotaUpdates(notifications)).toEqual([
      { used: RESUMED_USED, size: RESUMED_WINDOW },
      { used: TURN_USED, size: RESUMED_WINDOW },
    ]);
  });

  it("loads the session anyway when the report rejects", async () => {
    const getContextUsage = vi.fn(async () => {
      throw new Error("get_context_usage control request failed");
    });
    installQuery({ getContextUsage });
    const agent = await makeAgent();

    // Best-effort by design: `readResumedLiveModel` catches and logs, because
    // failing a whole session/load over an unreadable report would be worse
    // than loading it without the model, the window and the occupancy.
    await expect(
      agent.loadSession({ sessionId: SESSION_ID, cwd: projectDir, mcpServers: [] }),
    ).resolves.toBeDefined();
    expect(agent.sessions[SESSION_ID]).toBeDefined();
    expect(getContextUsage).toHaveBeenCalled();
    expect(loggedErrors.some((line) => line.includes("live model"))).toBe(true);

    // Nothing was read, so nothing is claimed: the field stays undefined and
    // the quota payload falls back to 0 exactly as it did before the seeding.
    expect(agent.sessions[SESSION_ID]?.contextUsedTokens).toBeUndefined();
    await vi.waitFor(() => expect(quotaUpdates(notifications).length).toBeGreaterThan(0));
    expect(quotaUpdates(notifications)).toEqual([{ used: 0, size: 200_000 }]);
  });

  /**
   * Ported half of upstream #1089 (`fix: restore session forks and speed up
   * loading`), and the half this fork could take.
   *
   * Upstream removed the `getContextUsage` call outright, because the model was
   * the only thing it wanted from that response. This fork reads THREE values
   * out of it — the model, `rawMaxTokens` and `totalTokens` — and the window
   * and occupancy have no second source, so the request stays. What was taken
   * is the local transcript as the model's FIRST source, read in parallel with
   * the request rather than instead of it.
   *
   * That changes exactly one observable thing, and it is the case above: when
   * the report rejects, the session used to fall back to the freshly-computed
   * default model, reopening issue #845 at the moment the session was least
   * healthy. The transcript is the same field Claude Code itself restores a
   * resumed query from, it is a file read rather than IPC, and it still answers.
   *
   * The request COUNT is unchanged and this suite's premise survives: a second
   * control request on the session/load path would be the cure worse than the
   * disease (issues #886/#880), and a file read is not one.
   */
  it("restores the model from the transcript when the report rejects (upstream #1089)", async () => {
    // TWO models, and the resumed one is NOT models[0]. With a single-model
    // catalog this test passes against the old behaviour too -- the default and
    // the transcript's answer are the same string, so nothing is being
    // discriminated. Verified by reverting the change and watching it stay
    // green; the second model is what makes it go red.
    const OTHER_MODEL = { ...MODEL, value: "claude-opus-4-6", displayName: "Claude Opus" };
    const getContextUsage = vi.fn(async () => {
      throw new Error("get_context_usage control request failed");
    });
    // A transcript whose last real assistant record names the live model.
    getSessionMessagesSpy.mockResolvedValueOnce([
      { type: "assistant", message: { model: OTHER_MODEL.value } },
    ]);
    installQuery({
      getContextUsage,
      initializationResult: async () => ({ models: [MODEL, OTHER_MODEL] }),
    });
    const agent = await makeAgent();

    await expect(
      agent.loadSession({ sessionId: SESSION_ID, cwd: projectDir, mcpServers: [] }),
    ).resolves.toBeDefined();

    // The model survives the failed report -- this is the whole point. Before
    // the port this was MODEL.value, the freshly-computed default (models[0]).
    expect(agent.sessions[SESSION_ID]?.models.currentModelId).toBe(OTHER_MODEL.value);
    // And the request was still made: the window and occupancy still need it,
    // once on the load path -- and once more in the background, because the
    // failed report left the window a guess (upstream #1186's refresh).
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    // Which is why those two are still absent when it fails.
    expect(agent.sessions[SESSION_ID]?.contextUsedTokens).toBeUndefined();
  });
});
