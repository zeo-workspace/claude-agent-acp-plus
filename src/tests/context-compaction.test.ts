import { describe, it, expect, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  CONTEXT_COMPACTION_META_KEY,
  CONTEXT_COMPACTION_META_VERSION,
  createContextCompactionMeta,
} from "../context-compaction-meta.js";
import {
  ContextCompactionLifecycle,
  contextCompactionMetadataFromBoundary,
} from "../context-compaction.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * R2.1 / R2.2 - compaction is reported as one ACP tool lifecycle carrying a
 * versioned `_meta.contextCompaction`, and the `compactionInProgress` inference
 * that used to report it is gone rather than left inert.
 *
 * The load-bearing case is duplicate-terminal, in both converse directions:
 *   - two terminal signals for ONE compaction must not become two reports
 *     (wrongly split);
 *   - two genuinely separate compactions in one turn must not collapse into one
 *     (wrongly collapsed).
 * A suite that only checked the benign single-compaction case would stay green
 * against a fix that satisfies either converse by violating the other.
 */

type Update = Record<string, any>;

function capture() {
  const updates: Update[] = [];
  const sendUpdate = vi.fn(async (notification: SessionNotification) => {
    updates.push(notification.update as unknown as Update);
  });
  return { updates, sendUpdate };
}

function isToolUpdate(update: Update): boolean {
  return update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
}

describe("context compaction metadata", () => {
  it("carries a schema version under its own _meta key", () => {
    // D3: the downstream patch reads the version and degrades on any value it
    // does not know. A payload without one cannot be degraded from.
    const meta = createContextCompactionMeta({ trigger: "manual", preTokens: 180_000 });

    expect(Object.keys(meta)).toEqual([CONTEXT_COMPACTION_META_KEY]);
    expect(CONTEXT_COMPACTION_META_KEY).toBe("contextCompaction");
    expect(typeof CONTEXT_COMPACTION_META_VERSION).toBe("number");
    expect(CONTEXT_COMPACTION_META_VERSION).toBeGreaterThanOrEqual(1);
    expect(meta[CONTEXT_COMPACTION_META_KEY]).toMatchObject({
      version: CONTEXT_COMPACTION_META_VERSION,
      trigger: "manual",
      preTokens: 180_000,
    });
  });

  it("maps a compact boundary onto provider-neutral names", () => {
    expect(
      contextCompactionMetadataFromBoundary({
        trigger: "auto",
        pre_tokens: 180_000,
        post_tokens: 12_345,
        duration_ms: 2_500,
      }),
    ).toEqual({
      trigger: "automatic",
      preTokens: 180_000,
      postTokens: 12_345,
      durationMs: 2_500,
    });
  });

  it("omits boundary fields an older SDK frame does not carry", () => {
    expect(contextCompactionMetadataFromBoundary({ trigger: "manual", pre_tokens: 42 })).toEqual({
      trigger: "manual",
      preTokens: 42,
    });
  });
});

