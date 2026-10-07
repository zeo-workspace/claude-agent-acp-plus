/**
 * Story 016: a call the auto-mode classifier denies asks the operator instead
 * of failing. An approval becomes a grant — memory only, scoped to one
 * session — that the next matching call consumes to skip the classifier.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
// Type-only: acp-agent.ts imports this module at runtime, so the agent is
// passed in as a parameter rather than imported.
import type { ClaudeAcpAgent, Logger, ToolUpdateMeta } from "./acp-agent.js";
import { buildClassifierEscalationOptions } from "./permissions/options/shared.js";
import { buildClaudePermissionPresentation, humanText } from "./permissions/presentation.js";
import {
  decodeClassifierEscalationResponse,
  type ClassifierEscalationAnswer,
} from "./permissions/response.js";

const CYCLE = Symbol("cycle");

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw CYCLE;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, ancestors));
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key], ancestors);
    }
    return sorted;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * One string per (tool name, input): keys sorted recursively, array order kept,
 * and the top-level Bash `description` dropped — a cosmetic label the model
 * rewrites on retry. `undefined` when the input cannot be serialised (cyclic),
 * which every caller treats as "no grant possible".
 */
export function fingerprint(toolName: string, input: unknown): string | undefined {
  let subject = input;
  if (
    toolName === "Bash" &&
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "description" in input
  ) {
    const rest: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    delete rest.description;
    subject = rest;
  }
  try {
    // A JSON array keeps the tool name and the input apart: no text can move
    // from one to the other and render the same string.
    return JSON.stringify([toolName, canonicalize(subject, new Set())]);
  } catch (error) {
    if (error === CYCLE) return undefined;
    throw error;
  }
}

export type GrantKind = "once" | "session";

/** The grants of one session. Memory only: nothing here touches the disk. */
export class GrantStore {
  private readonly once = new Set<string>();
  private readonly session = new Set<string>();

  grantOnce(fp: string): void {
    this.once.add(fp);
  }

  grantSession(fp: string): void {
    this.session.add(fp);
  }

  /** Whether a grant matches, without consuming it. */
  has(fp: string): boolean {
    return this.session.has(fp) || this.once.has(fp);
  }

  /** A session grant wins and stays; a once grant is deleted when consumed. */
  consume(fp: string): GrantKind | undefined {
    if (this.session.has(fp)) return "session";
    if (this.once.delete(fp)) return "once";
    return undefined;
  }

  /** Turn end: an unused "Yes" does not outlive its turn. */
  clearOnce(): void {
    this.once.clear();
  }

  /** Session teardown. */
  clear(): void {
    this.once.clear();
    this.session.clear();
  }
}

/** How an escalated call ended: the operator's answer, or the fail-closed default. */
export type EscalationOutcome = "approved" | "rejected" | "cancelled";

/** A `permission_denied` frame, as the frame handler notes it. */
export type DeniedFrame = {
  toolUseId: string;
  /** `decision_reason_type`: "classifier", "rule", "mode", … */
  reasonType: string | undefined;
  /** `decision_reason ?? message` — exactly the text today's failed update shows. */
  reason: string;
  /** A subagent's `agent_id`, when the denied call ran inside one. */
  agentId?: string;
  /**
   * Today's `_meta` for the denied call's failed update (tool name, parent
   * stamp, `toolResponse`), built by the frame handler where the session is in
   * reach. Reused verbatim so a rejected update is byte for byte today's.
   */
  meta?: ToolUpdateMeta;
  /**
   * Whether the client was ever sent this call's `tool_call`. A fallback update
   * for a call the client never saw is dropped, as today's handler drops it.
   */
  emitted?: boolean;
};

type ToolCallUpdate = Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>;

export type EscalationRegistryDeps = {
  sessionId: string;
  /** Sends one `tool_call_update` for the denied call to the client. */
  emit: (toolUseId: string, update: ToolCallUpdate) => unknown;
  logger: Logger;
};

/** How long each side waits for the other before failing closed. */
const SIGNAL_WAIT_MS = 5_000;

const APPROVED_TEXT =
  "Approved by the operator after a classifier denial; the call will run again.";
const CANCELLED_TEXT = "Permission request cancelled; the call did not run.";

/** A timer that never keeps the process alive on its own. */
function backgroundTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * Orders the two signals the CLI sends for one classifier denial — the
 * `permission_denied` frame and the `PermissionDenied` hook, in either order,
 * keyed by tool_use_id — and guarantees the denied call exactly one final
 * `tool_call_update`: never zero (a call left pending), never two.
 */
