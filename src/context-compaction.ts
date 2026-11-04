/**
 * Context compaction as ONE idempotent ACP tool lifecycle (story 010, R2.1/R2.2).
 *
 * What this replaces: the adapter used to infer compaction from a
 * `compactionInProgress` boolean and narrate it as assistant text
 * ("Compacting…", "Compacting completed."). The flag existed only because, in
 * the adapter's own comment, the SDK's two terminal `status` messages were
 * "indistinguishable" — a guess, not a signal. Once the lifecycle is explicit
 * the guess is not merely redundant, it double-reports: the tool call says the
 * compaction finished and the banner says so again. So the inference is
 * DELETED, not left inert (D4) — a flag that no longer decides anything is a
 * thing the next reader has to prove is inert.
 *
 * What replaces it: a small state machine that folds every event shape the SDK
 * can produce onto a single tool call.
 *
 *   SDK event                                   → lifecycle call
 *   ------------------------------------------- -----------------------------
 *   `status` = "compacting"                     → start()      tool_call, in_progress
 *   `stream_event` compaction block/delta       → heartbeat()  tool_call_update, in_progress
 *   `status` with compact_result success/failed → finish()     tool_call_update, terminal
 *   `compact_boundary` (token counts)           → finish(enrich) tool_call_update, metadata only
 *   a terminal with no preceding "compacting"   → finish()     tool_call, terminal (standalone)
 *   a DUPLICATED terminal                       → finish()     nothing
 *
 * The two hard cases pull in opposite directions and both are real:
 *
 *   - The SDK duplicates the terminal `compact_result` message for a single
 *     failed compaction. Two terminals for one compaction must stay ONE report.
 *   - One model turn can legitimately compact more than once. Two genuine
 *     compactions must stay TWO distinguishable reports.
 *
 * The state machine separates them by phase rather than by identity: a
 * terminal that arrives when the lifecycle has already terminated is a
 * duplicate and changes nothing, while a fresh `compacting` status AFTER a
 * terminal opens a new lifecycle with a new tool call id. A rule that instead
 * suppressed by matching ids or payloads would satisfy one case by breaking
 * the other.
 *
 * State lives until the owning turn's `result` (or an abort) rather than being
 * cleared at each terminal, because the SDK can also omit the opening status
 * on replay — the terminal has to be able to stand alone.
 *
 * Kept self-contained — no import from `acp-agent.ts`, mirroring
 * `thinking-option.ts` and `rewind-command.ts`; what it needs from the adapter
 * (the send chokepoint) is injected, which also leaves the whole state machine
 * unit-testable without a live SDK session. The reason is merge cost:
 * `acp-agent.ts` is a ~9,700-line file that changes upstream almost daily, so
 * every coupling to it is paid again at each sync.
 */

import { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import {
  ContextCompactionMetadata,
  createContextCompactionMeta,
} from "./context-compaction-meta.js";

/** The phases a compaction can END in. `in_progress` is not terminal. */
type CompactionStatus = "completed" | "failed";

/** One compaction's identity and phase. */
type CompactionState = {
  /** The ACP tool call id every update for this compaction carries. */
  toolCallId: string;
  /** Set once the lifecycle has reported an outcome; the duplicate guard. */
  terminalStatus?: CompactionStatus;
  /** Stream heartbeats are collapsed to one keep-alive per lifecycle. */
  heartbeatSent: boolean;
};

/**
 * The adapter's send chokepoint, injected. Deliberately the ACP SDK's
 * `SessionNotification` rather than an adapter-local alias, so this module
 * needs nothing from `acp-agent.ts`.
 */
type SendUpdate = (notification: SessionNotification) => Promise<void>;

/**
 * Translates Claude's compaction signals into one idempotent ACP tool
 * lifecycle. One instance per consumer; `reset()` at each turn boundary.
 */
export class ContextCompactionLifecycle {
  private activeCompaction: CompactionState | undefined;
  private outputDelivered = false;
  private duplicateErrorOutput: string | undefined;

  constructor(private readonly sendUpdate: SendUpdate) {}

  /**
   * Whether this turn already showed the user something about a compaction.
   *
   * The adapter reads it for two decisions the deleted banners used to make
   * implicitly, by counting as delivered assistant text: an echo-less turn
   * that only compacted (e.g. `/compact`) must not have its result text
   * re-emitted by the issue-#453 fallback, and a replayed synthetic
   * local-command frame from an earlier compact attempt must not be forwarded
   * on top of the lifecycle.
   */
  get hasDeliveredOutput(): boolean {
    return this.outputDelivered;
  }

  /** Return to the unstarted state; call at each turn boundary. */
  reset(): void {
    this.activeCompaction = undefined;
    this.outputDelivered = false;
    this.duplicateErrorOutput = undefined;
  }

  /**
   * Claude also emits a failed manual compaction's error as local-command
   * stdout. Consume that one duplicate after the tool lifecycle already
   * carried it, without hiding unrelated command output.
   *
   * Matching is by exact (trimmed) text and consumes at most once, so a
   * command that genuinely prints the same string later still reaches the
   * client.
   *
   * @returns `true` when the caller should drop this content.
   */
  consumeDuplicateErrorOutput(content: string): boolean {
    if (
      this.duplicateErrorOutput === undefined ||
      content.trim() !== this.duplicateErrorOutput.trim()
    ) {
      return false;
    }
    this.duplicateErrorOutput = undefined;
    return true;
  }

  /**
   * Open the tool call the client renders. Idempotent while a compaction is
   * still running (a repeated `compacting` status re-uses the open call); a
   * `compacting` that arrives AFTER a terminal starts a fresh lifecycle, which
   * is how two real compactions in one turn stay two reports.
   *
   * @param toolCallId The SDK message uuid — replay-stable, so a re-delivered
   *   frame addresses the same tool call rather than inventing one.
   */
  async start(sessionId: string, toolCallId: string): Promise<CompactionState> {
    if (this.activeCompaction && !this.activeCompaction.terminalStatus) {
      return this.activeCompaction;
    }

    this.activeCompaction = { toolCallId, heartbeatSent: false };
    this.outputDelivered = true;
    await this.sendUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: COMPACTION_TOOL_TITLE,
        kind: "think",
        status: "in_progress",
        _meta: compactionToolMeta(),
      },
    });
    return this.activeCompaction;
  }

  /**
   * Keep the open call alive while compaction streams. Sent at most once per
   * lifecycle: the deltas carry the generated summary, which stays internal to
   * the agent, so repeating them would add noise and no information.
   *
   * @param fallbackId Used only when the opening status never arrived (replay).
   */
  async heartbeat(sessionId: string, fallbackId: string): Promise<void> {
    const state = this.activeCompaction ?? (await this.start(sessionId, fallbackId));
    if (state.terminalStatus || state.heartbeatSent) return;

    state.heartbeatSent = true;
    await this.sendUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: state.toolCallId,
        status: "in_progress",
        _meta: compactionToolMeta(),
      },
    });
  }

  /**
   * Report the outcome — exactly once per compaction.
   *
   * Three shapes converge here:
   *  - no lifecycle open (the SDK omitted the opening status on replay): emit a
   *    standalone terminal `tool_call`, so the event is reported rather than
   *    dropped for lack of a start;
   *  - the first terminal for an open lifecycle: a `tool_call_update` carrying
   *    the status;
   *  - a duplicate terminal: nothing at all.
   *
   * @param fallbackId Tool call id for the standalone shape.
   * @param metadata Compaction facts; also emitted as `rawOutput` when non-empty,
   *   so a client that ignores `_meta` can still show something.
   * @param enrichTerminal Allow a SECOND update on an already-terminal
   *   lifecycle that adds facts without re-reporting the outcome. Used by
   *   `compact_boundary`, which arrives after the terminal `status` and is the
   *   only frame carrying the token counts. The status field is omitted on that
   *   update, so the client still sees exactly one terminal transition.
   */
  async finish(
    sessionId: string,
    fallbackId: string,
    status: CompactionStatus,
    metadata: Omit<ContextCompactionMetadata, "version"> = {},
    enrichTerminal = false,
  ): Promise<void> {
    const rawOutput = Object.keys(metadata).length > 0 ? metadata : undefined;

    if (!this.activeCompaction) {
      this.activeCompaction = {
        toolCallId: fallbackId,
        heartbeatSent: false,
        terminalStatus: status,
      };
      this.outputDelivered = true;
      this.rememberDuplicateErrorOutput(status, metadata);
      await this.sendUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: fallbackId,
          title: COMPACTION_TOOL_TITLE,
          kind: "think",
          status,
          ...compactionErrorFields(status, metadata),
          ...(rawOutput ? { rawOutput } : {}),
          _meta: compactionToolMeta(metadata),
        },
      });
      return;
    }

    const state = this.activeCompaction;
    // The duplicate guard: a terminal on an already-terminal lifecycle is the
    // SDK repeating itself, and must change nothing the client can see.
    if (state.terminalStatus && !enrichTerminal) return;

    const firstTerminal = state.terminalStatus === undefined;
    if (firstTerminal) state.terminalStatus = status;
    this.rememberDuplicateErrorOutput(status, metadata);
    await this.sendUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: state.toolCallId,
        ...(firstTerminal ? { status } : {}),
        ...compactionErrorFields(status, metadata),
        ...(rawOutput ? { rawOutput } : {}),
        _meta: compactionToolMeta(metadata),
      },
    });
  }

  /**
   * Close an open compaction because the TURN ended, not because the runtime
   * reported an outcome: a cancel, a force cancellation, the SDK stream
   * ending, a conversation reset.
   *
   * Idempotent, and silent when nothing is open, because several of those paths
   * run in sequence for one turn -- the force-cancel backstop settles the turn
   * and the SDK's late trailing idle then reaches the cancelled-turn branch,
   * and both call this.
   *
   * WHY IT EMITS, WHERE `reset()` DOES NOT. `reset()` returns the lifecycle to
   * its unstarted state and sends nothing, which is right at a turn boundary
   * the runtime closed properly. It is wrong at an interruption: the last frame
   * the client saw is the opening `in_progress`, and dropping the reference
   * leaves that frame standing -- a compaction row that spins for the rest of
   * the session. So this reports the terminal, and the caller still resets
   * afterwards for the turn-boundary state.
   *
   * WHY `failed`, AND WHY THAT IS NOT UPSTREAM'S ANSWER. Upstream's own
   * `interrupt()` (a05aca6, #1154) deliberately leaves a legacy tool-call
   * presentation untouched, saying why in as many words: ACP `ToolCallStatus`
   * has no `cancelled` state. This fork has ONLY that presentation -- and,
   * unlike upstream, it has a downstream reader for the terminal. Patch `0017`
   * maps `acp::ToolCallStatus::Failed` to `ContextCompactionStatus::Canceled`,
   * the terminal the crate's enum offers that claims the least. So `failed`
   * here is not an invented convention; it is the one the other half of this
   * chain was already built to receive.
   *
   * `nonExecutionKind: "interrupted"` is what keeps it distinguishable from a
   * compaction that genuinely failed. It is the adapter's existing field for
   * "why the tool never actually ran", and without it the two are one status.
   */
  async interrupt(sessionId: string): Promise<void> {
    const state = this.activeCompaction;
    if (!state || state.terminalStatus) return;

    state.terminalStatus = "failed";
    await this.sendUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: state.toolCallId,
        status: "failed",
        _meta: compactionToolMeta({}, "interrupted"),
      },
    });
  }

  /** Arm {@link consumeDuplicateErrorOutput} for the stdout copy Claude emits. */
  private rememberDuplicateErrorOutput(
    status: CompactionStatus,
    metadata: Omit<ContextCompactionMetadata, "version">,
  ): void {
    if (status === "failed" && metadata.error) {
      this.duplicateErrorOutput = metadata.error;
    }
  }
}