describe("ContextCompactionLifecycle - one shape per event", () => {
  it("status 'compacting' opens the tool call the client renders", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "compact-start",
      title: "Compact conversation",
      kind: "think",
      status: "in_progress",
      _meta: { [CONTEXT_COMPACTION_META_KEY]: { version: CONTEXT_COMPACTION_META_VERSION } },
    });
    expect(lifecycle.hasDeliveredOutput).toBe(true);
  });

  it("stream heartbeats update the open call once and never leak the summary", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-delta-1");
    await lifecycle.heartbeat("test-session", "compact-delta-1");
    await lifecycle.heartbeat("test-session", "compact-delta-2");

    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "compact-delta-1",
      status: "in_progress",
    });
    // The generated summary is internal to the agent; nothing about it reaches
    // the client through this lane.
    expect(JSON.stringify(updates)).not.toContain("summary");
  });

  it("a terminal-only result still produces one completed tool call", async () => {
    // The SDK omits the opening status on replay, so the terminal signal has to
    // be able to stand alone rather than be dropped for lack of a start.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.finish("test-session", "compact-result", "completed");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "compact-result",
      title: "Compact conversation",
      kind: "think",
      status: "completed",
    });
  });

  it("a failure carries its reason on the same lifecycle", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start");
    await lifecycle.finish("test-session", "compact-start", "failed", {
      error: "summary rejected",
    });

    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "compact-start",
      status: "failed",
      _meta: {
        [CONTEXT_COMPACTION_META_KEY]: {
          version: CONTEXT_COMPACTION_META_VERSION,
          error: "summary rejected",
        },
      },
    });
    // Claude also emits that error as local-command stdout; the duplicate is
    // consumed once, and only when it is the same text.
    expect(lifecycle.consumeDuplicateErrorOutput("summary rejected")).toBe(true);
    expect(lifecycle.consumeDuplicateErrorOutput("summary rejected")).toBe(false);
    expect(lifecycle.consumeDuplicateErrorOutput("additional diagnostic")).toBe(false);
  });

  it("HOSTILE - two terminal signals for one compaction stay one report", async () => {
    // The SDK duplicates terminal compact_result messages. One compaction is one
    // lifecycle: the second terminal must change nothing the client can see.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start");
    await lifecycle.finish("test-session", "compact-start", "failed", {
      error: "summary rejected",
    });
    await lifecycle.finish("test-session", "compact-start", "failed", {
      error: "summary rejected",
    });

    expect(updates.filter(isToolUpdate)).toHaveLength(2);
    expect(updates.filter((update) => update.status === "failed")).toHaveLength(1);
  });

  it("HOSTILE (converse) - two compactions in one turn stay two reports", async () => {
    // The converse defect: a rule that suppressed the second terminal by
    // identity would also swallow a genuine second compaction. The two must stay
    // distinguishable - different tool call ids, one terminal each.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start-1");
    await lifecycle.finish("test-session", "compact-start-1", "completed");
    await lifecycle.start("test-session", "compact-start-2");
    await lifecycle.finish("test-session", "compact-start-2", "completed");

    const ids = updates.filter(isToolUpdate).map((update) => update.toolCallId);
    expect(new Set(ids).size).toBe(2);
    expect(updates.filter((update) => update.status === "completed")).toHaveLength(2);
  });

  it("reset returns the lifecycle to its unstarted state between turns", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "turn-1-compaction");
    await lifecycle.finish("test-session", "turn-1-compaction", "completed");
    lifecycle.reset();
    expect(lifecycle.hasDeliveredOutput).toBe(false);

    await lifecycle.start("test-session", "turn-2-compaction");
    expect(updates.at(-1)).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "turn-2-compaction",
      status: "in_progress",
    });
  });
});

/**
 * Upstream a05aca6 (#1154): "force cancellation could return
 * `stopReason: cancelled` while leaving the compaction `in_progress`". Upstream
 * fixed it with one shared idempotent cleanup across six call sites. None of
 * those call sites exists here as written -- this fork reports compaction on a
 * synthetic tool call carrying `_meta.contextCompaction`, not on ACP's native
 * `compaction_update` -- so whether the same leak exists here is a question
 * about THIS code, and these cases are the answer.
 *
 * WHAT "LEFT OPEN" MEANS, and why it is phrased over frames. There is no public
 * observable for an open compaction: `activeCompaction` is private, and the
 * lifecycle is a `const` local inside the consumer, unreachable from the
 * session. The only thing outside the class that can see anything is the update
 * stream -- which is also the only thing a CLIENT can see, so it is the right
 * place for the assertion rather than a concession. `reset()` emits nothing, so
 * the three paths that do call it still leave the last frame the client saw at
 * `in_progress` forever: a compaction row that spins for the rest of the session.
 *
 * WHY THIS GOES BEYOND UPSTREAM, deliberately. Upstream's own `interrupt()`
 * leaves its legacy tool-call presentation untouched, saying so in as many
 * words: ACP `ToolCallStatus` has no `cancelled` state. This fork has only that
 * presentation -- and, unlike upstream, it has a downstream reader for the
 * terminal. Patch 0017 maps `acp::ToolCallStatus::Failed` to
 * `ContextCompactionStatus::Canceled` precisely because the crate's enum has no
 * failure state. So a terminal `failed` here is not an invented convention: it
 * is the one the other half of this chain was already built to receive.
 */