export class EscalationRegistry {
  private readonly sessionId: string;
  private readonly emit: EscalationRegistryDeps["emit"];
  private readonly logger: Logger;

  private readonly frames = new Map<string, DeniedFrame>();
  private readonly waiters = new Map<string, Set<(reasonType: string | undefined) => void>>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly claimed = new Set<string>();
  private readonly abandoned = new Set<string>();
  private readonly settled = new Map<string, EscalationOutcome>();

  constructor(deps: EscalationRegistryDeps) {
    this.sessionId = deps.sessionId;
    this.emit = deps.emit;
    this.logger = deps.logger;
  }

  /** Frame side. Answers any hook waiting on this id; a classifier frame arms the fallback. */
  noteFrame(frame: DeniedFrame): void {
    const id = frame.toolUseId;
    const waiting = this.waiters.get(id);
    if (waiting) {
      this.waiters.delete(id);
      for (const wake of waiting) wake(frame.reasonType);
    }
    // A duplicate frame for a settled call has nothing left to decide.
    if (this.settled.has(id)) return;
    this.frames.set(id, frame);

    if (frame.reasonType !== "classifier") {
      // The frame handler sends today's update for these itself; the frame is
      // kept only long enough for a hook to read its reason type.
      this.clearDeadline(id);
      this.deadlines.set(
        id,
        backgroundTimer(() => {
          this.deadlines.delete(id);
          this.frames.delete(id);
          this.abandoned.delete(id);
        }, SIGNAL_WAIT_MS),
      );
      return;
    }
    if (this.claimed.has(id)) return;
    // The hook already gave up on this id: nobody else will settle it.
    if (this.abandoned.has(id)) {
      this.settle(id, "rejected", true);
      return;
    }
    this.clearDeadline(id);
    this.deadlines.set(
      id,
      backgroundTimer(() => {
        this.deadlines.delete(id);
        if (!this.claimed.has(id)) this.settle(id, "rejected", true);
      }, SIGNAL_WAIT_MS),
    );
  }

  /** Hook side. The frame's reason type, or `undefined` after 5 s. Never rejects. */
  awaitReasonType(toolUseId: string): Promise<string | undefined> {
    const frame = this.frames.get(toolUseId);
    if (frame) return Promise.resolve(frame.reasonType);
    // Settled without this hook (the fallback fired): no frame will come again.
    if (this.settled.has(toolUseId)) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      let waiters = this.waiters.get(toolUseId);
      if (!waiters) {
        waiters = new Set();
        this.waiters.set(toolUseId, waiters);
      }
      const wake = (reasonType: string | undefined) => {
        clearTimeout(timer);
        resolve(reasonType);
      };
      const timer = backgroundTimer(() => {
        const current = this.waiters.get(toolUseId);
        current?.delete(wake);
        if (current?.size === 0) this.waiters.delete(toolUseId);
        resolve(undefined);
      }, SIGNAL_WAIT_MS);
      waiters.add(wake);
    });
  }

  /**
   * The hook takes ownership: only `resolve` settles this id from now on.
   * `false` when the call was already settled — the hook must not ask then.
   */
  claim(toolUseId: string): boolean {
    if (this.settled.has(toolUseId)) return false;
    this.claimed.add(toolUseId);
    this.clearDeadline(toolUseId);
    return true;
  }

  /** The hook gave up (not the classifier's, or no frame in 5 s). */
  abandon(toolUseId: string): void {
    if (this.settled.has(toolUseId) || this.claimed.has(toolUseId)) return;
    const frame = this.frames.get(toolUseId);
    if (!frame) {
      // The frame may still come; when it does, it settles at once.
      this.abandoned.add(toolUseId);
      return;
    }
    if (frame.reasonType === "classifier") {
      this.settle(toolUseId, "rejected", true);
    } else {
      // The frame handler already sent today's update for this one.
      this.clearDeadline(toolUseId);
      this.frames.delete(toolUseId);
    }
  }

  /** Idempotent: the first outcome for an id wins and is emitted once. */
  resolve(toolUseId: string, outcome: EscalationOutcome): void {
    this.settle(toolUseId, outcome);
  }

  /** True once claimed and until resolved. */
  isEscalated(toolUseId: string): boolean {
    return this.claimed.has(toolUseId);
  }

  /** True after `resolve(..., "approved")`; the `tool_result` path reads it. */
  wasApproved(toolUseId: string): boolean {
    return this.settled.get(toolUseId) === "approved";
  }

  /** Session teardown: drop every timer and every per-call record. */
  clear(): void {
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    for (const [, waiting] of this.waiters) for (const wake of waiting) wake(undefined);
    this.waiters.clear();
    this.frames.clear();
    this.claimed.clear();
    this.abandoned.clear();
    this.settled.clear();
  }

  private settle(toolUseId: string, outcome: EscalationOutcome, fallback = false): void {
    if (this.settled.has(toolUseId)) return;
    this.settled.set(toolUseId, outcome);
    this.clearDeadline(toolUseId);
    this.claimed.delete(toolUseId);
    this.abandoned.delete(toolUseId);
    const frame = this.frames.get(toolUseId);
    this.frames.delete(toolUseId);
    // The hook path emits a missing tool call before asking; the fallback does
    // not, so it stays silent about a call the client was never shown.
    if (fallback && frame?.emitted === false) return;
    this.send(toolUseId, buildFinalUpdate(toolUseId, outcome, frame));
  }

  private send(toolUseId: string, update: ToolCallUpdate): void {
    const warn = (error: unknown) =>
      this.logger.log(
        `classifier escalation: final tool_call_update failed level=warn sessionId=${this.sessionId} toolUseId=${toolUseId} error=${String(error)}`,
      );
    try {
      void Promise.resolve(this.emit(toolUseId, update)).catch(warn);
    } catch (error) {
      warn(error);
    }
  }

  private clearDeadline(toolUseId: string): void {
    const timer = this.deadlines.get(toolUseId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.deadlines.delete(toolUseId);
  }
}