/**
 * Map the SDK's `compact_boundary` metadata onto the provider-neutral names of
 * {@link ContextCompactionMetadata}. Fields an older CLI omits stay omitted
 * rather than becoming `undefined` keys, so `rawOutput` and `_meta` never
 * advertise a number nobody reported.
 */
export function contextCompactionMetadataFromBoundary(compactMetadata: {
  trigger: "manual" | "auto";
  pre_tokens: number;
  post_tokens?: number;
  duration_ms?: number;
}): Omit<ContextCompactionMetadata, "version"> {
  return {
    trigger: compactMetadata.trigger === "auto" ? "automatic" : "manual",
    preTokens: compactMetadata.pre_tokens,
    ...(compactMetadata.post_tokens !== undefined
      ? { postTokens: compactMetadata.post_tokens }
      : {}),
    ...(compactMetadata.duration_ms !== undefined
      ? { durationMs: compactMetadata.duration_ms }
      : {}),
  };
}

/** The title every compaction tool call carries; part of the R2.1 contract. */
const COMPACTION_TOOL_TITLE = "Compact conversation";

/**
 * The `_meta` payload for a compaction tool update: the versioned extension
 * plus the `claudeCode.toolName` every other tool call in this adapter carries,
 * so a client keying off it treats the synthetic call like any real one.
 *
 * Returns a plain record rather than the adapter's `ToolUpdateMeta` to keep the
 * module free of `acp-agent.ts` imports; the adapter widens `ToolUpdateMeta`
 * with the matching optional field for its own call sites.
 */
function compactionToolMeta(
  metadata: Omit<ContextCompactionMetadata, "version"> = {},
  nonExecutionKind?: string,
): Record<string, unknown> {
  return {
    ...createContextCompactionMeta(metadata),
    claudeCode: { toolName: "compact", ...(nonExecutionKind ? { nonExecutionKind } : {}) },
  };
}

/**
 * The failure reason as renderable tool content — `_meta` is optional for a
 * client, the reason for a failure is not.
 */
function compactionErrorFields(
  status: CompactionStatus,
  metadata: Omit<ContextCompactionMetadata, "version">,
) {
  if (status !== "failed" || !metadata.error) return {};
  return {
    content: [
      {
        type: "content" as const,
        content: { type: "text" as const, text: `Compaction failed: ${metadata.error}` },
      },
    ],
  };
}