describe("no compaction survives an interruption (#1154)", () => {
  /**
   * The invariant, read off the wire: every tool call that was announced
   * `in_progress` must later carry a terminal status under the same id.
   *
   * Written as a fold rather than "the last frame is terminal" on purpose -- two
   * compactions in one turn are two ids, and a suite that only looked at the
   * last frame would call the first one closed because the second one closed.
   */
  function stillOpen(updates: Update[]): string[] {
    const open = new Set<string>();
    for (const update of updates) {
      if (!isToolUpdate(update)) continue;
      if (update.status === "in_progress") open.add(update.toolCallId);
      else if (update.status !== undefined) open.delete(update.toolCallId);
    }
    return [...open];
  }

  // --- the lifecycle's own contract ----------------------------------------

  it("interrupt closes an open compaction on the wire, not just in memory", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-1");
    expect(stillOpen(updates)).toEqual(["compact-1"]);

    await lifecycle.interrupt("test-session");

    expect(stillOpen(updates)).toEqual([]);
    expect(updates.at(-1)).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "compact-1",
      status: "failed",
      // Distinguishable from a compaction that genuinely failed. The field is
      // the adapter's existing vocabulary for exactly this -- "why the tool
      // never actually ran, so a client can render the cancellation distinctly
      // from a real tool failure" -- and without it the two are one status.
      _meta: { claudeCode: { nonExecutionKind: "interrupted" } },
    });
  });

  it("HOSTILE - reset alone leaves the client looking at in_progress forever", async () => {
    // The characterisation that says why interrupt() has to exist. The existing
    // reset case calls it on an ALREADY-TERMINAL lifecycle, so it never observed
    // this; reset drops the reference without sending anything, and the frame it
    // abandons is the one the client is still rendering.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-1");
    lifecycle.reset();

    expect(stillOpen(updates)).toEqual(["compact-1"]);
  });

  it("interrupt is idempotent, and silent when there is nothing open", async () => {
    // It is called from several paths that can run in sequence for one turn, so
    // a second call must not add a second terminal -- the same duplicate-guard
    // the SDK's repeated terminals already get.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.interrupt("test-session");
    expect(updates).toHaveLength(0);

    await lifecycle.start("test-session", "compact-1");
    await lifecycle.interrupt("test-session");
    await lifecycle.interrupt("test-session");
    expect(updates.filter((u) => u.status === "failed")).toHaveLength(1);

    await lifecycle.start("test-session", "compact-2");
    await lifecycle.finish("test-session", "compact-2", "completed");
    await lifecycle.interrupt("test-session");
    expect(updates.filter((u) => u.status === "completed")).toHaveLength(1);
    expect(stillOpen(updates)).toEqual([]);
  });
});

/**
 * The same invariant, driven through the agent's own interruption paths. The
 * block above proves the lifecycle CAN close itself; these prove each path
 * actually asks it to, which is the half a unit test cannot reach -- the
 * lifecycle is a `const` local inside the consumer, so nothing but the agent
 * can call it, and nothing but the update stream can see that it did.
 *
 * Four paths, named because upstream's six do not map onto this fork:
 * an ordinary cancel that reaches its trailing idle, a force cancellation that
 * never does, the SDK stream ending mid-compaction, and a conversation reset
 * arriving while one is open.
 */