function buildFinalUpdate(
  toolUseId: string,
  outcome: EscalationOutcome,
  frame: DeniedFrame | undefined,
): ToolCallUpdate {
  const text = (value: string) => [
    { type: "content" as const, content: { type: "text" as const, text: value } },
  ];
  const claudeCode = frame?.meta?.claudeCode;
  // Approved and cancelled keep the call's identity (tool name, parent stamp)
  // but not the denial's `toolResponse`, which would contradict them.
  const identity = claudeCode
    ? {
        toolName: claudeCode.toolName,
        ...(claudeCode.parentToolUseId ? { parentToolUseId: claudeCode.parentToolUseId } : {}),
      }
    : undefined;

  switch (outcome) {
    case "approved":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: toolUseId,
        status: "completed",
        content: text(APPROVED_TEXT),
        ...(identity ? { _meta: { claudeCode: identity } satisfies ToolUpdateMeta } : {}),
      };
    case "cancelled":
      // ACP has no cancelled tool-call status: the adapter's representation is
      // `failed` with `nonExecutionKind: "cancelled"`.
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: toolUseId,
        status: "failed",
        content: text(CANCELLED_TEXT),
        ...(identity
          ? {
              _meta: {
                claudeCode: { ...identity, nonExecutionKind: "cancelled" },
              } satisfies ToolUpdateMeta,
            }
          : {}),
      };
    case "rejected":
    default:
      // Today's failed update, byte for byte — also the fail-closed default.
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: toolUseId,
        status: "failed",
        content: text(
          `Permission denied: ${frame?.reason ?? "denied by the auto-mode classifier"}`,
        ),
        ...(frame?.meta ? { _meta: frame.meta } : {}),
      };
  }
}

/** What the hook asks the operator about: the denied call, as the CLI reported it. */
export type EscalationRequest = {
  /** The denied call's own tool_use_id — the request references it, never a new one. */
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** The classifier's reason, shown alongside the command. */
  reason: string;
  /** A subagent's `agent_id`, when the denied call ran inside one. */
  agentId?: string;
};

/** Asks the operator one question; rejects when the client cannot answer. */
export type AskOperator = (
  req: EscalationRequest,
  signal: AbortSignal,
) => Promise<ClassifierEscalationAnswer>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The only bridge from the hook to the client: one ACP permission request with
 * the three classifier answers, referencing the denied call's own tool call
 * (emitted first if the client has not seen it), and attributed to the
 * spawning Agent/Task call when the denial happened inside a subagent.
 */
export function createAskOperator(agent: ClaudeAcpAgent, sessionId: string): AskOperator {
  return async (req, signal) => {
    const session = agent.sessions[sessionId];
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Resolve a subagent the way the frame handler and canUseTool do: by
    // `agent_id`, through `liveBackgroundTasks`, never by the Agent/Task call.
    const parentToolUseId = req.agentId
      ? session.liveBackgroundTasks.get(req.agentId)?.parentToolUseId
      : undefined;
    if (req.agentId && !parentToolUseId) {
      agent.logger.log(
        `classifier escalation: no parent tool_use recorded for subagent level=warn sessionId=${sessionId} toolUseId=${req.toolUseId} agentId=${req.agentId}`,
      );
    }

    const input = isRecord(req.input) ? req.input : { input: req.input };
    const presentation = buildClaudePermissionPresentation({
      toolName: req.toolName,
      input,
      toolUseID: req.toolUseId,
      cwd: session.cwd,
      supportsTerminalOutput: agent.clientCapabilities?._meta?.["terminal_output"] === true,
    });
    // The reason goes into the request content itself, beside the command:
    // the operator decides on both, not on the command alone.
    presentation.toolCall.content = [
      ...(presentation.toolCall.content ?? []),
      {
        type: "content",
        content: {
          type: "text",
          text: `Denied by the auto-mode classifier. Reason: ${
            // Model-steerable text: the same cleaning and cap the card applies
            // to every other reason it shows.
            humanText(req.reason, 4_000) ?? "none given"
          }`,
        },
      },
    ];
    if (parentToolUseId) {
      presentation.toolCall._meta = {
        claudeCode: { toolName: req.toolName, parentToolUseId },
      };
    }

    const response = await agent.requestPermissionFromClient(
      { ...presentation, options: buildClassifierEscalationOptions(), sessionId },
      req.toolName,
      signal,
      parentToolUseId,
    );
    return decodeClassifierEscalationResponse(response);
  };
}

/** The hook's own bound, below the matcher's 600 s so the adapter decides. */
const ANSWER_WAIT_MS = 590_000;

export type PermissionDeniedHookDeps = {
  session: { sessionId: string; classifierGrants: GrantStore };
  logger: Logger;
  escalations: Pick<EscalationRegistry, "awaitReasonType" | "claim" | "abandon" | "resolve">;
  askOperator: AskOperator;
};

type Settlement =
  | { kind: "answer"; answer: ClassifierEscalationAnswer }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

const RETRY: HookJSONOutput = {
  hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true },
};

/**
 * The `PermissionDenied` hook. A classifier denial becomes one question; "Yes"
 * or "Yes for this session" becomes a grant plus `retry: true`, which only
 * tells the model it may retry — the grant hook is what lets the retry run.
 * Every other path (No, cancel, abort, a failing client, the 590 s bound, an
 * input that cannot be fingerprinted) grants nothing: fail closed.
 */
export function createPermissionDeniedHook(deps: PermissionDeniedHookDeps): HookCallback {
  const { session, logger, escalations, askOperator } = deps;
  const sessionId = session.sessionId;

  return async (input, toolUseID, { signal }) => {
    if (input.hook_event_name !== "PermissionDenied") return {};
    const toolUseId = input.tool_use_id || toolUseID;
    if (!toolUseId) return {};
    const toolName = input.tool_name;
    // Never the command or the input: ids, tool name and outcome only (R6.3).
    const line = (level: "info" | "warn", event: string, fields: string) =>
      logger.log(
        `classifier escalation: ${event} level=${level} sessionId=${sessionId} toolUseId=${toolUseId} toolName=${toolName} ${fields}`,
      );

    let claimed = false;
    try {
      const reasonType = await escalations.awaitReasonType(toolUseId);
      if (reasonType !== "classifier") {
        escalations.abandon(toolUseId);
        return {};
      }
      // Only an explicit `false` means the call was settled without this hook.
      if (escalations.claim(toolUseId) === false) return {};
      claimed = true;

      const fp = fingerprint(toolName, input.tool_input);
      if (fp === undefined) {
        escalations.resolve(toolUseId, "rejected");
        line("warn", "input cannot be fingerprinted", "answer=none outcome=rejected");
        return {};
      }

      const settlement = await askWithBounds(
        askOperator,
        {
          toolUseId,
          toolName,
          input: input.tool_input,
          reason: input.reason,
          ...(input.agent_id ? { agentId: input.agent_id } : {}),
        },
        signal,
      );

      switch (settlement.kind) {
        case "answer":
          switch (settlement.answer) {
            case "once":
            case "session":
              if (settlement.answer === "once") session.classifierGrants.grantOnce(fp);
              else session.classifierGrants.grantSession(fp);
              escalations.resolve(toolUseId, "approved");
              line("info", "operator answered", `answer=${settlement.answer} outcome=approved`);
              return RETRY;
            case "reject":
              escalations.resolve(toolUseId, "rejected");
              line("warn", "operator answered", "answer=reject outcome=rejected");
              return {};
            case "cancelled":
            default:
              escalations.resolve(toolUseId, "cancelled");
              line("info", "operator answered", "answer=cancelled outcome=cancelled");
              return {};
          }
        case "aborted":
          escalations.resolve(toolUseId, "cancelled");
          line("info", "turn aborted while asking", "answer=aborted outcome=cancelled");
          return {};
        case "timeout":
          escalations.resolve(toolUseId, "rejected");
          line(
            "warn",
            "no answer in time",
            `answer=timeout outcome=rejected waitedMs=${ANSWER_WAIT_MS}`,
          );
          return {};
        case "error":
        default:
          escalations.resolve(toolUseId, "rejected");
          line(
            "warn",
            "permission request failed",
            `answer=error outcome=rejected error=${errorKind(settlement.error)}`,
          );
          return {};
      }
    } catch (error) {
      // An unexpected fault in the hook itself: never leave the call pending,
      // never grant.
      if (claimed) escalations.resolve(toolUseId, "rejected");
      else escalations.abandon(toolUseId);
      logger.error(
        `classifier escalation: hook failed level=error sessionId=${sessionId} toolUseId=${toolUseId} toolName=${toolName} error=${errorKind(error)}`,
      );
      return {};
    }
  };
}