describe("no compaction survives an interruption - the agent's own paths", () => {
  function stillOpen(updates: Update[]): string[] {
    const open = new Set<string>();
    for (const update of updates) {
      if (!isToolUpdate(update)) continue;
      if (update.status === "in_progress") open.add(update.toolCallId);
      else if (update.status !== undefined) open.delete(update.toolCallId);
    }
    return [...open];
  }

  const compactingStatus = {
    type: "system",
    subtype: "status",
    status: "compacting",
    uuid: "compact-start",
    session_id: "test-session",
  };

  /**
   * A turn that stops mid-compaction and stays there until the case lets it go.
   * `before` is yielded, then the generator waits on the gate; `after` is what
   * the SDK still has to say once the case releases it -- empty for the paths
   * where the point is that it never says anything more.
   */
  function heldTurn(before: any[], after: any[] = []) {
    const updates: SessionNotification[] = [];
    const agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (notification: SessionNotification) => {
          updates.push(notification);
        },
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const input = new Pushable<any>();
    async function* generator() {
      const user = await input[Symbol.asyncIterator]().next();
      yield userEcho(user.value);
      yield* before;
      await gate;
      yield* after;
    }
    // The account-quota publish is stubbed out for every case in this block, and
    // it is isolation rather than convenience. A turn that reaches the `result`
    // case's `finally` calls publishAccountUsage, which reads and writes a quota
    // sample SHARED ON DISK between processes -- so a compaction case driving a
    // real turn writes a sample that account-usage-cadence.test.ts then reads,
    // in a different vitest worker. Measured: adding one more result-yielding
    // case here turned that file's "reuses a sample another process already paid
    // for" red with 0.42 where it expected 0.99, while both files stayed green
    // run alone and green at HEAD. The existing conversation-reset case was
    // passing on luck, not on isolation.
    (agent as unknown as { publishAccountUsage: () => Promise<void> }).publishAccountUsage =
      async () => {};
    (agent as unknown as { armAccountUsagePolling: () => void }).armAccountUsagePolling = () => {};
    agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });

    return {
      agent,
      updates,
      release,
      toolCalls: () => updates.map((u) => u.update as unknown as Update).filter(isToolUpdate),
      prompt: () =>
        agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/compact" }] }),
    };
  }

  /**
   * Wait until the opening `in_progress` frame has actually been SENT.
   *
   * Deliberately not "until a compaction is currently open": the conversation
   * reset is handled in the same drain as the frame that opened the compaction,
   * so on that path there is no window in which one is open, and a helper
   * waiting for one timed out and looked like the compaction never started.
   */
  async function awaitCompactionAnnounced(h: ReturnType<typeof heldTurn>) {
    for (let i = 0; i < 200; i++) {
      if (h.toolCalls().some((update) => update.toolCallId === "compact-start")) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("the compaction was never announced");
  }

  it("the SDK stream ending mid-compaction closes it", async () => {
    const h = heldTurn([compactingStatus]);
    const settled = h.prompt();
    await awaitCompactionAnnounced(h);

    h.release();
    await settled;

    expect(stillOpen(h.toolCalls())).toEqual([]);
  });

  it("an ordinary cancel that reaches its trailing idle closes it", async () => {
    const h = heldTurn(
      [compactingStatus],
      [{ type: "system", subtype: "session_state_changed", state: "idle" }],
    );
    const settled = h.prompt();
    await awaitCompactionAnnounced(h);

    await h.agent.cancel({ sessionId: "test-session" } as any);
    h.release();
    await settled;

    expect(stillOpen(h.toolCalls())).toEqual([]);
  });

  it("a force cancellation that never reaches an idle closes it", async () => {
    // The upstream defect verbatim: stopReason `cancelled` returned while the
    // compaction is left in_progress. The grace timer is cut to a few ms so the
    // abort races in instead of the trailing idle, which is the whole difference
    // from the case above.
    const h = heldTurn([compactingStatus]);
    (h.agent as any).forceCancelGraceMs = 20;
    const settled = h.prompt();
    await awaitCompactionAnnounced(h);

    await h.agent.cancel({ sessionId: "test-session" } as any);
    await settled;

    expect(stillOpen(h.toolCalls())).toEqual([]);
  });

  it("a turn whose result is an error closes it", async () => {
    // Found by audit, not by the plan.
    //
    // WHAT THIS CASE PROVES, exactly: with all three of the audit's sites
    // removed -- failActiveWithSessionFailure, the result case's `finally`, and
    // the consumer's outer catch -- it goes red with
    // `expected [ 'compact-start' ] to deeply equal []`. With any one of them
    // present it is green, so it proves the three COLLECTIVELY and isolates
    // none.
    //
    // AND IT IS NOT THE ONE YOU WOULD GUESS. Removing only the `finally`'s
    // interrupt leaves this case green, measured: an `is_error` result routes
    // through failActiveWithSessionFailure, which closes it first. So the
    // `finally` site is defended by reasoning and not by this case -- it is the
    // one point every exit from that case passes through, and an arm reaching it
    // without a terminal (a refusal) would hit `compaction.reset()`, which sends
    // nothing. That arm has no case here; saying so is cheaper than implying it
    // does.
    const h = heldTurn(
      [compactingStatus],
      [
        successfulResultMessage({
          subtype: "error_during_execution",
          is_error: true,
          result: "boom",
        }),
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
    );
    const settled = h.prompt();
    await awaitCompactionAnnounced(h);

    h.release();
    await settled.catch(() => undefined);

    expect(stillOpen(h.toolCalls())).toEqual([]);
  });

  it("a conversation reset arriving mid-compaction closes it", async () => {
    const h = heldTurn(
      [
        compactingStatus,
        {
          // A top-level message TYPE, not a `system` subtype -- the first
          // version of this case spelled it as one, and the agent's switch
          // silently ignored it, so the leak the case was written to catch
          // looked exactly like the leak it was supposed to fix.
          type: "conversation_reset",
          new_conversation_id: "conversation-2",
          uuid: "reset-1",
          session_id: "test-session",
        },
      ],
      [
        successfulResultMessage(),
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
    );
    const settled = h.prompt();
    await awaitCompactionAnnounced(h);

    h.release();
    await settled;

    expect(stillOpen(h.toolCalls())).toEqual([]);
  });
});

describe("the agent reports one compaction once", () => {
  function runTurn(messages: any[]) {
    const updates: SessionNotification[] = [];
    const agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (notification: SessionNotification) => {
          updates.push(notification);
        },
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );

    const input = new Pushable<any>();
    async function* generator() {
      const user = await input[Symbol.asyncIterator]().next();
      yield userEcho(user.value);
      yield* messages;
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
    agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });

    return {
      updates,
      prompt: () =>
        agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/compact" }] }),
    };
  }

  const compactingStatus = {
    type: "system",
    subtype: "status",
    status: "compacting",
    uuid: "compact-start",
    session_id: "test-session",
  };

  const compactSucceeded = {
    type: "system",
    subtype: "status",
    status: null,
    compact_result: "success",
    uuid: "compact-done",
    session_id: "test-session",
  };

  function toolUpdates(updates: SessionNotification[]) {
    return updates.map((update) => update.update as unknown as Update).filter(isToolUpdate);
  }

  function chunkTexts(updates: SessionNotification[]) {
    return updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.update as any).content.text as string);
  }

  it("emits the tool lifecycle rather than the inferred text banner", async () => {
    const { updates, prompt } = runTurn([compactingStatus, compactSucceeded]);

    await prompt();

    expect(toolUpdates(updates)[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "compact-start",
      title: "Compact conversation",
      kind: "think",
      status: "in_progress",
      _meta: { [CONTEXT_COMPACTION_META_KEY]: { version: CONTEXT_COMPACTION_META_VERSION } },
    });
    // R2.2: the `compactionInProgress` inference is removed, not left inert, so
    // none of its banners can reach the client alongside the lifecycle.
    expect(chunkTexts(updates).join("\n")).not.toMatch(/Compacting/);
  });

  it("HOSTILE - a duplicated terminal does not become a second report", async () => {
    // The double-report R2.2 forbids: the lifecycle reports the outcome, and a
    // surviving inference (or an unguarded duplicate) would report it again.
    const { updates, prompt } = runTurn([
      compactingStatus,
      compactSucceeded,
      { ...compactSucceeded, uuid: "compact-done-duplicate" },
    ]);

    await prompt();

    const terminal = toolUpdates(updates).filter((update) => update.status === "completed");
    expect(terminal).toHaveLength(1);
    expect(toolUpdates(updates)).toHaveLength(2);
    expect(chunkTexts(updates).join("\n")).not.toMatch(/Compacting/);
  });
});