/**
 * The error's class and code, never its message: a client may echo the
 * request's params — the command — back in it (R6.3).
 */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string"
    ? `${error.name}:${String(code).replace(/[^\w.-]/gu, "")}`
    : error.name;
}

/**
 * Race the question against the hook's abort signal and the 590 s bound. The
 * question gets its own signal, aborted whenever it loses the race, so the
 * client's card is withdrawn rather than left open. The timer and the abort
 * listener are released as soon as the race settles.
 */
async function askWithBounds(
  askOperator: AskOperator,
  req: EscalationRequest,
  signal: AbortSignal,
): Promise<Settlement> {
  if (signal.aborted) return { kind: "aborted" };
  const question = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const settlement = await new Promise<Settlement>((resolve) => {
      timer = backgroundTimer(() => resolve({ kind: "timeout" }), ANSWER_WAIT_MS);
      onAbort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      // An async wrapper so a synchronous throw is a rejection like any other.
      void (async () => askOperator(req, question.signal))().then(
        (answer) => resolve({ kind: "answer", answer }),
        (error: unknown) => resolve({ kind: "error", error }),
      );
    });
    if (settlement.kind !== "answer") question.abort();
    return settlement;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const GRANT_ALLOW_REASON = "approved by the operator after a classifier denial";

/** The hook input's mode as a log token: never free text from the input. */
function modeToken(mode: unknown): string {
  if (typeof mode !== "string") return "none";
  const token = mode.replace(/[^\w-]/gu, "").slice(0, 32);
  return token || "none";
}

/**
 * The `PreToolUse` side: a call matching a grant is allowed before the
 * classifier sees it — measured in Task 1 to skip the classifier. Anything else
 * returns `{}` and the CLI decides as usual.
 *
 * A grant answers a classifier denial, so it applies only while the CLI reports
 * `auto` for this very call (story 029). In any other mode — or with no mode —
 * it is held, not consumed: that mode's own checks decide, and the grant is
 * still there when the session returns to `auto`. The mode is read from the
 * hook input, never from the adapter's session state, which can lag a switch.
 */
export function createGrantPreToolUseHook(
  session: { sessionId: string; classifierGrants: GrantStore },
  logger: Logger,
): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const fp = fingerprint(input.tool_name, input.tool_input);
    if (fp === undefined) return {};
    const mode: unknown = input.permission_mode;
    if (mode !== "auto") {
      if (session.classifierGrants.has(fp)) {
        logger.log(
          `classifier escalation: grant held level=info sessionId=${session.sessionId} toolUseId=${toolUseID ?? input.tool_use_id} toolName=${input.tool_name} mode=${modeToken(mode)}`,
        );
      }
      return {};
    }
    const kind = session.classifierGrants.consume(fp);
    if (!kind) return {};
    logger.log(
      `classifier escalation: grant consumed level=info sessionId=${session.sessionId} toolUseId=${toolUseID ?? input.tool_use_id} toolName=${input.tool_name} grant=${kind}`,
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: GRANT_ALLOW_REASON,
      },
    };
  };
}
