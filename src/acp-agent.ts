import {
  agent as acpAgent,
  AgentContext,
  AuthenticateRequest,
  AuthMethod,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  DisableProviderRequest,
  DisableProviderResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  LlmProtocol,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ProviderInfo,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  SetProviderRequest,
  SetProviderResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  AgentInfo,
  CanUseTool,
  deleteSession,
  FastModeDisabledReason,
  FastModeState,
  getSessionMessages,
  listSessions,
  McpServerConfig,
  ModelInfo,
  ModelUsage,
  OnElicitation,
  OnUserDialog,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  query,
  SDKAssistantMessageError,
  SDKActiveGoalMessage,
  SDKMessage,
  SDKMessageOrigin,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  Settings,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {
  GOAL_ACTIONS,
  GOAL_CONTROL_METHOD,
  GOAL_EXTENSION_VERSION,
  GoalCapability,
  GoalRequest,
  GoalControlResponse,
  GoalSnapshot,
  goalUpdateFromPrompt,
  parseGoalRequest,
  toGoalSnapshot,
} from "./goal-extension.js";
import { sanitizeTitle, SessionTitles } from "./session-titles.js";
import { readResumedSession, type ResumedSessionSnapshot } from "./resumed-session.js";
import { SessionTiming } from "./session-timing.js";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };
import {
  applyAskElicitationResponse,
  askUserQuestionsToCreateRequest,
  createElicitationResponseToElicitResult,
  ElicitationSupport,
  extractAskUserQuestions,
  extractRefusalFallbackPrompt,
  mcpElicitationToCreateRequest,
  REFUSAL_FALLBACK_DIALOG_KIND,
  refusalFallbackResultFromResponse,
  refusalFallbackToCreateRequest,
} from "./elicitation.js";
import { agentName } from "./agent-name.js";
import { filterDeprecatedModels } from "./model-deprecation.js";
import { filterSupersededModels } from "./model-recency.js";
import { SettingsManager } from "./settings.js";
import { ContextCompactionMetadata } from "./context-compaction-meta.js";
import {
  ContextCompactionLifecycle,
  contextCompactionMetadataFromBoundary,
} from "./context-compaction.js";
import {
  createThinkingConfigOption,
  effectiveThinkingConfig,
  resolveThinkingSelection,
  THINKING_CONFIG_ID,
} from "./thinking-option.js";
import {
  effortOptionValue,
  isUltracodeAvailable,
  isUltracodeValue,
  ULTRACODE_OPTION_NAME,
  ULTRACODE_OPTION_VALUE,
  ultracodeFlagSettings,
  UltracodeOptionState,
} from "./ultracode.js";
import { handleRewindCommand, parseRewindInvocation, RewindDeps } from "./rewind-command.js";
import { resolvePermissionMode, sessionAllowsBypass } from "./permissions/modes.js";
import { normalizeDurablePermissionChangeSet } from "./permissions/normalization.js";
import { buildClaudePermissionOptions } from "./permissions/options.js";
import { buildClaudePermissionPresentation } from "./permissions/presentation.js";
import { decodeClaudePermissionResponse } from "./permissions/response.js";
import {
  activeUsageLimitMessage,
  airSessionFailureCapabilityMeta,
  assistantMessageText,
  type ClaudeFailureKind,
  createSessionFailureState,
  isSyntheticUsageLimitMessage,
  type PublishedSessionFailure,
  providerFailureCategory,
  SessionFailureController,
  type SessionFailureState,
  sessionFailureMeta,
  supportsAirSessionFailures,
} from "./session-failure-extension.js";
import {
  AGENT_FILE_CHANGE_REPORT_CAPABILITY,
  agentFileChangeReportMeta,
  agentFileChangeReportRequestId,
  containsFileChangeAuditMarker,
  createFileChangeAuditSupport,
  createFileChangeAuditTurnState,
  FILE_CHANGE_AUDIT_SERVER_NAME,
  type FileChangeAuditSupport,
  type FileChangeAuditTurnState,
  type FileChangeReportUnavailableReason,
  isFileChangeAuditReportPhase,
  isFileChangeAuditTool,
  supportsAgentFileChangeReport,
} from "./file-change-audit.js";
import {
  clientSupportsNotices,
  MAX_NOTICE_TITLE_LENGTH,
  normalizeNoticeText,
  noticeOrTranscriptUpdate,
  sentenceCase,
  splitNoticeText,
} from "./session-notices.js";
import {
  applyTaskCreate,
  applyTaskList,
  applyTaskUpdate,
  ClaudePlanEntry,
  createPostToolUseHook,
  createTaskHook,
  parseTaskCreateOutput,
  parseTaskListOutput,
  parseTaskUpdateOutput,
  planEntries,
  registerHookCallback,
  TaskState,
  taskStateToPlanEntries,
  toolInfoFromToolUse,
  toolUpdateFromDiffToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";
import {
  acceptedPlanToolResult,
  ExitPlanCoordinator,
  exitPlanModeRawOutput,
  isExitPlanInterruptionResult,
  observeExitPlanToolResults,
} from "./exit-plan.js";
import { DEFAULT_AGENT_ID, EFFORT_CONFIG_ID } from "./session-config-ids.js";
import { withPrecompactHistory } from "./compacted-history.js";
import { findTranscript } from "./transcript-path.js";
import { parseToolResultMeta } from "./tool-result-meta.js";
import { AccountUsageTracker } from "./account-usage.js";
import { readFreshLimits, sharedSampleMaxAgeMs, writeLimits } from "./quota-cache.js";
import {
  ACCOUNT_CONFIG_ID,
  accountForValue,
  accountInForce,
  type AccountOptionState,
  createAccountConfigOption,
  type DeclaredAccount,
  envForAccount,
  readDeclaredAccounts,
} from "./accounts.js";
import {
  isUsageCommandText,
  structuredUsageMarkdown,
  syntheticLocalCommand,
} from "./usage-markdown.js";

export { DEFAULT_AGENT_ID, EFFORT_CONFIG_ID } from "./session-config-ids.js";
import { MODE_CONFIG_ID, SessionModeManager } from "./session-mode.js";

export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const execFileAsync = promisify(execFile);

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

type AccumulatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

type UsageSnapshot = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const DEFAULT_CONTEXT_WINDOW = 200000;

/** Floor after `session/cancel` before the adapter forces the active prompt
 *  loop to return "cancelled". `query.interrupt()` normally makes the SDK
 *  yield a trailing idle within milliseconds, and the loop returns through its
 *  usual path — so this timer is armed and cleared, never fired, on healthy
 *  cancels. It only trips when the SDK is genuinely wedged (e.g. a
 *  `TaskOutput { block: true }` poll against a hung background task — issue
 *  #680) and never yields. The value is deliberately loose: it's an
 *  "obviously stuck" ceiling, not a guess at interrupt latency, so it can't
 *  pre-empt a slow-but-healthy interrupt. */
const DEFAULT_FORCE_CANCEL_GRACE_MS = 30_000;

/** Ceiling on the lazy query recreate's initialization phase (see
 *  `recreateSessionQuery`). A wedged replacement subprocess could hang
 *  `initializationResult()` forever (same wedge class as issue #680), and
 *  every join on `queryRecreateInFlight` — prompt/cancel/the config setters,
 *  and closeSession/deleteSession/dispose via `teardownSession → cancel()` —
 *  would inherit that hang. Expiry routes to the recreate's failure path (the
 *  replacement is closed, the old query stays live, the pending flag is
 *  retained), bounding every join. Same "obviously stuck" rationale as
 *  DEFAULT_FORCE_CANCEL_GRACE_MS. */
const QUERY_RECREATE_INIT_TIMEOUT_MS = 30_000;

/** Error surfaced when the SDK declares a turn over (`session_state_changed:
 *  idle`, its authoritative turn-over signal) without ever emitting the turn's
 *  `result` — a model stream that dropped mid-turn, or an async agent that
 *  completed/stalled without the host turn resolving (issue #825). */
const TURN_NO_RESULT_MESSAGE =
  "The turn ended without a result: the agent went idle while this prompt was still in flight " +
  "(e.g. the model stream dropped mid-turn). Any partial output may be incomplete; please retry.";

/** Custom (extension) request method a client uses to steer the turn that is
 *  currently running: the message is injected into the in-flight turn rather
 *  than queued as a separate `session/prompt`. Named `_session/steering` per the
 *  agreed ACP steering wire protocol; advertised to clients via the top-level
 *  `InitializeResponse._meta.steering.supported`. */
const STEER_METHOD = "_session/steering";

/** How urgently the SDK delivers a steered message relative to the running
 *  turn — an internal Claude implementation detail, not part of the wire
 *  contract. `now` pre-empts the current generation and handles the message
 *  immediately (interrupting a single-shot response, or slotting in between a
 *  multi-step turn's tool calls), while `later` waits for a pending
 *  permission/elicitation callback to settle instead of cancelling its ACP
 *  request and hiding the client's user-input card (IJAI-1191). Maps to
 *  `SDKUserMessage.priority`; injected steering uses `now` unless the session is
 *  awaiting user input (see `Session.pendingUserInputCount`). */
const STEER_PRIORITY_NOW = "now" as const;
const STEER_PRIORITY_LATER = "later" as const;

/** Request-level steering options. `promptRequired` is opt-in so existing Hosts
 *  keep the established idle fallback behavior. */
type SteerMeta = {
  [key: string]: unknown;
  steering?: {
    idleBehavior?: "promptRequired";
  };
};

/** Params of a {@link STEER_METHOD} request. Shaped like the relevant subset of
 *  a `PromptRequest` so the same `promptToClaude` conversion applies. Delivery
 *  priority is deliberately NOT exposed here — it's an internal detail the agent
 *  chooses (see {@link STEER_PRIORITY_NOW} / {@link STEER_PRIORITY_LATER}). */
/** `session_info_update._meta` key carrying the live, non-ambient background
 *  tasks (`{ count, tasks: [{ id, type, description }] }`). The level the SDK
 *  reports in `background_tasks_changed`, so a client can tell an idle thread
 *  from one whose turn ended while a shell or subagent keeps running. */
export const BACKGROUND_TASKS_META_KEY = "_claude/backgroundTasks";

export type SteerRequest = {
  sessionId: string;
  prompt: PromptRequest["prompt"];
  _meta?: SteerMeta | null;
};

/** Result of a {@link STEER_METHOD} request. The legacy `startedNewTurn` result
 *  remains the default idle behavior; `promptRequired` is returned only when the
 *  Host explicitly opts into the host-owned fallback in request `_meta`. */
export type SteerResponse =
  | { outcome: "injected" }
  | { outcome: "startedNewTurn" }
  | { outcome: "promptRequired"; reason: "noRunningTurn" };

/** Validate raw JSON-RPC params into a {@link SteerRequest}. Kept minimal — the
 *  content blocks are handed to `promptToClaude`, which tolerates unknown block
 *  types — but `sessionId` and a non-empty `prompt` array are required. */
function parseSteerRequest(params: unknown): SteerRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "steer params must be an object");
  }
  const { sessionId, prompt, _meta } = params as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, "steer params require a non-empty sessionId");
  }
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw RequestError.invalidParams(undefined, "steer params require a non-empty prompt array");
  }
  const steering =
    _meta && typeof _meta === "object" ? (_meta as Record<string, unknown>).steering : undefined;
  const idleBehavior =
    steering && typeof steering === "object"
      ? (steering as Record<string, unknown>).idleBehavior
      : undefined;
  if (idleBehavior !== undefined && idleBehavior !== "promptRequired") {
    throw RequestError.invalidParams(undefined, "unsupported steering idleBehavior");
  }
  return {
    sessionId,
    prompt: prompt as PromptRequest["prompt"],
    _meta: _meta as SteerMeta | null | undefined,
  };
}

/** Internal model-selection state. Mirrors the shape the ACP SDK exposed as
 *  `SessionModelState` before model selection moved entirely into
 *  `SessionConfigOption` (category "model"). Retained internally to track the
 *  current model and build the "model" config option. */
type SessionModelState = {
  availableModels: Array<{ modelId: string; name: string; description?: string }>;
  currentModelId: string;
};

/** One in-flight `prompt()` call. A persistent per-session consumer (see
 *  `runConsumer`) drains the SDK query stream for the whole session and settles
 *  each Turn's deferred when that turn's outcome is known, so `prompt()` itself
 *  holds no loop. Turns are processed FIFO: the SDK echoes queued user messages
 *  back in submission order, so `turnQueue[0]` is the turn currently running. */
type Turn = {
  /** uuid stamped on the pushed `SDKUserMessage`; the SDK echoes it back so the
   *  consumer can match the replayed user message to this turn. */
  promptUuid: string;
  /** Local-only slash commands (e.g. `/clear`) return a result without an echo,
   *  so the consumer can't promote them via the replay; it falls back to
   *  promoting the queue head when the result arrives. */
  isLocalOnlyCommand: boolean;
  /** Whitespace-normalized text this turn delivered as live `notice` updates
   *  (SDK `informational` frames on the notice lane). A hook-blocked turn's
   *  result repeats the block reason verbatim with zero output tokens; the
   *  issue-#453 result-text fallback skips a result that only repeats one of
   *  these, without the notice counting as the turn's answer. Recorded on the
   *  queue head, not `activeTurn`: a UserPromptSubmit block arrives before
   *  any echo, so the turn is only promoted when its result lands. */
  noticeTexts?: string[];
  /** Set when this turn's prompt is exactly `/usage` (story 011, R2.3). The
   *  command still runs through the normal SDK turn — ordering, cancellation,
   *  persistence and replay are untouched — and the structured render is only
   *  an overlay on the output it produces. */
  isUsageCommand?: boolean;
  /** The in-flight structured render for this turn, started once and awaited by
   *  whichever message shape carries the command's output. Resolves to null on
   *  each of R2.4's three ways out, which means "forward Claude Code's own
   *  text, unchanged". */
  usageMarkdown?: Promise<string | null>;
  /** Abandons {@link usageMarkdown} when the turn ends. Half of the bound D5
   *  asks for: the timeout covers a request that is never serviced, this covers
   *  a request whose turn is already over. */
  usageMarkdownAbort?: AbortController;
  /** Set once the render has been published, so the SAME output arriving again
   *  through a second message shape is not rendered twice. */
  usageMarkdownDelivered?: boolean;
  /** Why the render was not produced (timed out, incompatible, failed), held
   *  until the original text is actually published: a turn cancelled first
   *  fell back to nothing and must log nothing (story 011, R2.3). */
  usageFallbackReason?: string;
  /** Set once this turn has logged its one fallback line (story 011, R2.2). */
  usageFallbackLogged?: boolean;
  /** The original text the published render replaced — how a duplicate mirror
   *  of that frame is told from a later, genuinely different one. */
  usageOriginalOutput?: string;
  /** Optional hidden, model-authored file-change audit requested by the ACP
   *  client for this turn. The state is turn-owned so a late tool call can
   *  never be rebound to a newer prompt. */
  fileChangeAudit?: FileChangeAuditTurnState;
  /** Set once the deferred has been resolved/rejected, so the consumer never
   *  settles a turn twice (idle + handoff + stream-end can all race). */
  settled: boolean;
  /** Set when a `command_lifecycle` "started" frame arrives for this turn's
   *  uuid (msg_lifecycle_v1 CLIs): the SDK dispatched the command into a turn.
   *  Read by cancel() to seed the orphan's state — a started orphan's turn may
   *  still emit a result, an undispatched one may be dropped without one. */
  commandStarted?: boolean;
  /** Set when a terminal `command_lifecycle` frame arrives for this turn's
   *  uuid while the turn is still queued (msg_lifecycle_v1 CLIs). The command
   *  is already finished SDK-side, so a later cancel() must not seed an
   *  orphan entry for it — no terminal frame will ever come to drain it.
   *  "completed"/"discarded"/"refused" leave nothing outstanding; "cancelled"
   *  after a dispatch means the dead turn's result may still arrive (seeded
   *  as a zombie) unless it already passed (`commandResultSeen`), and without
   *  a dispatch means dropped (nothing coming). */
  commandFinished?: "completed" | "discarded" | "cancelled" | "refused";
  /** Set when a user-turn result arrives while this command is known
   *  dispatched (`commandStarted`) with no terminal frame yet. Turns run
   *  sequentially and frames arrive in stream order, so the turn this command
   *  was dispatched into IS the turn that emitted that result — including
   *  when the command was FOLDED into another turn (their shared result).
   *  Read by cancel() and the force-cancel wedge path so neither seeds an
   *  orphan entry for a result that has already passed: such an entry could
   *  never be drained by its result and would swallow an unrelated later
   *  echo-less one instead. */
  commandResultSeen?: boolean;
  /** Task ids of the background subagents launched while this turn was the
   *  active one — including during its held-open drain window, so an agent
   *  chain (a followup that launches another subagent) extends the hold.
   *  A turn only waits on its OWN spawned subagents: a long-running agent
   *  from an earlier turn must not stall every later prompt's settlement.
   *  Known residual: task_started carries no lineage, so a spawn made by a
   *  PREVIOUS turn's followup chain while a later turn happens to be held
   *  is attributed to the holder — extending that hold behind a foreign
   *  chain. Bounded: the hold still ends at drain, hand-off, or cancel. */
  spawnedTaskIds?: Set<string>;
  /** Set instead of settling when the turn's terminal result arrives while
   *  subagents it spawned are still live (`spawnedTaskIds` ∩
   *  `session.liveBackgroundTasks`). The turn is held open — its
   *  `session/prompt` stays pending — so the subagents' streamed output,
   *  their permission requests (which would otherwise block on an RPC a
   *  client that stops consuming at the prompt response never answers —
   *  issue #866), and the model's task-notification followup summary all
   *  land inside the turn.
   *
   *  Idle cadence depends on the CLI. Through 2.1.269 the trailing idle is
   *  NOT held for background agents (observed on 2.1.206: `idle` follows the
   *  result immediately while the subagent still runs), so the hold spans
   *  multiple idle cycles: user result → idle → (subagent works) →
   *  task_notification → followup turn → idle. From 2.1.270 the CLI stays
   *  `running` while background agents live (user result →
   *  task_notification → followup turn → ONE idle), so the user result's
   *  idle debt goes unpaid — swept at the next `running` transition.
   *  The stored outcome (the result's stop reason and usage snapshot) is
   *  what the turn settles with once its spawned subagents have settled —
   *  at the followup's terminal result (the summary has streamed by then),
   *  or at an idle with none of its subagents left (no followup came). A
   *  cancel or the next turn's echo hand-off settles it earlier, so a
   *  long-running subagent never holds the prompt hostage.
   *
   *  Accepted residuals. (1) A subagent that ends WITHOUT waking the model —
   *  its task_notification lost or skipped (only the terminal task_updated
   *  patch is guaranteed per transition) — leaves no followup result and no
   *  further idle, so the held turn parks until `session/cancel` or the next
   *  prompt (either settles it: the echo hand-off or ensureActiveTurn's
   *  held-turn hand-off). Settling at the prune sites instead would preempt
   *  the followup summary in the normal ordering (prunes precede the
   *  notification), and a grace timer was judged not worth the machinery —
   *  the same rescue contract as the adapter's other wedge classes (issue
   *  #825's out-of-scope notes). (2) Drained-ness is judged by live-task
   *  membership only: with parallel subagents, a notification that prunes
   *  the last task during an earlier task's still-streaming followup lets
   *  that followup's result settle the turn before the LAST task's summary
   *  streams — degrading to post-turn delivery for it, never worse than the
   *  pre-hold behavior (pending wakes are not countable: notifications can
   *  batch into one followup). */
  deferredSettle?: PromptResponse;
  /** Uuids of `steer()`-injected messages the SDK has not replayed back yet.
   *
   *  A steer is normally delivered at {@link STEER_PRIORITY_NOW}, so the CLI
   *  ABORTS the running cycle: it emits its own human-origin `result` —
   *  indistinguishable from a turn's terminal one — and the steered message runs
   *  as a SECOND cycle. Settling at that result would answer `session/prompt`
   *  mid-work, so a steered turn's results only RECORD their outcome
   *  (`steeredSettle`) and it settles at the SDK's `idle`, the only signal
   *  spanning both cycles (CLI 2.1.220).
   *
   *  A non-empty set at an idle means the steered cycle hasn't started — the CLI
   *  replays a message only when it picks it up, always after the interrupted
   *  cycle's result — so that idle is swallowed. Drained by the replay handler.
   *
   *  Residual: a message the CLI drops unreplayed parks the turn until
   *  `session/cancel` or the next prompt (both settle it). */
  steeredEchoes?: Set<string>;
  /** What a steered turn settles with once its steered work has run: the outcome
   *  of its latest result, so its usage covers every cycle the turn ran. */
  steeredSettle?: PromptResponse;
  carriedUsage?: AccumulatedUsage;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
  /** Settles after the ACP prompt request completes, regardless of outcome. */
  completion?: Promise<void>;
};

/** How often the account quota windows are refreshed while a session sits idle,
 *  in milliseconds; `0` disables polling entirely.
 *
 *  Without this the windows move at only three moments: session establishment,
 *  the end of every turn, and a pushed `rate_limit_event`. None of them is time
 *  — so a five-hour window that resets while nobody is prompting keeps showing
 *  the old utilization, and the bar is wrong in the one direction that matters
 *  (it under-reports how much is available) until the next turn ends.
 *
 *  The floor is not timidity: each tick costs one control request, and neither
 *  the five-hour nor the seven-day window can move fast enough for a tighter
 *  loop to show anything a 15-second one would miss. */
const QUOTA_POLL_DEFAULT_MS = 60_000;
const QUOTA_POLL_FLOOR_MS = 15_000;

/** Resolve the poll interval from the environment, clamped. An unparseable or
 *  negative value falls back to the default rather than disabling the refresh:
 *  a typo should not silently return the bars to the stale behaviour this
 *  exists to fix. Exactly `0` disables, because that is the only way to ask. */
export function quotaPollIntervalMs(
  raw: string | undefined = process.env.CLAUDE_ACP_QUOTA_POLL_MS,
): number {
  if (raw === undefined || raw.trim() === "") {
    return QUOTA_POLL_DEFAULT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return QUOTA_POLL_DEFAULT_MS;
  }
  if (parsed === 0) {
    return 0;
  }
  return Math.max(parsed, QUOTA_POLL_FLOOR_MS);
}

export type Session = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  cancelled: boolean;
  /** FIFO of in-flight prompts. The head is the turn the SDK is currently
   *  processing; later entries are queued and will be echoed in order. */
  turnQueue?: Turn[];
  /** The turn whose messages the consumer is currently attributing output to
   *  (the head of `turnQueue` once its user message has been echoed). */
  activeTurn?: Turn | null;
  /** Request ids already accepted for hidden agent file-change reports. Kept
   *  for the session lifetime so a redelivered prompt cannot publish the same
   *  audit twice or bind a late report to another turn. */
  fileChangeReportRequestIds: Set<string>;
  /** Session-owned publisher for negotiated file-change audits. Turn state
   *  stays on each Turn; this controller supplies the single idempotent
   *  unavailable terminal used by every non-report settlement path. */
  fileChangeAuditSupport?: FileChangeAuditSupport;
  /** Optimistic goal state published for a submitted `/goal` command whose
   *  matching runtime update has not arrived yet. Runtime updates for the old
   *  goal are suppressed until this command is echoed or completes, otherwise
   *  a late old-goal update can overwrite a replacement that the runtime never
   *  announces (the compatibility case the optimistic update exists for). */
  pendingGoalUpdate?: {
    commandUuid: string;
    expected: GoalSnapshot | null;
    previous: GoalSnapshot | null | undefined;
    started: boolean;
  };
  /** Last goal snapshot sent to the ACP client, used to roll back an
   *  optimistic `/goal` update when the command itself fails. */
  lastPublishedGoal?: GoalSnapshot | null;
  /** Sorted, newline-joined ids of the non-ambient background tasks last
   *  published under {@link BACKGROUND_TASKS_META_KEY}; undefined = none yet,
   *  which compares equal to an empty set so a session that never runs one
   *  sends nothing. */
  lastPublishedBackgroundTasks?: string;
  /** Count of result messages the consumer should treat as orphans and skip
   *  (not promote/attribute to the current head). When cancel() settles+removes
   *  a queued turn, that turn's user message was already pushed to the SDK, so
   *  the SDK still runs it and emits a result with no uuid we can match. Because
   *  the SDK processes input FIFO, those orphan results arrive (in submission
   *  order) before the next live turn's, so skipping exactly this many leaves
   *  the genuine head untouched. On CLIs with the interrupt receipt, orphans
   *  the interrupt dropped (absent from `still_queued`) are uncounted as soon
   *  as the receipt arrives (see cancel()). Reset to 0 on every activation as
   *  a backstop against a dropped queued input this can't see (older CLIs, a
   *  receipt lost to a failed control round-trip). Only used when the CLI does
   *  NOT emit lifecycle frames (see `orphanCommands` for the msg_lifecycle_v1
   *  lane); a count can't express command coalescing — N queued commands can
   *  fold into ONE turn emitting one result, leaving a stale skip of N-1. */
  pendingOrphanResults?: number;
  /** msg_lifecycle_v1 lane of the orphan accounting (see
   *  `pendingOrphanResults` for the count lane): the uuids of cancelled queued
   *  turns whose SDK-side command may still produce an unaccounted result,
   *  keyed to what we know of its fate. "pending" = not seen dispatched; if
   *  the SDK drops it (interrupt, `cancelled` before "started") no result
   *  ever comes. "started" = dispatched into a turn whose result is still
   *  coming; exactly one terminal lifecycle frame will follow. "zombie" = its
   *  turn was aborted/failed after dispatch with no result seen since
   *  (`cancelled` after "started"); no more lifecycle frames come, but the
   *  dead turn's error result may still arrive. Entries are removed the
   *  moment their result is covered: EVERY user-turn result covers ALL
   *  started and zombie entries at once (turns run sequentially and frames
   *  arrive in stream order, so at any result the started entries were
   *  dispatched into — possibly folded into — the emitting turn, and any
   *  zombie's late result has already passed or never existed), whether that
   *  result was attributed to the active turn or skipped echo-less (see
   *  recordResultForOrphanCommands / ensureActiveTurn). A command's own
   *  terminal frame also drains its entry ("completed" is emitted after any
   *  result its turn produced; a bare `cancelled` deletes a pending entry —
   *  dropped without running — and zombifies a started one). An echo-less
   *  result is an orphan's iff this map is non-empty (FIFO: orphan turns run
   *  before any live turn's). Cleared on every activation, same self-heal as
   *  the count (covers a lost frame, which can leak an entry — each state
   *  bounds the damage to one wrong skip). */
  orphanCommands?: Map<string, "pending" | "started" | "zombie">;
  /** True once a `system`/init advertised the msg_lifecycle_v1 capability, so
   *  cancel() routes orphan accounting to `orphanCommands` (exact, per-uuid)
   *  instead of `pendingOrphanResults` (count, coalescing-blind). */
  msgLifecycleV1?: boolean;
  /** Latched from `system`/init `terminal_slash_commands` (CLI 2.1.232+):
   *  names of advertised slash commands whose UX is bound to the CLI's own
   *  terminal (e.g. /doctor, /color). ACP clients aren't that terminal, so
   *  these are filtered out of `available_commands_update` payloads. */
  terminalSlashCommands?: string[];
  /** Serialized `system`/init `plugin_errors` last logged, so the per-turn
   *  init re-emit logs a plugin load failure once, not every turn. */
  loggedPluginErrors?: string;
  /** The long-lived consumer task. Lazily started on the first `prompt()` and
   *  kept alive for the session so between-turn/background messages are still
   *  drained and forwarded. */
  consumer?: Promise<void>;
  /** Set once the SDK query stream has terminated (it ran to `done` or threw a
   *  non-process error). The query iterator is not reusable afterward, so a
   *  later `prompt()` rejects instead of enqueueing onto a dead stream and
   *  hanging (or silently restarting a consumer that resolves `end_turn`
   *  without ever reaching the model). */
  queryClosed?: boolean;
  cwd: string;
  /** Serialized snapshot of session-defining params (cwd, mcpServers) used to
   *  detect when loadSession/resumeSession is called with changed values. */
  sessionFingerprint: string;
  /** Original ACP parameters used to recreate this query with a new provider. */
  creationParams?: NewSessionRequest;
  settingsManager: SettingsManager;
  /** This session's title state and the turn-end logic that maintains it. */
  titles: SessionTitles;
  accumulatedUsage: AccumulatedUsage;
  modes: SessionModeState;
  /** The mode the session left when it entered plan mode, if it is in plan. */
  prePlanMode?: string;
  models: SessionModelState;
  modelInfos: ModelInfo[];
  /** Prevents the model-specific Auto fallback from spamming the transcript. */
  autoModeFallbackWarningShown?: boolean;
  /** Initial mode fallback is reported after session/new, on the first prompt. */
  autoModeFallbackWarningPending?: boolean;
  configOptions: SessionConfigOption[];
  /** Custom main-thread agent personas the user (or a plugin/project) has
   *  configured, discovered via `supportedAgents()` with Claude Code's built-in
   *  subagents filtered out. Empty when none are configured, in which case the
   *  "agent" config option is omitted entirely. */
  agents: AgentInfo[];
  /** The currently selected main-thread agent name, or "default" for the
   *  standard Claude Code agent (no `agent` flag applied). */
  currentAgent: string;
  /** Whether Fast mode is currently enabled for this session. Tracked as the
   *  user's intent so it persists across model switches; the Fast mode config
   *  option is only surfaced while the selected model supports it. */
  fastModeEnabled: boolean;
  /** Whether Ultracode is the session's current effort selection. Tracked as
   *  intent for the same reason `fastModeEnabled` is: the entry disappears from
   *  the picker on a model without `xhigh`, and reappears selected when a model
   *  that has it is chosen again. It is NOT derivable from the effort level —
   *  `xhigh` on its own is a legitimate selection that is not Ultracode. */
  ultracode: boolean;
  /** Whether this session's resolved settings disable workflows — the half of
   *  the Ultracode gate that is not a model capability. Read once at
   *  initialize and held, rather than re-read per model switch: settings are
   *  resolved when the session is created, and re-reading them on a hot path
   *  would imply they can change under it. */
  workflowsDisabled: boolean;
  /** The accounts declared in this session's resolved settings (D4), read once
   *  at initialize and held for the same reason `workflowsDisabled` is. Empty
   *  when none are declared, in which case no selector is advertised and the
   *  process's own configuration home stands. Optional because a Session
   *  assembled without it (a fixture, a future construction site) has declared
   *  no accounts, which is exactly what absent means here. */
  declaredAccounts?: DeclaredAccount[];
  /** The account selector's value in force for this session, or `undefined`
   *  when nothing is declared. Rebuilt into the option on every
   *  `buildConfigOptions` pass so the row survives a model switch. */
  currentAccount?: string;
  /** The environment overlay the account in force resolves to — one variable,
   *  `CLAUDE_CONFIG_DIR` (D2). Set when the session is created, and again when
   *  the selector changes, where it records what a session created FROM NOW ON
   *  will be started with. It is NOT applied to the query already running: the
   *  live query's env is baked into `queryOptions`, which a lazy recreate
   *  rebuilds from, so a selection cannot move the thread on screen onto
   *  another account's history (D7). */
  accountEnv?: Record<string, string>;
  /** Why the SDK currently can't serve Fast mode, when the reason is one worth
   *  telling the user about (see {@link FAST_MODE_UNAVAILABLE_EXPLANATIONS} —
   *  routine states like the SDK's own opt-in requirement normalize to
   *  `undefined`). Refreshed from every `fast_mode_disabled_reason` the SDK
   *  reports on `system`/init and user-turn `result`s; surfaced in the Fast mode
   *  option's description so a toggle that snaps back off explains itself. */
  fastModeDisabledReason?: FastModeDisabledReason;
  /** Tri-state Thinking intent (story 006): `true`/`false` once the client has
   *  set the Thinking config option, `undefined` while untouched — i.e. the
   *  env-driven `MAX_THINKING_TOKENS` behavior stays in charge (R1.6). Mirrors
   *  `fastModeEnabled` intent tracking so the selection survives model
   *  switches (R1.7); collapsed to the SDK's `thinking` option only via
   *  `effectiveThinkingConfig`. */
  thinkingEnabled?: boolean;
  /** Set by the Thinking set-handler when the session's thinking intent
   *  changes; the next `prompt()` start consumes it to lazily recreate the SDK
   *  query with the new thinking config (see `recreateSessionQuery`). */
  pendingQueryRecreate?: boolean;
  /** The exact SDK `Options` the session's current query was created with.
   *  `recreateSessionQuery` derives the replacement query's options from these
   *  plus the live-tracked session state, so creation-only inputs (hooks,
   *  canUseTool, mcpServers, env, systemPrompt, …) survive the swap without
   *  re-running `createSession`'s assembly. Always set by `createSession`;
   *  optional only because tests hand-build Session objects — the recreate
   *  path fails gracefully when it is absent. Refreshed on every successful
   *  recreate. */
  queryOptions?: Options;
  /** The in-flight lazy query recreate, when one is running. A concurrent
   *  `prompt()` joins (awaits) it instead of racing a second recreate or
   *  enqueueing onto the query mid-swap. */
  queryRecreateInFlight?: Promise<void>;
  /** Set while a `/rewind` command is running (`handleRewindCommand` in
   *  flight). A rewind never enqueues a Turn, so it is invisible to the lazy
   *  query-recreate trigger's idleness check (`turnQueue`/`activeTurn`);
   *  without this flag a real prompt arriving mid-restore would look idle,
   *  start a recreate, and close the query underneath `query.rewindFiles()`.
   *  The trigger additionally requires this flag to be unset. */
  rewindInFlight?: boolean;
  abortController: AbortController;
  /** Signal the consumer races `query.next()` against. Aborted by cancel()
   *  (after a grace period) to force the active turn to settle "cancelled" when
   *  the SDK is wedged and `query.next()` never yields again (issue #680).
   *  Distinct from `abortController`: this only wakes the consumer; it does NOT
   *  touch the SDK query/subprocess. The consumer re-arms it after each fire.
   *  Undefined until the consumer is started by the first prompt. */
  cancelController?: AbortController;
  /** Pending grace-period timer that aborts `cancelController`. Cleared when the
   *  active turn settles normally so the backstop never fires after a clean
   *  cancel. */
  forceCancelTimer?: ReturnType<typeof setTimeout>;
  /** Repeating timer that refreshes the account quota windows while this session
   *  is idle. Armed at the end of the first turn rather than at session
   *  establishment: before then a control request is not serviced at all
   *  (issues #886/#880), so an earlier timer would only log failures. Cleared in
   *  `closeQueryStream` — the one point every teardown path passes through --
   *  so it cannot outlive the stream it queries. Undefined while polling is
   *  disabled or before the first turn settles. */
  accountUsageTimer?: ReturnType<typeof setInterval>;
  emitRawSDKMessages: boolean | SDKMessageFilter[];
  /** Whether nested subagent text/thinking is forwarded to the ACP client.
   *  Enabled by either the ACP capability or the pre-existing SDK option. */
  forwardSubagentText: boolean;
  /** Number of ACP permission/elicitation requests currently awaiting user
   *  input. A counter rather than a boolean because parallel subagents can ask
   *  concurrently; steering must stay non-interrupting until the LAST of them
   *  settles. Maintained by `withPendingUserInput`, which owns every increment
   *  and decrement. */
  pendingUserInputCount?: number;
  /** Context window size of the session's current model, carried across
   *  prompts so mid-stream usage_update notifications report a correct `size`
   *  before the turn's first result message arrives. Seeded synchronously at
   *  session creation and on model switches from the per-model cache or the
   *  text heuristic (DEFAULT_CONTEXT_WINDOW when both miss; on session/load the
   *  resumed session's own `getContextUsage` report wins, see
   *  `readResumedLiveModel`), then confirmed — and the cache populated — by each
   *  result's modelUsage. No extra `getContextUsage` IPC is on these paths: on a
   *  fresh session it stalls until the first turn runs (see the seeding call
   *  sites and `contextWindowCache`). */
  contextWindowSize: number;
  /** Context-window occupancy last reported for this session, in tokens — the
   *  `used` half of every `usage_update`. `undefined` means nothing has been
   *  READ yet, which is a different statement from a measured zero and is
   *  treated as one: the permission request's `contextUsedPercent` omits the
   *  figure entirely rather than showing 0%.
   *
   *  Written by the turn itself (each top-level assistant message's usage, and
   *  the compact boundary's `getContextUsage`), and seeded once at session
   *  creation on session/load — never on session/new — from the resumed
   *  session's own `getContextUsage` report, the same response
   *  `getAvailableModels` already awaits to learn the live model, so no extra
   *  IPC (see `readResumedLiveModel`). Without that seed a thread reloaded
   *  with real context reported `used: 0` until its first turn ended, and the
   *  client renders that as an empty ring rather than as "unknown": its
   *  `UsageUpdate` arm assigns `used`/`size` unconditionally and creates the
   *  token-usage record where there was none. A fresh session really has used
   *  nothing, so `publishAccountUsage` reporting its `undefined` as 0 is not
   *  the same defect and stays as it is. */
  contextUsedTokens?: number;
  /** Maps this session's structured `/usage` reports onto the quota-window
   *  payloads the client ingests, and remembers the status a live
   *  `rate_limit_event` MEASURED for as long as that window instance lasts
   *  (see {@link AccountUsageTracker}).
   *
   *  Session-scoped on purpose, and in both directions: the memory has to
   *  outlive a turn (a five-hour window measured on turn one still governs
   *  turn nine) and must never outlive the session (it is per-account state,
   *  and two sessions can run against different accounts). Living on the
   *  Session gives it exactly that lifetime — a consumer local would lose it
   *  on the lazy Thinking recreate, which starts a fresh consumer mid-session.
   *  Always set by `createSession`; optional only because tests hand-build
   *  Session objects, so the accessor creates it on demand. */
  accountUsage?: AccountUsageTracker;
  /** Whether `contextWindowSize` came from an authoritative source (the
   *  cross-session cache, a resumed session's `getContextUsage` report, or a
   *  `result.modelUsage`) rather than the text heuristic / default. Guards the
   *  mid-stream `message_start` heuristic upgrade: an authoritative window that
   *  happens to equal DEFAULT_CONTEXT_WINDOW must not be mistaken for "unseeded"
   *  and clobbered by a "1m" text match. */
  contextWindowAuthoritative: boolean;
  /** Stable identifier of the LLM backend this session's query was created
   *  against, derived from the routing-relevant vars of the exact `env` handed
   *  to the SDK at query creation (see {@link providerCacheKeyFor}). The context
   *  window is a property of (model id, backend) — the same resolved model id
   *  can name different windows behind different base URLs, routing headers, or
   *  credentials — so this scopes the module-global `contextWindowCache` per
   *  backend. Captured from the query's own env (not re-resolved later) because
   *  the process-wide provider config can change while a session is being
   *  created, while the query stays baked to the env it was created with. */
  providerCacheKey: string;
  /** Accumulated task list for the session, keyed by task ID. Task IDs are
   *  per-session, so this state must not be shared across sessions. */
  taskState: TaskState;
  /** Caches `tool_use` blocks by id so the matching `tool_result` can recover
   *  the tool name/input when mapping it to a `tool_call_update`. Per-session
   *  (tool_use ids are only unique within a session) and pruned at
   *  `tool_result` time so a long-running session doesn't accumulate every
   *  tool call for its whole lifetime. */
  toolUseCache: ToolUseCache;
  /** Tracks which tool_use ids we've already emitted a `tool_call` for, so the
   *  second source to encounter a tool call sends a `tool_call_update` instead
   *  of a duplicate `tool_call`. The SDK can invoke `canUseTool` (→ a permission
   *  request, which emits the tool_call eagerly so the client has it before
   *  being asked to approve it) either before or after the assistant message's
   *  tool_use block streams; this set makes the two paths converge regardless of
   *  order. Pruned at `tool_result` time alongside `toolUseCache`. */
  emittedToolCalls: Set<string>;
  /** ExitPlanMode denial that intentionally interrupts the current Claude
   *  cycle. Correlated by tool-use id until the terminal result arrives. */
  pendingExitPlanModeInterruption?: {
    toolUseId: string;
    toolResultSeen: boolean;
  };
  pendingExitPlanContextReset?: {
    toolUseId: string;
    plan: string;
    mode: PermissionMode;
  };
  /** Registry of live background tasks, keyed by task id: populated at
   *  `task_started`, pruned when the task settles (a `task_notification` or
   *  a terminal `task_updated` patch), and reconciled against
   *  `background_tasks_changed`'s replace-semantics payload so a lost
   *  bookend can't leak an entry. One structure for both of its concerns so
   *  a future terminal path can't prune one and not the other:
   *
   *  `parentToolUseId` — the tool_use id of the Agent/Task call that spawned
   *  the task. For subagent tasks the SDK keys its registry by agent id, so
   *  `task_started.task_id` IS the `agentID` that `canUseTool` later
   *  receives. Lets the permission flow attribute a subagent's
   *  eagerly-emitted `tool_call` (and the permission request itself) to its
   *  parent tool call via `_meta.claudeCode.parentToolUseId`, matching the
   *  streamed subagent path. Best-effort: a `canUseTool` that races ahead of
   *  the consumer processing `task_started` omits the attribution from the
   *  eager tool_call, and the streamed tool_use chunk's refining
   *  `tool_call_update` — which carries the message-level
   *  `parent_tool_use_id` — restores it for merging clients; that recovery
   *  is what makes best-effort acceptable here.
   *
   *  `isSubagent` — whether the task is a Task/Agent-tool subagent
   *  (`task_started` carried a `subagent_type`). Read by
   *  `turnAwaitingSubagents` (with `spawnedTaskIds`) to decide whether a
   *  turn's settlement is deferred (see `Turn.deferredSettle`), so the
   *  subagents' post-result output and permission requests stay inside the
   *  turn (issues #864/#866). Deliberately false for non-subagent background
   *  tasks (e.g. a `run_in_background` dev server): those can outlive every
   *  turn, and the model's contract with them is a wake-on-exit
   *  notification, not a turn-scoped drain — a hold must NEVER wait on a
   *  shell.
   *
   *  `endedPerLevel` — a `background_tasks_changed` payload did not include
   *  this subagent entry. The level's universe is BACKGROUND tasks only, so
   *  a live sync (foreground) subagent is legitimately absent — its entry is
   *  kept for permission attribution — but a hold must stop waiting on the
   *  id: an absent id can equally be a leaked async entry whose settle
   *  bookends were lost, and waiting on it would park the hold forever.
   *  Non-subagent entries are simply deleted instead (shells are always in
   *  the level's universe). */
  liveBackgroundTasks: Map<
    string,
    {
      parentToolUseId?: string;
      isSubagent: boolean;
      /** Absent-from-level lifecycle, one field so the illegal
       *  armed-but-not-ended state is unrepresentable: undefined = live per
       *  the level signal; "ended" = a level omitted the task (holds stop
       *  waiting on it; attribution is kept); "sweep-armed" = a turn
       *  activation saw it ended — the NEXT activation deletes it. The
       *  one-activation grace exists for the absent-mark race (a level
       *  payload built before a live async agent's registration): a
       *  corrective inclusive level resets the field to undefined — one
       *  assignment, disarming any in-flight sweep — if it arrives within a
       *  full turn, keeping the agent's attribution; eager deletion would
       *  be irreversible, since levels never ADD entries. A re-mark
       *  preserves an in-flight arm (`??=`), keeping a continuously absent
       *  entry on its two-activation clock. */
      endedPerLevel?: "ended" | "sweep-armed";
    }
  >;
  /** Whether any top-level assistant text reached the client since the last
   *  stretch boundary. Set as a side effect of sending in the consumer's
   *  `sendUpdate`, never at an emission site; read at the terminal `result`
   *  to tell a turn whose answer was already delivered from one that only
   *  ever carried it on `result` (issue #453). Session-level (not
   *  consumer-scoped) so cancel()'s inline settle can clear it.
   *
   *  The CURRENT boundary set — a new clear site must be added here: the
   *  result case's `finally` (user-turn results), settleActive's wasHeld
   *  clear (every held-turn settle lane: drain settle, both hand-offs,
   *  stream-done), failActive, the force-cancel backstop, the idle
   *  cancelled-settle, the autonomous-result close (only with no turn
   *  active OR queued — see its queued-turn guard), and cancel()'s inline
   *  mirror.
   *
   *  Deliberately NOT reset on turn activation: activation can fire
   *  mid-message (see the echo hand-off), so a flag cleared there would
   *  forget text that already streamed and the result text would be emitted
   *  a second time. Neither the consolidated `assistant` message nor a
   *  `stream_event` carries `origin`, so an autonomous cycle's prose is
   *  indistinguishable from a user turn's here and sets the flag too; the
   *  autonomous-result close normally ends that stretch so a replayed
   *  prompt behind it still delivers, and only in the racing window (a
   *  turn already active or queued when the autonomous result lands) does
   *  the replayed turn stay silent rather than risk a duplicate. */
  emittedAssistantText: boolean;
  /** The last turn whose prompt was exactly `/usage`. CLI 2.1.280 can send the
   *  command's synthetic frame AFTER the result that settled the turn, when no
   *  active or queued turn is left to own it; this is how that trailing copy
   *  is recognised as output already rendered (story 011, R1.3). */
  lastUsageTurn?: Turn;
  /** The most recent `session_state_changed` state the consumer processed.
   *  Read by cancel() to decide whether the interrupt will produce a
   *  trailing idle worth pre-counting: interrupting a RUNNING cycle yields
   *  one; interrupting an already-idle session (the common held-turn shape)
   *  yields none, and a pre-counted debt that never drains would mask one
   *  future issue-#825 detection. */
  lastSessionState?: "idle" | "running" | "requires_action";
  /** How many trailing `session_state_changed: idle` messages are already
   *  accounted for: every result is followed by one (user-turn results that
   *  terminate a turn — settle, reject, or orphan skip — and autonomous
   *  cycles alike), as is a cancelled turn settled by the next turn's echo
   *  hand-off or by cancel()'s inline settle of a held turn whose interrupt
   *  pre-empts a running cycle — the reason this lives on the Session:
   *  cancel() must be able to record the debt. The idle handler absorbs
   *  owed idles; an idle that arrives when NONE is owed while the active
   *  turn is still unsettled means the SDK ended the turn without ever
   *  emitting its result, so the turn will never settle on its own (issue
   *  #825). Stream-level debt, deliberately NOT reset per turn: a lagged
   *  idle can arrive after the next turn has already activated (issue
   *  #773), and the debt is what attributes it to the turn that owed it.
   *  Over-counting (an idle the SDK never emits) is benign: the counter
   *  just absorbs one future idle, and detection degrades to the status quo
   *  rather than misfiring. */
  owedTrailingIdles: number;
  /** Maps the ACP `messageId` we expose to clients (see `messageIdForGrouping`)
   *  to the SDK message uuid that the Agent SDK's rewind/resume APIs key on
   *  (`Query.rewindFiles` takes a user-message uuid; `resumeSessionAt` takes an
   *  `SDKAssistantMessage.uuid`). For assistant turns the two differ — the ACP
   *  id is the Anthropic API message id (`msg_…`), available at `message_start`
   *  so streamed chunks can carry it, while the uuid only arrives on the
   *  consolidated message — so a client can only ask to rewind/fork by the id it
   *  was given, and we need this table to translate it back.
   *
   *  Populated as a byproduct of the message loop (the consolidated message
   *  carries both ids) and of `replaySessionHistory` on load, so no extra
   *  `getSessionMessages` read is needed at rewind time. Last-write-wins
   *  naturally yields the turn-boundary uuid when one `msg_…` spans several
   *  content-block messages.
   *
   *  NOT READ YET — recorded now so the mapping exists if/when we wire up
   *  fork/rewind. */
  messageIdToUuid: Map<string, string>;
  /** Durable-for-this-consumer failure state shared with session/load replay.
   *  Keeping it on the Session lets replay seed a failure that the persistent
   *  consumer can later clear with the same id and a higher revision. */
  sessionFailureState: SessionFailureState;
};

/** Result-message origin kinds that mark an AUTONOMOUS cycle — work the
 *  model did on its own (a task-notification followup, a peer/coordinator/
 *  observer message it handled) rather than the user's prompt. Absent,
 *  `human`, and `channel` origins are the user's own turn (this adapter's
 *  prompts arrive as the ACP channel on some CLI configurations — ALL
 *  channel servers are treated as user, so a foreign channel integration's
 *  autonomously-handled result is misclassified as the user's; accepted,
 *  see below), and `auto-continuation` continues the user's turn, so its
 *  result is the turn's real terminal.
 *
 *  Deliberately fail-OPEN: an unknown future kind defaults to the user
 *  lane — including `unclassified` (SDK 0.3.232+), the CLI's own "couldn't
 *  attribute this" marker, which gets the same safe default. Misrouting a
 *  USER result into the autonomous lane hangs the prompt un-detectably
 *  (the result is skipped, its trailing idle absorbed as owed, so the
 *  #825 detector can't fire); misrouting an autonomous result into the
 *  user lane is the bounded misattribution class this set exists to
 *  reduce. */
const AUTONOMOUS_RESULT_ORIGINS: ReadonlySet<SDKMessageOrigin["kind"]> = new Set([
  "task-notification",
  "peer",
  "coordinator",
  "observer",
  "observer-activity",
]);

/** Whether this turn's terminal result arrived but its settlement is being
 *  held for background subagents it spawned (see Turn.deferredSettle). The
 *  single spelling of the hold predicate, shared by the consumer's settle
 *  lanes and cancel(). */
function isHeldOpen(
  turn: Turn | null | undefined,
): turn is Turn & { deferredSettle: PromptResponse } {
  return turn != null && turn.deferredSettle !== undefined && !turn.settled;
}

/** Whether a steer moved this turn's settlement off the next result and onto the
 *  SDK's `idle` (see Turn.steeredEchoes). Shared by the consumer's settle lanes. */
function isSteering(turn: Turn | null | undefined): turn is Turn & { steeredEchoes: Set<string> } {
  return turn != null && turn.steeredEchoes !== undefined && !turn.settled;
}

/** Disarm the force-cancel backstop (see Session.forceCancelTimer). Every
 *  path that settles the active turn must run this so a timer can never fire
 *  on an already-settled turn — and must leave the field undefined, or the
 *  arm site's !forceCancelTimer guard would refuse to arm the backstop for
 *  the NEXT turn's cancel. */
function disarmForceCancel(session: Session): void {
  if (session.forceCancelTimer) {
    clearTimeout(session.forceCancelTimer);
    session.forceCancelTimer = undefined;
  }
}

/** Compute a stable fingerprint of the session-defining params so we can
 *  detect when a loadSession/resumeSession call requires tearing down and
 *  recreating the underlying Query process.  MCP servers are sorted by name
 *  so that ordering differences don't trigger unnecessary recreations.
 *
 *  Additional directories are part of it (the additionalDirectories half of
 *  upstream #1097): the SDK reads them only when the process starts, so a warm
 *  resume that changed them would otherwise keep the old workspace roots. They
 *  are resolved the way createSession resolves them -- the ACP field, else
 *  `_meta.additionalRoots` -- then de-duplicated and sorted, so an absent list
 *  and an empty one, or the same list reordered, reuse the running query. */
export function computeSessionFingerprint(params: {
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
  additionalDirectories?: NewSessionRequest["additionalDirectories"];
  _meta?: NewSessionRequest["_meta"];
}): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const additionalDirectories = [
    ...new Set(
      params.additionalDirectories ??
        (params._meta as NewSessionMeta | undefined)?.additionalRoots ??
        [],
    ),
  ].sort();
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers, additionalDirectories });
}

export type SDKMessageFilter = {
  type: string;
  subtype?: string;
  origin?: SDKMessageOrigin["kind"];
};

/**
 * Extra metadata that can be given when creating a new session.
 */
export type NewSessionMeta = {
  claudeCode?: {
    /**
     * Options forwarded to Claude Code when starting a new session.
     * Those parameters will be ignored and managed by ACP:
     *   - cwd
     *   - includePartialMessages
     *   - allowDangerouslySkipPermissions
     *   - permissionMode
     *   - canUseTool
     *   - executable
     * Those parameters will be used and updated to work with ACP:
     *   - hooks (merged with ACP's hooks)
     *   - mcpServers (merged with ACP's mcpServers)
     *   - disallowedTools (merged with ACP's disallowedTools)
     *   - tools (passed through; defaults to claude_code preset if not provided)
     */
    options?: Options;
    /**
     * When set, raw SDK messages are emitted as extNotification("_claude/sdkMessage", message)
     * in addition to normal processing.
     * - true: emit all messages
     * - false/undefined: emit nothing (default)
     * - SDKMessageFilter[]: emit only messages matching at least one filter
     */
    emitRawSDKMessages?: boolean | SDKMessageFilter[];
  };
  additionalRoots?: string[];
};

/**
 * Extra metadata for 'gateway' authentication requests.
 */
type GatewayAuthMeta = {
  /**
   * These parameters are mapped to environment variables to:
   * - Redirect API calls via baseUrl
   * - Inject custom headers
   * - Bypass the default Claude login requirement
   */
  gateway: {
    baseUrl: string;
    headers: Record<string, string>;
  };
};

type GatewayAuthRequest = AuthenticateRequest & { _meta?: GatewayAuthMeta };

const SUPPORTED_PROTOCOLS: LlmProtocol[] = ["anthropic", "bedrock", "vertex"];
const PROVIDER_ID = "main";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Vertex needs project + region that the standard `providers/set` payload
 * (`apiType`/`baseUrl`/`headers`) does not model, so clients pass them through
 * `_meta.claudeCode.vertex`. Required only when `apiType === "vertex"`.
 */
type SetProviderMeta = {
  claudeCode?: {
    vertex?: {
      projectId: string;
      region: string;
    };
  };
};

/**
 * Resolved, non-secret + secret routing config for the `main` provider. This is
 * the shared shape produced by both `providers/set` and the legacy gateway auth
 * path, and consumed by {@link createEnvForProvider}. `null` means the provider
 * is unconfigured (no client-managed routing in effect).
 */
type ProviderConfig = {
  apiType: LlmProtocol;
  baseUrl: string;
  headers: Record<string, string>;
  /** Present only for `apiType === "vertex"`. */
  vertex?: {
    projectId: string;
    region: string;
  };
};

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  /* Versioned facts about a context compaction, on the synthetic tool call
     that reports one. See context-compaction-meta.ts for why this rides in
     `_meta` rather than ACP's own `compaction_update` variant. */
  contextCompaction?: ContextCompactionMetadata;
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. Also carried as the
       standard ACP `name` field on the initial `tool_call`; kept here so every
       `tool_call_update` stays self-describing for clients that key off it. */
    toolName: string;
    /* A human-readable title supplied by Claude Code for the tool call. */
    title?: string;
    /* The structured output provided by Claude Code. */
    toolResponse?: unknown;
    /* For a tool call made inside a subagent: the tool_use id of the
       Agent/Task call that spawned the subagent. Mirrors the SDK's
       `parent_tool_use_id` on streamed subagent messages. */
    parentToolUseId?: string;
    /* On a "failed" tool_call_update: why the tool never actually ran, so a
       client can render the denial/cancellation distinctly from a real tool
       failure. From the SDK's `tool_result_meta` non_execution_kind:
       "user-rejected", "permission-rule", "interrupted", "cancelled", …
       (open set). Absent when the tool executed — including real failures. */
    nonExecutionKind?: string;
    /* Free-text the user supplied when rejecting the tool call, when the
       harness collected any. Only ever present alongside nonExecutionKind. */
    userFeedback?: string;
    /* Marks Agent/Task tool calls as subagent launches. ACP 1.2 has no
       standard subagent ToolKind yet, so clients that support nested
       transcripts need a namespaced marker instead of inferring from
       `toolName` or the generic `think` kind. */
    subagent?: true;
    /* For Skill tool calls: the name of the skill being loaded (e.g. "commits").
       Lets clients render a "Load skill: <name>" block without parsing the title. */
    skill?: string;
    /* For Skill tool calls: absolute path of that skill's SKILL.md, when it could be
       located on disk. Lets clients turn the rendered skill name into a link to it. */
    skillPath?: string;
  };
  /* Terminal metadata for Bash tool execution, matching codex-acp's _meta protocol. */
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number;
    signal: string | null;
  };
};

const SUBAGENT_TRANSCRIPT_CAPABILITY = "subagent-transcript";

function supportsSubagentTranscript(capabilities?: ClientCapabilities | null): boolean {
  return capabilities?._meta?.[SUBAGENT_TRANSCRIPT_CAPABILITY] === true;
}

function parentToolUseIdOf(message: { parent_tool_use_id?: unknown }): string | null {
  if (!("parent_tool_use_id" in message)) return null;
  return typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
}

function stripSubagentTextAndThinking(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter(
    (item) =>
      !item ||
      typeof item !== "object" ||
      !("type" in item) ||
      (item.type !== "text" && item.type !== "thinking"),
  );
}

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

type StreamedToolInput = {
  id: string;
  name: string;
  partialJson: string;
  /** Offset into `partialJson` the scanner has consumed; each delta only scans
   *  the newly appended fragment, so total scan work stays linear. */
  scannedTo: number;
  inString: boolean;
  escaped: boolean;
  objectDepth: number;
  arrayDepth: number;
  /** Offset of the most recent comma at the top level of the input object
   *  (-1 before the first). Everything before it is a complete field. */
  lastTopLevelComma: number;
  /** The comma offset the last emitted refinement was sliced at (-1 before the
   *  first), so a field boundary only triggers one recovery attempt. */
  emittedThroughComma: number;
};

export type StreamedToolInputCache = Map<string, Map<number, StreamedToolInput>>;

/**
 * Advance the lexer state across the fragment appended since the last delta:
 * just enough JSON awareness (string/escape, nesting depth) to spot commas
 * that sit at the top level of the input object — everything before such a
 * comma is a set of complete fields. Returns true once the input object's
 * closing brace arrives.
 */
function scanStreamedToolInput(state: StreamedToolInput): boolean {
  let complete = false;
  for (let index = state.scannedTo; index < state.partialJson.length; index++) {
    const character = state.partialJson[index];
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (character === "\\") {
        state.escaped = true;
      } else if (character === '"') {
        state.inString = false;
      }
      continue;
    }

    if (character === '"') {
      state.inString = true;
    } else if (character === "{") {
      state.objectDepth++;
    } else if (character === "}") {
      state.objectDepth--;
      if (state.objectDepth === 0) {
        complete = true;
      }
    } else if (character === "[") {
      state.arrayDepth++;
    } else if (character === "]") {
      state.arrayDepth--;
    } else if (character === "," && state.objectDepth === 1 && state.arrayDepth === 0) {
      state.lastTopLevelComma = index;
    }
  }
  state.scannedTo = state.partialJson.length;
  return complete;
}

/** Parse the complete top-level fields before a top-level comma by closing the
 *  object at that boundary. */
function recoveredToolInput(prefix: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(prefix + "}");
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function claudeCliPath(): Promise<string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  // The SDK's CLI is a native binary shipped as a platform-specific optional
  // dependency of @anthropic-ai/claude-agent-sdk. Resolve via a require bound
  // to the SDK so nested installs are found even when npm doesn't hoist.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const ext = process.platform === "win32" ? ".exe" : "";
  // On linux, both glibc and musl variants may be installed side-by-side
  // (e.g. bunx hydrates every optional dep), so picking one by trial is
  // unreliable: the wrong binary segfaults at runtime instead of failing to
  // spawn. Detect the runtime libc and prefer the matching variant, falling
  // back to the other only if the preferred one isn't installed.
  const candidates =
    process.platform === "linux"
      ? isMuslLibc()
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
          ]
        : [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
          ]
      : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];
  for (const candidate of candidates) {
    try {
      return req.resolve(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Claude native binary not found for ${process.platform}-${process.arch}. ` +
      `Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set CLAUDE_CODE_EXECUTABLE.`,
  );
}

function isMuslLibc(): boolean {
  // process.report.getReport().header.glibcVersionRuntime is populated when
  // Node is dynamically linked against glibc, and absent on musl.
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

function shouldHideClaudeAuth(): boolean {
  return process.argv.includes("--hide-claude-auth");
}

/** Returned to clients when a prompt or cancel targets a session whose SDK
 *  query stream has already ended (ran to `done` or died). The stream is not
 *  revivable, so the only recovery is a fresh session. */
const SESSION_ENDED_MESSAGE = "The Claude Agent session has ended. Please start a new session.";

// Slash commands that the SDK handles locally without replaying the user
// message and without invoking the model.
const LOCAL_ONLY_COMMANDS = new Set(["/context", "/heapdump", "/extra-usage"]);

// Commands whose marker-only transcript records are ACP/client-local UI noise,
// not model-visible user prompts. Marker-only custom slash skills are not in
// this list, so replay can reconstruct them from `<command-name>`/`<command-args>`.
const REPLAY_HIDDEN_COMMANDS = new Set([
  ...LOCAL_ONLY_COMMANDS,
  "/compact",
  "/model",
  "/status",
  "/usage",
]);

// The Claude SDK persists local slash command invocations (e.g. `/model`) and
// their output as user messages in the session transcript, wrapping the
// payload in these XML-like markers that the CLI uses for its own display.
// The live prompt loop drops them; replay must strip them too or they leak
// into the UI on session/load.
const LOCAL_COMMAND_MARKERS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
].map((tag) => ({ open: `<${tag}>`, close: `</${tag}>` }));

// Context the CLI injects into a user turn to steer the model, appended to
// whatever the user typed. Nobody wrote it and no client sees it live — the
// prompt loop's user-message skip covers the whole message — but it is
// persisted alongside that prose, so replay would hand the client a prompt
// with instructions in it the user never gave. A `task-notification` tells the
// model that a background task stopped; live, the SDK `task_notification`
// frame reports the same stop, so replay drops it rather than showing the raw
// XML as a prompt (upstream #1205; restoring the task's state from it, as
// upstream does, needs a runtime this fork does not carry).
const INJECTED_CONTEXT_MARKERS = ["system-reminder", "task-notification"].map((tag) => ({
  open: `<${tag}>`,
  close: `</${tag}>`,
}));

// Everything a replayed user message may be wrapped in that is not speech.
const TRANSCRIPT_MARKERS = [...LOCAL_COMMAND_MARKERS, ...INJECTED_CONTEXT_MARKERS];

// Single-pass scanner that removes each `<tag>…</tag>` marker (matching the
// nearest closing tag of the same name, like a lazy regex would).
function stripMarkerTags(text: string): string {
  const dead = new Set<string>();
  let result = "";
  let copiedUpTo = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const marker = TRANSCRIPT_MARKERS.find(
        (m) => !dead.has(m.open) && text.startsWith(m.open, i),
      );
      if (marker) {
        const end = text.indexOf(marker.close, i + marker.open.length);
        if (end !== -1) {
          result += text.slice(copiedUpTo, i);
          i = copiedUpTo = end + marker.close.length;
          continue;
        }
        // No closing marker remains anywhere ahead, and `indexOf` only ever
        // searches forward from here on, so stop treating this tag as an
        // opener — that avoids rescanning the tail for it on every match.
        dead.add(marker.open);
      }
    }
    i++;
  }
  return result + text.slice(copiedUpTo);
}

function markerTagText(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return undefined;
  return text.slice(start + open.length, end);
}

function hasMarkerTag(text: string, tag: string): boolean {
  return markerTagText(text, tag) !== undefined;
}

function commandInvocationFromMarkerOnlyText(text: string): string | null {
  if (hasMarkerTag(text, "local-command-stdout") || hasMarkerTag(text, "local-command-stderr")) {
    return null;
  }
  const commandName = markerTagText(text, "command-name")?.trim();
  if (!commandName?.startsWith("/")) return null;
  if (REPLAY_HIDDEN_COMMANDS.has(commandName.split(" ", 1)[0])) return null;

  const commandArgs = markerTagText(text, "command-args")?.trim();
  return commandArgs ? `${commandName} ${commandArgs}` : commandName;
}

function stripLocalCommandMetadataText(text: string): string | null {
  const stripped = stripMarkerTags(text);
  if (stripped.trim() !== "") return stripped;
  return commandInvocationFromMarkerOnlyText(text);
}

/**
 * Return user-message content with local-command and injected-context marker
 * tags removed, or `null` if nothing meaningful remains (caller should skip
 * the message). Preserves real prose that's mixed in alongside the markers —
 * e.g. a message like `<command-name>…</command-name>hi` becomes `hi`, and
 * `hi<system-reminder>…</system-reminder>` becomes `hi`.
 */
export function stripLocalCommandMetadata(content: unknown): unknown | null {
  if (typeof content === "string") {
    return stripLocalCommandMetadataText(content);
  }
  if (!Array.isArray(content)) return content;

  const kept: unknown[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const stripped = stripLocalCommandMetadataText((block as { text: string }).text);
      if (stripped === null) continue;
      kept.push({ ...(block as object), text: stripped });
    } else {
      kept.push(block);
    }
  }
  if (kept.length === 0) return null;
  return kept;
}

/** Origin kinds of the meta user messages `getSessionMessages` returns since
 *  SDK 0.3.284 (messages from other agents, sessions and channels). */
const REPLAY_HIDDEN_META_ORIGIN_KINDS = new Set([
  "peer",
  "channel",
  "observer",
  "observer-activity",
  "slack-ping",
]);

/**
 * True for a transcript message delivered to the model from another agent,
 * session or channel. Since SDK 0.3.284 `getSessionMessages` returns these as
 * `is_meta` user messages whose content is the full harness framing (envelope
 * XML plus the "not typed by your user" preamble). The live prompt loop never
 * renders them, so replay skips them too rather than presenting them as text
 * the user typed. Other `is_meta` messages (compact summaries) are kept.
 * Ported from upstream #1208.
 *
 * `is_meta` and `origin` are runtime fields not declared on `SessionMessage`.
 */
export function isReplayHiddenMetaMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const { type, is_meta, origin } = message as {
    type?: unknown;
    is_meta?: unknown;
    origin?: { kind?: unknown } | null;
  };
  return (
    type === "user" &&
    is_meta === true &&
    typeof origin?.kind === "string" &&
    REPLAY_HIDDEN_META_ORIGIN_KINDS.has(origin.kind)
  );
}

export function isLocalCommandMetadata(content: unknown): boolean {
  return stripLocalCommandMetadata(content) === null;
}

/**
 * True for the synthetic assistant message the CLI injects into the transcript
 * when a turn fails authentication (e.g. "Not logged in · Please run /login",
 * "Session expired. Please run /login to sign in again."). The `/login`
 * instruction is Claude Code TUI-specific and meaningless to ACP clients
 * (issue #863). The live prompt loop suppresses the text and fails the turn
 * with `authRequired` so the client can run its own auth flow; replay must
 * skip it too — both for parity with what the client saw live and because the
 * message stays in the transcript forever, so it would resurface on every
 * session/load even after the user has logged back in.
 *
 * Takes the API message (`message.message`), which replay only knows as
 * `unknown`. The persisted record's structured `error: "authentication_failed"`
 * marker is stripped by `getSessionMessages`, so the synthetic model + text is
 * all both paths have to match on.
 */
export function isSyntheticLoginMessage(apiMessage: unknown): boolean {
  if (!apiMessage || typeof apiMessage !== "object") {
    return false;
  }
  const { model, content } = apiMessage as { model?: unknown; content?: unknown };
  if (model !== "<synthetic>" || !Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const block = content[0] as { type?: unknown; text?: unknown } | null;
  return (
    !!block &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.includes("Please run /login")
  );
}

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  permission request so the client can dismiss its prompt (and settle our
   *  await) instead of leaving the dialog open after the turn was cancelled. */
  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  elicitation so the client can dismiss its prompt and settle our await. */
  unstable_createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void>;
  /** Send a custom (extension) notification, e.g. `_claude/sdkMessage`. */
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}

/**
 * Bridges {@link AcpClient} to the connection-scoped {@link AgentContext}
 * exposed by `AgentApp.connect(...)` as `connection.client`. The peer handle is
 * valid for the entire connection lifetime, so it is captured once at
 * construction.
 */
class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, params);
  }

  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.ctx.request(methods.client.session.requestPermission, params, {
      cancellationSignal: signal,
    });
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.ctx.request(methods.client.fs.readTextFile, params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.ctx.request(methods.client.fs.writeTextFile, params);
  }

  unstable_createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.ctx.request(methods.client.elicitation.create, params, {
      cancellationSignal: signal,
    });
  }

  unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.ctx.notify(methods.client.elicitation.complete, params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.ctx.notify(method, params);
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("Tool use aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class ClaudeAcpAgent {
  sessions: {
    [key: string]: Session;
  };
  client: AcpClient;
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
  private readonly sessionModes: SessionModeManager<Session>;
  gatewayAuthRequest?: GatewayAuthRequest;
  /** Set while ACP overrides the agent's native provider configuration. */
  providerConfig?: ProviderConfig;
  /** Serializes provider changes while every open query is recreated between turns. */
  private providerUpdate: Promise<void> | null = null;
  private readonly exitPlan: ExitPlanCoordinator<Session, Turn>;
  /** Grace period before a `session/cancel` forces a wedged prompt loop to
   *  return "cancelled". See {@link DEFAULT_FORCE_CANCEL_GRACE_MS}. Mutable so
   *  tests can shrink it. */
  forceCancelGraceMs: number = DEFAULT_FORCE_CANCEL_GRACE_MS;
  /** The account selector's last choice, as a selector value (see
   *  `accounts.ts`). Held on the AGENT, not on a session, because that is what
   *  it governs: the account applies to sessions created after it is set, and
   *  the thread that was on screen when the user chose keeps the account it
   *  started under (D7 — a session id belongs to one account's local history,
   *  so a live thread cannot be carried across a switch). `undefined` until a
   *  selection is made, in which case the first declared account stands. */
  private selectedAccount?: string;

  constructor(client: AcpClient, logger?: Logger) {
    this.sessions = {};
    this.client = client;
    this.logger = logger ?? console;
    this.exitPlan = new ExitPlanCoordinator<Session, Turn>({
      currentSession: (id) => this.sessions[id],
      closeQueryStream: (session) => this.closeQueryStream(session),
      restartSession: async (params, options) => {
        await this.createSession(params, options);
        const session = this.sessions[options.publicSessionId];
        if (!session) throw new Error("Fresh Claude context was not created");
        return session;
      },
      applyFastMode: (session, enabled) => this.applyFastMode(session, enabled),
      sessionUpdate: (notification) => this.client.sessionUpdate(notification),
      ensureConsumer: (session, id) => this.ensureConsumer(session, id),
      logError: (message, error) => this.logger.error(message, error),
      destroyReplacement: (id, session) => {
        disarmForceCancel(session);
        session.cancelController?.abort();
        this.closeQueryStream(session);
        session.abortController.abort();
        if (this.sessions[id] === session) delete this.sessions[id];
      },
      settleCancelledTurn: (original, session, turn) => {
        disarmForceCancel(session);
        this.finishFileChangeAudit(session, turn, "cancelled");
        turn.settled = true;
        turn.resolve({ stopReason: "cancelled", usage: sessionUsage(original) });
      },
      settleFailedTurn: (session, turn, error) => {
        disarmForceCancel(session);
        this.finishFileChangeAudit(session, turn, "providerError");
        turn.settled = true;
        turn.reject(error);
      },
    });
    this.sessionModes = new SessionModeManager({
      getSession: (sessionId) => this.sessions[sessionId],
      sessionEndedMessage: SESSION_ENDED_MESSAGE,
      updateConfigOption: (sessionId, configId, value) =>
        this.updateConfigOption(sessionId, configId, value),
      sessionUpdate: (params: SessionNotification) => this.client.sessionUpdate(params),
      // Capabilities arrive at initialize, after this constructor runs.
      supportsNotices: () => clientSupportsNotices(this.clientCapabilities),
      logError: (...args: unknown[]) => this.logger.error(...args),
    });
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    // Bypasses standard auth by routing requests through a custom Anthropic-protocol gateway.
    // Only offered when the client advertises `auth._meta.gateway` capability.
    const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;

    const gatewayAuthMethod: AuthMethod = {
      id: "gateway",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "anthropic",
        },
      },
    };

    const gatewayBedrockAuthMethod: AuthMethod = {
      id: "gateway-bedrock",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "bedrock",
        },
      },
    };

    const supportsTerminalAuth = request.clientCapabilities?.auth?.terminal === true;
    const supportsMetaTerminalAuth = request.clientCapabilities?._meta?.["terminal-auth"] === true;

    // Detect remote environments where the OAuth browser redirect to localhost
    // won't work. This matches the SDK's internal isRemote check. In these cases,
    // the `auth login` subcommand would fall back to a device-code-like manual
    // flow, which doesn't work well over ACP, so we offer the TUI login instead.
    const isRemote = !!(
      process.env.NO_BROWSER ||
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.CLAUDE_CODE_REMOTE
    );
    const terminalAuthMethods: AuthMethod[] = [];

    if (isRemote) {
      const remoteLoginMethod: AuthMethod = {
        description: "Run `claude /login` in the terminal",
        name: "Log in with Claude",
        id: "claude-login",
        type: "terminal",
        args: ["--cli"],
      };

      if (supportsMetaTerminalAuth) {
        remoteLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...process.argv.slice(1), "--cli"],
            label: "Claude Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(remoteLoginMethod);
      }
    } else {
      const claudeLoginMethod: AuthMethod = {
        description: "Use Claude subscription ",
        name: "Claude Subscription",
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
      };

      const consoleLoginMethod: AuthMethod = {
        description: "Use Anthropic Console (API usage billing)",
        name: "Anthropic Console",
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
      };

      if (supportsMetaTerminalAuth) {
        const baseArgs = process.argv.slice(1);
        claudeLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--claudeai"],
            label: "Claude Login",
          },
        };
        consoleLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--console"],
            label: "Anthropic Console Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(claudeLoginMethod);
      }
      if (supportsTerminalAuth || supportsMetaTerminalAuth) {
        terminalAuthMethods.push(consoleLoginMethod);
      }
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        auth: {
          logout: {},
        },
        // Client-managed LLM routing via `providers/list`, `providers/set`, and
        // `providers/disable`. Advertised unconditionally; there is no client
        // capability prerequisite for the provider methods.
        providers: {},
        loadSession: true,
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Agent",
        version: packageJson.version,
      },
      authMethods: [
        ...terminalAuthMethods,
        ...(supportsGatewayAuth ? [gatewayAuthMethod, gatewayBedrockAuthMethod] : []),
      ],
      // Top-level `_meta` (sibling of `agentCapabilities`), per the existing ACP
      // steering extension contract: advertises the `_session/steering` request
      // so clients know they may inject a follow-up into a running turn.
      _meta: {
        ...airSessionFailureCapabilityMeta(AGENT_FILE_CHANGE_REPORT_CAPABILITY),
        steering: {
          supported: true,
        },
        goal: {
          version: GOAL_EXTENSION_VERSION,
          controlMethod: GOAL_CONTROL_METHOD,
          actions: [...GOAL_ACTIONS],
        } satisfies GoalCapability,
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.providerUpdate) await this.providerUpdate;
    const response = await this.createSession(params, {
      // Revisit these meta values once we support resume
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    if (this.providerUpdate) await this.providerUpdate;
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      },
    );
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (this.providerUpdate) await this.providerUpdate;
    const result = await this.getOrCreateSession(params);

    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);
    return result;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (this.providerUpdate) await this.providerUpdate;
    const result = await this.getOrCreateSession(params);

    await this.replaySessionHistory(params.sessionId);

    // Send available commands after replay so it doesn't interleave with history
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);

    return result;
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sdk_sessions = await listSessions({ dir: params.cwd ?? undefined });
    const sessions = [];

    for (const session of sdk_sessions) {
      if (!session.cwd) continue;
      sessions.push({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: sanitizeTitle(session.summary),
        updatedAt: new Date(session.lastModified).toISOString(),
      });
    }
    return {
      sessions,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway" || _params.methodId === "gateway-bedrock") {
      this.gatewayAuthRequest = _params as GatewayAuthRequest;
      return;
    }
    throw new Error("Method not implemented.");
  }

  async unstable_listProviders(_params: ListProvidersRequest): Promise<ListProvidersResponse> {
    const config = this.providerConfig ?? this.defaultProviderConfig();
    this.logger.log(
      `[providers/list] apiType=${config.apiType} baseUrl=${config.baseUrl} overridden=${this.providerConfig !== undefined}`,
    );
    const provider: ProviderInfo = {
      providerId: PROVIDER_ID,
      supported: SUPPORTED_PROTOCOLS,
      required: false,
      current: { apiType: config.apiType, baseUrl: config.baseUrl },
    };
    return { providers: [provider] };
  }

  /**
   * `providers/set` — replace the full configuration for the `main` provider.
   * Rejects unknown IDs, unsupported protocols, and empty/invalid base URLs with
   * `invalid_params`. Config is process-scoped and applies to sessions created or
   * loaded after this call.
   */
  async unstable_setProvider(params: SetProviderRequest): Promise<SetProviderResponse> {
    if (params.providerId !== PROVIDER_ID) {
      throw RequestError.invalidParams(
        { providerId: params.providerId },
        `Unknown provider ID "${params.providerId}"; expected "${PROVIDER_ID}".`,
      );
    }
    if (!SUPPORTED_PROTOCOLS.includes(params.apiType)) {
      throw RequestError.invalidParams(
        { apiType: params.apiType, supported: SUPPORTED_PROTOCOLS },
        `Unsupported apiType "${params.apiType}" for provider "${PROVIDER_ID}".`,
      );
    }
    if (!isValidBaseUrl(params.baseUrl)) {
      throw RequestError.invalidParams(
        { baseUrl: params.baseUrl },
        "baseUrl must be a non-empty absolute http(s) URL.",
      );
    }

    const config: ProviderConfig = {
      apiType: params.apiType,
      baseUrl: params.baseUrl,
      headers: params.headers ?? {},
    };

    // Vertex requires project + region, which the standard payload cannot
    // carry, so they arrive via `_meta.claudeCode.vertex`.
    if (params.apiType === "vertex") {
      const vertex = (params._meta as SetProviderMeta | undefined)?.claudeCode?.vertex;
      if (
        !vertex ||
        typeof vertex.projectId !== "string" ||
        vertex.projectId.trim() === "" ||
        typeof vertex.region !== "string" ||
        vertex.region.trim() === ""
      ) {
        throw RequestError.invalidParams(
          undefined,
          "vertex apiType requires non-empty `_meta.claudeCode.vertex.projectId` and `_meta.claudeCode.vertex.region`.",
        );
      }
      config.vertex = { projectId: vertex.projectId, region: vertex.region };
    }

    this.logger.log(
      `[providers/set] apiType=${config.apiType} baseUrl=${config.baseUrl} sessions=${Object.keys(this.sessions).length}`,
    );
    await this.enqueueProviderUpdate(config);
    return {};
  }

  /**
   * `providers/disable` ends ACP ownership of the single mutually exclusive
   * backend slot and restores the agent's native routing state.
   */
  async unstable_disableProvider(params: DisableProviderRequest): Promise<DisableProviderResponse> {
    if (params.providerId === PROVIDER_ID) {
      this.logger.log(`[providers/disable] sessions=${Object.keys(this.sessions).length}`);
      await this.enqueueProviderUpdate(undefined);
    }
    // Unknown provider: idempotent success.
    return {};
  }

  resolveProviderConfig(): ProviderConfig | null {
    return this.providerConfig ?? gatewayRequestToProviderConfig(this.gatewayAuthRequest);
  }

  private defaultProviderConfig(): ProviderConfig {
    const gatewayConfig = gatewayRequestToProviderConfig(this.gatewayAuthRequest);
    if (gatewayConfig) {
      return gatewayConfig;
    }
    if (process.env.CLAUDE_CODE_USE_BEDROCK) {
      return {
        apiType: "bedrock",
        baseUrl: process.env.ANTHROPIC_BEDROCK_BASE_URL ?? "https://bedrock-runtime.amazonaws.com",
        headers: {},
      };
    }
    if (process.env.CLAUDE_CODE_USE_VERTEX) {
      return {
        apiType: "vertex",
        baseUrl: process.env.ANTHROPIC_VERTEX_BASE_URL ?? "https://aiplatform.googleapis.com",
        headers: {},
      };
    }
    return {
      apiType: "anthropic",
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
      headers: {},
    };
  }

  async logout(_params: LogoutRequest): Promise<void> {
    // Clear in-memory gateway credentials supplied via `authenticate` and any
    // provider routing set via `providers/set`. Neither touches the on-disk
    // credential store, so dropping these references is the whole logout for
    // those paths.
    this.gatewayAuthRequest = undefined;
    this.providerConfig = undefined;
    // Learned context windows are per-account state too: 1M-context
    // entitlement is gated per org/tier, and an OAuth re-login is invisible to
    // the env-derived provider cache key, so windows learned under the old
    // login must not seed sessions under the next. Worst case of clearing is
    // re-learning on each model's next turn.
    contextWindowCache.clear();

    // For the Claude/Console login methods the credentials live in the native
    // CLI's store (keychain or config dir), which only the binary can clear.
    // `claude auth logout` is non-interactive and idempotent.
    const cliPath = await claudeCliPath();
    try {
      await execFileAsync(cliPath, ["auth", "logout"]);
    } catch (error) {
      const stderr =
        typeof error === "object" && error && "stderr" in error
          ? String((error as { stderr: unknown }).stderr).trim()
          : undefined;
      throw RequestError.internalError(
        { stderr: stderr || undefined },
        `claude auth logout failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.providerUpdate) await this.providerUpdate;
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // The SDK query stream already terminated (see `queryClosed`); its iterator
    // can't be revived, so enqueueing here would hang on a deferred that never
    // settles. Fail clearly and let the client start a fresh session.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    // `/rewind` is served fully locally (story 006, R3.2/R3.3): it lists or
    // restores file checkpoints via the SDK file-rewind API and streams its own
    // messages. It must be intercepted BEFORE the lazy query-recreate below (a
    // `/rewind` must not consume this session's pending recreate — that belongs
    // to the next real turn) and must never enqueue a turn. handleRewindCommand
    // emits every user-facing update before it resolves, so returning end_turn
    // here leaves Zed with a complete turn rather than an empty/hung one.
    const commandText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
    const rewindInvocation = parseRewindInvocation(commandText);
    if (rewindInvocation) {
      // A lazy Thinking recreate may be swapping the session's query right
      // now; join it first (mirroring cancel()) so the RewindDeps below
      // capture the live replacement query — not the old one mid-close — and
      // so the active-turn guard next evaluates the post-recreate queue
      // state. Safe: `recreateSessionQuery` never rejects.
      if (session.queryRecreateInFlight) {
        await session.queryRecreateInFlight;
      }
      // Never touch checkpoints while a turn is active or queued (same idleness
      // predicate as the lazy query-recreate trigger below). The turn FIFO
      // exists precisely so work lands in submission order; `/rewind` bypassing
      // it would let `query.rewindFiles()` restore files that the active turn
      // is editing at that very moment — a mixed workspace state — and would
      // interleave the rewind's output with the turn's. Refuse, explain, and
      // leave the checkpoints untouched.
      if (session.turnQueue?.length || session.activeTurn) {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                "A turn is still running in this session, so `/rewind` was not executed " +
                "(files may be under active edit). Stop the current turn first, then run " +
                "`/rewind` again.",
            },
          },
        });
        return { stopReason: "end_turn" };
      }
      const deps: RewindDeps = {
        sessionId: params.sessionId,
        client: this.client,
        query: session.query,
        // getSessionMessages resolves the SDK's SessionMessage[] (a loosely
        // typed transcript-row shape that listCheckpoints reads structurally);
        // reinterpret it as the RewindDeps SDKMessage[] contract.
        getSessionMessages: async (sessionId) => {
          const messages = await getSessionMessages(sessionId);
          return messages as unknown as SDKMessage[];
        },
      };
      // Flag the restore for its whole duration (see Session.rewindInFlight):
      // a rewind holds no Turn, so without it a concurrent real prompt would
      // pass the recreate trigger's idleness check below and close the query
      // under `rewindFiles`.
      session.rewindInFlight = true;
      try {
        await handleRewindCommand(deps, rewindInvocation);
      } catch (error) {
        // handleRewindCommand catches its own dep failures; only a rejection
        // of the client's sessionUpdate channel itself propagates here. Guard
        // it and report locally instead of surfacing a failed turn.
        this.logger.error(`Session ${params.sessionId}: /rewind command failed: ${error}`);
      } finally {
        session.rewindInFlight = false;
      }
      return { stopReason: "end_turn" };
    }

    if (session.autoModeFallbackWarningPending) {
      await this.sessionModes.publishFallbackWarning(params.sessionId, session);
    }

    if (Array.from(session.taskState.values()).some((task) => task.status !== "completed")) {
      await this.publishTaskPlan(params.sessionId, session.taskState);
    }

    // Lazy Thinking application (R1.3): a pending config change is applied by
    // recreating the SDK query with session resume BEFORE this turn is
    // enqueued — never mid-turn, so only when no other prompt is in flight. A
    // concurrent prompt() joins the in-flight recreate rather than racing a
    // second one (or pushing onto the old query mid-swap). On recreate failure
    // the flag stays set (retried by the next prompt) and this turn proceeds
    // on the old query; `recreateSessionQuery` never rejects.
    if (session.queryRecreateInFlight) {
      await session.queryRecreateInFlight;
    } else if (
      session.pendingQueryRecreate &&
      !session.turnQueue?.length &&
      !session.activeTurn &&
      // An in-flight `/rewind` restore holds no Turn, so the queue checks
      // above can't see it; recreating now would close the query underneath
      // `rewindFiles` (see Session.rewindInFlight).
      !session.rewindInFlight
    ) {
      const recreate = this.recreateSessionQuery(params.sessionId, session);
      session.queryRecreateInFlight = recreate;
      try {
        await recreate;
      } finally {
        session.queryRecreateInFlight = undefined;
      }
    }

    const userMessage = promptToClaude(params);
    const promptUuid = randomUUID();
    userMessage.uuid = promptUuid;

    // Local-only commands (e.g. `/clear`) return a result without replaying the
    // user message, so the consumer can't promote the turn from the echo.
    const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
    const isLocalOnlyCommand =
      firstText.startsWith("/") && LOCAL_ONLY_COMMANDS.has(firstText.split(" ", 1)[0]);

    const fileChangeReportRequestId = supportsAgentFileChangeReport(this.clientCapabilities)
      ? agentFileChangeReportRequestId(params._meta)
      : undefined;
    let fileChangeAudit: FileChangeAuditTurnState | undefined;
    if (
      fileChangeReportRequestId &&
      !session.fileChangeReportRequestIds.has(fileChangeReportRequestId)
    ) {
      session.fileChangeReportRequestIds.add(fileChangeReportRequestId);
      fileChangeAudit = createFileChangeAuditTurnState(fileChangeReportRequestId);
    }

    // R2.3: exactly `/usage`, and nothing else in the prompt. A second block
    // (an attached file, a second text part) is a model turn that happens to
    // mention the command, not the local command itself.
    const isUsageCommand =
      params.prompt.length === 1 &&
      params.prompt[0]?.type === "text" &&
      isUsageCommandText(params.prompt[0].text);

    session.titles.onPrompt(params.prompt);

    // Each prompt is a Turn whose deferred the persistent consumer settles once
    // the turn's outcome is known. `prompt()` owns no loop: it enqueues the
    // turn, pushes the user message onto the streaming input, makes sure the
    // consumer is running, and awaits the deferred.
    const turn: Turn = {
      promptUuid,
      isLocalOnlyCommand,
      ...(isUsageCommand
        ? { isUsageCommand: true, usageMarkdownAbort: new AbortController() }
        : {}),
      ...(fileChangeAudit ? { fileChangeAudit } : {}),
      settled: false,
      resolve: () => {},
      reject: () => {},
    };
    let completeTurn!: () => void;
    turn.completion = new Promise<void>((resolve) => {
      completeTurn = resolve;
    });
    const response = new Promise<PromptResponse>((resolve, reject) => {
      turn.resolve = (result) => {
        resolve(result);
        completeTurn();
      };
      turn.reject = (error) => {
        reject(error);
        completeTurn();
      };
    });

    session.turnQueue ??= [];
    session.turnQueue.push(turn);
    session.input.push(userMessage);
    this.ensureConsumer(session, params.sessionId);
    await this.publishGoalFromPrompt(params.sessionId, firstText, promptUuid);
    return response;
  }

  async goal(params: GoalRequest): Promise<GoalControlResponse> {
    const command = params.action === "set" ? `/goal ${params.objective}` : "/goal clear";
    const prompt = [{ type: "text" as const, text: command }];
    const steering = await this.steer({
      sessionId: params.sessionId,
      prompt,
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    if (steering.outcome === "promptRequired") {
      await this.prompt({ sessionId: params.sessionId, prompt });
    }
    return {};
  }

  private async publishGoal(sessionId: string, goal: GoalSnapshot | null): Promise<void> {
    const session = this.sessions[sessionId];
    if (session) {
      session.lastPublishedGoal = goal;
    }
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { goal },
      },
    });
  }

  private async publishTaskPlan(sessionId: string, taskState: TaskState): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: taskStateToPlanEntries(taskState),
      },
    });
  }

  /** This session's quota-window mapper, created on first use (see
   *  {@link Session.accountUsage} for why it lives on the Session). */
  private accountUsageTracker(session: Session): AccountUsageTracker {
    return (session.accountUsage ??= new AccountUsageTracker());
  }

  /**
   * Ask the SDK for the structured `/usage` report and forward every quota
   * window it carries to the client (R1.1 at session establishment, R1.2 at the
   * end of each turn).
   *
   * ONE notification per window, never one aggregate: the client's
   * `AccountUsage::ingest` reads a single `rateLimitType` per payload and merges
   * by kind, so it is the sequence that accumulates into a full panel.
   *
   * Total by construction (R1.7). The report rides an SDK method whose own
   * declaration says it "may change or be removed in any release without
   * notice", so a rejection, a method that no longer exists, a response shaped
   * differently than declared, or a client channel that has gone away must all
   * cost the windows and nothing else — never the session. The failure is
   * logged (which window kinds went unreported is not knowable, so the log says
   * only that the request failed and why) and the previously reported windows
   * are left standing, because nothing was sent.
   */
  /** Fetch the account's quota windows and publish them to this session.
   *
   *  `allowCache` is the difference between the two callers. A turn ending and a
   *  session being established are moments when THIS session's own consumption
   *  just changed, so they always fetch. The idle poll has no such reason: it is
   *  asking about an account, and every other adapter process on the desktop is
   *  asking the same question about the same account. It reads the shared sample
   *  instead -- see quota-cache.ts for why sharing, not tighter intervals, is
   *  what makes separate windows agree. */
  private async publishAccountUsage(
    sessionId: string,
    session: Session,
    { allowCache = false }: { allowCache?: boolean } = {},
  ): Promise<void> {
    try {
      // Not `getUsage`: this awful spelling is the only name the real `Query`
      // answers to, and it is written out here rather than hidden behind a
      // helper so a rename lands as one named failure in the log below, not as
      // a quiet degradation to no report at all.
      // `skipBehaviors` drops the local-transcript scan that fills the report's
      // `behaviors` section. Nothing here reads it — `windowsFrom` touches only
      // `rate_limits_available` and `rate_limits` — so on every call, not just
      // the polled ones, that scan was pure cost. `/usage` still asks for the
      // full report, because it renders those contributions.
      // A sample another process already paid for, when this call is allowed to
      // take one. `null` covers every failure the cache can have, so a broken
      // cache degrades to exactly the behaviour that existed before it.
      const cached = allowCache
        ? await readFreshLimits(sharedSampleMaxAgeMs(quotaPollIntervalMs()))
        : null;
      const report =
        cached ??
        (await session.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        }));
      if (!cached) {
        // Fired, not awaited: the other processes benefit from this sample, but
        // this session's own client must not wait on a filesystem write to see
        // its bars. `writeLimits` never rejects.
        void writeLimits(report);
      }
      // The session can be torn down or recreated while the request is in
      // flight (provider switch, a changed cwd on session/load). A successor
      // must not inherit its predecessor's windows.
      if (this.sessions[sessionId] !== session) {
        return;
      }
      // `usage_update` is the only carrier ACP gives this `_meta`, and it
      // requires both numbers. `contextUsedTokens` is the session-scoped mirror
      // of the consumer's `lastAssistantTotalUsage`, so at the end of a turn
      // this is the same occupancy the turn's own usage_update reported. At
      // session establishment nothing has been measured yet and 0 says exactly
      // that — the consumer's `!== null` guard would instead emit NOTHING, at
      // precisely the border R1.1 exists for.
      //
      // Snapshotted once, outside the loop: every window below comes from ONE
      // report, and each `sessionUpdate` yields to the event loop, where the
      // consumer can advance both fields. Reading them per window would let a
      // single report's bars disagree about the context they were measured in.
      const used = session.contextUsedTokens ?? 0;
      const size = session.contextWindowSize;
      for (const window of this.accountUsageTracker(session).windowsFrom(report)) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used,
            size,
            _meta: { "_claude/rateLimit": window },
          },
        });
      }
    } catch (error) {
      this.logger.error(`Session ${sessionId}: structured usage report unavailable: ${error}`);
    }
  }

  /** Start the idle refresh of the account quota windows for this session.
   *
   *  Idempotent, and deliberately called at the end of every turn rather than
   *  once: the first call arms, the rest return immediately, so no caller has to
   *  know whether this is turn one.
   *
   *  The tick does nothing while a turn is in flight. That turn's own end
   *  already refreshes the windows, and a second control request would buy the
   *  same answer twice — the same reasoning that excludes autonomous cycles at
   *  the end-of-turn call site. */
  private armAccountUsagePolling(sessionId: string, session: Session): void {
    if (session.accountUsageTimer) {
      return;
    }
    const intervalMs = quotaPollIntervalMs();
    if (intervalMs === 0) {
      return;
    }
    // Closure-local rather than a Session field: it guards this timer alone, and
    // a slow report must not let ticks pile up into a queue of duplicate control
    // requests against a session that is already struggling to answer one.
    let inFlight = false;
    const timer = setInterval(() => {
      // Re-resolve through the map. A provider update replaces the Session
      // object under the same id and the replacement arms its own timer, so an
      // orphaned closure must retire rather than keep polling a husk.
      if (this.sessions[sessionId] !== session || session.queryClosed) {
        clearInterval(timer);
        return;
      }
      if (session.turnQueue?.length || session.activeTurn || inFlight) {
        return;
      }
      inFlight = true;
      // `publishAccountUsage` never rejects — it logs and returns — so this
      // cannot become an unhandled rejection, and `finally` always re-opens.
      void this.publishAccountUsage(sessionId, session, { allowCache: true }).finally(() => {
        inFlight = false;
      });
    }, intervalMs);
    // A quota refresh is never a reason to keep the process alive.
    timer.unref?.();
    session.accountUsageTimer = timer;
  }

  private async publishGoalFromPrompt(
    sessionId: string,
    prompt: string,
    commandUuid: string,
  ): Promise<void> {
    const goalUpdate = goalUpdateFromPrompt(prompt);
    if (goalUpdate !== undefined) {
      const session = this.sessions[sessionId];
      if (session) {
        session.pendingGoalUpdate = {
          commandUuid,
          expected: goalUpdate,
          previous: session.lastPublishedGoal,
          started: false,
        };
      }
      await this.publishGoal(sessionId, goalUpdate);
    }
  }

  private async publishRuntimeGoal(sessionId: string, goal: GoalSnapshot | null): Promise<void> {
    const session = this.sessions[sessionId];
    const pending = session?.pendingGoalUpdate;
    if (pending) {
      const matchesPending =
        pending.expected === null
          ? goal === null
          : goal !== null && goal.objective === pending.expected.objective;
      if (!matchesPending) {
        return;
      }
      session.pendingGoalUpdate = undefined;
    }
    await this.publishGoal(sessionId, goal);
  }

  /** Steer the session per the ACP steering wire protocol: inject a follow-up
   *  message into the turn that is currently running. If that turn already
   *  settled, the established default starts a new detached turn; Hosts may opt
   *  into the host-owned `promptRequired` fallback through request `_meta`.
   *
   *  When a turn is in flight this injects (returns `injected`): unlike
   *  `prompt()`, it does NOT create a Turn or enqueue on `turnQueue`; it pushes
   *  an `SDKUserMessage` onto the same streaming input, which the SDK routes
   *  into the in-flight turn. The injected message's echo carries a uuid that
   *  matches no queued turn, so the consumer drops it as an unrelated replay
   *  without promoting/settling anything. It is normally delivered at {@link
   *  STEER_PRIORITY_NOW} so it pre-empts the current generation (interrupting a
   *  single-shot response, or slotting in between a multi-step turn's tool
   *  calls). While a permission or elicitation is awaiting user input it uses
   *  {@link STEER_PRIORITY_LATER} instead, because interrupting that SDK
   *  callback cancels the ACP request and can strand the prompt (IJAI-1191).
   *  The steered message's own output streams via `session/update`, not this
   *  response.
   *
   *  Pre-empting means ABORTING: the interrupted cycle emits a `result` of its
   *  own and the steered message runs as a second one, so the turn is marked
   *  (`Turn.steeredEchoes`) to settle at the SDK's `idle` instead of that result.
   *
   *  When the session is idle, the opt-in path returns `promptRequired` WITHOUT
   *  calling `prompt()`, pushing SDK input, or mutating `turnQueue`: the content
   *  stays Host-owned so the Host can submit it through a standard
   *  `session/prompt`. Without the opt-in, the existing detached `prompt()` and
   *  `startedNewTurn` result are preserved for compatibility. */
  async steer(params: SteerRequest): Promise<SteerResponse> {
    const sessionId = params.sessionId;
    const session = this.sessions[sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    // "A turn is running" = the queue holds an unsettled turn. This covers both
    // the activated turn and one just submitted but not yet echoed/activated,
    // which is exactly the window in which steering is meaningful. This check
    // and the active-path push below stay in one synchronous section so the
    // turn cannot settle in the gap between deciding to inject and enqueueing.
    const turnInFlight = (session.turnQueue ?? []).find((turn) => !turn.settled);
    if (!turnInFlight) {
      const promptRequest: PromptRequest = {
        sessionId,
        prompt: params.prompt,
      };
      if (params._meta?.steering?.idleBehavior === "promptRequired") {
        // The opt-in path leaves the content untouched so the Host can retry via
        // a normal session/prompt whose lifecycle owns the continuation result.
        return { outcome: "promptRequired", reason: "noRunningTurn" };
      }

      // Preserve the established default for Hosts that do not opt in. This is
      // intentionally detached for compatibility with the existing contract.
      this.prompt(promptRequest).catch((error) => {
        this.logger.error(`Session ${sessionId}: steered new turn failed: ${error}`);
      });
      return { outcome: "startedNewTurn" };
    }

    const promptRequest: PromptRequest = {
      sessionId,
      prompt: params.prompt,
    };
    const userMessage = promptToClaude(promptRequest);
    const steeredUuid = randomUUID();
    userMessage.uuid = steeredUuid;
    // Deliver into the running turn rather than queuing behind it as a fresh
    // prompt would. A steer landing while the client has a permission or
    // elicitation card open must not pre-empt it — the interrupt cancels that
    // ACP request — so it waits for the LAST such request to settle instead.
    userMessage.priority =
      (session.pendingUserInputCount ?? 0) > 0 ? STEER_PRIORITY_LATER : STEER_PRIORITY_NOW;
    // Mark before the push and in the same synchronous section as the in-flight
    // check: the interrupt can have the CLI finalizing the aborted cycle by the
    // time the consumer next runs, and an unmarked result would settle the turn
    // (see Turn.steeredEchoes).
    (turnInFlight.steeredEchoes ??= new Set()).add(steeredUuid);
    // A turn already held for background subagents has a recorded outcome the
    // steer supersedes: move it into the steer lane so one lane owns settlement.
    // The idle handler re-applies the hold through the subagent gate.
    if (turnInFlight.deferredSettle !== undefined) {
      turnInFlight.steeredSettle = turnInFlight.deferredSettle;
      turnInFlight.deferredSettle = undefined;
    }
    session.input.push(userMessage);
    const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
    await this.publishGoalFromPrompt(sessionId, firstText, steeredUuid);
    return { outcome: "injected" };
  }

  /** Publish the audit terminal for every turn path that did not reach the
   *  report tool. The support flips the turn state synchronously before its
   *  transport await, so callers can stay fail-open and settle the ACP prompt
   *  immediately without allowing a racing lifecycle path to publish twice. */
  private finishFileChangeAudit(
    session: Session,
    turn: Turn,
    reason: FileChangeReportUnavailableReason,
  ): void {
    if (!turn.fileChangeAudit || !session.fileChangeAuditSupport) return;
    void session.fileChangeAuditSupport.finishUnavailable(turn.fileChangeAudit, reason);
  }

  /** Lazily start the per-session consumer that drains the SDK query stream for
   *  the session's whole life. Idempotent: only the first `prompt()` starts it. */
  private ensureConsumer(session: Session, sessionId: string): void {
    if (session.consumer) {
      return;
    }
    // Wake-up channel so cancel() can force the consumer to settle the active
    // turn "cancelled" even when query.next() is wedged and never yields again
    // (issue #680). The consumer re-arms it after each fire.
    session.cancelController = new AbortController();
    session.consumer = this.runConsumer(session, { sessionId });
    session.consumer.catch((error) => {
      this.logger.error(`Session ${sessionId}: consumer terminated unexpectedly: ${error}`);
    });
  }

  /** The single, long-lived consumer of the SDK query stream for a session. It
   *  forwards every message as ACP `sessionUpdate`s (so background/between-turn
   *  output streams live, not just while a prompt is awaiting) and settles each
   *  Turn's deferred when that turn ends. Replaces the per-prompt message loop;
   *  `params` only carries the (session-invariant) `sessionId`. */
  private async runConsumer(session: Session, params: { sessionId: string }): Promise<void> {
    // Per-turn scratch, reset whenever a turn becomes active. Kept as consumer
    // locals (rather than per-Turn fields) because they describe the message
    // currently being processed, which is sequential — exactly one turn is
    // active at a time. Mirrors the locals the old per-prompt loop held.
    let lastAssistantTotalUsage: number | null = null;
    let lastAssistantUsage: UsageSnapshot | null = null;
    let lastAssistantModel: string | null = null;
    // When the Claude SDK classifies a turn as failed (e.g. rate limit, auth
    // problem, billing), it sets a categorical `error` field on the
    // `SDKAssistantMessage` that precedes the final `result` message. We capture
    // it here so the subsequent `RequestError.internalError` can forward it to
    // clients as structured `data`, sparing them from pattern-matching on text.
    let lastAssistantError: SDKAssistantMessageError | undefined;
    let lastAssistantWasUsageLimit = false;
    let lastAssistantFailureTitle: string | undefined;
    // When a streaming classifier refuses a turn, the assistant message carries
    // stop_reason "refusal" and structured stop_details. We capture the
    // human-readable explanation so the terminal `result` can surface it.
    let lastRefusalExplanation: string | null = null;
    // Anthropic API message id of the assistant message currently being
    // streamed, captured from `message_start` so the streamed chunks that follow
    // (whose delta events don't carry it) can all be tagged with the same,
    // replay-stable id.
    let currentStreamMessageId: string | undefined;
    // The text/thinking blocks that have actually streamed live as
    // `stream_event` deltas for the message the next consolidated `assistant`
    // will repeat, in stream order, each accumulated to its full streamed text.
    // The consolidated handler diffs each assembled block against these and
    // forwards only the un-streamed remainder — nothing if it streamed in full
    // (the common case), the whole block if it never streamed (a non-streaming
    // gateway), or just the tail if the stream was cut short mid-block. Matching
    // on content rather than the Anthropic message id makes dedupe robust to
    // gateways that don't carry a stable/matching id across the stream and the
    // consolidated message. Reset after each consolidated message consumes it.
    const streamedBlocks: { index: number; type: "text" | "thinking"; text: string }[] = [];
    // Tool-use blocks start streaming before their JSON input. Keep the
    // partial input per parent message and block index so completed top-level
    // fields can refine the pending tool call while it streams. Entries are
    // dropped at block/message boundaries; the whole map is swept when a turn
    // settles, since an interrupted subagent stream (keyed by a
    // parent_tool_use_id that never recurs) has no boundary event of its own.
    const streamedToolInputs: StreamedToolInputCache = new Map();
    // Stop reason accumulated for the active turn (result subtype, refusal,
    // max_tokens, …). Reset per turn; read when the turn settles at idle.
    let stopReason: StopReason = "end_turn";
    /** The consumer's single send chokepoint: every `sessionUpdate` in this
     *  loop goes through here (never `this.client.sessionUpdate` directly) so
     *  answer-delivery tracking is a property of sending, not something each
     *  emission site must remember. A top-level `agent_message_chunk` marks
     *  the stretch's answer as delivered; subagent-attributed chunks are
     *  recognizable by the `parentToolUseId` meta that toAcpNotifications
     *  stamps from `parent_tool_use_id`, and never reach the top-level feed
     *  as the turn's answer. */
    /** Compaction as one ACP tool lifecycle, replacing the in-progress boolean
     *  this consumer used to infer it from (story 010, R2.1/R2.2). Declared
     *  ahead of `sendUpdate` because that chokepoint consults it; the closure
     *  below only dereferences `sendUpdate` when an update is actually sent,
     *  which is always after both bindings exist. */
    const compaction = new ContextCompactionLifecycle((notification) => sendUpdate(notification));
    /** Publish the live background-task set as
     *  `session_info_update._meta["_claude/backgroundTasks"]`, only when its
     *  membership changed: `background_tasks_changed` also fires for ambient
     *  tasks this view filters out, and an unchanged set is not news. */
    const publishBackgroundTasks = async (
      tasks: { task_id: string; task_type: string; description: string }[],
    ) => {
      const key = tasks
        .map((task) => task.task_id)
        .sort()
        .join("\n");
      if (key === (session.lastPublishedBackgroundTasks ?? "")) {
        return;
      }
      session.lastPublishedBackgroundTasks = key;
      await sendUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: {
            [BACKGROUND_TASKS_META_KEY]: {
              count: tasks.length,
              tasks: tasks.map((task) => ({
                id: task.task_id,
                type: task.task_type,
                description: task.description,
              })),
            },
          },
        },
      });
    };
    // Adapter-composed advisories (hook feedback, model fallbacks) are live
    // events, not something the model said. Clients on the notice contract get
    // them as `notice` updates; the rest keep the bold-label transcript line.
    const supportsNotices = clientSupportsNotices(this.clientCapabilities);
    /** Tool uses whose progress already produced a notice: the SDK marks
     *  repeated `informational` progress for one tool use with its
     *  `tool_use_id` so hosts can collapse them; a notice has no lifecycle to
     *  update, so only the first becomes one. */
    const noticedToolUses = new Set<string>();
    const sendUpdate = async (notification: SessionNotification) => {
      const { update } = notification;
      if (
        isFileChangeAuditReportPhase(session.activeTurn?.fileChangeAudit) &&
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk" ||
          update.sessionUpdate === "user_message_chunk" ||
          update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update")
      ) {
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        const claudeMeta = update._meta?.claudeCode as
          { parentToolUseId?: string | null } | undefined;
        // A failed manual compaction's error also arrives as assistant text;
        // the tool lifecycle already carried it, so drop that one copy rather
        // than report the same failure twice (R2.2).
        if (
          !claudeMeta?.parentToolUseId &&
          update.content.type === "text" &&
          compaction.consumeDuplicateErrorOutput(update.content.text)
        ) {
          return;
        }
        if (!claudeMeta?.parentToolUseId) {
          session.emittedAssistantText = true;
          session.titles.onAssistantText(update.content);
        }
      }
      await this.client.sessionUpdate(notification);
    };

    let pendingWorkerShutdown = false;
    const isCurrentConsumer = () => this.sessions[params.sessionId] === session;
    const sessionFailures = new SessionFailureController({
      sessionId: params.sessionId,
      state: session.sessionFailureState,
      capabilities: this.clientCapabilities,
      isCurrent: isCurrentConsumer,
      sendUpdate,
      logger: this.logger,
    });
    const createSessionFailure = async (
      kind: ClaudeFailureKind,
      options: {
        turnScoped?: boolean;
        title?: string;
        details?: string;
        severity?: "warning" | "error";
      } = {},
    ): Promise<PublishedSessionFailure | undefined> => {
      const turnId = options.turnScoped === false ? undefined : session.activeTurn?.promptUuid;
      return sessionFailures.prepare(kind, {
        turnId,
        sessionScoped: options.turnScoped === false,
        title: options.title,
        details: options.details,
        severity: options.severity,
      });
    };

    const publishSessionFailure = async (
      kind: ClaudeFailureKind,
      options: {
        turnScoped?: boolean;
        title?: string;
        details?: string;
        severity?: "warning" | "error";
      } = {},
    ) => {
      const turnId = options.turnScoped === false ? undefined : session.activeTurn?.promptUuid;
      await sessionFailures.publish(kind, {
        turnId,
        sessionScoped: options.turnScoped === false,
        title: options.title,
        details: options.details,
        severity: options.severity,
      });
    };

    const clearFailuresFromEarlierTurns = async () => {
      const activeTurnId = session.activeTurn?.promptUuid;
      // Advisories carry no turnId, so without the guard every turn boundary would sweep them away.
      // They are session-scoped and stay until superseded or dismissed by the user.
      await sessionFailures.clear(
        (failure) => failure.recoveryPolicy === "next_attempt" && failure.turnId !== activeTurnId,
      );
    };

    const internalErrorForClient = (data: unknown, rawDetail?: string) =>
      RequestError.internalError(
        data,
        supportsAirSessionFailures(this.clientCapabilities) ? undefined : rawDetail,
      );

    const resetTurnScratch = () => {
      lastAssistantTotalUsage = null;
      lastAssistantUsage = null;
      lastAssistantModel = null;
      lastAssistantError = undefined;
      lastAssistantWasUsageLimit = false;
      lastAssistantFailureTitle = undefined;
      lastRefusalExplanation = null;
      // Do NOT reset currentStreamMessageId or streamedBlocks here. Turn
      // activation can fire mid-message (the replayed user echo with
      // --replay-user-messages lands between a message's blocks); clearing the
      // streamed-content record on activation would drop the blocks that
      // streamed before the echo, so the consolidated assistant message would
      // re-emit them as duplicates. streamedBlocks is bounded instead by being
      // cleared when each consolidated message consumes it. #785 stopped
      // resetting the streamed-content tracking here but left this line.
      stopReason = "end_turn";
      session.accumulatedUsage = session.activeTurn?.carriedUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      };
      if (session.activeTurn) session.activeTurn.carriedUsage = undefined;
    };

    /** Start this turn's structured `/usage` render, once, and hand back the
     *  in-flight promise; undefined when the turn owns no render.
     *
     *  Started at ACTIVATION rather than when the output arrives, so the
     *  bounded wait overlaps the command instead of following it: by the time
     *  the CLI has printed its answer the report has usually already lost or
     *  won its race, and the user waits for neither. */
    const ensureUsageMarkdown = (turn: Turn): Promise<string | null> | undefined => {
      if (!turn.isUsageCommand || !turn.usageMarkdownAbort) {
        return undefined;
      }
      // `session.query` is read here rather than captured: a provider switch
      // can replace it, and the render must ask the query that is live now.
      turn.usageMarkdown ??= structuredUsageMarkdown(
        session.query,
        turn.usageMarkdownAbort.signal,
        {
          error: (message) => {
            turn.usageFallbackReason ??= message;
          },
        },
      );
      return turn.usageMarkdown;
    };

    /** Promote a queued turn to active: it becomes the one output is attributed
     *  to, and its scratch starts fresh. Clears the cancelled flag so a turn
     *  enqueued after a prior cancel isn't treated as cancelled. Also clears any
     *  leftover orphan-skip count: since the SDK echoes/runs input FIFO, every
     *  orphan from a prior cancel has already arrived by the time a live turn
     *  activates, so a non-zero remainder means the SDK dropped a queued turn on
     *  interrupt (no orphan emitted) — drop the stale count so a later echo-less
     *  result isn't wrongly skipped. */
    const activateTurn = (turn: Turn) => {
      session.activeTurn = turn;
      session.cancelled = false;
      ensureUsageMarkdown(turn);
      session.pendingOrphanResults = 0;
      session.orphanCommands?.clear();
      // Two-phase sweep of registry entries the level signal ended (see
      // the endedPerLevel field doc): armed at the first activation,
      // deleted at the second — the same activation-time self-heal as the
      // orphan lanes, and the growth bound for leaked entries whose settle
      // bookends never arrive. The one-activation grace lets a corrective
      // inclusive level rescue a live async agent that a racing payload
      // absent-marked (deletion is irreversible: levels never ADD entries).
      // Local-only commands don't advance the clock: two quick /context
      // calls would otherwise burn the whole grace in seconds of wall time
      // while the corrective level is still in flight, and they interact
      // with no tasks — a later real turn still bounds growth.
      if (!turn.isLocalOnlyCommand) {
        for (const [taskId, record] of session.liveBackgroundTasks) {
          if (!record.endedPerLevel) {
            continue;
          }
          if (record.endedPerLevel === "sweep-armed") {
            session.liveBackgroundTasks.delete(taskId);
          } else {
            record.endedPerLevel = "sweep-armed";
          }
        }
      }
      resetTurnScratch();
    };

    /** Ensure there is an active turn before a user-turn result that carries no
     *  echo to activate it, by promoting the queue head. Most turns are
     *  activated by their replayed user message before their result, but some
     *  legitimately produce a result with no matching echo: local-only commands
     *  (e.g. `/context`) and compaction (`/compact`, whose only user messages
     *  are the generated summary and a `<local-command-stdout>` replay — neither
     *  carries the prompt's uuid). Promoting the head settles those.
     *
     *  But an echo-less result can also be an ORPHAN: cancel() settles+removes a
     *  queued turn whose user message was already pushed, so the SDK still runs
     *  it and emits a result with no echo to match. Promoting the head for an
     *  orphan would misattribute its stop reason/usage to an unrelated later
     *  prompt. `session.pendingOrphanResults` counts exactly how many such
     *  orphans are still expected (FIFO, they arrive before any live turn's
     *  result), so we skip those and only promote once the count is drained.
     *
     *  `resultUserMessageUuid` is the result's own join key (SDK 0.3.246+
     *  echoes the triggering send's client uuid on results; absent on older
     *  CLIs, synthetic/meta turns, and session-scoped failures). When present
     *  it upgrades the map lane from positional heuristics to an exact match:
     *  a stamp naming an orphaned command consumes the result outright, and a
     *  stamp naming anything else positively refutes "this is a dead turn's
     *  result", so the dup-over-loss one-skip must not eat it. */
    const ensureActiveTurn = (resultUserMessageUuid?: string) => {
      if (session.activeTurn) {
        if (!isHeldOpen(session.activeTurn)) {
          return;
        }
        // A held turn (Turn.deferredSettle) already produced its result, so
        // this incoming user-turn result cannot be its — it belongs to the
        // next queued command (an echo-less one, e.g. `/context` sent while
        // the hold drains; a normal prompt's echo would have handed the held
        // turn off before its result). Settle the held turn with its
        // recorded outcome — the user moving on outranks the hold, same
        // contract as the echo hand-off — and fall through to promote the
        // queue head, which this result belongs to. Without this, the head
        // would never be promoted (echo-less turns have no other promotion
        // path) and its prompt would hang, while this result's outcome
        // overwrote the held turn's. Orphan lanes below are necessarily
        // empty while a turn is held: orphans are seeded by cancel(), which
        // inline-settles a held turn, and activation cleared older ones.
        // settleActive also closes the held turn's delivery stretch, so the
        // promoted command's own delivery decision is not judged against the
        // held turn's followup text (issue #453) — the caller snapshots the
        // flag AFTER this runs.
        settleActive(session.activeTurn.deferredSettle);
      }
      // Orphan accounting runs BEFORE the head check: an orphan's echo-less
      // result can arrive with an EMPTY queue (the common post-cancel
      // timeline — the active turn settled at the interrupt's idle and the
      // user hasn't typed yet), and it must still be consumed here. Skipping
      // the bookkeeping when there is nothing to promote would leave a
      // phantom entry/count that swallows the next live echo-less result
      // (e.g. /compact) instead.
      if ((session.pendingOrphanResults ?? 0) > 0) {
        session.pendingOrphanResults!--;
        return;
      }
      // msg_lifecycle_v1 lane. Attribute this echo-less result using the
      // entries' states — turns run sequentially and frames arrive in stream
      // order, so at any result: every "zombie" is from an already-dead turn
      // whose own result already passed before the frame that created the
      // newest entry (or never existed), every "started" entry was dispatched
      // into THE turn that emitted this result (an older turn's entries got
      // their terminal frames before a newer turn's "started" frames), and a
      // "pending" entry was not dispatched before it. One result therefore
      // covers ALL started and zombie entries at once (N coalesced commands
      // share ONE result); their outstanding terminal frames then no-op on
      // the missing entries. NOTE this ordering argument is asserted from
      // observed CLI behavior, not a documented wire contract — if a dead
      // turn's late result could lag past the NEXT turn's dispatch frames,
      // deleting a zombie and a started entry on one result would
      // double-consume it. The unexpected-transition logging in the frame
      // handler is the tripwire for that class of drift.
      if (session.orphanCommands?.size) {
        // Resolved BEFORE the drain below, which deletes every started/zombie
        // entry: a stamp naming a "started" orphan would no longer be found
        // afterwards, and the result would promote the head — misattributing
        // a dead turn's outcome to a live prompt, the exact failure the map
        // exists to prevent. The lookup order is load-bearing.
        const stampedOrphanUuid =
          resultUserMessageUuid !== undefined && session.orphanCommands.has(resultUserMessageUuid)
            ? resultUserMessageUuid
            : undefined;
        let consumedOrphanResult = false;
        let oldestPending: string | undefined;
        // The started/zombie drain applies regardless of the stamp: commands
        // folded into the turn that emitted this result share it, and zombies'
        // late results have already passed (or never existed).
        for (const [uuid, state] of session.orphanCommands) {
          if (state === "started" || state === "zombie") {
            consumedOrphanResult = true;
            session.orphanCommands.delete(uuid);
          } else {
            oldestPending ??= uuid;
          }
        }
        if (stampedOrphanUuid !== undefined) {
          // Exact join: the result names an orphaned command. Delete the
          // matched entry even when it is still "pending" (its dispatch frame
          // was lost) and consume the result — no promotion.
          session.orphanCommands.delete(stampedOrphanUuid);
          return;
        }
        if (resultUserMessageUuid !== undefined) {
          // The stamp names a send that is NOT in the orphan map, so this is
          // a live turn's result: skip both the consumed-return (its folded
          // orphans were drained above, but the result itself still needs a
          // turn) and the dup-over-loss one-skip the stamp refutes, and fall
          // through to promote the head.
        } else {
          if (consumedOrphanResult) {
            return;
          }
          if (oldestPending !== undefined) {
            // No dispatch was seen before this result, so it is very likely a
            // live turn's — but a lost "started" frame would mean it IS the
            // orphan's (dup-over-loss: prefer one wrong skip over
            // misattributing a dead turn's outcome to a live prompt). Grant
            // each pending entry exactly one skip, like the count lane did.
            session.orphanCommands.delete(oldestPending);
            return;
          }
        }
      }
      const head = firstUnsettledQueuedTurn();
      if (!head) {
        return;
      }
      activateTurn(head);
    };

    /** Result-time bookkeeping that must run whether or not the result can be
     *  attributed to a turn. (1) Latch `commandResultSeen` on every queued
     *  turn whose command is known dispatched with no terminal frame yet —
     *  the emitting turn is the one it was dispatched (possibly folded) into,
     *  so its result has now passed; a later cancel() must not seed an orphan
     *  entry that waits for it (see Turn.commandResultSeen). (2) When a turn
     *  is ACTIVE, the result is attributed to it and never reaches
     *  ensureActiveTurn — but it still covers the map's started entries
     *  (commands folded into the active turn share its result) and zombies
     *  (their late results have already passed or never existed), so drain
     *  them here or they would zombify/linger and swallow a later live
     *  echo-less result. */
    const recordResultForOrphanCommands = () => {
      for (const turn of session.turnQueue ?? []) {
        if (!turn.settled && turn.commandStarted && !turn.commandFinished) {
          turn.commandResultSeen = true;
        }
      }
      if (session.activeTurn && session.orphanCommands?.size) {
        for (const [uuid, state] of session.orphanCommands) {
          if (state === "started" || state === "zombie") {
            session.orphanCommands.delete(uuid);
          }
        }
      }
    };

    /** The unsettled in-flight turn owning this prompt uuid, if any. */
    const findUnsettledTurn = (uuid: string) =>
      (session.turnQueue ?? []).find((t) => t.promptUuid === uuid && !t.settled);

    /** The first queued turn still awaiting its outcome, if any — the single
     *  spelling of "a prompt is pending" shared by the head promotion and
     *  the autonomous stretch-close guard. */
    const firstUnsettledQueuedTurn = () => (session.turnQueue ?? []).find((t) => !t.settled);

    /** Claim the structured render for whichever turn is producing this local
     *  command output. Three answers, and the caller must distinguish all
     *  three:
     *
     *    undefined — not a `/usage` turn, or one of R2.4's three ways out
     *                fired: publish `originalOutput` unchanged
     *    string    — the render: publish it INSTEAD of `originalOutput`
     *    null      — publish nothing (a duplicate of an already-replaced
     *                frame, or a turn cancelled during the wait)
     *
     *  No content signature and no text parsing: which turn owns a render was
     *  decided from the prompt, so a command whose output happens to look like
     *  `/usage`'s can never be rewritten. */
    const takeUsageMarkdown = async (
      originalOutput: string,
    ): Promise<string | null | undefined> => {
      const turn = session.activeTurn ?? firstUnsettledQueuedTurn();
      if (!turn) {
        // A copy of output the last `/usage` turn already rendered, arriving
        // after the result settled it: publish nothing.
        const last = session.lastUsageTurn;
        if (last?.usageMarkdownDelivered && last.usageOriginalOutput === originalOutput) {
          return null;
        }
        if (!last?.usageFallbackLogged) {
          this.logger.error(
            "Structured /usage not applied: turn not resolved for the command's output; preserving Claude Code output",
          );
          if (last) {
            last.usageFallbackLogged = true;
          }
        }
        return undefined;
      }
      if (turn.isUsageCommand) {
        session.lastUsageTurn = turn;
      }
      const pending = ensureUsageMarkdown(turn);
      if (!pending) {
        return undefined;
      }
      const markdown = await pending;
      // That await can span the whole bounded wait, and a cancel landing inside
      // it ends the turn. A cancelled turn publishes nothing — not the render,
      // and not the original text either.
      if (session.cancelled) {
        return null;
      }
      if (markdown === null) {
        if (!turn.usageFallbackLogged) {
          this.logger.error(
            turn.usageFallbackReason ?? "Structured /usage failed; preserving Claude Code output",
          );
          turn.usageFallbackLogged = true;
        }
        return undefined;
      }
      if (turn.usageMarkdownDelivered) {
        // One local command can reach the client through more than one SDK
        // message shape. Suppress an exact mirror of the frame already
        // replaced, but let a later, genuinely different frame (an
        // interruption diagnostic, say) take the normal path.
        return turn.usageOriginalOutput === originalOutput ? null : undefined;
      }
      turn.usageMarkdownDelivered = true;
      turn.usageOriginalOutput = originalOutput;
      return markdown;
    };

    /** Whether any background subagent this turn spawned is still live —
     *  while true, the turn's settlement stays deferred so the subagent's
     *  output and permission requests land inside it (see
     *  Turn.deferredSettle). */
    const turnAwaitingSubagents = (turn: Turn) => {
      if (!turn.spawnedTaskIds?.size) {
        return false;
      }
      for (const taskId of turn.spawnedTaskIds) {
        const record = session.liveBackgroundTasks.get(taskId);
        // The isSubagent read is defense in depth for the shells-never-defer
        // contract: spawnedTaskIds only ever holds subagent ids today, but a
        // future add site must not silently let a long-lived shell hold a
        // prompt open. endedPerLevel entries are kept for attribution only —
        // the level signal says the task is gone (or its bookends were
        // lost), so a hold must not wait on them.
        if (record?.isSubagent && !record.endedPerLevel) {
          return true;
        }
      }
      return false;
    };

    /** Settle the active turn's stored deferred outcome once none of its
     *  spawned subagents is live. The single drain rule shared by the
     *  followup-result and idle settle sites, so the two lanes can't drift. */
    const settleDeferredIfDrained = () => {
      const turn = session.activeTurn;
      if (isHeldOpen(turn) && !turnAwaitingSubagents(turn)) {
        settleActive(turn.deferredSettle);
      }
    };

    /** Settle the active turn with `outcome` now — unless subagents it
     *  spawned are still live, in which case store the outcome and hold the
     *  turn open (see Turn.deferredSettle). Every result-time settle of a
     *  turn that can have spawned subagents must route through here: a site
     *  calling settleActive directly bypasses the hold and re-opens the
     *  out-of-turn permission deadlock (issue #866) through its lane. */
    const settleOrDefer = (outcome: PromptResponse) => {
      // No result ends a steered turn: the steer aborted the cycle this result
      // may belong to, and the steered one is still to come. Record the outcome
      // for the idle lane (see Turn.steeredEchoes); later cycles overwrite it,
      // so the last result and its usage win.
      if (isSteering(session.activeTurn)) {
        session.activeTurn.steeredSettle = outcome;
        return;
      }
      if (
        session.activeTurn &&
        !session.activeTurn.settled &&
        turnAwaitingSubagents(session.activeTurn)
      ) {
        session.activeTurn.deferredSettle = outcome;
      } else {
        settleActive(outcome);
      }
    };

    /** Settle the active turn's deferred exactly once, disarm the force-cancel
     *  backstop (the turn is over), and drop it from the queue. */
    const settleActive = (
      result: PromptResponse,
      auditReason: FileChangeReportUnavailableReason = result.stopReason === "cancelled"
        ? "cancelled"
        : "notReported",
    ) => {
      const turn = session.activeTurn;
      if (!turn || turn.settled) {
        return;
      }
      this.finishFileChangeAudit(session, turn, auditReason);
      // Captured before the settled flip below (isHeldOpen tests !settled).
      const wasHeld = isHeldOpen(turn);
      turn.settled = true;
      // The turn is over: abandon any structured `/usage` render still in
      // flight rather than leaving it to run out its own clock (D5).
      turn.usageMarkdownAbort?.abort();
      disarmForceCancel(session);
      session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== turn);
      session.activeTurn = null;
      streamedToolInputs.clear();
      if (wasHeld) {
        // Settling a held turn is its delivery-stretch boundary: the turn's
        // answer finished long ago, so text streamed since the last boundary
        // is normally its followups' — left latched it would suppress a
        // following replayed turn's issue-#453 result-text fallback (the
        // common post-hold sequence). Known trade: at the echo hand-off an
        // incoming turn's pre-echo deltas share this one boolean, so a
        // STREAMING replay on a usage-omitting backend could re-emit its
        // answer — the flag cannot attribute text to a turn before its
        // echo, and the suppression direction is the common one, so the
        // clear wins. Every held-settle lane inherits this: the drain
        // settle, both hand-offs, and stream-done; cancel()'s inline mirror
        // carries its own copy.
        session.emittedAssistantText = false;
      }
      turn.resolve(result);
    };

    /** Reject the active turn (auth required, error result, …) without tearing
     *  down the consumer: the stream continues to idle and later turns proceed. */
    const failActive = (error: unknown) => {
      disarmForceCancel(session);
      const turn = session.activeTurn;
      if (!turn || turn.settled) {
        this.logger.error(
          `Session ${params.sessionId}: cannot fail active turn because no unsettled active turn exists: ${error}`,
        );
        return;
      }
      this.finishFileChangeAudit(session, turn, "providerError");
      turn.settled = true;
      turn.usageMarkdownAbort?.abort();
      session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== turn);
      session.activeTurn = null;
      streamedToolInputs.clear();
      // A failed turn's stretch is over, and some failure lanes (the issue
      // #825 idle-fail) never see the result whose `finally` would close it —
      // start the next stretch clean, or its stale delivery record would
      // suppress the next turn's issue-#453 result-text fallback.
      session.emittedAssistantText = false;
      turn.reject(error);
    };

    /** Complete a negotiated terminal failure on the prompt response itself,
     *  which is the canonical AIR carrier. Legacy clients keep the historical
     *  JSON-RPC rejection path. */
    const failActiveWithSessionFailure = async (
      kind: ClaudeFailureKind,
      error: unknown,
      title?: string,
    ) => {
      // Both arms below end the turn, and neither reports a terminal for a
      // compaction that was open when the provider failed. Ahead of the
      // capability branch for that reason, and a no-op when nothing is open.
      await compaction.interrupt(params.sessionId);
      if (!supportsAirSessionFailures(this.clientCapabilities)) {
        failActive(error);
        return;
      }
      if (!session.activeTurn || session.activeTurn.settled) {
        this.logger.error(
          `Session ${params.sessionId}: cannot attach ${kind} to a prompt response because no active turn exists; publishing a session-scoped failure`,
        );
        await publishSessionFailure(kind, { turnScoped: false, title });
        return;
      }
      const failure = await createSessionFailure(kind, { title });
      if (!failure) {
        failActive(error);
        return;
      }
      sessionFailures.recordActive(failure);
      settleActive(
        {
          stopReason: "end_turn",
          usage: sessionUsage(session),
          _meta: sessionFailureMeta(failure),
        },
        "providerError",
      );
    };

    /** Reject every in-flight turn — used when the stream dies. */
    const failAllTurns = (error: unknown) => {
      disarmForceCancel(session);
      const turns = session.activeTurn
        ? [session.activeTurn, ...(session.turnQueue ?? []).filter((t) => t !== session.activeTurn)]
        : [...(session.turnQueue ?? [])];
      session.activeTurn = null;
      session.turnQueue = [];
      for (const turn of turns) {
        if (!turn.settled) {
          this.finishFileChangeAudit(session, turn, "providerError");
          const wasHeld = isHeldOpen(turn);
          turn.settled = true;
          turn.usageMarkdownAbort?.abort();
          if (wasHeld) {
            // A held turn's answer already streamed and its outcome is
            // recorded — a stream death during the post-answer hold is a
            // background failure, not the turn's. Resolve with the real
            // outcome, mirroring the stream-done path.
            turn.resolve(turn.deferredSettle);
          } else {
            turn.reject(error);
          }
        }
      }
    };

    // The wake-up channel cancel()/teardown aborts to force the active turn to
    // settle "cancelled" even when query.next() is wedged (issue #680). Re-armed
    // after each fire so the consumer keeps serving later turns.
    let cancelController = session.cancelController!;

    // The query this consumer serves, bound at start: the lazy Thinking
    // recreate (`recreateSessionQuery`) can swap `session.query` for a fresh
    // one while this consumer is parked on the OLD query's next(). A
    // superseded consumer must abdicate — a fresh consumer owns the new
    // query — WITHOUT running its end-of-stream/error cleanup, which would
    // close the session's LIVE (replacement) resources.
    const myQuery = session.query;

    // The in-flight query.next(), kept across abort wake-ups that don't
    // consume a message, so no yielded message is ever dropped — async
    // generators serialize next() calls, so racing a SECOND next() while one
    // is pending would make the abandoned one swallow a message (e.g. a
    // force-cancelled turn's late result, whose orphan accounting below
    // depends on actually seeing it).
    let pendingNext: Promise<{ kind: "message"; result: IteratorResult<SDKMessage, void> }> | null =
      null;

    try {
      while (true) {
        // Superseded by a lazy query recreate: a fresh consumer owns
        // `session.query` now. Abandon the stale in-flight next() (swallowing
        // its eventual settlement so it can't surface as unhandled) and exit
        // without touching the session's turns or resources.
        if (session.query !== myQuery) {
          void pendingNext?.catch(() => {});
          return;
        }
        pendingNext ??= myQuery.next().then((result) => ({ kind: "message" as const, result }));
        const nextMessage = pendingNext;
        // Fresh abort listener per iteration, removed when next() wins, so a
        // long-lived session doesn't accumulate listeners on one signal. An
        // abort that fired while the consumer was busy elsewhere, such as
        // sending an update, still wakes it: a listener added to an aborted
        // signal never fires. The consumer re-arms after each abort it
        // handles, so an aborted signal here is always an unhandled abort
        // (upstream #1243).
        let onAbort!: () => void;
        const abortRace = new Promise<"abort">((resolve) => {
          onAbort = () => resolve("abort");
          if (cancelController.signal.aborted) onAbort();
          else cancelController.signal.addEventListener("abort", onAbort, { once: true });
        });
        const raced = await Promise.race([nextMessage, abortRace]);
        cancelController.signal.removeEventListener("abort", onAbort);

        if (raced === "abort") {
          // cancel()/teardown woke us: settle the active turn "cancelled" per
          // the ACP contract. The SDK never acknowledged this turn (that's why
          // the force-cancel backstop fired), so if it later recovers from the
          // wedge it will still emit the turn's result — with no live turn to
          // match — followed by its trailing idle. Pre-count it as an orphan
          // so that late result is skipped (not promoted onto the next queued
          // prompt) and its trailer is recorded as owed, not read as the next
          // turn being abandoned. Stale counts self-heal: activation resets
          // them (see activateTurn).
          if (session.activeTurn && !session.activeTurn.settled) {
            // Seed by what the frames already told us, mirroring cancel()'s
            // queued-turn sweep — the consumer may have drained the wedged
            // turn's result and/or terminal frame before the backstop fired,
            // and an entry seeded for a result or frame that is already
            // spent would never drain (it would swallow an unrelated later
            // echo-less result instead).
            const active = session.activeTurn;
            if (
              active.commandFinished === "completed" ||
              active.commandFinished === "discarded" ||
              active.commandFinished === "refused"
            ) {
              // Finished SDK-side; any result already passed. Nothing to
              // track.
            } else if (active.commandFinished === "cancelled") {
              // Aborted after dispatch: its late result may still come —
              // unless it already did.
              if (!active.commandResultSeen) {
                this.trackOrphanCommand(session, active.promptUuid, "zombie");
              }
            } else if (active.commandResultSeen) {
              // Its result was already consumed (dropped at the cancelled
              // guard); only the terminal frame is outstanding, which no-ops
              // with no entry. Nothing to track.
            } else {
              // The wedged turn WAS dispatched (it's active), so track it
              // "started": its late result (if the SDK recovers) is skipped
              // echo-less, and its terminal frame — or that skip plus
              // activation's clear when the frame is lost to the wedge — is
              // what drains it.
              this.trackOrphanCommand(session, active.promptUuid, "started");
            }
          }
          // #1154's own case: this settles the turn "cancelled" while the
          // compaction the client is watching is still in_progress, and the
          // SDK will never send its terminal because the backstop fired
          // precisely because the SDK stopped answering.
          await compaction.interrupt(params.sessionId);
          settleActive({ stopReason: "cancelled", usage: sessionUsage(session) });
          // The cancelled turn's result may never come (that's why the
          // backstop fired) — close its delivery stretch here so partial
          // streamed text can't suppress the next turn's issue-#453 fallback.
          // If a late orphan result does arrive, its `finally` clears again;
          // FIFO ordering means no live turn's text can have streamed yet.
          session.emittedAssistantText = false;
          // If the session is being torn down — or this consumer was
          // superseded by a lazy query recreate — abandon the in-flight
          // next() (swallowing any later rejection so it can't surface as
          // unhandled) and stop; otherwise re-arm and keep consuming —
          // `pendingNext` stays in flight so its eventual message is
          // processed, not dropped. The supersession check also keeps a
          // superseded consumer from clobbering `session.cancelController`
          // (re-armed below) under the replacement consumer.
          if (!this.sessions[params.sessionId] || session.query !== myQuery) {
            void nextMessage.catch(() => {});
            return;
          }
          cancelController = new AbortController();
          session.cancelController = cancelController;
          continue;
        }

        // A message arrived: this next() is consumed; arm a fresh one next pass.
        pendingNext = null;

        const { value: message, done } = raced.result as IteratorResult<SDKMessage, void>;

        if (done || !message) {
          // A superseded consumer (the lazy query recreate closed the OLD
          // query out from under it) must NOT run end-of-stream cleanup: the
          // session's query/input/settings now belong to the replacement and
          // `closeQueryStream` would tear the LIVE ones down. The recreate
          // path owns the whole transition; just exit.
          if (session.query !== myQuery) {
            return;
          }

          if (pendingWorkerShutdown) {
            pendingWorkerShutdown = false;
            if (session.activeTurn) {
              if (!isHeldOpen(session.activeTurn)) {
                await failActiveWithSessionFailure(
                  "worker_shutdown",
                  internalErrorForClient({ errorKind: "worker_shutdown" }),
                );
              } else {
                // The held turn already has its authoritative terminal outcome,
                // but EOF permanently closes the non-revivable Query. Preserve
                // the turn result below and report the independent session-health
                // failure without a turnId so AIR can offer a new session.
                await publishSessionFailure("worker_shutdown", { turnScoped: false });
              }
            } else {
              await publishSessionFailure("worker_shutdown", { turnScoped: false });
            }
          }
          // The stream ended. Settle the in-flight turns FIRST, then release the
          // stream resources — same order as the error paths (failAllTurns before
          // closeQueryStream). Settling is the user-facing contract; resource
          // release is best-effort cleanup, so a throw there must not pre-empt a
          // turn's real outcome.
          //
          // Settle the turn that was in flight so its prompt() doesn't hang:
          // cancelled if a cancel is pending, otherwise the outcome a
          // deferred turn already recorded (see Turn.deferredSettle) or the
          // accumulated scratch outcome. The scratch currently still equals
          // a deferred turn's stored outcome (followup results never mutate
          // it), but the stored one is the authoritative source.
          const inFlight = session.activeTurn;
          // The stream is gone, so no terminal for an open compaction is ever
          // coming; close it before the turn settles, or the frame outlives the
          // query that would have finished it.
          await compaction.interrupt(params.sessionId);
          settleActive(
            session.cancelled
              ? { stopReason: "cancelled", usage: sessionUsage(session) }
              : (inFlight?.deferredSettle ?? { stopReason, usage: sessionUsage(session) }),
          );
          // Queued turns the SDK never started never ran, so reject them rather
          // than reporting a success (end_turn) — or a misleading "cancelled" —
          // for a prompt that produced no output. (A cancel already settled the
          // turns that were queued at cancel time and removed them, so anything
          // still here was enqueued afterward and was not part of the cancel.)
          for (const queued of [...(session.turnQueue ?? [])]) {
            if (!queued.settled) {
              this.finishFileChangeAudit(session, queued, "providerError");
              queued.settled = true;
              queued.reject(RequestError.internalError(undefined, SESSION_ENDED_MESSAGE));
            }
          }
          session.turnQueue = [];
          // The query iterator can't be revived, so close the session's stream
          // (marks queryClosed, drops the consumer handle, releases the dead
          // subprocess/settings resources) — a later prompt() then rejects up
          // front rather than restarting a consumer on the exhausted stream.
          this.closeQueryStream(session);
          return;
        }

        if (
          session.emitRawSDKMessages &&
          shouldEmitRawMessage(session.emitRawSDKMessages, message)
        ) {
          await this.client.extNotification("_claude/sdkMessage", {
            sessionId: params.sessionId,
            message: message as Record<string, unknown>,
          });
        }

        // CLIs 2.1.206+ (capability msg_lifecycle_v1) report the fate of every
        // uuid-stamped queued command (queued/started/completed/cancelled/
        // discarded/refused) as `command_lifecycle` frames — 2-3 per prompt, since
        // prompt() stamps a uuid on every message. The frame is @internal and
        // absent from the SDKMessage union, so handle it BEFORE the exhaustive
        // switch: it must not reach `unreachable`'s error log, and a `case`
        // for it wouldn't typecheck. It feeds only the orphan accounting (see
        // Session.orphanCommands); turn settlement stays driven by
        // echoes/results/idle. (Raw-mode emission above still forwards these
        // frames.)
        if ((message as { type: string }).type === "command_lifecycle") {
          const frame = message as unknown as { command_uuid: string; state: string };
          switch (frame.state) {
            case "started": {
              // Remember dispatch on the live turn so a cancel() that orphans
              // it seeds the right state (see Turn.commandStarted)...
              const queued = findUnsettledTurn(frame.command_uuid);
              if (queued) {
                queued.commandStarted = true;
              }
              // ...and promote an already-orphaned command: once dispatched,
              // a bare `cancelled` no longer means "dropped without running".
              const state = session.orphanCommands?.get(frame.command_uuid);
              if (state === "pending") {
                session.orphanCommands!.set(frame.command_uuid, "started");
              } else if (state === "zombie") {
                // "started" after the command's terminal frame: the ordering
                // the whole lane rests on has been violated (frames are
                // per-uuid FIFO). Surface it — a silent drift here degrades
                // into swallowed or misattributed results.
                this.logger.error(
                  `Session ${params.sessionId}: command_lifecycle "started" for ${frame.command_uuid} after its terminal frame; orphan accounting may be off for this cancel.`,
                );
              }
              break;
            }
            case "completed":
            case "discarded":
            case "refused":
            case "cancelled": {
              // Terminal frames. Latch the fate on a still-queued turn so a
              // later cancel() doesn't seed an orphan entry for a command
              // whose one-and-only terminal frame has already been consumed
              // (nothing would ever drain that entry).
              const queued = findUnsettledTurn(frame.command_uuid);
              if (queued) {
                queued.commandFinished = frame.state as NonNullable<Turn["commandFinished"]>;
              }
              if (frame.state === "cancelled") {
                // Ambiguous by design (dup-over-loss): dropped before
                // dispatch (no result will ever come — safe to forget) vs
                // consumed into a turn that was aborted/failed. For the
                // latter, any result the dead turn managed to emit has
                // already deleted the entry (see
                // recordResultForOrphanCommands / ensureActiveTurn), so a
                // still-"started" entry means no result was seen since
                // dispatch — it becomes a zombie for the next
                // echo-less-result skip.
                const state = session.orphanCommands?.get(frame.command_uuid);
                if (state === "pending") {
                  session.orphanCommands?.delete(frame.command_uuid);
                } else if (state === "started") {
                  session.orphanCommands?.set(frame.command_uuid, "zombie");
                }
                break;
              }
              // Exactly-one-terminal: the command is finished. "completed" is
              // emitted after any result its turn produced (fresh turn) or the
              // command folded into another turn whose result is attributed
              // elsewhere — either way no echo-less result remains to skip.
              // "discarded" = session ended with it still queued; no result.
              // "refused" (2.1.238+) = a cross-session peer message declined
              // by receive-side policy before dispatch; never a prompt-lane
              // command of ours, and no result will ever come.
              session.orphanCommands?.delete(frame.command_uuid);
              break;
            }
            default:
              // "queued" carries no fate information. Anything else is a
              // state this adapter doesn't know — likely a CLI that grew the
              // v1 vocabulary. The entry still drains by result coverage or
              // activation's clear (bounded damage), but log it so the
              // degradation is visible instead of silent.
              if (frame.state !== "queued") {
                this.logger.error(
                  `Session ${params.sessionId}: unknown command_lifecycle state "${frame.state}" for ${frame.command_uuid}; treating as uninformative.`,
                );
              }
              break;
          }
          continue;
        }

        // `active_goal` is emitted by the Claude runtime but is not currently
        // included in the public SDKMessage union. Handle it before the
        // exhaustive switch and publish only the provider-neutral ACP shape.
        if ((message as { type: string }).type === "active_goal") {
          const activeGoal = message as unknown as SDKActiveGoalMessage;
          await this.publishRuntimeGoal(params.sessionId, toGoalSnapshot(activeGoal));
          continue;
        }

        switch (message.type) {
          case "system":
            switch (message.subtype) {
              case "init":
                // Latch the lifecycle capability so cancel() routes orphan
                // accounting through `orphanCommands` (per-uuid, exact)
                // instead of the coalescing-blind count. Never unlatch: init
                // re-emits per turn and the capability can't be lost mid-CLI.
                if (message.capabilities?.includes("msg_lifecycle_v1")) {
                  session.msgLifecycleV1 = true;
                }
                // A fresh `system`/init (e.g. after reinitialize) can carry an
                // updated Fast mode state; reconcile it with what we seeded at
                // session creation.
                await this.syncFastModeState(
                  params.sessionId,
                  session,
                  message.fast_mode_state,
                  message.fast_mode_disabled_reason,
                );
                // Terminal-bound slash commands (absent when none, and on
                // older CLIs). The session/new advertisement runs before any
                // init frame can be observed, so the first latch (or a
                // genuine change) re-publishes the now-filtered list.
                if (
                  message.terminal_slash_commands &&
                  JSON.stringify(message.terminal_slash_commands) !==
                    JSON.stringify(session.terminalSlashCommands)
                ) {
                  session.terminalSlashCommands = message.terminal_slash_commands;
                  try {
                    await this.sendAvailableCommandsUpdate(params.sessionId);
                  } catch (error) {
                    // Advisory reconcile only — the client keeps its current
                    // (unfiltered) list; never fail the turn over it.
                    this.logger.error(`Failed to re-advertise slash commands: ${error}`);
                  }
                }
                // Plugin load failures (CLI 2.1.283+) have no ACP surface;
                // log them so a missing plugin isn't silent.
                if (message.plugin_errors?.length) {
                  const pluginErrors = JSON.stringify(message.plugin_errors);
                  if (pluginErrors !== session.loggedPluginErrors) {
                    session.loggedPluginErrors = pluginErrors;
                    for (const error of message.plugin_errors) {
                      this.logger.error(
                        `Plugin ${error.plugin} failed to load (${error.type})` +
                          `${error.path ? ` from ${error.path}` : ""}: ${error.message}`,
                      );
                    }
                  }
                }
                break;
              case "status": {
                // Compaction is reported as ONE tool lifecycle rather than the
                // assistant-text banners this branch used to emit (R2.1). The
                // banners needed a boolean in-progress guard because the SDK
                // repeats the terminal `status` and the two copies are
                // indistinguishable here; the lifecycle owns that de-duplication
                // by phase instead, so the guard is gone rather than inert (R2.2).
                //
                // The SDK signals manual `/compact` completion with a status
                // message carrying `compact_result`, not the `compact_boundary`
                // message (which only fires when there's content to compact) —
                // so both frames must be able to close a lifecycle.
                if (message.status === "compacting") {
                  await compaction.start(params.sessionId, message.uuid);
                } else if (message.compact_result === "success") {
                  await compaction.finish(params.sessionId, message.uuid, "completed");
                } else if (message.compact_result === "failed") {
                  await compaction.finish(params.sessionId, message.uuid, "failed", {
                    ...(message.compact_error ? { error: message.compact_error } : {}),
                  });
                }
                break;
              }
              case "compact_boundary": {
                // This is the only frame carrying the token counts, and it
                // arrives AFTER the terminal `status` — so it enriches the
                // lifecycle rather than reporting an outcome again
                // (`enrichTerminal`): the update omits `status`, leaving exactly
                // one terminal transition the client can see (R2.2). It also
                // stands alone when no `status` preceded it (an automatic
                // compaction, or a replay that dropped the opening frame).
                const compactMetadata = message.compact_metadata;
                await compaction.finish(
                  params.sessionId,
                  message.uuid,
                  "completed",
                  compactMetadata ? contextCompactionMetadataFromBoundary(compactMetadata) : {},
                  true,
                );
                // Refresh the displayed usage immediately so the client doesn't
                // keep showing the stale pre-compaction size (e.g. "944k/1m")
                // right after the compaction tool call completes, which is
                // confusing and wrong.
                //
                // Prefer the SDK's authoritative post-compaction `used` via
                // getContextUsage — it reflects the real retained context
                // (system prompt + tools + surviving messages), which the
                // per-message API usage numbers can't give us until the next
                // turn's result. If the control request fails, fall back to the
                // used:0 approximation: directionally correct (context just
                // dropped dramatically) and replaced within seconds by the next
                // result message.
                //
                // `size` keeps coming from session.contextWindowSize —
                // compaction frees occupancy, it doesn't change the model's
                // window.
                const usedTokens = await fetchContextUsedTokens(session.query, this.logger);
                lastAssistantUsage = null;
                lastAssistantTotalUsage = usedTokens ?? 0;
                session.contextUsedTokens = usedTokens ?? 0;
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "usage_update",
                    used: lastAssistantTotalUsage,
                    size: session.contextWindowSize,
                  },
                });
                break;
              }
              case "local_command_output": {
                // A failed `/compact` also prints its error here; the tool
                // lifecycle already carried it, so consume that one duplicate
                // (matched by text, once) without hiding other command output.
                if (compaction.consumeDuplicateErrorOutput(message.content)) {
                  break;
                }
                // R2.3/R2.4: a `/usage` turn publishes its structured render
                // here instead; anything else, and any way out, publishes the
                // CLI's own text byte-for-byte.
                const usageMarkdown = await takeUsageMarkdown(message.content);
                if (usageMarkdown === null) {
                  break;
                }
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: usageMarkdown ?? message.content },
                  },
                });
                break;
              }
              case "session_state_changed": {
                const previousState = session.lastSessionState;
                session.lastSessionState = message.state;
                if (
                  message.state === "running" &&
                  previousState !== "running" &&
                  session.owedTrailingIdles > 0
                ) {
                  // A transition INTO `running` proves the idle period before
                  // it ended: every idle the CLI was going to emit for earlier
                  // results has been emitted, so debt still outstanding here
                  // can never be paid. (A repeated `running` is not a
                  // transition and is left alone.)
                  //
                  // The debt only survives to this point under CLI 2.1.270+,
                  // which withholds `idle` while background agents run --
                  // user result -> task_notification -> followup result -> ONE
                  // idle -- so a held turn's own result leaves one unpaid unit
                  // per hold. Through 2.1.269 the idle follows the result
                  // immediately and the debt is already zero here, which is
                  // why this sweep is safe to carry on both cadences.
                  //
                  // Left in place, each unit would absorb a later un-owed idle
                  // -- masking an issue-#825 detection -- or swallow the idle a
                  // steered turn settles on (the owed-idle branch runs before
                  // the steer lane), hanging that prompt.
                  this.logger.log(
                    `[turn/idle-debt] swept=${session.owedTrailingIdles} session=${params.sessionId} at=running-transition`,
                  );
                  session.owedTrailingIdles = 0;
                }
                if (message.state === "idle") {
                  // A non-cancelled turn normally settled at its terminal
                  // `result` already (issue #773), and that result recorded an
                  // owed trailing idle — absorbed here via the decrement. We
                  // must NOT settle `activeTurn` on an owed idle: `idle`
                  // carries no turn identity, and it can lag (the SDK flushes
                  // held-back results / drains background agents first), so by
                  // the time it arrives the SDK may have echoed the NEXT turn
                  // and activated it — settling now would resolve that new
                  // turn prematurely with end_turn and ~zero usage, dropping
                  // its real result. A cancelled turn relies on `idle`: its
                  // `result` is dropped at the `session.cancelled` guard, so
                  // it never settles at a result and must settle here.
                  //
                  // An idle that is NOT owed while the active turn is still
                  // unsettled is the issue #825 signature: `idle` is the SDK's
                  // authoritative turn-over signal (it fires after held-back
                  // results flush and background agents drain), so a turn that
                  // reaches it without a result will never get one — the model
                  // stream dropped mid-turn, or an async agent
                  // completed/stalled without the host turn resolving. Fail
                  // the turn NOW so its session/prompt gets a terminal
                  // response, instead of leaving it hanging until the next
                  // prompt drains the wreckage.
                  // A cancelled turn still consumed tokens: its dropped result
                  // already fed the accumulator (the usage tally at the result
                  // handler runs before the `session.cancelled` guard), so
                  // report it — clients metering spend would otherwise lose
                  // the interrupted turn's tokens entirely (issue #844). Zero
                  // when the cancel pre-empted the result (wedge/force-cancel).
                  if (session.cancelled && session.activeTurn && !session.activeTurn.settled) {
                    // An interrupt can pre-empt the result entirely, so the
                    // lifecycle's own reset there never ran; close it here or a
                    // half-open compaction would leak into the next turn.
                    //
                    // reset() alone was not enough and looked like it was: it
                    // drops the state without sending anything, so the opening
                    // in_progress frame stayed the last word the client had.
                    await compaction.interrupt(params.sessionId);
                    compaction.reset();
                    settleActive({ stopReason: "cancelled", usage: sessionUsage(session) });
                    // An interrupt can pre-empt the turn's result entirely
                    // (nothing ran the result-case `finally`), so close the
                    // delivery stretch here: idle is the SDK's authoritative
                    // turn-over signal, and stale partial-text state would
                    // suppress the next turn's issue-#453 fallback.
                    session.emittedAssistantText = false;
                  } else if (isHeldOpen(session.activeTurn)) {
                    // A turn held open for its background subagents (see
                    // Turn.deferredSettle). Idle cadence during the hold
                    // depends on the CLI: through 2.1.269 one idle per
                    // processing cycle (the turn's own trailer, then one per
                    // followup); from 2.1.270 none until the background agents
                    // drain, then one. Either way each idle absorbs an
                    // outstanding trailer debt (the unpayable remainder is
                    // swept at the next `running` transition above), and the
                    // turn only settles once none of its spawned subagents is
                    // left (the followup-result settle usually got there
                    // first; this is the fallback when no followup came). Mid-hold
                    // idles never fall through: a held turn HAS its result,
                    // so reading its idle as "turn abandoned without a
                    // result" (issue #825) would fail a healthy prompt.
                    if (session.owedTrailingIdles > 0) {
                      session.owedTrailingIdles--;
                    }
                    settleDeferredIfDrained();
                  } else if (session.owedTrailingIdles > 0) {
                    // Absorb a settled turn's trailing idle. Also covers a
                    // cancel that landed between a turn's counted result and
                    // this lagged idle (no active turn to settle): the idle
                    // still belongs to that settled turn, and skipping the
                    // decrement would leak the debt permanently.
                    // Deliberately BEFORE the steer lane below: an owed idle
                    // belongs to an earlier turn, and reading it as the steered
                    // sequence's turn-over signal would settle a turn whose
                    // steered cycle is still running. Steered results owe none.
                    session.owedTrailingIdles--;
                  } else if (isSteering(session.activeTurn)) {
                    // A steered turn settles here, not at a result: this idle is
                    // the only signal spanning the interrupted and steered cycles
                    // (see Turn.steeredEchoes). An idle before the steered echo,
                    // or before any result was recorded, means the answer is
                    // still ahead — swallow it, and never let it reach the #825
                    // fail below, which would reject a prompt about to answer.
                    //
                    // Plain Turn so the fields can be cleared below; isSteering
                    // narrows steeredEchoes to non-optional.
                    const steered: Turn = session.activeTurn;
                    if (steered.steeredEchoes?.size === 0 && steered.steeredSettle !== undefined) {
                      // Via the subagent gate, not settleActive: a steered turn
                      // can also have spawned background subagents, which own it
                      // from here (settles now if none is live, holds otherwise).
                      steered.deferredSettle = steered.steeredSettle;
                      steered.steeredEchoes = undefined;
                      steered.steeredSettle = undefined;
                      settleDeferredIfDrained();
                    }
                  } else if (
                    !session.cancelled &&
                    session.activeTurn &&
                    !session.activeTurn.settled
                  ) {
                    // Same reason as the cancelled branch: this turn will never
                    // reach the result that would have reset the lifecycle, and
                    // reset() sends nothing, so the terminal has to be reported
                    // before the state is dropped.
                    await compaction.interrupt(params.sessionId);
                    compaction.reset();
                    // Deliberately only the ACTIVE turn: a queued turn that
                    // was never echoed is NOT failed here, because an idle
                    // can legitimately precede the SDK picking up freshly
                    // pushed input (the idle was emitted before the SDK read
                    // it) — failing the queue head on that race would reject
                    // a prompt the SDK is about to run. A turn abandoned
                    // before its echo therefore still hangs until cancel or
                    // the next prompt; only a timer could tell those apart.
                    this.logger.error(
                      `Session ${params.sessionId}: SDK went idle without emitting a result ` +
                        `for the active turn; failing the in-flight prompt (issue #825)`,
                    );
                    await failActiveWithSessionFailure(
                      "internal_error",
                      RequestError.internalError(
                        errorKindData("no_result"),
                        TURN_NO_RESULT_MESSAGE,
                      ),
                      TURN_NO_RESULT_MESSAGE,
                    );
                  }
                  // Turn-over is when a title may have landed or become
                  // generatable; see SessionTitles.onTurnEnd.
                  await session.titles.onTurnEnd(session);
                }
                break;
              }
              case "memory_recall": {
                const isSynthesis = message.mode === "synthesize";
                const locations = isSynthesis
                  ? []
                  : message.memories.map((m) => ({ path: m.path }));
                const content = isSynthesis
                  ? message.memories
                      .filter(
                        (m): m is (typeof message.memories)[number] & { content: string } =>
                          typeof m.content === "string",
                      )
                      .map((m) => ({
                        type: "content" as const,
                        content: { type: "text" as const, text: m.content },
                      }))
                  : [];
                const count = message.memories.length;
                const title = isSynthesis
                  ? "Recalled synthesized memory"
                  : `Recalled ${count} ${count === 1 ? "memory" : "memories"}`;
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: message.uuid,
                    // Synthesized, but still this call's first report, so it
                    // carries the standard `name` like any other initial one.
                    name: "memory_recall",
                    title,
                    kind: "read",
                    status: "completed",
                    ...(locations.length > 0 && { locations }),
                    ...(content.length > 0 && { content }),
                    _meta: {
                      claudeCode: {
                        toolName: "memory_recall",
                        toolResponse: { mode: message.mode },
                      },
                    } satisfies ToolUpdateMeta,
                  },
                });
                break;
              }
              case "commands_changed": {
                // Push the full slash-command list after a mid-session change
                // (e.g. skills discovered dynamically as the agent works in a
                // subdirectory). The client should REPLACE its cached command
                // list with this payload. Forward message.commands directly —
                // it's authoritative, and re-querying supportedCommands()
                // would just return the same list with an extra round-trip.
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "available_commands_update",
                    availableCommands: getAvailableSlashCommands(
                      message.commands,
                      session.terminalSlashCommands,
                    ),
                  },
                });
                break;
              }
              case "mirror_error": {
                // The SDK failed to persist session history (SessionStore
                // append rejected/timed out after retry) — potential data loss
                // the user should know about rather than a silent gap on
                // resume. Log it and surface a warning in the conversation.
                this.logger.error(
                  `Session ${message.session_id}: failed to persist history: ${message.error}`,
                );
                break;
              }
              case "permission_denied": {
                // A tool call was auto-denied (by a rule, the classifier,
                // dontAsk mode, etc.) before running. The tool_use block was
                // already emitted as a `tool_call`, so mark it failed with the
                // rejection reason — otherwise the client shows a tool call
                // that silently never resolves.
                //
                // The id is the executing call's own, and the frame lands
                // between its `tool_use` and its `tool_result` (the SDK enqueues
                // it from inside canUseTool), so the call is normally in flight
                // here. Not always: the assistant message carrying the tool_use
                // is dropped by the cancelled-turn guard below, and a denial for
                // it can still arrive afterwards — the case the `tool_result`
                // fallback in `toAcpNotifications` gates on `wasEmitted` for.
                // Drop the update rather than reference a tool call the client
                // was never given (see `ensureToolCallEmitted`, issue #851).
                if (!session.emittedToolCalls.has(message.tool_use_id)) {
                  break;
                }
                // A denial inside a subagent identifies the subagent by
                // `agent_id` (as canUseTool does with `agentID`), never by the
                // Agent/Task call that spawned it. Resolve it the same way so
                // the update lands in the subagent's transcript alongside the
                // `tool_call` it resolves, which carries the parent stamped from
                // `parent_tool_use_id` (see `liveBackgroundTasks`).
                const parentToolUseId = message.agent_id
                  ? session.liveBackgroundTasks.get(message.agent_id)?.parentToolUseId
                  : undefined;
                const reason = message.decision_reason ?? message.message;
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: message.tool_use_id,
                    status: "failed",
                    content: [
                      {
                        type: "content",
                        content: { type: "text", text: `Permission denied: ${reason}` },
                      },
                    ],
                    _meta: {
                      claudeCode: {
                        toolName: message.tool_name,
                        ...(parentToolUseId ? { parentToolUseId } : {}),
                        toolResponse: {
                          decisionReasonType: message.decision_reason_type,
                          decisionReason: message.decision_reason,
                          message: message.message,
                        },
                      },
                    } satisfies ToolUpdateMeta,
                  },
                });
                break;
              }
              case "informational": {
                // Free-form notice from the SDK (e.g. why a UserPromptSubmit/Stop
                // hook blocked continuation). Surface the text so the user sees it
                // instead of a silent stop. Clients on the notice contract get it
                // as a `notice` at the SDK's level: 'warning' is the only
                // prominent one; 'notice' and 'suggestion' are gray status
                // lines; 'info' shows only in Claude Code's transcript mode, so
                // it is not worth a live notice at all. For the rest, ACP's
                // agent_message_chunk has no severity field, so fold the level
                // into the text for the more prominent levels ('info' is
                // transcript-only noise — leave plain).
                //
                // A hook-blocked turn's result repeats the block reason with zero
                // output tokens, and the issue-#453 fallback must not emit it a
                // second time. The transcript line is the stretch's delivered
                // text via sendUpdate; a notice is not an answer, so instead the
                // turn remembers the text and the fallback skips a result that
                // only repeats it (see `Turn.noticeTexts`).
                if (supportsNotices) {
                  if (message.level === "info") break;
                  if (message.tool_use_id) {
                    if (noticedToolUses.has(message.tool_use_id)) break;
                    noticedToolUses.add(message.tool_use_id);
                  }
                }
                const severity = message.level === "warning" ? "warning" : "info";
                const transcriptText =
                  message.level === "info"
                    ? message.content
                    : `**${sentenceCase(message.level)}:** ${message.content}`;
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: noticeOrTranscriptUpdate(
                    {
                      severity,
                      ...splitNoticeText(
                        message.content,
                        severity === "warning"
                          ? "Claude reported a warning"
                          : "Claude reported a notice",
                      ),
                    },
                    supportsNotices,
                    transcriptText,
                    { claudeCode: { kind: "informational", level: message.level } },
                  ),
                });
                const noticedTurn = session.activeTurn ?? session.turnQueue?.[0];
                if (supportsNotices && noticedTurn) {
                  (noticedTurn.noticeTexts ??= []).push(normalizeNoticeText(message.content));
                }
                break;
              }
              case "hook_started":
              case "hook_progress":
              case "hook_response":
              case "files_persisted":
              case "task_progress":
                break;
              case "task_started":
                // For subagent tasks `task_id` is the subagent's agent id (the
                // SDK keys its task registry by agent id) and `tool_use_id` is
                // the Agent/Task tool_use that spawned it — recorded so the
                // subagent's permission requests, which reach canUseTool with
                // only `agentID`, can attribute their eagerly-emitted
                // tool_call to the parent tool call. Non-subagent tasks (e.g.
                // background Bash) land here too; their task_ids never match
                // an agentID, so those entries are inert for attribution.
                //
                // `isSubagent` marks Task/Agent-tool subagents — the tasks
                // whose completion wakes the model for a followup, so the
                // ones worth deferring turn settlement for. A sync subagent
                // is pruned (terminal task_updated) before its turn's result
                // can arrive, so registry membership at result time means an
                // async subagent. Their spawn is also recorded on the active
                // turn: a turn only ever waits on its own subagents, and a
                // spawn during a held-open drain window (an agent chain)
                // extends that turn's hold.
                session.liveBackgroundTasks.set(message.task_id, {
                  parentToolUseId: message.tool_use_id,
                  isSubagent: !!message.subagent_type,
                });
                if (message.subagent_type && session.activeTurn && !session.activeTurn.settled) {
                  (session.activeTurn.spawnedTaskIds ??= new Set()).add(message.task_id);
                }
                break;
              case "task_notification":
                // The task settled — no further tool calls can originate
                // from it, so its registry entry can be dropped.
                session.liveBackgroundTasks.delete(message.task_id);
                break;
              case "task_updated":
                // terminal-status task_updated patch and a (deduplicated)
                // task_notification when a task settles, but only the patch is
                // guaranteed per transition — prune on it too so the registry
                // can't grow for the session's lifetime if a notification is
                // skipped.
                if (
                  message.patch.status === "completed" ||
                  message.patch.status === "failed" ||
                  message.patch.status === "killed"
                ) {
                  session.liveBackgroundTasks.delete(message.task_id);
                }
                break;
              case "worker_shutting_down":
                // Defer until stream end. The announcement is durable and may be
                // replayed before later frames, but those frames do not prove that
                // a new worker epoch began: they can be buffered output from the
                // shutting-down worker. Keep the signal armed until the transport
                // actually ends. Deliberately do not add a quiet-period timer: the
                // iterator has no replay/live boundary, so a timeout could publish
                // while a slow replay is still in flight.
                pendingWorkerShutdown = true;
                break;
              case "elicitation_complete": {
                // A url-mode MCP elicitation finished server-side. Let the client
                // dismiss any UI it opened for it. Only meaningful when the
                // client supports url elicitation; ignore failures otherwise.
                if (this.clientCapabilities?.elicitation?.url) {
                  try {
                    await this.client.unstable_completeElicitation({
                      elicitationId: message.elicitation_id,
                    });
                  } catch (error) {
                    this.logger.error(`Failed to complete elicitation: ${error}`);
                  }
                }
                break;
              }
              case "plugin_install":
              case "notification":
              case "thinking_tokens":
                // Todo: process via status api: https://docs.claude.com/en/docs/claude-code/hooks#hook-output
                break;
              case "api_retry": {
                // `no_response` (SDK 0.3.261+): the API sent no response headers
                // within the first-byte window, so this retry waits longer for
                // them. Say so -- "attempt 1 of 1" alone reads like a final
                // failure, and the wait is what the user is about to sit
                // through.
                const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;
                const noResponse = message.no_response
                  ? ` No response after ${seconds(message.no_response.waited_ms)}; waiting up to ${seconds(message.no_response.retry_wait_ms)}.`
                  : "";
                const title =
                  message.error_status === null
                    ? `Reconnecting to Claude, attempt ${message.attempt} of ${message.max_retries}.${noResponse}`
                    : `Retrying Claude, attempt ${message.attempt} of ${message.max_retries}.${noResponse}`;
                await publishSessionFailure(
                  message.error_status === null
                    ? "transport_lost"
                    : providerFailureCategory(message.error),
                  {
                    title,
                    severity: "warning",
                  },
                );
                break;
              }
              case "model_refusal_fallback": {
                // The SDK retried a refused turn on the fallback model and made
                // the swap persistent for the session. Without a notice the
                // user just sees regenerated output; without the state sync the
                // client's model picker (and the model-dependent options
                // rebuilt from it) keeps advertising a model the session is no
                // longer running.
                //
                // Current CLIs only emit direction "retry" (persistent swap).
                // "revert"/"sticky" are retained in the SDK enum for older
                // CLIs, where "revert" marked a turn-only fallback — for that
                // direction the session stays on the original model, so skip
                // the persistent-swap claim and the state sync.
                //
                // `scope` (CLI 2.1.232+) marks WHERE the fallback happened:
                // "local" means a subagent / side-question / background fork
                // response fell back and the session model is unchanged, so
                // syncing the picker would advertise a model the session
                // isn't running. Absent scope means an older CLI, where every
                // retry was a session-level swap — treat as "session".
                const local = message.scope === "local";
                const persistent = message.direction !== "revert" && !local;
                const category = message.api_refusal_category
                  ? ` (${message.api_refusal_category})`
                  : "";
                const outcome = persistent
                  ? `The session will continue on ${message.fallback_model}.`
                  : local
                    ? `Only that response came from ${message.fallback_model}; the session stays on ${message.original_model}.`
                    : `The session stays on ${message.original_model}.`;
                const fallbackSummary =
                  `${message.original_model} declined this request${category}; ` +
                  `retried with ${message.fallback_model}. ${outcome}`;
                const explanation = message.api_refusal_explanation || undefined;
                const fallbackNotice = explanation
                  ? `${fallbackSummary}\n\n${explanation}`
                  : fallbackSummary;
                // A silent model swap is a session-level advisory, not something the model said.
                // Clients on the ACP notice contract get it as a `notice`; clients that negotiated
                // AIR typed records get it as one of those; the rest keep the bold-label transcript
                // line, which was the only way to flag it before.
                if (!supportsNotices && supportsAirSessionFailures(this.clientCapabilities)) {
                  const useDetails =
                    explanation !== undefined &&
                    fallbackSummary.length + 2 + explanation.length > MAX_NOTICE_TITLE_LENGTH;
                  await publishSessionFailure("advisory", {
                    title: useDetails ? fallbackSummary : fallbackNotice,
                    ...(useDetails ? { details: explanation } : {}),
                  });
                } else {
                  // A title must stand alone: the one-line summary when it is
                  // short enough, else a generic title with everything in the
                  // description (the same cap the AIR lane applies above).
                  const notice =
                    fallbackSummary.length > MAX_NOTICE_TITLE_LENGTH
                      ? { title: "Model fallback", description: fallbackNotice }
                      : {
                          title: fallbackSummary,
                          ...(explanation ? { description: explanation } : {}),
                        };
                  await sendUpdate({
                    sessionId: params.sessionId,
                    update: noticeOrTranscriptUpdate(
                      { severity: "warning", ...notice },
                      supportsNotices,
                      `**Model fallback:** ${fallbackNotice}`,
                    ),
                  });
                }
                if (persistent) {
                  await this.syncModelAfterRefusalFallback(
                    params.sessionId,
                    session,
                    message.fallback_model,
                  );
                }
                break;
              }
              case "model_refusal_no_fallback":
                // The refusal ends the turn as an error; the terminal `result`
                // handler settles it with ACP's `refusal` stop reason and
                // streams `lastRefusalExplanation`. The assistant frame's
                // stop_details is the primary source for that explanation —
                // this structured banner is the backup source when the frame
                // carried none (older CLIs, gateways that drop stop_details).
                //
                // `refused_user_message_uuid` is explicitly null when the
                // refused turn was not human-authored (a background
                // task-notification followup or auto-continuation) — don't
                // let those pollute the user turn's explanation. `undefined`
                // (older CLIs that omit the field) can't be attributed either
                // way, so keep seeding — the same exposure the assistant-frame
                // capture already has.
                if (!lastRefusalExplanation && message.refused_user_message_uuid !== null) {
                  lastRefusalExplanation = message.api_refusal_explanation ?? message.content;
                }
                break;
              // `control_request_progress` only reports on side_question
              // control requests, which this adapter never issues.
              case "control_request_progress":
                break;
              case "background_tasks_changed":
                // A level signal: the full live background-task set on every
                // membership change, with REPLACE semantics. Used only to
                // reconcile `liveBackgroundTasks` — dropping (or, for
                // subagent entries, unpinning) any entry whose settle
                // bookend (task_notification / terminal task_updated) was
                // lost, so a leaked subagent entry can't defer its spawning
                // turn's settlement forever. Growth of retained
                // (endedPerLevel) subagent entries is bounded by the
                // activation-time sweep in activateTurn, not here. It never
                // ADDS entries (the payload carries no attribution or
                // subagent marker), so the unspecified ordering vs. the edge
                // bookends is safe: a level that precedes its task_started
                // simply no-ops here.
                if (session.liveBackgroundTasks.size > 0) {
                  const live = new Set(message.tasks.map((t) => t.task_id));
                  for (const [taskId, record] of session.liveBackgroundTasks) {
                    if (live.has(taskId)) {
                      // The level proves the task live in the background
                      // universe (e.g. a foreground agent was backgrounded
                      // after an earlier absent-marking, or that marking was
                      // a racing payload built before the task registered) —
                      // un-end it so a hold waits on it again, and disarm
                      // the activation sweep.
                      record.endedPerLevel = undefined;
                      continue;
                    }
                    if (record.isSubagent) {
                      // The level's universe is BACKGROUND tasks only, so a
                      // live sync (foreground) subagent is legitimately
                      // absent — deleting its entry would strand its
                      // permission attribution (#859). Keep the entry but
                      // stop any hold from waiting on the id: an absent id
                      // can equally be a leaked async entry whose settle
                      // bookends were lost.
                      record.endedPerLevel ??= "ended";
                    } else {
                      session.liveBackgroundTasks.delete(taskId);
                    }
                  }
                }
                // The same level, forwarded: once the turn has settled the
                // client reads the thread as idle, and a background shell or
                // subagent still running is invisible to it. Ambient tasks
                // (watchers, skip_transcript work) are excluded because the
                // SDK marks them as "not activity" for exactly this use.
                await publishBackgroundTasks(message.tasks.filter((task) => !task.ambient));
                break;
              default:
                unreachable(message, this.logger);
                break;
            }
            break;
          case "result": {
            // A result from an autonomous cycle — a task-notification
            // followup, or a peer/coordinator/observer message the model
            // handled on its own (see AUTONOMOUS_RESULT_ORIGINS) — is not
            // the user's prompt's. Autonomous results must never touch the
            // user-turn lifecycle (stop reason, settles, failActive,
            // slash-command output forwarding), though their cost is real.
            const isAutonomousResult =
              message.origin != null && AUTONOMOUS_RESULT_ORIGINS.has(message.origin.kind);
            const pendingExitPlanModeInterruption = session.pendingExitPlanModeInterruption;
            const pendingExitPlanContextReset = session.pendingExitPlanContextReset;
            try {
              // Reconcile the Fast mode toggle with the SDK's reported state.
              // Gated to user-driven turns like every other side effect below;
              // an autonomous cycle's state lands on the next user turn's
              // result. Runs even when the turn errors or was cancelled.
              if (!isAutonomousResult) {
                await this.syncFastModeState(
                  params.sessionId,
                  session,
                  message.fast_mode_state,
                  message.fast_mode_disabled_reason,
                );
              }

              // A user-turn result needs an active turn so its stop reason is
              // attributed and the turn settles at idle. Local-only commands carry
              // no user-message echo to promote them, so do it here from the head.
              // Promote BEFORE accumulating usage, since activation resets the
              // accumulator — promoting after would discard this result's tokens.
              // The orphan bookkeeping runs first: it covers folded/zombie
              // commands whose shared or late result this is, even when the
              // result is the ACTIVE turn's (ensureActiveTurn never looks at
              // the map in that case).
              if (!isAutonomousResult) {
                recordResultForOrphanCommands();
                ensureActiveTurn(message.user_message_uuid);
                // Once the submitted goal command has produced its own result,
                // no older runtime update can still precede it in the ordered
                // SDK stream. Stop suppressing updates even when this runtime
                // omitted the matching active_goal notification entirely.
                if (session.pendingGoalUpdate?.started) {
                  const pendingGoalUpdate = session.pendingGoalUpdate;
                  session.pendingGoalUpdate = undefined;
                  const goalCommandFailed =
                    message.is_error ||
                    message.stop_reason === "refusal" ||
                    ("result" in message &&
                      message.is_error &&
                      message.result.includes("Please run /login"));
                  if (goalCommandFailed) {
                    await this.publishGoal(params.sessionId, pendingGoalUpdate.previous ?? null);
                  }
                }
              }

              // A result closes the stretch of output it terminates: snapshot
              // the delivery record — AFTER ensureActiveTurn, whose held-turn
              // hand-off closes the held stretch, so an echo-less command
              // promoted here is judged on its own delivery, not on the held
              // turn's followup text — and before the handling below can emit
              // anything of its own; the `finally` then clears it so every
              // exit from this case (the cancelled-guard and refusal breaks
              // included) starts the next stretch clean. Clearing up front
              // instead would let result-time emissions (refusal explanation,
              // result-text forwarding) taint the next stretch and suppress a
              // following replayed turn's fallback. Autonomous cycles run
              // alongside a user turn and must not clear its flag (they exit
              // through the early break below, which the gated `finally`
              // leaves alone).
              const deliveredAssistantText = session.emittedAssistantText;
              // Story 011, R2.1: a `/usage` turn whose output already reached
              // the client through a shape no interception point claimed —
              // neither rendered nor logged by any other way out.
              const usageTurn = session.activeTurn;
              if (
                usageTurn?.isUsageCommand &&
                deliveredAssistantText &&
                !usageTurn.usageMarkdownDelivered &&
                !usageTurn.usageFallbackLogged &&
                !session.cancelled
              ) {
                this.logger.error(
                  "Structured /usage not applied: the command's output was not intercepted; preserving Claude Code output",
                );
                usageTurn.usageFallbackLogged = true;
              }
              // The deleted "Compacting…" banners counted as delivered text
              // simply by going through sendUpdate; tool calls don't, so a turn
              // that ONLY compacted (e.g. `/compact`, promoted at its own
              // result) needs this to keep its result text from being re-emitted
              // by the issue-#453 fallback below.
              const deliveredCompactionOutput = compaction.hasDeliveredOutput;

              // Every user-turn result terminates a turn (settle, reject, or
              // orphan skip) and the SDK follows it with a trailing
              // `session_state_changed: idle` — record the debt so the idle
              // handler absorbs that idle rather than reading it as a turn the
              // SDK abandoned (issue #825). One exclusion: the cancelled ACTIVE
              // turn's own result. It is dropped at the `session.cancelled`
              // guard, and either the idle itself settles the turn (consuming
              // the trailer) or the next echo's hand-off does (which records
              // the debt there instead) — counting here too would double it.
              // Results skipped while cancelled with NO active turn — orphaned
              // queued turns the SDK still ran, or a force-cancelled turn's
              // late result after the backstop settled it — get no such settle,
              // so their trailers must be counted here or they'd later be read
              // as the next healthy turn being abandoned and false-fail it.
              // Autonomous results (followups, peer/channel/coordinator
              // cycles) are counted too: each is its own processing cycle with
              // its own trailing idle, and that idle can lag past the next
              // prompt's echo — which, un-owed, would be read as the fresh
              // turn being abandoned (#825 false-fail). That lag was mostly
              // unreachable when such cycles only ran with no pending turn,
              // but a held turn settling AT a followup result unblocks the
              // client at exactly that point, making the race the common
              // case.
              // The cancelled-ACTIVE-turn exclusion applies only to that
              // turn's OWN result — a followup result arriving inside the
              // cancel window still gets its own trailer and must be counted,
              // or that idle would later false-fail the next prompt.
              // A second exclusion: a steered turn's own results (see
              // Turn.steeredEchoes). One idle covers the whole interrupted +
              // steered sequence and that idle settles the turn, so counting
              // either result would leave a debt that swallows it. Autonomous
              // results inside a steered turn keep their own trailers.
              const owesTrailingIdle = isAutonomousResult || !isSteering(session.activeTurn);
              if (
                owesTrailingIdle &&
                (isAutonomousResult || !session.cancelled || !session.activeTurn)
              ) {
                session.owedTrailingIdles++;
              }

              // Accumulate usage into the user turn's tally. Skip autonomous
              // results: their cost is real but is reported separately via the
              // usage_update below, and `session.accumulatedUsage` is only reset on
              // turn activation — so folding an autonomous result that lands
              // after the next turn is active (but before it settles) would leak
              // those tokens into that turn's PromptResponse.usage.
              if (!isAutonomousResult) {
                session.accumulatedUsage.inputTokens += message.usage.input_tokens;
                session.accumulatedUsage.outputTokens += message.usage.output_tokens;
                session.accumulatedUsage.cachedReadTokens += message.usage.cache_read_input_tokens;
                session.accumulatedUsage.cachedWriteTokens +=
                  message.usage.cache_creation_input_tokens;
              }

              const matchingModelUsage = lastAssistantModel
                ? getMatchingModelUsage(message.modelUsage, lastAssistantModel)
                : null;
              // Only overwrite when we have an authoritative, sane value. A miss
              // (e.g. a turn with no top-level assistant message), or a
              // nonsensical non-positive/NaN window (observed from third-party
              // backends), would otherwise discard the window learned on a prior
              // turn and leave the next prompt's mid-stream updates reporting a
              // wrong size. `cacheContextWindow` applies the same `> 0` guard, so
              // a bad value never reaches the cross-session cache either.
              if (
                matchingModelUsage &&
                typeof matchingModelUsage.usage.contextWindow === "number" &&
                matchingModelUsage.usage.contextWindow > 0
              ) {
                session.contextWindowSize = matchingModelUsage.usage.contextWindow;
                session.contextWindowAuthoritative = true;
                // Authoritative: fold it into the cross-session cache keyed on
                // (this session's provider, the resolved model id —
                // matchingModelUsage.key, e.g. "claude-sonnet-5[1m]") so a later
                // session/new or switch on the same provider that resolves to
                // this model seeds the correct window synchronously, with no
                // getContextUsage IPC.
                cacheContextWindow(
                  contextWindowCacheKey(session.providerCacheKey, matchingModelUsage.key),
                  matchingModelUsage.usage.contextWindow,
                );
                // Also cache under the assistant message's own (bare) spelling.
                // Seed-time reads fall back to a picker value / verbatim live id
                // when a row carries no resolvedModel (the synthesized
                // out-of-allowlist resume row sets it undefined on purpose), and
                // those spellings match `.model` from the assistant message, not
                // the decorated modelUsage key — without this entry such rows
                // could never hit the cache.
                if (lastAssistantModel && lastAssistantModel !== matchingModelUsage.key) {
                  cacheContextWindow(
                    contextWindowCacheKey(session.providerCacheKey, lastAssistantModel),
                    matchingModelUsage.usage.contextWindow,
                  );
                }
              }

              // Send usage_update notification
              if (lastAssistantTotalUsage !== null) {
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "usage_update",
                    used: lastAssistantTotalUsage,
                    size: session.contextWindowSize,
                    cost: {
                      amount: message.total_cost_usd,
                      currency: "USD",
                    },
                    ...(message.origin && {
                      _meta: { "_claude/origin": message.origin },
                    }),
                  },
                });
              }

              if (session.cancelled) {
                session.pendingExitPlanModeInterruption = undefined;
                session.pendingExitPlanContextReset = undefined;
                if (!isAutonomousResult) {
                  await clearFailuresFromEarlierTurns();
                  stopReason = "cancelled";
                }
                break;
              }

              // A held turn (see Turn.deferredSettle) settles at its
              // followup's terminal result: this is the earliest point at which
              // the promised summary has fully streamed — the trailing idle
              // would work too, but a client should not wait out another idle
              // round-trip for a response whose content is already complete.
              // (While the turn still awaits another of its subagents —
              // parallel spawns — the helper holds; the next notification's
              // followup settles it instead. Other autonomous origins — peer/
              // channel/coordinator cycles — reach here too: settling a
              // drained hold at their results is as good as the idle
              // fallback.) Then stop: everything below is user-turn
              // lifecycle, and an autonomous outcome must never touch it —
              // its is_error or "Please run /login" text would otherwise
              // failActive a live turn (the held one, or the user's next
              // prompt) whose own result recorded a different outcome.
              if (isAutonomousResult) {
                // A held turn's followup can itself plan: the subagent
                // finishes, the model writes the plan and calls ExitPlanMode
                // inside the task-notification cycle, and the user answers it
                // within the still-open turn. The interrupted cycle's
                // diagnostic then carries that cycle's origin, so it lands
                // here rather than in the user-lane check below — and settling
                // the hold at it would end the turn with `end_turn`, silently
                // dropping an accepted clear-context plan (issue #1167).
                const heldTurn = session.activeTurn;
                if (
                  isHeldOpen(heldTurn) &&
                  pendingExitPlanModeInterruption &&
                  isExitPlanInterruptionResult(message, pendingExitPlanModeInterruption)
                ) {
                  session.pendingExitPlanModeInterruption = undefined;
                  if (
                    pendingExitPlanContextReset &&
                    pendingExitPlanContextReset.toolUseId ===
                      pendingExitPlanModeInterruption.toolUseId
                  ) {
                    // The fresh query has none of this one's background
                    // tasks, so the hold can never drain there: drop it, and
                    // let the continuation's own result settle the turn.
                    (heldTurn as Turn).deferredSettle = undefined;
                    await this.exitPlan.restart(
                      params.sessionId,
                      session,
                      pendingExitPlanContextReset,
                    );
                    return;
                  }
                  // "No, keep planning": the turn ends cancelled, with the
                  // usage its own result recorded — still held while other
                  // subagents it spawned are live.
                  session.pendingExitPlanContextReset = undefined;
                  settleOrDefer({ ...heldTurn.deferredSettle, stopReason: "cancelled" });
                  break;
                }
                settleDeferredIfDrained();
                // With no turn in flight OR QUEUED (also after the settle
                // above), the stretch holds only autonomous prose — close
                // it, so a replayed next prompt isn't silently suppressed by
                // the issue-#453 delivery check. A live turn's flag may
                // guard the USER's already-streamed text — and so may a
                // QUEUED turn's: with mid-message echo lag its deltas stream
                // before the echo activates it (activeTurn still null), and
                // clearing then would re-emit that answer via the fallback,
                // the duplicate direction the flag's doc forbids.
                if (!session.activeTurn && !firstUnsettledQueuedTurn()) {
                  session.emittedAssistantText = false;
                }
                break;
              }

              await clearFailuresFromEarlierTurns();

              // `interrupt: true` is required to make "No, keep planning"
              // terminate the ACP turn. Claude represents that intentional
              // interrupt as an error-shaped diagnostic, so translate only a
              // diagnostic causally paired with the recorded ExitPlanMode
              // permission response.
              if (
                pendingExitPlanModeInterruption &&
                isExitPlanInterruptionResult(message, pendingExitPlanModeInterruption)
              ) {
                session.pendingExitPlanModeInterruption = undefined;
                if (
                  pendingExitPlanContextReset &&
                  pendingExitPlanContextReset.toolUseId ===
                    pendingExitPlanModeInterruption.toolUseId
                ) {
                  await this.exitPlan.restart(
                    params.sessionId,
                    session,
                    pendingExitPlanContextReset,
                  );
                  return;
                }
                stopReason = "cancelled";
                settleOrDefer({ stopReason: "cancelled", usage: sessionUsage(session) });
                break;
              }
              if (pendingExitPlanModeInterruption) {
                // This result ended the interrupted cycle without the exact
                // correlated cancellation shape. Never carry its marker into
                // a later turn, whether or not the tool result was observed.
                session.pendingExitPlanModeInterruption = undefined;
                session.pendingExitPlanContextReset = undefined;
              }

              // A refusal can arrive on any result subtype (and may even set
              // is_error), so handle it before the subtype switch — otherwise the
              // is_error throw below would surface it as an internal error. The
              // refused assistant message carries no visible content, so surface
              // the classifier's explanation (when available) and report ACP's
              // dedicated `refusal` stop reason.
              if (message.stop_reason === "refusal") {
                if (lastRefusalExplanation) {
                  await sendUpdate({
                    sessionId: params.sessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: lastRefusalExplanation },
                    },
                  });
                }
                stopReason = "refusal";
                // Through the deferral gate, not settleActive: a refusal can
                // land on a turn whose spawned subagents are still live, and
                // settling it out from under them would strand their output
                // and permission requests out-of-turn (issue #866's deadlock,
                // through the refusal lane).
                settleOrDefer({ stopReason: "refusal", usage: sessionUsage(session) });
                break;
              }

              // A priority:'now' steer can make the SDK terminate the
              // interrupted cycle with an error-shaped diagnostic result
              // before it replays the injected message's echo. That result is
              // not the steered command's outcome: keep it on the steer lane
              // and let the cycle after the pending echo decide the turn.
              if (
                message.is_error &&
                isSteering(session.activeTurn) &&
                session.activeTurn.steeredEchoes.size > 0
              ) {
                settleOrDefer({ stopReason: "end_turn", usage: sessionUsage(session) });
                break;
              }

              if (!message.is_error && lastAssistantModel !== null) {
                const activeTurnId = session.activeTurn?.promptUuid;
                await sessionFailures.clear(
                  (failure) =>
                    failure.recoveryPolicy === "real_model_success" ||
                    (failure.severity === "warning" && failure.turnId === activeTurnId),
                );
              }

              switch (message.subtype) {
                case "success": {
                  if (message.is_error && message.result.includes("Please run /login")) {
                    await failActiveWithSessionFailure(
                      "auth_required",
                      RequestError.authRequired(),
                      message.result,
                    );
                    break;
                  }
                  if (message.stop_reason === "max_tokens") {
                    stopReason = "max_tokens";
                    break;
                  }
                  if (message.is_error) {
                    await failActiveWithSessionFailure(
                      providerFailureCategory(lastAssistantError, lastAssistantWasUsageLimit),
                      internalErrorForClient(errorKindData(lastAssistantError), message.result),
                      lastAssistantFailureTitle ?? message.result,
                    );
                    break;
                  }
                  // The result text is forwarded in two cases. Local-only
                  // commands (no model invocation): the result IS the command
                  // output. Otherwise the result is normally a trailing copy of
                  // text that already streamed — but a cache-replayed turn
                  // generates no tokens, and some CLIs then skip streaming
                  // entirely and answer on the `result` alone: no `stream_event`
                  // deltas, no consolidated `assistant` message (issue #453).
                  // Forward it rather than end the turn silently:
                  // `deliveredAssistantText` covers whatever already reached the
                  // client (a turn that showed its answer cannot emit it twice),
                  // and the output-token check keeps the fallback to the
                  // replayed turns it was reported for. `?? 0`: typed non-null,
                  // but third-party backends have been observed omitting usage
                  // token fields (see snapshotFromUsage), and the replay lane
                  // was reported from exactly such a backend — treat a missing
                  // count as the replay signature rather than silently disabling
                  // the fallback there. (Autonomous results never get here —
                  // they exit at the early break above — so no background
                  // prose can be injected into the feed.)
                  const shouldForwardResult =
                    session.activeTurn?.isLocalOnlyCommand ||
                    (!deliveredAssistantText &&
                      !deliveredCompactionOutput &&
                      (message.usage.output_tokens ?? 0) === 0 &&
                      !session.activeTurn?.noticeTexts?.includes(
                        normalizeNoticeText(message.result),
                      ));
                  if (shouldForwardResult) {
                    // A `/usage` turn whose output arrives only on the result.
                    // Claiming it here also stops the raw text following a
                    // render already published from another message shape.
                    const usageMarkdown = await takeUsageMarkdown(message.result);
                    if (usageMarkdown === null) {
                      break;
                    }
                    for (const notification of toAcpNotifications(
                      usageMarkdown ?? message.result,
                      "assistant",
                      params.sessionId,
                      session.toolUseCache,
                      this.client,
                      this.logger,
                    )) {
                      await sendUpdate(notification);
                    }
                  }
                  break;
                }
                case "error_during_execution": {
                  if (message.stop_reason === "max_tokens") {
                    stopReason = "max_tokens";
                    break;
                  }
                  if (message.is_error) {
                    await failActiveWithSessionFailure(
                      providerFailureCategory(lastAssistantError, lastAssistantWasUsageLimit),
                      internalErrorForClient(
                        errorKindData(lastAssistantError),
                        message.errors.join(", ") || message.subtype,
                      ),
                      lastAssistantFailureTitle ?? (message.errors.join(", ") || message.subtype),
                    );
                    break;
                  }
                  stopReason = "end_turn";
                  break;
                }
                case "error_max_budget_usd":
                  if (message.is_error) {
                    await failActiveWithSessionFailure(
                      "budget_exhausted",
                      internalErrorForClient(
                        errorKindData(lastAssistantError),
                        message.errors.join(", ") || message.subtype,
                      ),
                      message.errors.join(", ") || message.subtype,
                    );
                    break;
                  }
                  stopReason = "max_turn_requests";
                  break;
                case "error_max_turns":
                  if (message.is_error) {
                    await failActiveWithSessionFailure(
                      "context_exhausted",
                      internalErrorForClient(
                        errorKindData(lastAssistantError),
                        message.errors.join(", ") || message.subtype,
                      ),
                      message.errors.join(", ") || message.subtype,
                    );
                    break;
                  }
                  stopReason = "max_turn_requests";
                  break;
                case "error_max_structured_output_retries":
                  if (message.is_error) {
                    await failActiveWithSessionFailure(
                      "provider_error",
                      internalErrorForClient(
                        errorKindData(lastAssistantError),
                        message.errors.join(", ") || message.subtype,
                      ),
                      message.errors.join(", ") || message.subtype,
                    );
                    break;
                  }
                  stopReason = "max_turn_requests";
                  break;
                default:
                  unreachable(message, this.logger);
                  break;
              }
              // Settle the user turn at its terminal result so the client unlocks
              // as soon as the answer is done, rather than waiting for the SDK's
              // trailing `idle` (which can lag while background work runs — issue
              // #773). The consumer keeps draining afterward (absorbing idle and
              // forwarding any background output).
              //
              // One exception: while background subagents this turn spawned are
              // still live, settling now would strand their remaining work
              // outside any turn — ACP allows out-of-turn session/update, but
              // many clients stop consuming at the prompt response, and a
              // subagent's permission request would block on an RPC nobody
              // answers (issues #864/#866). Hold the turn open instead: store
              // the outcome and settle with it once the subagents are done —
              // at their followup's terminal result (see the deferred-settle
              // block above the subtype switch) or at an idle with none of
              // them left — so the subagents' streamed output, their
              // permission requests, and the model's promised summary all land
              // inside the turn. `session/cancel` and the next prompt's echo
              // hand-off still settle a deferred turn early, so a long-running
              // subagent never holds the prompt hostage.
              //
              // is_error/auth already settled via failActive (activeTurn is null
              // then, so both branches no-op); cancellation is left to the
              // idle/abort path. settleActive is idempotent, so a duplicate
              // idle is a no-op.
              if (!session.cancelled) {
                settleOrDefer({ stopReason, usage: sessionUsage(session) });
              }
            } finally {
              if (!isAutonomousResult) {
                session.emittedAssistantText = false;
                // A result closes this turn's compaction lifecycle. Reset here
                // rather than at idle: an owed idle from this turn can arrive
                // after the next turn has already started, and would erase that
                // turn's compaction state instead of its own.
                //
                // interrupt() FIRST, and unconditionally: this `finally` is the
                // one point every exit from this case passes through, and the
                // arms that reach it without a terminal -- `auth_required`,
                // `is_error`, a refusal -- would otherwise leave the opening
                // in_progress frame as the client's last word, because reset()
                // sends nothing. A successful result has already reported its
                // own terminal, so this is a no-op there.
                await compaction.interrupt(params.sessionId);
                compaction.reset();
                // R1.2: a user turn's terminal result is the moment consumption
                // actually changed, so refresh the account quota windows here —
                // in the `finally`, which is the one point EVERY exit from this
                // case passes through (refusal, cancellation, a failed turn,
                // the plain success), so no lane ends a turn without asking.
                // Autonomous cycles are excluded by the same gate that guards
                // the flag above: they are background work alongside a turn,
                // not a turn ending, and would spend one request each.
                //
                // Awaited, not fired and forgotten: the turn has already
                // settled a few lines above, so the client is not kept waiting
                // on this round-trip — only the consumer's own progression to
                // the trailing idle is, and a stalled control request there is
                // the same exposure `fetchContextUsedTokens` already accepts.
                await this.publishAccountUsage(params.sessionId, session);
                // A settled turn is the proof that control requests are being
                // serviced (before the first one they are not — #886/#880), so
                // this is the earliest honest moment to start the idle refresh.
                this.armAccountUsagePolling(params.sessionId, session);
              }
            }
            break;
          }
          case "stream_event": {
            // Compaction streams as its own block type. The deltas carry the
            // generated summary, which stays internal to the agent — all the
            // client gets is one keep-alive on the open tool call, so a long
            // compaction doesn't look stalled.
            const isCompactionProgress =
              (message.event.type === "content_block_start" &&
                message.event.content_block.type === "compaction") ||
              (message.event.type === "content_block_delta" &&
                message.event.delta.type === "compaction_delta");
            if (isCompactionProgress) {
              await compaction.heartbeat(params.sessionId, message.uuid);
            }
            // `message_start` carries the Anthropic API message id; capture it
            // so the streamed chunks that follow (whose delta events don't carry
            // it) can all be tagged with the same, replay-stable id.
            if (message.event.type === "message_start") {
              currentStreamMessageId = message.event.message.id || undefined;
              // A new top-level message starts: clear any streamed-content
              // residue from a prior message that never reached its
              // consolidated reset — a cancelled turn breaks out before the
              // reset, and the synthetic-auth/system/local-command paths
              // `break` early too. Block indices restart at 0 each message, so
              // leftover entries would otherwise collide with this message's
              // blocks and re-emit (or truncate) already-streamed text. Gated on
              // `parent_tool_use_id === null` so a subagent stream can't clear
              // the top-level record. Fires once, before any of this message's
              // blocks, so it doesn't disturb the mid-message turn-activation
              // path the way resetting on turn activation would.
              if (message.parent_tool_use_id === null) {
                streamedBlocks.length = 0;
              }
            }
            // Accumulate the text/thinking actually streamed live, so the
            // `assistant` case below can diff its assembled blocks against what
            // already reached the client as chunks and forward only the
            // remainder. Gated on `parent_tool_use_id === null` so a subagent
            // stream can't attribute its content to the top-level message.
            // Contiguous deltas of the same block (same index and type) extend
            // the current entry; anything else opens a new one.
            if (
              message.parent_tool_use_id === null &&
              message.event.type === "content_block_delta"
            ) {
              const delta = message.event.delta;
              const chunk =
                delta.type === "text_delta"
                  ? { type: "text" as const, text: delta.text }
                  : delta.type === "thinking_delta"
                    ? { type: "thinking" as const, text: delta.thinking }
                    : undefined;
              // Skip empty deltas (some gateways emit empty thinking chunks —
              // #793): appending "" is a no-op, but pushing a "" entry would
              // create a block the consolidated handler's `text.length > 0`
              // guard can never consume, stalling the diff cursor and
              // re-emitting the next block as a duplicate.
              if (chunk?.text) {
                const index = message.event.index;
                const last = streamedBlocks[streamedBlocks.length - 1];
                if (last && last.index === index && last.type === chunk.type) {
                  last.text += chunk.text;
                } else {
                  streamedBlocks.push({ index, type: chunk.type, text: chunk.text });
                }
              }
            }
            if (
              message.parent_tool_use_id === null &&
              (message.event.type === "message_start" || message.event.type === "message_delta")
            ) {
              if (message.event.type === "message_start") {
                lastAssistantUsage = snapshotFromUsage(message.event.message.usage);
                const model = message.event.message.model;
                if (model && model !== "<synthetic>") {
                  lastAssistantModel = model;
                  // Only upgrade from the heuristic default — once we have an
                  // authoritative window (cache-seeded at session creation or
                  // on a model switch, read from the resumed session on
                  // session/load, confirmed by each `result`), trust it over
                  // the heuristic. The flag, not the value, is the sentinel: an
                  // authoritative window can legitimately equal
                  // DEFAULT_CONTEXT_WINDOW (e.g. a backend serving a 200k lane
                  // under a "[1m]"-spelled id) and must not be clobbered.
                  if (
                    !session.contextWindowAuthoritative &&
                    session.contextWindowSize === DEFAULT_CONTEXT_WINDOW
                  ) {
                    const inferred = inferContextWindowFromModel(model);
                    if (inferred !== null) {
                      session.contextWindowSize = inferred;
                    }
                  }
                }
              } else {
                const usage = message.event.usage;
                const prev: Readonly<UsageSnapshot> = lastAssistantUsage ?? ZERO_USAGE;
                // Per Anthropic API, message_delta usage fields are *cumulative*;
                // nullable fields (input_tokens and the cache fields) fall back
                // to the prior snapshot when the server omits them from this
                // delta. Only output_tokens is guaranteed non-null.
                lastAssistantUsage = {
                  input_tokens: usage.input_tokens ?? prev.input_tokens,
                  output_tokens: usage.output_tokens,
                  cache_read_input_tokens:
                    usage.cache_read_input_tokens ?? prev.cache_read_input_tokens,
                  cache_creation_input_tokens:
                    usage.cache_creation_input_tokens ?? prev.cache_creation_input_tokens,
                };
              }

              const nextUsage = totalTokens(lastAssistantUsage);
              if (nextUsage !== lastAssistantTotalUsage) {
                lastAssistantTotalUsage = nextUsage;
                session.contextUsedTokens = nextUsage;
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "usage_update",
                    used: nextUsage,
                    size: session.contextWindowSize,
                  },
                });
              }
            }
            for (const notification of streamEventToAcpNotifications(
              message,
              params.sessionId,
              session.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                cwd: session.cwd,
                taskState: session.taskState,
                emittedToolCalls: session.emittedToolCalls,
                messageId: currentStreamMessageId,
                streamedToolInputs,
              },
            )) {
              // sendUpdate records delivery; a subagent stream's chunks carry
              // the stamped parentToolUseId meta and are excluded there.
              await sendUpdate(notification);
            }
            break;
          }
          case "user":
          case "assistant": {
            // Record the ACP messageId -> SDK uuid mapping for this message
            // (including replays). The consolidated message carries both ids, so
            // this is where we learn the uuid the SDK's rewind/resume APIs key on
            // for the id we hand clients. Not read yet (see messageIdToUuid).
            const mappedMessageId = messageIdForGrouping(message);
            if (mappedMessageId && typeof message.uuid === "string" && message.uuid.length > 0) {
              session.messageIdToUuid.set(mappedMessageId, message.uuid);
            }

            // A replayed user message echoes a queued turn back in submission
            // order. The first echo promotes that turn to active; if a different
            // turn is still active, it is handed off (settled end_turn) first.
            // Done before the `cancelled` guard so a turn enqueued after a cancel
            // is still promoted — activateTurn() clears the flag. The turn's own
            // echo is then dropped from the feed (the client already shows it).
            if (message.type === "user" && "uuid" in message && message.uuid) {
              if (session.pendingGoalUpdate?.commandUuid === message.uuid) {
                session.pendingGoalUpdate.started = true;
              }
              const queued = findUnsettledTurn(message.uuid);
              if (queued) {
                // Only (re)activate if this isn't already the active turn — a
                // turn promoted early (e.g. by a result that preceded its echo)
                // must not have its accumulated usage reset by its own echo.
                if (session.activeTurn !== queued) {
                  if (session.activeTurn) {
                    // Hand off the previous turn. If a cancel is pending for it
                    // (its trailing idle hasn't arrived yet), settle it
                    // "cancelled" per the ACP contract rather than "end_turn" —
                    // otherwise a cancel followed quickly by the next prompt
                    // would report the cancelled turn as a normal completion.
                    if (session.cancelled) {
                      // The cancelled turn settles here, but the trailing idle
                      // its interrupt produces is still in flight — record the
                      // debt so that lagged idle is absorbed rather than read
                      // as the freshly-activated turn ending without a result
                      // (which would false-fail a healthy turn — issue #825).
                      // Counted for a DEFERRED turn too, even though its own
                      // result already recorded a debt that may still be
                      // outstanding: the interrupt can produce a trailer of
                      // its own, and over-counting is benign (absorbs one
                      // future idle) while under-counting risks the false
                      // fail this debt exists to prevent.
                      session.owedTrailingIdles++;
                      // Before activateTurn resets the accumulator, so the
                      // usage still belongs to the cancelled turn.
                      settleActive({ stopReason: "cancelled", usage: sessionUsage(session) });
                    } else if (isHeldOpen(session.activeTurn)) {
                      // A turn held open for its background subagents (see
                      // Turn.deferredSettle) hands off with the real outcome
                      // its result recorded, not a guessed end_turn — the
                      // user moving on must not block behind a long-running
                      // subagent, but it must not rewrite the stop reason
                      // either. Its trailing-idle debt stands and is absorbed
                      // when the drain idle eventually arrives.
                      settleActive(session.activeTurn.deferredSettle);
                    } else if (
                      isSteering(session.activeTurn) &&
                      session.activeTurn.steeredSettle !== undefined
                    ) {
                      // Same for a turn with an open steer (see
                      // Turn.steeredEchoes): the user moving on outranks the
                      // steered continuation, but its last result's stop reason
                      // stands. With no result yet it falls through to the
                      // end_turn hand-off below, owing nothing there.
                      //
                      // The steer lane normally pays for that result's trailing
                      // idle by settling on it; this hand-off settles instead,
                      // so count it here or it arrives un-owed against the fresh
                      // turn and false-fails it (issue #825). Harmless if it
                      // never comes: the debt absorbs one future idle.
                      session.owedTrailingIdles++;
                      settleActive(session.activeTurn.steeredSettle);
                    } else {
                      settleActive({ stopReason: "end_turn", usage: sessionUsage(session) });
                    }
                  }
                  // Unlike the no-result teardown lanes, this hand-off must
                  // NOT clear emittedAssistantText for a NON-held previous
                  // turn (a held one's settleActive above closes its own
                  // stretch): the echo can land
                  // mid-message, so deltas already streamed belong to the turn
                  // being activated — clearing would forget them and let its
                  // result re-emit the answer.
                  activateTurn(queued);
                }
                break;
              }
              if ("isReplay" in message && message.isReplay) {
                // A steered message's echo matches no turn (steer() creates
                // none), but it marks the steered cycle as running — how the idle
                // lane tells "the answer is still ahead" from "the turn is over"
                // (see Turn.steeredEchoes).
                if (isSteering(session.activeTurn)) {
                  session.activeTurn.steeredEchoes.delete(message.uuid);
                }
                // Unrelated replay (e.g. the echo of an already-settled turn).
                break;
              }
            }

            if (session.cancelled) {
              break;
            }

            // Synthetic assistant frames carry the CLI's local-command output.
            // On resume the SDK can replay a stale frame from an earlier compact
            // attempt after a later compaction completed. Scope the suppression
            // to the compaction lifecycle and the synthetic frame itself rather
            // than to the owning turn: one model turn may compact more than
            // once, and its real assistant response must still be delivered.
            if (
              message.type === "assistant" &&
              message.parent_tool_use_id === null &&
              message.message.model === "<synthetic>" &&
              compaction.hasDeliveredOutput
            ) {
              break;
            }

            // Snapshot the latest top-level assistant usage and model so the
            // next `result` can emit a usage_update tied to the right context
            // window. Subagent messages are excluded to keep the snapshot
            // aligned with what the user's current selection is producing.
            // Synthetic frames (spend limits, sign-in prompts, local command
            // output) are CLI-local banners with an all-zero usage object, not
            // model responses, so they must not erase the last real context
            // measurement. A turn with no real frame leaves the snapshot null
            // and the result emits no usage_update, keeping the client's value.
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              if (message.message.model !== "<synthetic>") {
                lastAssistantUsage = snapshotFromUsage(message.message.usage);
                lastAssistantTotalUsage = totalTokens(lastAssistantUsage);
                session.contextUsedTokens = lastAssistantTotalUsage;
              }
              lastAssistantWasUsageLimit = isSyntheticUsageLimitMessage(message.message);
              if (message.error || lastAssistantWasUsageLimit) {
                lastAssistantFailureTitle = assistantMessageText(message.message);
              }
              if (message.message.model && message.message.model !== "<synthetic>") {
                lastAssistantModel = message.message.model;
              }
              if (message.error) {
                lastAssistantError = message.error;
              }
              if (message.message.stop_reason === "refusal") {
                // Keep any explanation already seeded by a
                // `model_refusal_no_fallback` banner — the banner/frame
                // ordering is CLI-dependent, and a frame whose stop_details
                // was dropped (the case the banner backup exists for) must
                // not clobber the seed back to null.
                lastRefusalExplanation =
                  message.message.stop_details?.explanation ?? lastRefusalExplanation;
              }
            }

            // Strip <command-*>/<local-command-stdout> markers and render any
            // remaining prose. Skill bodies and built-in slash commands (e.g.
            // /usage, /status, /model) arrive wrapped in these tags; pure-marker
            // payloads (e.g. /compact's malformed output) strip to null and are
            // skipped. Mirrors the replay path at replaySessionHistory.
            if (
              message.message.role !== "system" &&
              typeof message.message.content === "string" &&
              message.message.content.includes("<local-command-stdout>")
            ) {
              const stripped = stripLocalCommandMetadata(message.message.content);
              if (typeof stripped === "string") {
                // The usual shape for a real `/usage`: the comment above names
                // it as one of the commands the CLI wraps in these markers.
                const usageMarkdown = await takeUsageMarkdown(stripped);
                if (usageMarkdown === null) {
                  break;
                }
                for (const notification of toAcpNotifications(
                  usageMarkdown ?? stripped,
                  message.message.role,
                  params.sessionId,
                  session.toolUseCache,
                  this.client,
                  this.logger,
                  {
                    clientCapabilities: this.clientCapabilities,
                    parentToolUseId: message.parent_tool_use_id,
                    cwd: session.cwd,
                    taskState: session.taskState,
                    messageId: messageIdForGrouping(message),
                  },
                )) {
                  await sendUpdate(notification);
                }
              } else {
                this.logger.log(message.message.content);
              }
              break;
            }

            if (
              typeof message.message.content === "string" &&
              message.message.content.includes("<local-command-stderr>")
            ) {
              this.logger.error(message.message.content);
              break;
            }
            // Skip these user messages for now, since they seem to just be messages we don't want in the feed
            if (
              message.type === "user" &&
              (typeof message.message.content === "string" ||
                (Array.isArray(message.message.content) &&
                  message.message.content.length === 1 &&
                  message.message.content[0].type === "text"))
            ) {
              break;
            }
            if (message.message.role === "system") {
              break;
            }

            if (message.type === "assistant" && isSyntheticLoginMessage(message.message)) {
              await failActiveWithSessionFailure(
                "auth_required",
                RequestError.authRequired(),
                assistantMessageText(message.message),
              );
              break;
            }

            // AIR receives this provider condition on the terminal prompt
            // response as a typed failure whose title is the exact assistant
            // error text captured above. Do not duplicate that text as an
            // ordinary assistant message; legacy clients retain the historical
            // transcript behavior.
            if (
              message.type === "assistant" &&
              message.parent_tool_use_id === null &&
              (message.error || isSyntheticUsageLimitMessage(message.message)) &&
              supportsAirSessionFailures(this.clientCapabilities)
            ) {
              break;
            }

            // Story 011: CLI >=2.1.280 answers `/usage` with a synthetic
            // assistant frame marked `local_command_run.command: "usage"`.
            // Published as ordinary text it also silenced the result branch,
            // the last place the render was requested, so the render never
            // ran. Claim it here: null publishes nothing, a render replaces
            // the frame, and undefined falls through to the frame's own text.
            if (
              message.type === "assistant" &&
              message.parent_tool_use_id === null &&
              message.message.model === "<synthetic>" &&
              syntheticLocalCommand(message) === "usage"
            ) {
              const original = assistantMessageText(message.message) ?? "";
              const usageMarkdown = await takeUsageMarkdown(original);
              if (usageMarkdown === null) {
                break;
              }
              if (usageMarkdown !== undefined) {
                for (const notification of toAcpNotifications(
                  usageMarkdown,
                  "assistant",
                  params.sessionId,
                  session.toolUseCache,
                  this.client,
                  this.logger,
                  {
                    clientCapabilities: this.clientCapabilities,
                    parentToolUseId: message.parent_tool_use_id,
                    cwd: session.cwd,
                    taskState: session.taskState,
                    messageId: messageIdForGrouping(message),
                  },
                )) {
                  await sendUpdate(notification);
                }
                break;
              }
            }

            let content: typeof message.message.content;
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              // Top-level assistant message: each text/thinking block may have
              // already been streamed live as deltas. Diff each against what
              // streamed (`streamedBlocks`, in document order) and forward only
              // the un-streamed remainder — nothing if it streamed in full (the
              // common case), the whole block if it never streamed (a
              // non-streaming gateway), or just the tail if the stream was cut
              // short mid-block. `streamPos` walks the streamed blocks in step
              // with the assembled text/thinking blocks; tool_use and other
              // blocks pass through untouched (their own `toolUseCache` collapses
              // the streamed/assembled pair) without advancing it.
              const blocks = message.message.content;
              const kept: typeof blocks = [];
              let streamPos = 0;
              for (const item of blocks) {
                if (item.type !== "text" && item.type !== "thinking") {
                  kept.push(item);
                  continue;
                }
                const full = item.type === "text" ? item.text : item.thinking;
                // Empty assembled blocks carry nothing (some gateways emit an
                // empty `thinking` block before the real text) — drop them.
                if (full.length === 0) {
                  continue;
                }
                // A streamed block of the same type whose accumulated text is a
                // prefix of this one was already (at least partly) delivered as
                // chunks; consume it and forward only what's left. A non-empty
                // streamed text is required so an empty/aborted streamed block
                // doesn't swallow the assembled copy.
                const streamed = streamedBlocks[streamPos];
                if (
                  streamed &&
                  streamed.type === item.type &&
                  streamed.text.length > 0 &&
                  full.startsWith(streamed.text)
                ) {
                  streamPos++;
                  const remainder = full.slice(streamed.text.length);
                  if (remainder.length === 0) {
                    continue;
                  }
                  // Overwrite in place with just the un-streamed tail (the
                  // assembled message isn't read again after this) so the block
                  // keeps its exact SDK type.
                  if (item.type === "text") {
                    item.text = remainder;
                  } else {
                    item.thinking = remainder;
                  }
                  kept.push(item);
                  continue;
                }
                // Not matched: never streamed (or the stream diverged from the
                // assembled text) — forward the block in full.
                kept.push(item);
              }
              content = kept;
              // Consumed: reset so the next message's blocks accumulate fresh and
              // the record stays bounded to the in-flight message.
              streamedBlocks.length = 0;
            } else if (
              message.type === "assistant" &&
              !(session.forwardSubagentText || supportsSubagentTranscript(this.clientCapabilities))
            ) {
              // Legacy clients don't understand nested transcripts. Keep the
              // historical behavior for them: subagent text/thinking remains
              // internal to the tool call instead of leaking into the top-level
              // feed. Capable clients opt into the branch above unchanged, with
              // `parentToolUseId` stamped by toAcpNotifications.
              content = message.message.content.filter(
                (item) => item.type !== "text" && item.type !== "thinking",
              );
            } else {
              content = message.message.content;
            }

            const acceptedPlanToolUseId = observeExitPlanToolResults(message, content, session);

            for (const notification of toAcpNotifications(
              content,
              message.message.role,
              params.sessionId,
              session.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                parentToolUseId: message.parent_tool_use_id,
                cwd: session.cwd,
                taskState: session.taskState,
                emittedToolCalls: session.emittedToolCalls,
                messageId: messageIdForGrouping(message),
                toolUseResult: message.type === "user" ? message.tool_use_result : undefined,
                // On the wire since CLI 2.1.216 but not in SDKUserMessage's
                // type, hence the cast. Validated by parseToolResultMeta.
                toolResultMeta:
                  message.type === "user"
                    ? (message as { tool_result_meta?: unknown }).tool_result_meta
                    : undefined,
              },
            )) {
              // sendUpdate records delivery. Subagent text/thinking is
              // filtered out of `content` above; blocks that do pass through
              // (e.g. a subagent image) carry the stamped parentToolUseId
              // meta and are excluded there.
              await sendUpdate(acceptedPlanToolResult(notification, acceptedPlanToolUseId));
            }
            break;
          }
          case "tool_progress": {
            // Not every beat reports under the id of a tool call the client has
            // seen: heartbeats derive `<tool_use_id>-heartbeat-<n>`, and the
            // `agent_api_retry` beats behind `subagentRetry` report under
            // `agent_<assistant_message_id>`. Forwarding those verbatim leaves the
            // client resolving an id it has never been told about (the same trap
            // `ensureToolCallEmitted` documents for #851). The SDK stamps
            // `parent_tool_use_id` with the executing tool's real id whenever the
            // beat doesn't carry one of its own, so fall back to it rather than
            // pattern-matching each synthetic id shape. Beats that do report a real
            // id (a subagent's `bash_progress`, whose parent is the spawning Agent
            // call) keep resolving to that id.
            const toolCallId = session.emittedToolCalls.has(message.tool_use_id)
              ? message.tool_use_id
              : message.parent_tool_use_id;
            // Ids leave `emittedToolCalls` at `tool_result`, so this also stops a
            // beat that races past completion from reopening a finished call.
            if (toolCallId === null || !session.emittedToolCalls.has(toolCallId)) {
              break;
            }
            await sendUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "in_progress",
                _meta: {
                  claudeCode: {
                    toolName: message.tool_name,
                    toolResponse: {
                      elapsedTimeSeconds: message.elapsed_time_seconds,
                      // For Agent/Task calls: the subagent's type, and — when
                      // the subagent is waiting out an API rate-limit retry —
                      // the SDK's retry counters (attempt, max_retries,
                      // retry_delay_ms, …), forwarded verbatim so clients can
                      // show why a spawn looks stalled.
                      ...(message.subagent_type !== undefined && {
                        subagentType: message.subagent_type,
                      }),
                      ...(message.subagent_retry !== undefined && {
                        subagentRetry: message.subagent_retry,
                      }),
                    },
                  },
                } satisfies ToolUpdateMeta,
              },
            });
            break;
          }
          case "rate_limit_event": {
            // A live event is the ONLY source of a MEASURED status — the report
            // read at the two borders can derive `allowed`/`allowed_warning`
            // from a utilization, but never `rejected`, which means "a request
            // was actually refused". Remember it so the derived windows that
            // follow cannot report the same window instance as less
            // constrained than it was measured (R1.6).
            //
            // Recorded OUTSIDE the emission guard below, and before it: the
            // memory is fed by the event itself, not by our ability to forward
            // it, and before the first assistant message of a session that
            // guard is false. The forwarding itself is untouched (R1.8) — it
            // still sends `rate_limit_info` verbatim, still on the same
            // notification shape, still only when a context total exists.
            this.accountUsageTracker(session).recordMeasured(message.rate_limit_info);
            if (lastAssistantTotalUsage !== null) {
              await sendUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "usage_update",
                  used: lastAssistantTotalUsage,
                  size: session.contextWindowSize,
                  _meta: { "_claude/rateLimit": message.rate_limit_info },
                },
              });
            }
            break;
          }
          case "conversation_reset": {
            // The SDK has switched to a fresh conversation, whose Task* IDs
            // and task store are independent of the previous transcript.
            // Clear both the in-memory snapshot and the client's visible plan
            // before any follow-up prompt can republish stale tasks.
            session.taskState.clear();
            // A compaction open on the OLD transcript can never terminate on
            // the new one: the uuid its tool call is keyed by belongs to a
            // conversation that no longer exists.
            await compaction.interrupt(params.sessionId);
            await this.publishTaskPlan(params.sessionId, session.taskState);
            // A reset mounts a fresh transcript (`new_conversation_id`), so our
            // cached title no longer describes the session: drop it and
            // re-evaluate at the next turn-end.
            session.titles.reset();
            break;
          }
          case "tool_use_summary":
          case "prompt_suggestion":
            break;
          case "auth_status":
            if (!message.isAuthenticating && message.error === undefined) {
              await sessionFailures.clear((failure) => failure.kind === "auth_required");
            }
            break;
          default:
            unreachable(message, this.logger);
            break;
        }
      }
      // `while (true)` only exits via the `done` return above or the catch
      // below, so there is no normal fall-through here.
    } catch (error) {
      // A superseded consumer's stale next() may reject when the lazy query
      // recreate closes the old query; the session's live turns and resources
      // belong to the replacement consumer, so exit without failing turns or
      // releasing anything.
      if (session.query !== myQuery) {
        return;
      }
      // The stream died, so no terminal for an open compaction is coming.
      // After the supersession guard, never before it: a superseded consumer
      // must not send anything on the live consumer's behalf.
      await compaction.interrupt(params.sessionId);
      // The query stream itself died (a transport/process error surfaced from
      // query.next()). Turn-level failures (auth, error results) are handled
      // inline via failActive and never reach here. Reject every in-flight turn;
      // if the process is gone, tear the session down so the client starts fresh.
      const message = error instanceof Error ? error.message : String(error);
      const processDied =
        error instanceof Error &&
        (message.includes("ProcessTransport") ||
          message.includes("terminated process") ||
          message.includes("process exited with") ||
          message.includes("process terminated by signal") ||
          message.includes("Failed to write to process stdin"));
      if (supportsAirSessionFailures(this.clientCapabilities) && session.activeTurn) {
        if (!isHeldOpen(session.activeTurn)) {
          await failActiveWithSessionFailure(
            "transport_lost",
            internalErrorForClient({ errorKind: "transport_lost" }),
          );
        } else {
          // The held turn keeps its recorded PromptResponse outcome, while the
          // exhausted Query makes the session independently unrecoverable.
          await publishSessionFailure("transport_lost", { turnScoped: false });
        }
      } else {
        await publishSessionFailure("transport_lost", { turnScoped: false });
      }
      // Either way the query iterator is finished and the consumer is exiting,
      // so release its resources via closeQueryStream (idempotent). A process
      // death is unrecoverable, so additionally evict the session so the client
      // starts fresh; other stream errors keep the session so prompt()/cancel()
      // can answer with a clear "session ended" error.
      if (processDied) {
        this.logger.error(`Session ${params.sessionId}: Claude Agent process died: ${message}`);
        failAllTurns(
          RequestError.internalError(
            undefined,
            "The Claude Agent process exited unexpectedly. Please start a new session.",
          ),
        );
        this.closeQueryStream(session);
        delete this.sessions[params.sessionId];
      } else {
        this.logger.error(`Session ${params.sessionId}: query stream error: ${message}`);
        failAllTurns(
          supportsAirSessionFailures(this.clientCapabilities)
            ? internalErrorForClient({ errorKind: "transport_lost" })
            : error,
        );
        this.closeQueryStream(session);
      }
    }
  }

  /** Route one orphaned command into the session's orphan-accounting lane:
   *  the per-uuid map on msg_lifecycle_v1 CLIs (drained by the command's own
   *  terminal lifecycle frame and the echo-less-result skip), the plain count
   *  elsewhere (the count lane can't express per-command states, so `state`
   *  only matters on the map lane). Both orphan-producing paths — cancel()'s
   *  queued-turn sweep and the consumer's force-cancel wedge path — must seed
   *  through here so the lane split stays a single mechanism.
   *
   *  Known window: `msgLifecycleV1` is only learnable from the stream's first
   *  `system`/init (the control-channel initialize carries no capabilities),
   *  so a cancel that beats that drain seeds the COUNT lane on a
   *  lifecycle-capable CLI — where command coalescing can leave the count
   *  stale by N-1 (the pre-map bug, confined to this sub-second window and
   *  still healed by the next activation's reset). Structural until the SDK
   *  exposes capabilities before the stream starts. */
  private trackOrphanCommand(
    session: Session,
    uuid: string,
    state: "pending" | "started" | "zombie",
  ): void {
    if (session.msgLifecycleV1) {
      session.orphanCommands ??= new Map();
      session.orphanCommands.set(uuid, state);
    } else {
      session.pendingOrphanResults = (session.pendingOrphanResults ?? 0) + 1;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.cancelTurns(params, { awaitInterrupt: true });
  }

  /** Cancel the session's turns and interrupt the SDK query. With
   *  `awaitInterrupt: false` the interrupt is sent, but its reply is not
   *  awaited. `teardownSession` uses that: it closes the query right after, and
   *  the reply can queue behind a slow control request, such as the background
   *  `getContextUsage` of a fresh session (upstream #1216). */
  private async cancelTurns(
    params: CancelNotification,
    options: { awaitInterrupt: boolean },
  ): Promise<void> {
    this.exitPlan.cancel(params.sessionId);
    const session = this.sessions[params.sessionId];
    if (!session) {
      return;
    }
    // A lazy Thinking recreate may be swapping the session's query right now;
    // join it (mirroring prompt()) so `interrupt()` below targets the live
    // replacement query instead of racing the old one's close — an interrupt
    // control request killed by that close would reject out of this
    // fire-and-forget notification. Safe: `recreateSessionQuery` never
    // rejects.
    if (session.queryRecreateInFlight) {
      await session.queryRecreateInFlight;
    }
    session.cancelled = true;
    // Every turn's structured `/usage` render is abandoned here — the queue
    // still holds the active turn at this point, so one sweep covers both.
    for (const turn of session.turnQueue ?? []) {
      turn.usageMarkdownAbort?.abort();
    }
    session.pendingExitPlanModeInterruption = undefined;
    session.pendingExitPlanContextReset = undefined;
    // The stream already ended (see closeQueryStream): every in-flight turn was
    // settled when it closed, and there is no live query to interrupt. Calling
    // query.interrupt() on a finished iterator could reject and surface from
    // this fire-and-forget notification, so there is nothing to do here.
    if (session.queryClosed) {
      return;
    }
    // A priority steer may still be queued in the SDK when cancellation
    // settles its owning turn. Its later echo matches no live turn, and its
    // result must be skipped rather than promoted onto the next prompt.
    if (isSteering(session.activeTurn)) {
      for (const uuid of session.activeTurn.steeredEchoes) {
        this.trackOrphanCommand(session, uuid, "pending");
      }
    }
    // Capture the orphan-accounting lane before anything can await: the
    // consumer latches msgLifecycleV1 when it drains the first system/init,
    // which can happen DURING the awaited interrupt() below — the receipt
    // reconciliation must act on the same lane the seeding used, or a
    // count-lane orphan would be left for the map-lane receipt path (which
    // never decrements the count) to miss.
    const lifecycleLane = session.msgLifecycleV1 === true;
    // Settle queued turns that haven't started yet (no echo seen) right away —
    // they have no in-flight SDK work to interrupt. The active turn is settled
    // by the consumer when it observes the interrupt's trailing idle (or via the
    // backstop below). Mirrors the old pendingMessages cancellation.
    const orphanedTurns: Turn[] = [];
    if (session.turnQueue) {
      for (const turn of session.turnQueue) {
        if (turn !== session.activeTurn && !turn.settled) {
          this.finishFileChangeAudit(session, turn, "cancelled");
          turn.settled = true;
          // Deliberately no `usage`: a queued turn never ran, so the session
          // accumulator (the active turn's tally) is not its spend.
          turn.resolve({ stopReason: "cancelled" });
          orphanedTurns.push(turn);
        }
      }
      // Each removed queued turn's user message was already pushed to the SDK,
      // which processes input FIFO and will still emit a result for it with no
      // user echo to match (0.3.246+ CLIs do stamp results with the
      // triggering send's user_message_uuid, which ensureActiveTurn uses as
      // an exact join when present). Track those so the consumer skips them
      // (see ensureActiveTurn) rather than misattributing them to the head.
      // msg_lifecycle_v1 CLIs get per-uuid tracking drained by the command's
      // own terminal lifecycle frame — exact under command coalescing, where
      // N queued commands fold into ONE turn emitting one result and a plain
      // count would go stale by N-1 and swallow a later echo-less result.
      // Older CLIs keep the count and its activation-time self-heal (they
      // never see lifecycle frames, so commandStarted/commandFinished stay
      // unset and every turn takes the plain-seed path below).
      for (const turn of orphanedTurns) {
        if (
          turn.commandFinished === "completed" ||
          turn.commandFinished === "discarded" ||
          turn.commandFinished === "refused"
        ) {
          // The command already finished SDK-side and its terminal frame was
          // consumed while the turn sat queued — nothing is left to skip, and
          // a seeded entry would never drain.
          continue;
        }
        if (turn.commandFinished === "cancelled") {
          // Terminal frame already consumed. Dispatched-then-aborted: the
          // dead turn's late result may still come — seed the zombie the
          // frame handler would have made — unless that result already
          // passed pre-cancel (commandResultSeen: e.g. the command folded
          // into the active turn and their shared result was attributed
          // there), in which case a zombie would be a phantom that swallows
          // an unrelated later result. Never dispatched: dropped, no result
          // coming, nothing to track.
          if (turn.commandStarted && !turn.commandResultSeen) {
            this.trackOrphanCommand(session, turn.promptUuid, "zombie");
          }
          continue;
        }
        if (turn.commandStarted && turn.commandResultSeen) {
          // Dispatched and its turn's result already passed; only its
          // terminal frame is outstanding, which no-ops with no entry.
          continue;
        }
        this.trackOrphanCommand(
          session,
          turn.promptUuid,
          turn.commandStarted ? "started" : "pending",
        );
      }
      session.turnQueue = session.turnQueue.filter(
        (turn) => turn === session.activeTurn && !turn.settled,
      );
    }

    // A deferred active turn (see Turn.deferredSettle) already has its
    // result — it is only held open for its background subagents, which the
    // interrupt below tears down. Settle it "cancelled" NOW: during the hold
    // the session is typically already in state idle (the CLI's trailer
    // fired at the result), so the interrupt may produce no fresh idle for
    // the consumer's cancelled-settle path to run on, and the cancel would
    // otherwise stall until the force-cancel backstop. Any outstanding
    // trailer debt is absorbed by the idle handler when its idle does come.
    // The turn's own usage snapshot is reported per the cancelled-usage
    // contract (issue #844).
    {
      const active = session.activeTurn;
      if (isHeldOpen(active)) {
        this.finishFileChangeAudit(session, active, "cancelled");
        active.settled = true;
        // Mirror settleActive's invariants (it is consumer-scoped and
        // unreachable from here): disarm the backstop — none should be
        // armed for a held turn, but a drift here must not leave a timer
        // firing on a settled turn — and drop the turn from the queue.
        disarmForceCancel(session);
        session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== active);
        session.activeTurn = null;
        // Settling a held turn closes its delivery stretch: any streamed
        // text since the last boundary was its followups', and left latched
        // it would suppress a following replayed turn's issue-#453 fallback.
        session.emittedAssistantText = false;
        // When the interrupt below pre-empts a live cycle — running, or
        // blocked on a permission request (requires_action, the #866 shape
        // users cancel out of) — it produces a trailer idle with no counted
        // result; with the hold's own trailer typically already absorbed,
        // that idle would be un-owed and could lag past the next prompt's
        // echo — read as the fresh turn ending without a result (issue #825
        // false-fail). Pre-count it unless the session sits idle: there the
        // interrupt emits nothing, and a debt that never drains would mask
        // one future #825 detection. (lastSessionState is last-CONSUMED, so
        // both stale reads exist and both are accepted one-cycle windows: a
        // running transition still in the backlog reads as stale idle and
        // under-counts — that false-fail additionally needs the trailer to
        // lag past the next echo — while a cycle already completed into the
        // backlog reads as stale non-idle and over-counts, masking one
        // future #825 detection. Undefined — no state event consumed —
        // pre-counts; that only occurs on CLIs whose missing idle events
        // also disable the detector the debt could mask.)
        if (session.lastSessionState !== "idle") {
          session.owedTrailingIdles++;
        }
        active.resolve({ stopReason: "cancelled", usage: active.deferredSettle.usage });
      }
    }

    // A steered active turn (see Turn.steeredEchoes) settles "cancelled" in the
    // consumer at the interrupt's trailing idle, like any live turn. But the
    // steer lane pays for its last result's trailer by settling on it, which
    // this cancel pre-empts, so count that trailer here or it arrives un-owed
    // against the next prompt and false-fails it (issue #825). Over-counting
    // when only one trailer comes absorbs a future idle.
    if (isSteering(session.activeTurn) && session.activeTurn.steeredSettle !== undefined) {
      session.owedTrailingIdles++;
    }

    // Arm a backstop before interrupting: if a turn is actively consuming the
    // query and interrupt() doesn't make the SDK yield (e.g. a wedged TaskOutput
    // block — issue #680), force the consumer to settle the active turn
    // "cancelled" after the floor elapses so the pending session/prompt still
    // resolves per the ACP cancellation contract instead of hanging forever. The
    // consumer clears this timer when interrupt() works and it settles through
    // the normal idle path, so on healthy cancels it is armed but never fires.
    //
    // Arm at most once per turn: the floor is an absolute ceiling from the first
    // cancel, so a client that re-sends cancel (each call still retries
    // interrupt() below) can't keep pushing the deadline out.
    if (
      session.activeTurn &&
      session.cancelController &&
      !session.cancelController.signal.aborted &&
      !session.forceCancelTimer
    ) {
      const cancelController = session.cancelController;
      session.forceCancelTimer = setTimeout(() => {
        this.logger.error(
          `Session ${params.sessionId}: cancel floor elapsed without the SDK yielding; forcing "cancelled". The underlying query may still be wedged — a new session may be required.`,
        );
        cancelController.abort();
      }, this.forceCancelGraceMs);
    }

    const interrupt = session.query.interrupt();
    if (!options.awaitInterrupt) {
      // The caller closes the query next, which rejects the pending reply.
      // The receipt only adjusts orphan accounting of a live session.
      Promise.resolve(interrupt).catch(() => {});
      return;
    }
    const receipt = await interrupt;
    // On CLIs advertising `interrupt_receipt_v1`, the receipt's `still_queued`
    // lists exactly which queued messages survive the interrupt and will still
    // run. An orphaned turn whose uuid is absent was dropped by the interrupt
    // and will never emit a result — uncount it now instead of leaving a stale
    // skip that activateTurn's reset only clears once a later live ECHO
    // arrives: an echo-less result in between (a local-only command like
    // `/context`) would be wrongly swallowed by the leftover count. Subtracting
    // a count (rather than tracking uuids) stays race-safe against the
    // consumer draining concurrently: dropped uuids produce no results, so the
    // consumer's decrements only ever consume the still-queued share. Unknown
    // uuids in the receipt (internally-enqueued messages) are ignored, per its
    // contract. Older CLIs resolve `undefined` (guard the FIELD, not just the
    // receipt, so a bare `{}` success from a gateway can't read as "everything
    // was dropped") — keep the count-everything behavior and its
    // activation-time self-heal.
    if (Array.isArray(receipt?.still_queued) && orphanedTurns.length > 0) {
      const stillQueued = new Set(receipt.still_queued);
      if (lifecycleLane) {
        // Lifecycle lane: forget dropped orphans by uuid. Only entries still
        // "pending" — an orphan absent from `still_queued` because it was
        // DISPATCHED before the interrupt (not dropped) has usually been
        // promoted to "started" by its lifecycle frame by now, and its own
        // terminal frame must stay in charge of its fate. (If that frame is
        // still in the consumer's backlog we mis-forget — the same exposure
        // the count lane has always had for a dropped-then-run command.)
        // Mostly redundant with the "cancelled"-frame removal, but a receipt
        // survives paths where that frame was never emitted.
        for (const turn of orphanedTurns) {
          if (
            !stillQueued.has(turn.promptUuid) &&
            session.orphanCommands?.get(turn.promptUuid) === "pending"
          ) {
            session.orphanCommands.delete(turn.promptUuid);
          }
        }
      } else {
        const dropped = orphanedTurns.filter((turn) => !stillQueued.has(turn.promptUuid)).length;
        if (dropped > 0) {
          session.pendingOrphanResults = Math.max(0, (session.pendingOrphanResults ?? 0) - dropped);
        }
      }
    }
  }

  /** Mark a session's SDK query stream as permanently ended and release the
   *  resources tied to it: drop the consumer handle, dispose the settings
   *  watchers, end the input stream, and close the query (which terminates the
   *  subprocess). The query iterator is not revivable, so `prompt()`/`cancel()`
   *  consult `queryClosed` and fail/short-circuit instead of acting on a dead
   *  stream. Idempotent (guarded by `queryClosed`), so the consumer's done/error
   *  paths and a later `teardownSession` can all call it without double-releasing.
   *
   *  Deliberately does NOT abort `session.abortController`: that controller may be
   *  CLIENT-supplied (`_meta.claudeCode.options.abortController`) and reused, so
   *  aborting it on a spontaneous stream end would cancel the client's own work
   *  or make a sibling session born aborted. `query.close()` already terminates
   *  the subprocess; aborting the signal belongs in `teardownSession` (explicit
   *  destroy), not here. Also does NOT remove the session from the map — that is
   *  `teardownSession`'s job — so prompt() can still answer with a clear "session
   *  ended" error after an unexpected stream close. The leftover session object
   *  is a lightweight husk (its heavy resources are released here) and is evicted
   *  on the next closeSession/deleteSession or when the connection's `dispose()`
   *  runs. */
  private closeQueryStream(session: Session): void {
    if (session.queryClosed) {
      return;
    }
    session.queryClosed = true;
    session.consumer = undefined;
    // Every teardown path reaches this method, which is why the quota timer is
    // cleared here and nowhere else: a `clearInterval` repeated at each of the
    // four call sites is one merge away from missing the fifth. A session whose
    // stream is closed cannot answer the usage control request anyway, so a
    // surviving timer would only log a failure a minute, forever.
    if (session.accountUsageTimer) {
      clearInterval(session.accountUsageTimer);
      session.accountUsageTimer = undefined;
    }
    session.settingsManager.dispose();
    session.input.end();
    session.query.close();
  }

  /** Cleanly tear down a session: cancel in-flight work, release stream
   *  resources, and remove it from the session map. */
  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    try {
      await this.cancelTurns({ sessionId }, { awaitInterrupt: false });
    } catch (error) {
      this.logger.error(`Session ${sessionId}: cancellation failed during teardown`, error);
    }
    // cancel() arms the force-cancel floor and interrupts gracefully, but a
    // wedged consumer only wakes when `cancelController` aborts — closeQueryStream
    // below doesn't touch it. Since we're tearing the session down anyway, wake
    // the consumer now so the in-flight prompt() resolves immediately instead of
    // after the floor, and clear the timer so it can't outlive the deleted
    // session (it isn't unref'd and would otherwise keep the event loop alive
    // until it fires).
    disarmForceCancel(session);
    session.cancelController?.abort();
    this.closeQueryStream(session);
    // Abort the SDK abort signal only on explicit destroy. closeQueryStream
    // leaves it alone (it may be a client-owned controller — see its doc), but
    // here the client has asked us to close the session, so signalling abort is
    // appropriate; query.close() above has already torn the subprocess down.
    session.abortController.abort();
    delete this.sessions[sessionId];
  }

  /** Tear down all active sessions. Called when the ACP connection closes. */
  async dispose(): Promise<void> {
    await Promise.all(Object.keys(this.sessions).map((id) => this.teardownSession(id)));
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    await this.teardownSession(params.sessionId);
    return {};
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    // Tear down any active in-memory state first so the on-disk file isn't
    // recreated by an outstanding query writing to it.
    if (this.sessions[params.sessionId]) {
      await this.teardownSession(params.sessionId);
    }
    await deleteSession(params.sessionId);
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    // A lazy Thinking recreate may be swapping the session's query right now;
    // join it (mirroring prompt()) so `setPermissionMode` below lands on the
    // replacement query after cutover instead of an about-to-close one — and
    // so the mode isn't silently dropped from a query built from the
    // pre-await state snapshot. Safe: `recreateSessionQuery` never rejects.
    // The session-not-found and SESSION_ENDED guards the fork inlined here now
    // live in `SessionModeManager.requireOpenSession`, which raises the same
    // errors, so they are not duplicated in front of the delegation below.
    const session = this.sessions[params.sessionId];
    if (session?.queryRecreateInFlight) {
      await session.queryRecreateInFlight;
    }
    return this.sessionModes.setSessionMode(params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // A lazy Thinking recreate may be swapping the session's query right now;
    // join it (mirroring prompt()) so the model/mode/effort/fast SDK calls
    // below land on the replacement query after cutover instead of an
    // about-to-close one — and so their state updates aren't silently
    // dropped from a query built from the pre-await state snapshot. The
    // THINKING branch only arms the pending flag, so joining first is
    // harmless for it. Safe: `recreateSessionQuery` never rejects.
    if (session.queryRecreateInFlight) {
      await session.queryRecreateInFlight;
    }
    // The SDK query stream already ended (see closeQueryStream); the session is
    // a husk and the `query.setModel`/`setPermissionMode`/`applyFlagSettings`
    // calls this triggers would act on a closed query. Fail with the same clear
    // message prompt()/cancel() give for a dead stream.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    const option = session.configOptions.find((o) => o.id === params.configId);
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`);
    }

    // Fast mode carries a boolean value (for Clients that opted into boolean
    // config options) or the "on"/"off" select fallback, so it bypasses the
    // string-only validation the select-style options below rely on.
    if (params.configId === FAST_MODE_CONFIG_ID) {
      await this.applyFastMode(session, resolveFastModeEnabled(params));
      return { configOptions: session.configOptions };
    }

    // The Thinking toggle only records the session's intent — the SDK query
    // swap is deferred to the next prompt() start (lazy recreate, sub-task
    // 1.3), so there is no SDK call to fail here and the config option is
    // refreshed and acked immediately, mirroring Fast mode. An unrecognized
    // value deliberately falls through to the shared invalid-option-value
    // validation below rather than growing a bespoke error shape.
    if (params.configId === THINKING_CONFIG_ID) {
      const enabled = resolveThinkingSelection(params.value);
      if (enabled !== null) {
        session.thinkingEnabled = enabled;
        session.pendingQueryRecreate = true;
        session.configOptions = session.configOptions.map((o) =>
          o.id === THINKING_CONFIG_ID ? createThinkingConfigOption(enabled) : o,
        );
        return { configOptions: session.configOptions };
      }
    }

    if (typeof params.value !== "string") {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    const allValues =
      "options" in option && Array.isArray(option.options)
        ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
        : [];
    let validValue = allValues.find((o) => o.value === params.value);

    // The option's reported currentValue is always a valid target, even when
    // it has no options entry: a session running an out-of-picker model
    // (resumed onto an allowlist-excluded model, or a refusal fallback)
    // reports a currentValue that isn't selectable, and a client
    // round-tripping it must not get "Invalid value". It flows through the
    // normal apply path below — re-asserting an already-current value is
    // harmless and can repair SDK drift.
    if (!validValue && option.currentValue === params.value) {
      validValue = { value: params.value, name: params.value };
    }

    // For model options, fall back to resolveModelPreference when the exact
    // value doesn't match.  This lets callers use human-friendly aliases like
    // "opus" or "sonnet" instead of full model IDs like "claude-opus-4-6".
    // Resolve against session.modelInfos first: those entries carry
    // `resolvedModel`, so a full model id (in either hint spelling) lands on
    // the right row via the exact tier instead of a fuzzier one picking a
    // same-family sibling from a different context lane. The options-derived
    // list (which never carries `resolvedModel`) remains as a fallback for
    // resolutions that don't map back onto a selectable option (e.g. a fuzzy
    // hit on an out-of-picker verbatim entry).
    // No deprecation filter here (R4.2, no double work): this list is rebuilt
    // from the RENDERED option rows, which flow from the already-filtered
    // picker list (`hideDeprecatedModels` at every session-creation branch) —
    // so hidden rows are not selectable via aliases either.
    if (!validValue && params.configId === MODEL_CONFIG_ID) {
      const toOptionValue = (resolved: ModelInfo | null) =>
        resolved ? allValues.find((o) => o.value === resolved.value) : undefined;
      validValue = toOptionValue(resolveModelPreference(session.modelInfos, params.value));
      if (!validValue) {
        const optionInfos: ModelInfo[] = allValues.map((o) => ({
          value: o.value,
          displayName: o.name,
          description: o.description ?? "",
        }));
        validValue = toOptionValue(resolveModelPreference(optionInfos, params.value));
      }
    }

    if (!validValue) {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    // Use the canonical option value so downstream code always receives the
    // model ID rather than the caller-supplied alias.
    const resolvedValue = validValue.value;

    let effectiveValue = resolvedValue;
    if (params.configId === MODE_CONFIG_ID) {
      effectiveValue = await this.sessionModes.selectMode(params.sessionId, resolvedValue);
      await this.sessionModes.publishCurrent(params.sessionId, effectiveValue);
    } else if (params.configId === MODEL_CONFIG_ID) {
      await this.sessions[params.sessionId].query.setModel(resolvedValue);
    }
    // Effort SDK sync is handled inside applyConfigOptionValue so that direct
    // effort changes and effort changes induced by a model switch go through
    // the same path.

    await this.applyConfigOptionValue(params.sessionId, session, params.configId, effectiveValue);

    return { configOptions: session.configOptions };
  }

  private async replaySessionHistory(sessionId: string): Promise<void> {
    const toolUseCache: ToolUseCache = {};
    // getSessionMessages stops at the last compaction boundary; put the history
    // before it back, so a reopened compacted thread scrolls to its first prompt.
    const messages = await withPrecompactHistory(
      sessionId,
      await getSessionMessages(sessionId),
      CLAUDE_CONFIG_DIR,
    );
    const session = this.sessions[sessionId];
    const forwardSubagentText =
      session?.forwardSubagentText ?? supportsSubagentTranscript(this.clientCapabilities);
    const supportsTypedFailures = supportsAirSessionFailures(this.clientCapabilities);
    const activeUsageLimit = supportsTypedFailures ? activeUsageLimitMessage(messages) : undefined;
    const sessionFailures =
      session && supportsTypedFailures
        ? new SessionFailureController({
            sessionId,
            state: session.sessionFailureState,
            capabilities: this.clientCapabilities,
            isCurrent: () => this.sessions[sessionId] === session,
            sendUpdate: (notification) => this.client.sessionUpdate(notification),
            logger: this.logger,
          })
        : undefined;
    let replayTurnId: string | undefined;
    // Stop-hook additionalContext is persisted as an internal user message.
    // Once that marker (or the internal tool itself) appears, suppress the
    // whole audit exchange until its tool result. This also hides a disobedient
    // model's separate prose message, while an ordinary next user prompt safely
    // ends an incomplete audit lane.
    let replayingFileChangeAudit = false;
    const replayFileChangeAuditToolUseIds = new Set<string>();

    for (const message of messages) {
      if (isReplayHiddenMetaMessage(message)) {
        continue;
      }
      if (
        message.type === "user" &&
        message.parent_tool_use_id === null &&
        typeof message.uuid === "string" &&
        message.uuid.length > 0
      ) {
        replayTurnId = message.uuid;
      }
      // Backfill the ACP messageId -> SDK uuid mapping for messages we didn't
      // observe live (resumed/loaded sessions), so rewind/resume can translate
      // a client-supplied id without an extra getSessionMessages read. Not read
      // yet (see Session.messageIdToUuid).
      const replayMessageId = messageIdForGrouping(message);
      const replaySession = this.sessions[sessionId];
      if (replaySession && replayMessageId && message.uuid) {
        replaySession.messageIdToUuid.set(replayMessageId, message.uuid);
      }

      // The live prompt loop converts the synthetic "Please run /login"
      // assistant message into an authRequired error instead of showing its
      // TUI-specific text; skip it on replay too (issue #863).
      if (message.type === "assistant" && isSyntheticLoginMessage(message.message)) {
        continue;
      }

      // Capable clients saw every synthetic usage-limit message as a typed
      // failure live, so replay it at the same transcript position. The
      // preceding persisted user uuid is the live prompt uuid and therefore
      // recreates the same incident identity. Only the latest limit not
      // followed by a real model answer remains active internally.
      if (
        sessionFailures &&
        message.type === "assistant" &&
        message.parent_tool_use_id === null &&
        isSyntheticUsageLimitMessage(message.message)
      ) {
        const title = assistantMessageText(message.message);
        if (title) {
          await sessionFailures.restore(
            replayTurnId ? `${replayTurnId}:error` : `${sessionId}:history-error:${message.uuid}`,
            "quota_exhausted",
            title,
            message.uuid === activeUsageLimit?.uuid,
          );
        }
        continue;
      }

      // @ts-expect-error - untyped in SDK but we handle all of these
      let content: unknown = message.message.content;
      const parentToolUseId = parentToolUseIdOf(message);
      if (message.type === "assistant" && parentToolUseId && !forwardSubagentText) {
        content = stripSubagentTextAndThinking(content);
      }
      // @ts-expect-error - untyped in SDK but we handle all of these
      if (message.message.role === "user") {
        content = stripLocalCommandMetadata(content);
        if (content === null) continue;
      }

      const auditBlocks = Array.isArray(content)
        ? content.filter(
            (block): block is Record<string, unknown> =>
              typeof block === "object" && block !== null,
          )
        : [];
      const hasFileChangeAuditMarker =
        (typeof content === "string" && containsFileChangeAuditMarker(content)) ||
        auditBlocks.some(
          (block) => typeof block.text === "string" && containsFileChangeAuditMarker(block.text),
        );
      const fileChangeAuditToolUseIds = auditBlocks.flatMap((block) =>
        (block.type === "tool_use" ||
          block.type === "server_tool_use" ||
          block.type === "mcp_tool_use") &&
        typeof block.name === "string" &&
        isFileChangeAuditTool(block.name) &&
        typeof block.id === "string"
          ? [block.id]
          : [],
      );
      const replayMessageRole = (message as unknown as { message?: { role?: unknown } }).message
        ?.role;
      if (hasFileChangeAuditMarker || fileChangeAuditToolUseIds.length > 0) {
        replayingFileChangeAudit = true;
        for (const toolUseId of fileChangeAuditToolUseIds) {
          replayFileChangeAuditToolUseIds.add(toolUseId);
        }
        continue;
      }
      if (replayingFileChangeAudit) {
        const toolResultIds = auditBlocks.flatMap((block) =>
          (block.type === "tool_result" || block.type === "mcp_tool_result") &&
          typeof block.tool_use_id === "string"
            ? [block.tool_use_id]
            : [],
        );
        let completedReport = false;
        for (const toolUseId of toolResultIds) {
          if (replayFileChangeAuditToolUseIds.delete(toolUseId)) completedReport = true;
        }
        if (completedReport && replayFileChangeAuditToolUseIds.size === 0) {
          replayingFileChangeAudit = false;
          continue;
        }
        // A denied attempt to call another tool is still part of the hidden
        // lane. Its result must not end replay suppression before the report.
        if (toolResultIds.length > 0) {
          continue;
        }
        // The next real user prompt is already represented by the client and
        // starts a new turn; do not let a missing audit result hide it or the
        // rest of the replay.
        if (replayMessageRole === "user") {
          replayingFileChangeAudit = false;
        } else {
          continue;
        }
      }

      for (const notification of toAcpNotifications(
        // @ts-expect-error - untyped in SDK but we handle all of these
        content,
        // @ts-expect-error - untyped in SDK but we handle all of these
        message.message.role,
        sessionId,
        toolUseCache,
        this.client,
        this.logger,
        {
          registerHooks: false,
          clientCapabilities: this.clientCapabilities,
          cwd: this.sessions[sessionId]?.cwd,
          taskState: this.sessions[sessionId]?.taskState,
          messageId: replayMessageId,
          parentToolUseId,
        },
      )) {
        await this.client.sessionUpdate(notification);
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  /** Mark a client request as blocking on user input for exactly the lifetime
   *  of its promise. Steering consults this session-local count synchronously,
   *  so a message arriving while any permission/elicitation card is open uses
   *  non-interrupting SDK delivery. The decrement sits in `finally` (and is
   *  clamped at zero), so accepted, declined, cancelled, aborted and failed
   *  requests all settle the count — a request that ends by throwing must not
   *  pin the session at `later` for the rest of its life. */
  private async withPendingUserInput<T>(sessionId: string, request: () => Promise<T>): Promise<T> {
    const session = this.sessions[sessionId];
    if (!session) return request();
    session.pendingUserInputCount = (session.pendingUserInputCount ?? 0) + 1;
    try {
      return await request();
    } finally {
      // Decrement the SAME object the increment ran on, not a fresh
      // `this.sessions[sessionId]` lookup: a session replaced mid-request would
      // otherwise be charged for a request it never made. Both the clamp and
      // the `?? 1` land such a replacement's own count on 0, never below it.
      session.pendingUserInputCount = Math.max(0, (session.pendingUserInputCount ?? 1) - 1);
    }
  }

  /** Forward a permission request to the client, wiring the tool call's
   *  `signal` through as a `cancellationSignal`. When the turn is cancelled
   *  while the client's prompt is still open the signal aborts, the SDK sends
   *  `$/cancel_request`, and our local abort race settles even if the client
   *  ignores it. A `cancelled` outcome, request rejection, and local abort all
   *  surface the same "Tool use aborted" the callers already expect. */
  private async requestPermissionFromClient(
    params: RequestPermissionRequest,
    toolName: string,
    signal: AbortSignal,
    parentToolUseId?: string,
  ): Promise<RequestPermissionResponse> {
    if (signal.aborted) throw new Error("Tool use aborted");
    // The SDK may invoke `canUseTool` (and therefore this permission request)
    // before the assistant message's tool_use block streams to us. Some ACP clients
    // expect the `tool_call` a permission request references to already exist,
    // so emit it now if it hasn't been sent yet. The streamed tool_use chunk
    // later refines it with a `tool_call_update` rather than emitting a
    // duplicate (see `emittedToolCalls` in `toAcpNotifications`).
    await this.ensureToolCallEmitted(
      params.sessionId,
      toolName,
      params.toolCall.toolCallId,
      params.toolCall.rawInput,
      parentToolUseId,
      signal,
    );
    if (signal.aborted) throw new Error("Tool use aborted");

    // Do not rely on every ACP client settling requestPermission after the
    // cancellation signal. The local race guarantees that Claude's tool call
    // is released even when an older or broken client ignores $/cancel_request.
    try {
      return await this.withPendingUserInput(params.sessionId, () =>
        raceWithAbort(this.client.requestPermission(params, signal), signal),
      );
    } catch (error) {
      if (signal.aborted) {
        throw new Error("Tool use aborted", { cause: error });
      }
      throw error;
    }
  }

  /** Emit the `tool_call` a permission request references if it hasn't been sent
   *  yet, so the client has the tool call before being asked to approve it. The
   *  matching streamed tool_use chunk later refines it with a `tool_call_update`
   *  instead of emitting a duplicate (see `emittedToolCalls`). Built via the same
   *  `toolCallNotification` helper as the streamed path so the two are identical.
   *  Tools the stream renders as a plan (TodoWrite) or suppresses (Task*) are
   *  emitted too: a permission request referencing a tool call the client has
   *  never seen can trip strict clients (issue #851), so the reference must
   *  always resolve. Since the streamed path never completes those calls, they
   *  are resolved at tool_result time instead (see `toAcpNotifications`).
   *  `parentToolUseId` attributes a subagent's tool call to the Agent/Task call
   *  that spawned it, matching the streamed path's `_meta`. */
  private async ensureToolCallEmitted(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    toolInput: unknown,
    parentToolUseId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    if (session.emittedToolCalls.has(toolCallId)) {
      return;
    }
    session.emittedToolCalls.add(toolCallId);
    const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
    const update = toolCallNotification(
      { id: toolCallId, name: toolName, input: toolInput },
      toolInput,
      supportsTerminalOutput,
      session.cwd,
    );
    if (parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId,
        },
      };
    }
    try {
      const emission = this.client.sessionUpdate({ sessionId, update });
      await (signal ? raceWithAbort(emission, signal) : emission);
    } catch (error) {
      // The set is also the de-duplication guard for the later streamed
      // tool_use. Keep it truthful: if emission failed, that path must still
      // be allowed to publish the tool call instead of refining a phantom one.
      session.emittedToolCalls.delete(toolCallId);
      throw error;
    }
  }

  canUseTool(sessionId: string): CanUseTool {
    return async (
      toolName,
      toolInput,
      {
        signal,
        suggestions,
        toolUseID,
        agentID,
        matchedAskRule,
        blockedPath,
        decisionReason,
        title,
        displayName,
        description,
        defaultToNo,
        suppressAlwaysAllowRule,
      },
    ) => {
      const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
      const session = this.sessions[sessionId];
      if (!session) {
        return {
          behavior: "deny",
          message: "Session not found",
        };
      }

      const fileChangeAudit = session.activeTurn?.fileChangeAudit;
      if (isFileChangeAuditReportPhase(fileChangeAudit)) {
        // The hidden continuation is an audit-only lane: it may submit the
        // wrapper-owned report, but it must not run another command after the
        // user-visible answer has already completed.
        if (isFileChangeAuditTool(toolName) && fileChangeAudit?.phase === "collecting") {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message: "Only the internal file-change report is allowed during the audit.",
        };
      }
      // The tool is intentionally unusable outside a negotiated audit turn.
      if (isFileChangeAuditTool(toolName)) {
        return {
          behavior: "deny",
          message: "No file-change report was requested for this turn.",
        };
      }

      // When the tool call originates inside a subagent, attribute the eagerly
      // emitted tool_call (and the permission request itself) to the Agent/Task
      // tool call that spawned the subagent, mirroring the streamed subagent
      // path's `_meta.claudeCode.parentToolUseId` (see `liveBackgroundTasks`).
      const parentToolUseId = agentID
        ? session.liveBackgroundTasks.get(agentID)?.parentToolUseId
        : undefined;
      if (agentID && !parentToolUseId) {
        // The attribution rests on an undocumented SDK invariant
        // (task_started.task_id === canUseTool's agentID for subagent tasks;
        // verified against the bundled CLI). Should an SDK bump break it — or
        // the consumer lose the race with task_started — the lookup misses and
        // the request goes out unattributed; log it so the regression is
        // observable rather than silent.
        this.logger.log(
          `[claude-agent-acp] No parent tool_use recorded for subagent ${agentID}; ` +
            `sending the ${toolName} permission request unattributed`,
        );
      }

      // AskUserQuestion is surfaced to us as a normal permission check (the SDK
      // routes it through canUseTool whenever a callback is registered, rather
      // than the interactive dialog). Present it as an ACP form elicitation and
      // feed the answers back as updatedInput for the tool's own call() to read.
      if (toolName === "AskUserQuestion" && this.clientCapabilities?.elicitation?.form) {
        // Like permission requests, the elicitation references this toolUseID, so
        // make sure the tool_call has surfaced to the client before we send it.
        await this.ensureToolCallEmitted(
          sessionId,
          toolName,
          toolUseID,
          toolInput,
          parentToolUseId,
          signal,
        );
        return this.handleAskUserQuestion(sessionId, toolInput, toolUseID, signal);
      }

      // Do not auto-allow here based on the session's advertised mode. Claude
      // Code applies bypassPermissions before invoking canUseTool; a request
      // that still reaches this callback is deliberately bypass-immune (for
      // example a safety check, a tool requiring user interaction, or an
      // explicit ask rule). Re-applying bypass in the host would erase that
      // provider safety decision.

      // No persistent "always allow" option when the user's own ask rule forced
      // the prompt, or when the CLI says the rule it would write grants more
      // than this ask's own action (`suppressAlwaysAllowRule`, SDK 0.3.268+ --
      // set on its safety-check asks, e.g. delete-class Bash rulings and
      // Artifact publishes).
      const noPersistentRule = matchedAskRule !== undefined || suppressAlwaysAllowRule === true;
      const durableChangeSet = normalizeDurablePermissionChangeSet(suggestions, noPersistentRule);
      const presentation = buildClaudePermissionPresentation({
        toolName,
        input: toolInput,
        toolUseID,
        cwd: session.cwd,
        supportsTerminalOutput,
        blockedPath,
        title,
        displayName,
        description,
        decisionReason,
        defaultToNo,
      });

      if (parentToolUseId) {
        presentation.toolCall._meta = {
          claudeCode: { toolName, parentToolUseId },
        };
      }

      const permissionOptions = buildClaudePermissionOptions({
        toolName,
        displayName,
        input: toolInput,
        cwd: session.cwd,
        durableChangeSet,
        allowPersistentOptions: !noPersistentRule,
        defaultToNo,
        availableModes: this.sessionModes.availableModeIds(session.modes),
        prePlanMode: session.prePlanMode,
        contextUsedPercent:
          session.contextUsedTokens === undefined || session.contextWindowSize <= 0
            ? undefined
            : Math.max(
                0,
                Math.min(
                  100,
                  Math.round((session.contextUsedTokens / session.contextWindowSize) * 100),
                ),
              ),
      });

      const response = await this.requestPermissionFromClient(
        {
          ...presentation,
          options: permissionOptions,
          sessionId,
        },
        toolName,
        signal,
        parentToolUseId,
      );
      if (signal.aborted) throw new Error("Tool use aborted");
      const decodedPermission = decodeClaudePermissionResponse(
        response,
        toolName,
        toolInput,
        toolUseID,
        permissionOptions,
        durableChangeSet,
      );
      let permissionResult = decodedPermission.permissionResult;
      const autoFallback = this.sessionModes.applyPermissionFallback(session, permissionResult);
      permissionResult = autoFallback.permissionResult;
      if (autoFallback.fallbackApplied) {
        await this.sessionModes.publishFallbackWarning(sessionId, session);
      }
      if (toolName === "ExitPlanMode" && permissionResult.behavior === "allow") {
        const modeUpdate = permissionResult.updatedPermissions?.find(
          (update) => update.type === "setMode" && update.destination === "session",
        );
        if (modeUpdate?.type === "setMode") {
          try {
            await this.sessionModes.publishCurrent(sessionId, modeUpdate.mode);
            await this.updateConfigOption(sessionId, MODE_CONFIG_ID, modeUpdate.mode);
          } catch (error) {
            // The user already approved the plan; a failed notification must not
            // turn that approval into a failed permission request.
            this.logger.error("Failed to publish mode after plan approval:", error);
          }
        }
      }
      const clearContextMode = decodedPermission.contextResetMode
        ? this.sessionModes.effectiveMode(session, decodedPermission.contextResetMode)
        : undefined;
      if (toolName === "ExitPlanMode" && clearContextMode) {
        const plan = typeof toolInput.plan === "string" ? toolInput.plan.trim() : "";
        if (!plan) throw new Error("ExitPlanMode clear-context selection requires a plan");
        session.pendingExitPlanContextReset = {
          toolUseId: toolUseID,
          plan,
          mode: clearContextMode,
        };
      }
      if (
        toolName === "ExitPlanMode" &&
        permissionResult.behavior === "deny" &&
        permissionResult.interrupt === true
      ) {
        session.pendingExitPlanModeInterruption = {
          toolUseId: toolUseID,
          toolResultSeen: false,
        };
      }
      return permissionResult;
    };
  }

  /**
   * Handle elicitation requests that originate from MCP servers by forwarding
   * them to the client over ACP. Modes the client did not advertise (or
   * requests we can't represent) are declined.
   */
  private handleMcpElicitation(sessionId: string, support: ElicitationSupport): OnElicitation {
    return async (request, { signal }) => {
      const isUrl = request.mode === "url";
      if ((isUrl && !support.url) || (!isUrl && !support.form)) {
        return { action: "decline" };
      }

      const createRequest = mcpElicitationToCreateRequest(request, sessionId);
      if (!createRequest) {
        return { action: "decline" };
      }

      try {
        const response = await this.withPendingUserInput(sessionId, () =>
          this.client.unstable_createElicitation(createRequest, signal),
        );
        if (signal.aborted) {
          return { action: "cancel" };
        }
        return createElicitationResponseToElicitResult(response);
      } catch (error) {
        // A cancellation we requested (signal aborted) settles as a cancel, not
        // a hard decline — the elicitation was abandoned, not refused.
        if (signal.aborted) {
          return { action: "cancel" };
        }
        this.logger.error(`Failed to forward MCP elicitation: ${error}`);
        return { action: "decline" };
      }
    };
  }

  /**
   * Present the built-in AskUserQuestion tool's questions as an ACP form
   * elicitation and return the answers as the tool's `updatedInput`. Called from
   * `canUseTool` since that is where the SDK routes the tool's permission check.
   */
  private async handleAskUserQuestion(
    sessionId: string,
    toolInput: Record<string, unknown>,
    toolUseID: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = extractAskUserQuestions(toolInput);
    if (!questions) {
      return { behavior: "deny", message: "AskUserQuestion called with no valid questions." };
    }

    const createRequest = askUserQuestionsToCreateRequest(questions, sessionId, toolUseID);
    let response;
    try {
      response = await this.withPendingUserInput(sessionId, () =>
        this.client.unstable_createElicitation(createRequest, signal),
      );
    } catch (error) {
      // A cancellation we requested (signal aborted) settles as an aborted tool
      // use, matching the post-response check below.
      if (signal.aborted) {
        throw new Error("Tool use aborted", { cause: error });
      }
      this.logger.error(`Failed to present AskUserQuestion elicitation: ${error}`);
      return { behavior: "deny", message: "Could not present the question to the user." };
    }
    if (signal.aborted) {
      throw new Error("Tool use aborted");
    }

    const outcome = applyAskElicitationResponse(response, toolInput, questions);
    if (outcome.action === "cancel") {
      throw new Error("Tool use aborted");
    }
    return { behavior: "allow", updatedInput: outcome.updatedInput };
  }

  /**
   * Handle `request_user_dialog` control requests — blocking dialogs the CLI
   * asks the host to render. Only kinds declared in `supportedDialogKinds`
   * are ever emitted; everything unexpected is answered `cancelled` (the
   * required answer for unrecognized kinds), which applies the dialog's
   * default behavior CLI-side. Today the only declared kind is the
   * refusal-fallback consent prompt, rendered as an ACP form elicitation.
   */
  private handleUserDialog(sessionId: string): OnUserDialog {
    return async (request, { signal }) => {
      if (request.dialogKind !== REFUSAL_FALLBACK_DIALOG_KIND) {
        return { behavior: "cancelled" };
      }
      const prompt = extractRefusalFallbackPrompt(request.payload);
      if (!prompt) {
        this.logger.error(
          `refusal_fallback_prompt payload had an unexpected shape; cancelling the dialog: ${JSON.stringify(request.payload)}`,
        );
        return { behavior: "cancelled" };
      }
      let response: CreateElicitationResponse;
      try {
        response = await this.withPendingUserInput(sessionId, () =>
          this.client.unstable_createElicitation(
            refusalFallbackToCreateRequest(prompt, sessionId),
            signal,
          ),
        );
      } catch (error) {
        // A cancellation we requested (signal aborted) is expected teardown;
        // anything else is a client failure. Either way the safe answer is
        // `cancelled` — the CLI applies the dialog's default (keep the
        // refusal) rather than switching models without consent.
        if (!signal.aborted) {
          this.logger.error(`Failed to present refusal fallback elicitation: ${error}`);
        }
        return { behavior: "cancelled" };
      }
      if (signal.aborted) {
        return { behavior: "cancelled" };
      }
      return { behavior: "completed", result: refusalFallbackResultFromResponse(response) };
    };
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    const commands = await session.query.supportedCommands();
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: getAvailableSlashCommands(commands, session.terminalSlashCommands),
      },
    });
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    await this.applyConfigOptionValue(sessionId, session, configId, value);

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  /**
   * Replace a heuristic context window with `getContextUsage().rawMaxTokens`
   * without blocking the caller. The text heuristic misses natively-1M models
   * whose picker rows carry no "1m" token (`sonnet`, and since CLI 2.1.283
   * `opus`/`default`), which would otherwise report 200k until the first
   * result's modelUsage. Never awaited: SDK control requests are serialized,
   * so an awaited call would delay session/new or a model switch (before the
   * first turn it took ~15s on older CLIs, issues #886/#880; ~0.5s on 2.1.283).
   * Not written to `contextWindowCache` — that stays keyed to the
   * `result.modelUsage` spellings — and a result still overwrites it.
   * Ported from upstream #1186.
   */
  private refreshContextWindowInBackground(sessionId: string, session: Session): void {
    if (session.contextWindowAuthoritative) return;
    const { query } = session;
    const modelId = session.models.currentModelId;
    const stillCurrent = () =>
      this.sessions[sessionId] === session &&
      session.query === query &&
      session.models.currentModelId === modelId;
    // A synchronous throw must not fail the caller either.
    Promise.resolve()
      .then(() => query.getContextUsage())
      .then(
        (usage) => {
          if (!stillCurrent() || session.contextWindowAuthoritative) return;
          if (!(usage.rawMaxTokens > 0)) return;
          session.contextWindowSize = usage.rawMaxTokens;
          session.contextWindowAuthoritative = true;
        },
        (error) => {
          if (stillCurrent()) this.logger.error("Failed to read the context window:", error);
        },
      );
  }

  private async applyConfigOptionValue(
    sessionId: string,
    session: Session,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === MODE_CONFIG_ID) {
      this.sessionModes.syncConfig(session, value);
    } else if (configId === MODEL_CONFIG_ID) {
      // `ModelInfo.supportsAutoMode` is the canonical SDK signal for applying
      // the Auto fallback below; its `displayName`/`description` also let us infer the
      // context window for semantic aliases (e.g. `default`) whose ID alone
      // carries no "1m" token.
      const newModelInfo = session.modelInfos.find((m) => m.value === value);
      const modelChanged = session.models.currentModelId !== value;
      if (modelChanged) {
        // Seed the new model's context window WITHOUT awaited IPC on the
        // switch path: cached authoritative value if we've already learned it
        // (from a prior turn's `result.modelUsage`), else the text heuristic,
        // else the default. SDK control requests are serialized over one
        // channel, so an awaited `getContextUsage` here would delay the rest
        // of the switch (issues #886/#880); a guessed seed is instead refined
        // in the background once the switch is done
        // (`refreshContextWindowInBackground`).
        const seeded = immediateContextWindow(session.providerCacheKey, value, newModelInfo);
        session.contextWindowSize = seeded.size;
        session.contextWindowAuthoritative = seeded.authoritative;
      }
      session.models = { ...session.models, currentModelId: value };

      const modeDowngraded = await this.sessionModes.reconcileForModel(session, newModelInfo);

      // `model_not_allowed` described the model we just left, so it must not
      // follow us onto the new one; the remaining reasons are account- or
      // environment-scoped and stay true across a switch. Either way the next
      // init/result report refreshes this.
      if (session.fastModeDisabledReason === "model_not_allowed") {
        session.fastModeDisabledReason = undefined;
      }

      // Rebuild config options since effort levels depend on the selected model
      const effortOpt = session.configOptions.find((o) => o.id === EFFORT_CONFIG_ID);
      const currentEffort =
        typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
      session.configOptions = buildConfigOptions(
        session.modes,
        session.models,
        session.modelInfos,
        currentEffort,
        session.agents,
        session.currentAgent,
        {
          // The toggle follows the newly selected model: it disappears when the
          // model lacks fast support and reappears (with the retained user
          // intent) when a supporting model is selected again.
          supported: newModelInfo?.supportsFastMode ?? false,
          enabled: session.fastModeEnabled,
          useBooleanOption: clientSupportsBooleanConfigOptions(this.clientCapabilities),
          disabledReason: session.fastModeDisabledReason,
        },
        // Thinking is model-independent: re-render the retained tri-state
        // intent so the row survives this rebuild (an option not threaded
        // through here silently drops from the picker on every model switch,
        // R1.7). Untouched sessions keep displaying the env-driven state
        // (R1.6).
        session.thinkingEnabled ??
          effectiveThinkingConfig(undefined, process.env.MAX_THINKING_TOKENS, this.logger) !==
            undefined,
        {
          // The new model decides whether the entry renders at all; the session's
          // retained intent decides whether it renders selected. A model without
          // `xhigh` drops the entry, and `validEffort` then falls back for it the
          // same way it does for any unsupported level.
          available: isUltracodeAvailable(
            newModelInfo?.supportsEffort ? (newModelInfo.supportedEffortLevels ?? []) : [],
            { disableWorkflows: session.workflowsDisabled },
          ),
          enabled: session.ultracode,
        },
        {
          disableWorkflows: session.workflowsDisabled,
          // Threaded for the same reason Thinking is (R1.7): an option not
          // passed through this rebuild silently drops from the picker on
          // every model switch. The account is model-independent, so the row
          // and its selection survive unchanged.
          accounts: session.declaredAccounts,
          currentAccount: session.currentAccount,
        },
      );

      // Sync effort with the SDK if it changed after the model switch
      const newEffortOpt = session.configOptions.find((o) => o.id === EFFORT_CONFIG_ID);
      const newEffort =
        typeof newEffortOpt?.currentValue === "string" ? newEffortOpt.currentValue : undefined;
      if (newEffort !== currentEffort) {
        await session.query.applyFlagSettings(ultracodeFlagSettings(newEffort));
        session.ultracode = isUltracodeValue(newEffort);
      }

      // Emit current_mode_update only after session.modes AND
      // session.configOptions have been fully reconciled. This way, a failure
      // in the configOptions/effort rebuild above can't leave the client with
      // a clamped currentModeId but stale configOptions, and the notification
      // still precedes the caller's config_option_update so order-sensitive
      // clients update currentModeId before re-rendering the option list.
      if (modeDowngraded) {
        await this.sessionModes.publishFallbackState(sessionId, session);
      }
      // Last, so the switch's own control requests don't queue behind it.
      if (modelChanged) this.refreshContextWindowInBackground(sessionId, session);
    } else if (configId === AGENT_CONFIG_ID) {
      // Live agent switch — no subprocess restart needed. Apply the SDK flag
      // first so a rejected control request leaves both `currentAgent` and the
      // config option untouched (no UI/SDK desync). Passing `null` clears the
      // flag layer back to the standard Claude Code agent; the change takes
      // effect on the next turn (SDK >= 0.3.161).
      await session.query.applyFlagSettings({
        agent: value === DEFAULT_AGENT_ID ? null : value,
      });
      session.currentAgent = value;
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else if (configId === ACCOUNT_CONFIG_ID) {
      // Resolve BEFORE recording anything: an account nobody declared must
      // leave the session exactly as it was. `setSessionConfigOption`'s shared
      // validation already refuses a value that is not among the option's
      // entries; this second check covers the one path that bypasses it (a
      // client round-tripping `currentValue`) and keeps the refusal here
      // rather than in a caller (R6.3).
      const account = accountForValue(session.declaredAccounts ?? [], value);
      if (!account) {
        throw new Error(`Invalid value for config option ${configId}: ${value}`);
      }
      // No SDK call, and no query recreate: the account is applied through the
      // per-session `env` at query CREATION (D2/D9 — the SDK already accepts
      // one, so no Zed patch is involved), and this session's query keeps the
      // account it was created under (D7).
      this.selectedAccount = value;
      session.currentAccount = value;
      session.accountEnv = envForAccount(account);
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else {
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
      if (configId === EFFORT_CONFIG_ID) {
        // Both keys, always. Selecting a plain level after Ultracode must CLEAR
        // the flag, and only an explicit `null` clears it — see
        // `ultracodeFlagSettings`.
        await session.query.applyFlagSettings(ultracodeFlagSettings(value));
        session.ultracode = isUltracodeValue(value);
      }
    }
  }

  /** Reconcile adapter model state after the SDK persistently swapped the
   *  session's model out from under us (refusal fallback). The SDK already
   *  made the switch, so this must NOT call `query.setModel` — it only
   *  updates our bookkeeping (currentModelId, context window, mode clamping,
   *  effort/Fast-mode options) via the same `applyConfigOptionValue` path a
   *  user-driven model change takes, then notifies the client. */
  private async syncModelAfterRefusalFallback(
    sessionId: string,
    session: Session,
    fallbackModel: string,
  ): Promise<void> {
    // Map the SDK-reported model onto one of the session's model options
    // (handles display names and `resolvedModel` ids). The fallback model may
    // not be among the options — e.g. excluded by the user's
    // `availableModels` allowlist — in which case we track the raw id: the
    // picker shows no selection, but the model-dependent bookkeeping and any
    // later `setModel` round-trip stay truthful to what the SDK is running.
    const resolved = resolveModelPreference(session.modelInfos, fallbackModel);
    const value = resolved?.value ?? fallbackModel;
    if (session.models.currentModelId === value) return;

    try {
      await this.updateConfigOption(sessionId, MODEL_CONFIG_ID, value);
    } catch (err) {
      // This runs on the consumer loop: a throw here tears down the query
      // stream (failAllTurns + closeQueryStream) and bricks the session —
      // far worse than stale bookkeeping. The user-driven RPC path lets the
      // same errors propagate to fail just that request; here we log and
      // move on, matching the setPermissionMode containment inside
      // applyConfigOptionValue.
      this.logger.error(
        `Failed to reconcile model state after refusal fallback to "${fallbackModel}":`,
        err,
      );
    }
  }

  /** Replace the Fast mode option in `session.configOptions` so it reflects
   *  `enabled` (and the client's current boolean-capability). A no-op when the
   *  option isn't present, so callers must confirm the current model surfaces
   *  it first. */
  private refreshFastModeOption(session: Session, enabled: boolean): void {
    const refreshed = createFastModeConfigOption(
      enabled,
      clientSupportsBooleanConfigOptions(this.clientCapabilities),
      session.fastModeDisabledReason,
    );
    session.configOptions = session.configOptions.map((o) =>
      o.id === FAST_MODE_CONFIG_ID ? refreshed : o,
    );
  }

  /** Toggle Fast mode for a session: push the SDK flag, record the user's
   *  intent, and refresh the Fast mode config option in place. Only reached
   *  once the option exists (i.e. the current model supports fast mode), so the
   *  option is guaranteed to be present in `configOptions`. */
  private async applyFastMode(session: Session, enabled: boolean): Promise<void> {
    // Apply the SDK flag first so a rejected control request leaves both the
    // session state and the config option untouched (no UI/SDK desync).
    await session.query.applyFlagSettings({ fastMode: enabled });
    session.fastModeEnabled = enabled;
    this.refreshFastModeOption(session, enabled);
  }

  /** Lazily swap a session's SDK query for a fresh one so a Thinking change
   *  takes effect on the next turn (R1.3): thinking has no live flag-settings
   *  path in the SDK, so mid-session application goes through query recreation
   *  with session resume. The replacement resumes the SAME conversation
   *  (`{ resume: sessionId }` — the adapter's session ids ARE the SDK's, see
   *  `getOrCreateSession`) and is assembled from the creation-time
   *  `queryOptions` plus the live-tracked session state (model, permission
   *  mode, agent, effort, Fast mode), with thinking routed through
   *  `effectiveThinkingConfig` — the same single code path query creation
   *  uses (R1.5/R1.6).
   *
   *  Deliberately NOT `teardownSession`: that aborts `session.abortController`
   *  (possibly client-supplied and reused) and evicts the session from the
   *  map. This path keeps the Session object registered and every controller
   *  alive; only the query subprocess is replaced.
   *
   *  Ordering is what makes the swap safe:
   *  1. Build + initialize the NEW query first, time-bounded
   *     (QUERY_RECREATE_INIT_TIMEOUT_MS) so a wedged replacement cannot hang
   *     the joins on `queryRecreateInFlight`. Any failure leaves the old
   *     query untouched and usable: the user is told via agent_message_chunk,
   *     `pendingQueryRecreate` stays set (retried on the next prompt), and the
   *     caller's turn proceeds on the OLD query. Never rejects.
   *  2. Re-check, synchronously, session liveness and model/mode drift: if
   *     the OLD stream died (or the session was evicted) while step 1
   *     awaited — or a straggler setter moved the model/mode again after the
   *     delta re-apply — abandon the replacement instead of installing it.
   *  3. Cut over synchronously — swap `session.query`/`input`, drop the
   *     consumer handle (so `ensureConsumer` starts a fresh consumer for the
   *     new query), clear the pending flag — THEN end the old stream. Swapping
   *     before closing is load-bearing: the superseded consumer only wakes
   *     after this microtask completes, sees `session.query !== myQuery`, and
   *     exits via its supersession guards instead of running end-of-stream
   *     cleanup (which would close the NEW query and dispose live resources).
   *
   *  Only called from `prompt()` while the turn queue is idle (concurrent
   *  RPC entry points join `queryRecreateInFlight`), so there are no in-flight
   *  turns to migrate and the old query has nothing left to say. */
  private async recreateSessionQuery(sessionId: string, session: Session): Promise<void> {
    const newInput = new Pushable<SDKUserMessage>();
    let newQuery: Query | undefined;
    try {
      if (!session.queryOptions) {
        // Only reachable for hand-built sessions (tests): createSession always
        // records the options. Routed through the failure path below so the
        // old query stays usable.
        throw new Error("session has no recorded query options to rebuild from");
      }

      // ONE thinking code path for creation and recreation: the session's
      // tri-state intent beats the env var once set ("off" wins even with
      // MAX_THINKING_TOKENS present, R1.5); untouched sessions keep the
      // env-driven behavior (R1.6).
      const thinking = effectiveThinkingConfig(
        session.thinkingEnabled,
        process.env.MAX_THINKING_TOKENS,
        this.logger,
      );

      // Snapshot of the live-tracked model/mode the replacement is built
      // with. A setter that was ALREADY awaiting its control request on the
      // old query when this recreate started (i.e. past its
      // `queryRecreateInFlight` join) can land its state update after this
      // snapshot; the post-init delta re-apply below reconciles the NEW
      // query, and the synchronous pre-swap check abandons the recreate if
      // the state moves yet again.
      let appliedModelId = session.models.currentModelId;
      let appliedModeId = session.modes.currentModeId;

      const options: Options = {
        ...session.queryOptions,
        // Live-tracked state that may have drifted from creation time via
        // setSessionMode/setModel. `availableModes` ids are the SDK's own
        // permission modes (see `applySessionMode`'s validation), so the cast
        // is sound.
        permissionMode: appliedModeId as PermissionMode,
        model: appliedModelId,
        // Resume THIS conversation in the replacement subprocess.
        resume: sessionId,
        // Same controller: a client-supplied abort must keep governing the
        // session across the swap.
        abortController: session.abortController,
      };
      // `sessionId` is mutually exclusive with `resume` (and this is never a
      // fork); stale creation-time values would make the SDK reject or fork.
      delete options.sessionId;
      delete options.forkSession;
      // Route the fresh resolution in (a stale creation-time `thinking` must
      // not leak through when the fresh resolution is `undefined`).
      delete options.thinking;
      if (thinking !== undefined) {
        options.thinking = thinking;
      }
      // A session that has not finished a turn yet has no transcript, and
      // resuming it fails ("No conversation found with session ID"): that is why
      // every fresh thread's first turn used to carry the "could not be applied"
      // note -- Zed applies default_config_options.thinking before the first
      // prompt, which schedules this recreate. With nothing to resume, start the
      // replacement as a new session under the same id. Only on proof: the
      // transcript is looked for in the config dir THIS query runs with (an
      // account overlay moves it), and anything short of "not there" keeps
      // resuming, which is what the code did before.
      const configDir = session.queryOptions.env?.CLAUDE_CONFIG_DIR ?? CLAUDE_CONFIG_DIR;
      if ((await findTranscript(configDir, sessionId)) === undefined) {
        delete options.resume;
        options.sessionId = sessionId;
      }
      if (session.currentAgent === DEFAULT_AGENT_ID) {
        delete options.agent;
      } else {
        options.agent = session.currentAgent;
      }

      newQuery = query({ prompt: newInput, options });
      const replacement = newQuery;

      // Everything the replacement needs before it may serve a turn, grouped
      // into one phase so it can be time-bounded below.
      const initPhase = (async () => {
        // Fail fast while the OLD query is still intact: a spawn/resume
        // problem surfaces here, not after the cutover.
        await replacement.initializationResult();

        // Flag-layer settings don't survive into a new subprocess; re-apply
        // the session's current effort and Fast mode before any turn runs on
        // it (mirrors createSession's initial-effort application). Both are
        // read post-init, so a setter update that landed during the init
        // await is already included.
        const effortOpt = session.configOptions.find((o) => o.id === EFFORT_CONFIG_ID);
        const effortValue =
          typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
        const { effortLevel, ultracode } = ultracodeFlagSettings(effortValue);
        // Only the positive case is re-applied: the replacement's flag layer
        // starts empty, so clearing a key that was never set would be a control
        // request that says nothing. `ultracode` is sent WITH its level rather
        // than alone — the SDK requires an xhigh-capable model for it, and a
        // flag layer carrying one half of the pair is a state no picker names.
        if (effortLevel !== null) {
          await replacement.applyFlagSettings(
            ultracode === true ? { effortLevel, ultracode: true } : { effortLevel },
          );
        }
        const supportsFastMode =
          session.modelInfos.find((m) => m.value === session.models.currentModelId)
            ?.supportsFastMode ?? false;
        if (session.fastModeEnabled && supportsFastMode) {
          await replacement.applyFlagSettings({ fastMode: true });
        }

        // Delta re-apply: a model/mode setter that was already in flight on
        // the OLD query when this recreate snapshotted the session state may
        // have landed its update during the awaits above — the client was
        // acked for a value the replacement wasn't built with. Reconcile via
        // the new query's live controls (the same calls the setters use), and
        // keep `options` truthful for the stored `queryOptions` snapshot. (A
        // setter that instead resolves AFTER the swap applies to the closed
        // old query and surfaces as a visible rejection to the client — not a
        // silent desync — which is acceptable.)
        if (session.models.currentModelId !== appliedModelId) {
          appliedModelId = session.models.currentModelId;
          options.model = appliedModelId;
          await replacement.setModel(appliedModelId);
        }
        if (session.modes.currentModeId !== appliedModeId) {
          appliedModeId = session.modes.currentModeId;
          options.permissionMode = appliedModeId as PermissionMode;
          await replacement.setPermissionMode(appliedModeId as PermissionMode);
        }
      })();

      // Bound the whole phase (a wedged replacement subprocess can hang
      // initializationResult() forever — the issue #680 wedge class). Every
      // join on `queryRecreateInFlight` — prompt/cancel/the setters, and
      // teardown/dispose via cancel() — would inherit such a hang, so expiry
      // rejects into the failure path below (replacement closed, old query
      // untouched, pending flag retained). The timer is cleared on every
      // path; if the timeout wins, the losing initPhase's later settlement is
      // absorbed by Promise.race's own subscription, so no rejection can
      // surface as unhandled.
      let initTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          initPhase,
          new Promise<never>((_, reject) => {
            initTimer = setTimeout(() => {
              reject(
                new Error(
                  `recreate timed out: the replacement query did not finish initializing ` +
                    `within ${QUERY_RECREATE_INIT_TIMEOUT_MS}ms`,
                ),
              );
            }, QUERY_RECREATE_INIT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(initTimer);
      }

      // Liveness re-check: the awaits above are a long window in which the
      // OLD query's stream can die on its own — its (still-bound, not yet
      // superseded) consumer then runs closeQueryStream (queryClosed = true,
      // settings disposed) and, for a dead process, evicts the session.
      // Installing the new query anyway would brick the session (queryClosed
      // blocks prompt/cancel/setSessionMode/setSessionConfigOption) or, in
      // the eviction case, leak the fresh subprocess where no teardown could
      // ever reach it. Treat it as a failed recreate: release the new
      // resources and keep the pending flag. Deliberately NO client note
      // here — "retried on the next prompt" would be false for a dead
      // session (and meaningless for an evicted one); the authoritative
      // signal stays the existing SESSION_ENDED flow.
      if (session.queryClosed || this.sessions[sessionId] !== session) {
        const reason =
          this.sessions[sessionId] !== session
            ? "the session was evicted while the replacement query initialized"
            : "the session's query stream ended while the replacement query initialized";
        this.logger.error(`Session ${sessionId}: abandoning Thinking query recreate: ${reason}.`);
        newInput.end();
        try {
          newQuery.close();
        } catch (closeError) {
          this.logger.error(
            `Session ${sessionId}: failed to close abandoned replacement query:`,
            closeError,
          );
        }
        return;
      }

      // Reverse-interleaving re-check (synchronous — nothing may await
      // between here and the swap): if a straggler setter moved the model or
      // permission mode yet again after the delta re-apply in `initPhase`,
      // abandon the replacement rather than install it stale. The pending
      // flag is retained, so the next prompt rebuilds from fresh state.
      if (
        session.models.currentModelId !== appliedModelId ||
        session.modes.currentModeId !== appliedModeId
      ) {
        this.logger.error(
          `Session ${sessionId}: abandoning Thinking query recreate: the session's model ` +
            `or permission mode changed while the replacement initialized; retrying on ` +
            `the next prompt.`,
        );
        newInput.end();
        try {
          newQuery.close();
        } catch (closeError) {
          this.logger.error(
            `Session ${sessionId}: failed to close abandoned replacement query:`,
            closeError,
          );
        }
        return;
      }

      // Cutover. Synchronous from here through the old-stream close: the
      // superseded consumer can only wake in a later microtask, so it never
      // observes an intermediate state.
      const oldQuery = session.query;
      const oldInput = session.input;
      session.query = newQuery;
      session.input = newInput;
      session.queryOptions = options;
      // The superseded consumer exits via its guards without touching the
      // session; drop its handle so the caller's ensureConsumer starts a
      // fresh consumer for the new query.
      session.consumer = undefined;
      session.pendingQueryRecreate = false;
      // End the old stream last; its consumer wakes on the final next() only
      // after the swap above is complete.
      oldInput.end();
      oldQuery.close();
    } catch (error) {
      // Keep the OLD query fully usable and the pending flag set (the next
      // prompt retries); the current turn proceeds with the previous thinking
      // config. Everything is contained here — never an unhandled rejection.
      this.logger.error(
        `Session ${sessionId}: failed to recreate query for Thinking change:`,
        error,
      );
      newInput.end();
      try {
        newQuery?.close();
      } catch (closeError) {
        this.logger.error(
          `Session ${sessionId}: failed to close abandoned replacement query:`,
          closeError,
        );
      }
      try {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                "Note: the updated Thinking setting could not be applied to this turn " +
                "(recreating the session's query failed), so it continues with the previous " +
                "setting. The change will be retried on the next prompt.",
            },
          },
        });
      } catch (notifyError) {
        this.logger.error(
          `Session ${sessionId}: failed to notify the client about the Thinking recreate failure:`,
          notifyError,
        );
      }
    }
  }

  /** Reconcile the session's Fast mode toggle with an SDK-reported
   *  `fast_mode_state` (delivered on `system`/init and on user-turn `result`s).
   *  The SDK can flip fast mode independently of the user — e.g. back to `on`
   *  once a rate-limit `cooldown` clears — so we mirror definitive on/off
   *  changes into the config option and notify the client.
   *
   *  Guards, in order:
   *   - absent state: nothing to reconcile.
   *   - no Fast mode option: the current model doesn't support fast mode, so the
   *     reported state reflects capability, not the user's intent. Leave the
   *     retained setting untouched so it's correct when a supporting model is
   *     reselected (the source of the earlier intent-clobber bug was mutating it
   *     here).
   *   - `cooldown`: a transient suspension of an already-enabled fast mode.
   *     Leave the toggle as-is rather than flapping it — and never let a stray
   *     cooldown spuriously enable a toggle the user has off.
   *
   *  `reason` is the SDK's `fast_mode_disabled_reason`, reported alongside the
   *  state. Only explainable reasons are retained (see
   *  {@link normalizeFastModeDisabledReason}), so the comparison below tracks
   *  exactly what the user can see: a routine `sdk_opt_in_required` report on
   *  every turn's result can't churn the option, while a real blocker updates
   *  the description even when the toggle's own value is unchanged. */
  private async syncFastModeState(
    sessionId: string,
    session: Session,
    state: FastModeState | undefined,
    reason?: FastModeDisabledReason,
  ): Promise<void> {
    if (state === undefined) {
      return;
    }
    if (!session.configOptions.some((o) => o.id === FAST_MODE_CONFIG_ID)) {
      return;
    }
    if (state === "cooldown") {
      return;
    }
    const enabled = state === "on";
    // A reason only describes an off state; drop any that rides an `on` report
    // so it can't decorate the option the next time fast mode goes off.
    const nextReason = enabled ? undefined : normalizeFastModeDisabledReason(reason);
    if (enabled === session.fastModeEnabled && nextReason === session.fastModeDisabledReason) {
      return;
    }
    // The user asked for Fast mode and the SDK is telling us it can't serve it.
    // The description carries the same explanation, but a toggle silently
    // snapping back is the case worth saying out loud once, at the flip.
    const explanation =
      nextReason !== undefined ? FAST_MODE_UNAVAILABLE_EXPLANATIONS[nextReason] : undefined;
    const explain = session.fastModeEnabled && !enabled && explanation !== undefined;
    session.fastModeEnabled = enabled;
    session.fastModeDisabledReason = nextReason;
    this.refreshFastModeOption(session, enabled);
    if (explain) {
      await this.client.sessionUpdate({
        sessionId,
        update: noticeOrTranscriptUpdate(
          {
            severity: "warning",
            title: "Fast mode turned off",
            description: `${sentenceCase(explanation)}.`,
          },
          clientSupportsNotices(this.clientCapabilities),
          `**Fast mode turned off:** ${explanation}.`,
        ),
      });
    }
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async getOrCreateSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: NewSessionRequest["mcpServers"];
    additionalDirectories?: NewSessionRequest["additionalDirectories"];
    _meta?: NewSessionRequest["_meta"];
  }): Promise<NewSessionResponse> {
    const existingSession = this.sessions[params.sessionId];
    if (existingSession) {
      const fingerprint = computeSessionFingerprint(params);
      if (fingerprint === existingSession.sessionFingerprint) {
        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          configOptions: existingSession.configOptions,
        };
      }

      // Session-defining params changed (e.g. cwd pointed at a git worktree,
      // or MCP servers reconfigured). Tear down the existing session and
      // recreate it so the underlying Query process picks up the new values.
      await this.teardownSession(params.sessionId);
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
      },
    );

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    };
  }

  /**
   * Ensures the requested `cwd` is an absolute path that points at an existing
   * directory before we create a session. Throws an `invalidParams` error with
   * an actionable message so clients (e.g. Zed) can surface it to the user
   * instead of failing later with an opaque SDK error.
   */
  private async validateCwd(cwd: string): Promise<void> {
    if (!path.isAbsolute(cwd)) {
      throw RequestError.invalidParams(
        { cwd },
        `\`cwd\` must be an absolute path, but received: ${cwd}`,
      );
    }

    let stats: Stats;
    try {
      stats = await fs.stat(cwd);
    } catch {
      throw RequestError.invalidParams(
        { cwd },
        `\`cwd\` does not exist on the machine running the agent: ${cwd}`,
      );
    }

    if (!stats.isDirectory()) {
      throw RequestError.invalidParams({ cwd }, `\`cwd\` is not a directory: ${cwd}`);
    }
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: {
      resume?: string;
      forkSession?: boolean;
      publicSessionId?: string;
      permissionMode?: PermissionMode;
    } = {},
  ): Promise<NewSessionResponse> {
    // Validate `cwd` up front. The ACP spec requires an absolute path, and the
    // directory must actually exist on the machine running the agent. Without
    // this check a session is created against a missing directory and the
    // failure only surfaces later as a confusing "native binary failed to
    // launch" error from the SDK (see issue #749).
    await this.validateCwd(params.cwd);

    // We want to create a new session id unless it is resume,
    // but not resume + forkSession.
    let sessionId;
    if (creationOpts.publicSessionId) {
      sessionId = creationOpts.publicSessionId;
    } else if (creationOpts.forkSession) {
      sessionId = randomUUID();
    } else if (creationOpts.resume) {
      sessionId = creationOpts.resume;
    } else {
      sessionId = randomUUID();
    }

    const input = new Pushable<SDKUserMessage>();

    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    const mcpServers: Record<string, McpServerConfig> = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ("type" in server && (server.type === "http" || server.type === "sse")) {
          // HTTP or SSE type MCP server
          mcpServers[server.name] = {
            type: server.type,
            url: server.url,
            headers: server.headers
              ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
              : undefined,
          };
        } else if (!("type" in server)) {
          // Stdio type MCP server (with or without explicit type field)
          mcpServers[server.name] = {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: server.env
              ? Object.fromEntries(server.env.map((e) => [e.name, e.value]))
              : undefined,
          };
        }
      }
    }

    let systemPrompt: Options["systemPrompt"] = { type: "preset", preset: "claude_code" };
    if (params._meta?.systemPrompt) {
      const customPrompt = params._meta.systemPrompt;
      if (typeof customPrompt === "string") {
        systemPrompt = customPrompt;
      } else if (
        typeof customPrompt === "object" &&
        customPrompt !== null &&
        !Array.isArray(customPrompt)
      ) {
        // Forward all preset options (append, excludeDynamicSections, and
        // anything the SDK adds later) while locking type/preset.
        systemPrompt = {
          ...(customPrompt as object),
          type: "preset",
          preset: "claude_code",
        } as Options["systemPrompt"];
      }
    }

    // Decided once per session (upstream #1165): it gates the SDK flag, the
    // spawn-time mode -- the SDK rejects bypassPermissions without the flag --
    // and the mode catalog, so all three agree with what the CLI will accept.
    const allowBypass = sessionAllowsBypass(settingsManager.getSettings().permissions);
    const permissionMode = resolvePermissionMode(
      settingsManager.getSettings().permissions?.defaultMode,
      this.logger,
      allowBypass,
    );
    const initialPermissionMode =
      creationOpts.permissionMode === "bypassPermissions" && !allowBypass
        ? "default"
        : (creationOpts.permissionMode ?? permissionMode);

    // Extract options from _meta if provided
    const sessionMeta = params._meta as NewSessionMeta | undefined;
    const userProvidedOptions = sessionMeta?.claudeCode?.options;
    const forwardSubagentText =
      supportsSubagentTranscript(this.clientCapabilities) ||
      userProvidedOptions?.forwardSubagentText === true;

    // Configure thinking behavior through the same single code path query
    // recreation uses (`recreateSessionQuery`). A fresh session's Thinking
    // intent is untouched (`undefined`), so this resolves to exactly the
    // legacy env-driven MAX_THINKING_TOKENS behavior (R1.6).
    const thinking = effectiveThinkingConfig(
      undefined,
      process.env.MAX_THINKING_TOKENS,
      this.logger,
    );

    // Parse model configuration from environment (e.g. Bedrock model overrides)
    const modelConfig = parseModelConfig(process.env.CLAUDE_MODEL_CONFIG);

    // Elicitation modes the connected client advertised. We only forward
    // elicitations (and only re-enable AskUserQuestion) for modes the client
    // can actually render.
    const elicitationSupport: ElicitationSupport = {
      form: !!this.clientCapabilities?.elicitation?.form,
      url: !!this.clientCapabilities?.elicitation?.url,
    };

    // AskUserQuestion surfaces as a `permission_ask_user_question` dialog that
    // we render as a form elicitation. Without form-elicitation support there
    // is no way to present it over ACP, so keep it disabled in that case.
    const disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"];

    // Resolve which built-in tools to expose.
    // Explicit tools array from _meta.claudeCode.options takes precedence.
    // disableBuiltInTools is a legacy shorthand for tools: [] — kept for
    // backward compatibility but callers should prefer the tools array.
    const tools: Options["tools"] =
      userProvidedOptions?.tools ??
      (params._meta?.disableBuiltInTools === true ? [] : { type: "preset", preset: "claude_code" });

    const abortController = userProvidedOptions?.abortController || new AbortController();

    // Per-session task state. Created here (rather than in the session record
    // below) so the TaskCreated/TaskCompleted hook callbacks can close over
    // the same Map that the streaming message handler will read from.
    const taskState: TaskState = new Map();

    // Resolve every workspace root once. The hidden report tool uses this same
    // set for lexical path validation, and the SDK receives it below.
    const acpAdditionalDirectories =
      params.additionalDirectories ?? sessionMeta?.additionalRoots ?? [];
    const additionalDirectories = [
      ...(userProvidedOptions?.additionalDirectories ?? []),
      ...acpAdditionalDirectories,
    ];

    const fileChangeAuditSupport = supportsAgentFileChangeReport(this.clientCapabilities)
      ? createFileChangeAuditSupport({
          cwd: params.cwd,
          additionalDirectories,
          getActiveState: () => this.sessions[sessionId]?.activeTurn?.fileChangeAudit,
          publish: async (result) => {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "session_info_update",
                _meta: agentFileChangeReportMeta(result),
              },
            });
          },
          logError: (message) => this.logger.error(message),
        })
      : undefined;

    // The exact env the query will be created with. Built (and the provider
    // cache key derived from it, below) in one place so the key always
    // describes the backend this query actually talks to: `providers/set`,
    // `providers/disable`, and `logout` mutate the process-wide provider
    // config concurrently, so re-resolving it after any of the awaits between
    // here and the session registration could disagree with the env baked
    // into the query.
    const resolvedProvider = this.resolveProviderConfig();
    const providerEnv = createEnvForProvider(resolvedProvider);
    const configuredSettings =
      userProvidedOptions?.settings ??
      (modelConfig
        ? {
            ...(modelConfig.modelOverrides && { modelOverrides: modelConfig.modelOverrides }),
            ...(modelConfig.availableModels && { availableModels: modelConfig.availableModels }),
          }
        : undefined);
    // Claude Code applies env from settings.json after the subprocess env. Put
    // an active ACP route in the programmatic settings tier too so user/project
    // settings cannot silently restore a different ANTHROPIC_BASE_URL.
    let settings = configuredSettings;
    if (resolvedProvider) {
      const baseSettings =
        typeof configuredSettings === "string"
          ? (JSON.parse(
              await fs.readFile(path.resolve(params.cwd, configuredSettings), "utf8"),
            ) as Exclude<Options["settings"], string | undefined>)
          : configuredSettings;
      settings = {
        ...baseSettings,
        apiKeyHelper: "",
        env: { ...baseSettings?.env, ...providerEnv },
      };
    }
    // The account this session runs under (R6.3): the selector's last choice
    // when it names a declared account, else the first declared one. Read from
    // the resolved settings, because accounts are DECLARED, never discovered
    // (D4) — nothing here scans a home directory for credential stores. With
    // none declared there is no overlay and the process's own configuration
    // home stands, which is exactly the behavior that predates this option.
    const declaredAccounts = readDeclaredAccounts(settingsManager.getSettings(), this.logger);
    const accountEntry = accountInForce(declaredAccounts, this.selectedAccount);
    // The SESSION's account home, never the ADAPTER's (D3): this overlay is
    // handed to the SDK per session and to nothing else. `process.env` is not
    // mutated — `CLAUDE_CONFIG_DIR` is read once into a module-level constant
    // that `settings.ts` uses to find the adapter's OWN settings.json, so a
    // mutation would be seen by some readers and not others.
    const accountEnv = accountEntry ? envForAccount(accountEntry.account) : undefined;
    const env = {
      ...process.env,
      ...userProvidedOptions?.env,
      // After the client-supplied env: the selector is a live user choice,
      // and an agent entry that pinned CLAUDE_CONFIG_DIR is precisely the
      // "account as a second agent" shape this option replaces (D1). Before
      // the provider routing, which sets ANTHROPIC_* and never this key.
      ...accountEnv,
      // Client-managed LLM routing: `providers/set` config wins, else the
      // legacy gateway auth request. Routing is baked into the query at
      // creation; provider updates recreate loaded queries between turns.
      ...providerEnv,
      // Opt-in to session state events like when the agent is idle
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    };
    // Scopes the context-window cache to this query's backend (see
    // `contextWindowCache`). Derived from the same `env` object handed to the
    // SDK, so per-session `_meta` env routing and ambient process-env routing
    // are distinguished exactly as the CLI will see them.
    const providerCacheKey = providerCacheKeyFor(env);
    this.logger.log(
      `[session/query] sessionId=${sessionId} resume=${creationOpts?.resume ?? "none"} apiType=${resolvedProvider?.apiType ?? "native"} baseUrl=${resolvedProvider?.baseUrl ?? "native"}`,
    );

    const options: Options = {
      systemPrompt,
      settingSources: ["user", "project", "local"],
      ...(thinking !== undefined && { thinking }),
      // File checkpointing on by default so `/rewind N` can restore files
      // (story 006, R3.3). Placed before the user spread so an explicit user
      // `enableFileCheckpointing` still wins.
      enableFileCheckpointing: true,
      ...userProvidedOptions,
      ...(settings && { settings }),
      env,
      // Override certain fields that must be controlled by ACP
      cwd: params.cwd,
      includePartialMessages: true,
      forwardSubagentText,
      mcpServers: {
        ...(userProvidedOptions?.mcpServers || {}),
        ...mcpServers,
        ...(fileChangeAuditSupport
          ? { [FILE_CHANGE_AUDIT_SERVER_NAME]: fileChangeAuditSupport.mcpServer }
          : {}),
      },
      // If we want bypassPermissions to be an option, we have to allow it here.
      // But it doesn't work in root mode, so we only activate it if it will work.
      allowDangerouslySkipPermissions: allowBypass,
      permissionMode: initialPermissionMode,
      canUseTool: this.canUseTool(sessionId),
      // Forward MCP elicitation requests onto ACP elicitation. Only attached
      // when the client advertised support, so non-supporting clients keep the
      // SDK's default (auto-decline) behavior. (AskUserQuestion is handled in
      // canUseTool, not here.)
      ...(elicitationSupport.form || elicitationSupport.url
        ? { onElicitation: this.handleMcpElicitation(sessionId, elicitationSupport) }
        : {}),
      // Render the CLI's refusal-fallback consent prompt ("<model> declined —
      // retry with <fallback>?") as an ACP form elicitation. Declaring the
      // kind is the opt-in: the CLI never emits an undeclared dialog, and the
      // flow instead degrades to the classic refusal error ending the turn.
      // Gated on form elicitation since that's the only ACP surface that can
      // present a choice outside a tool call.
      ...(elicitationSupport.form
        ? {
            onUserDialog: this.handleUserDialog(sessionId),
            supportedDialogKinds: [REFUSAL_FALLBACK_DIALOG_KIND],
          }
        : {}),
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? (await claudeCliPath()),
      extraArgs: {
        ...userProvidedOptions?.extraArgs,
        "replay-user-messages": "",
      },
      disallowedTools: [...(userProvidedOptions?.disallowedTools || []), ...disallowedTools],
      tools,
      hooks: {
        ...userProvidedOptions?.hooks,
        ...(fileChangeAuditSupport
          ? {
              PreToolUse: [
                ...(userProvidedOptions?.hooks?.PreToolUse || []),
                { hooks: [fileChangeAuditSupport.preToolUseHook] },
              ],
            }
          : {}),
        PostToolUse: [
          ...(userProvidedOptions?.hooks?.PostToolUse || []),
          {
            hooks: [
              createPostToolUseHook({
                onEnterPlanMode: async () => {
                  await this.sessionModes.publishCurrent(sessionId, "plan");
                  await this.updateConfigOption(sessionId, MODE_CONFIG_ID, "plan");
                },
              }),
            ],
          },
        ],
        ...(fileChangeAuditSupport
          ? {
              Stop: [
                ...(userProvidedOptions?.hooks?.Stop || []),
                { hooks: [fileChangeAuditSupport.stopHook] },
              ],
            }
          : {}),
        TaskCreated: [
          ...(userProvidedOptions?.hooks?.TaskCreated || []),
          {
            hooks: [
              createTaskHook({
                taskState,
                onChange: () => this.publishTaskPlan(sessionId, taskState),
              }),
            ],
          },
        ],
        TaskCompleted: [
          ...(userProvidedOptions?.hooks?.TaskCompleted || []),
          {
            hooks: [
              createTaskHook({
                taskState,
                onChange: () => this.publishTaskPlan(sessionId, taskState),
              }),
            ],
          },
        ],
      },
      ...(creationOpts.resume !== undefined && { resume: creationOpts.resume }),
      ...(creationOpts.forkSession !== undefined && { forkSession: creationOpts.forkSession }),
      abortController,
    };

    // Prefer the official ACP `additionalDirectories` field. Fall back to the
    // legacy `_meta.additionalRoots` extension for clients that haven't been
    // updated yet. Either source is merged with directories supplied via
    // `_meta.claudeCode.options.additionalDirectories` (SDK pass-through).
    options.additionalDirectories = additionalDirectories;

    if (creationOpts?.resume === undefined || creationOpts?.forkSession) {
      // Set our own session id if not resuming an existing session.
      options.sessionId = creationOpts.publicSessionId ? randomUUID() : sessionId;
    }

    // Handle abort controller from meta options
    if (abortController?.signal.aborted) {
      throw new Error("Cancelled");
    }

    const q = query({
      prompt: input,
      options,
    });

    let initializationResult;
    try {
      initializationResult = await q.initializationResult();
    } catch (error) {
      if (
        creationOpts.resume &&
        error instanceof Error &&
        (error.message === "Query closed before response received" ||
          error.message.includes("No conversation found with session ID"))
      ) {
        throw RequestError.resourceNotFound(sessionId);
      }
      throw error;
    }

    if (
      shouldHideClaudeAuth() &&
      initializationResult.account.subscriptionType &&
      !this.gatewayAuthRequest
    ) {
      throw RequestError.authRequired(
        undefined,
        "This integration does not support using claude.ai subscriptions.",
      );
    }

    // Apply user's `availableModels` allowlist from settings.json before any
    // downstream model handling. The SDK only enforces this allowlist in its
    // own UI, not in `initializationResult.models`, so we filter here to keep
    // configOptions, the current-model resolver, and the stored modelInfos
    // consistent with what the user configured.
    const settingsAvailableModels = settingsManager.getSettings().availableModels;
    const settingsModelOverrides = settingsManager.getSettings().modelOverrides;
    // The CATALOG: allowlist-applied (when configured) but deprecation-
    // UNfiltered. Preference resolution (`resolveModelPreference`) and
    // capability lookups read this list, so a persisted preference pointing at
    // a deprecated model keeps resolving with full capabilities (R4.3 — the
    // deprecation filter is visibility-only, never a forced migration).
    const catalogModels = Array.isArray(settingsAvailableModels)
      ? buildAllowlistedModels(
          initializationResult.models,
          settingsAvailableModels,
          settingsModelOverrides,
        )
      : initializationResult.models;
    // The PICKER list: same pipeline plus the deprecation visibility filter
    // (R4.2). With an allowlist this goes through the exported boundary
    // `applyAvailableModelsAllowlist` (the filter lives inside it — pinned by
    // model-picker-filter.test.ts); the small allowlist recompute vs.
    // `catalogModels` is deliberate so the boundary stays the single place
    // filter and allowlist compose. Without an allowlist the raw SDK list is
    // the one list-building site that never crosses that boundary, so it
    // applies the SAME `hideDeprecatedModels` helper directly, plus
    // `hideSupersededModels` — which the allowlist branch deliberately does NOT
    // get, because an allowlist is the user naming versions on purpose (see
    // that helper's doc).
    const allowedModels = Array.isArray(settingsAvailableModels)
      ? applyAvailableModelsAllowlist(
          initializationResult.models,
          settingsAvailableModels,
          settingsModelOverrides,
          this.logger,
        )
      : hideSupersededModels(
          hideDeprecatedModels(initializationResult.models, this.logger),
          this.logger,
        );

    const {
      modelState: models,
      resumedContextWindow,
      resumedContextUsedTokens,
    } = await getAvailableModels(
      q,
      catalogModels,
      allowedModels,
      initializationResult.models,
      settingsManager,
      this.logger,
      creationOpts.resume !== undefined,
      creationOpts.resume,
    );

    // Resolve the current model's capabilities separately from the stable
    // permission-mode catalog advertised to ACP clients.
    // Looked up in the UNfiltered catalog: a session honoring a persisted
    // deprecated preference must keep that model's real capabilities (R4.3).
    // A resumed session can also be running a model outside the
    // `availableModels` allowlist (currentModelId is then the verbatim live
    // id, see `matchResumedModel`); its capabilities are still known to the
    // SDK's unfiltered list, so fall back to that before treating the model
    // as unknown — otherwise auto mode would be spuriously clamped and the
    // Fast-mode/Effort options hidden for a model that supports them.
    const catalogModelInfo = catalogModels.find((m) => m.value === models.currentModelId);
    const fallbackModelInfo = catalogModelInfo
      ? undefined
      : (resolveModelPreference(initializationResult.models, models.currentModelId) ?? undefined);
    const currentModelInfo = catalogModelInfo ?? fallbackModelInfo;
    // Register the fallback-resolved capabilities under the verbatim live id
    // so every modelInfos consumer (buildConfigOptions' effort lookup, later
    // rebuilds via session.modelInfos) agrees with the gating below. The
    // picker options themselves come from `models.availableModels`, so this
    // adds no selectable entry. The spread keeps every capability flag
    // (current and future); the identity fields are overridden because the
    // fuzzy-matched sibling's resolvedModel/displayName/description can
    // describe a different context lane and would poison later resolvedModel
    // matching (syncModelAfterRefusalFallback) and context-window inference
    // (applyConfigOptionValue) if they traveled under this id.
    // Built on the UNfiltered catalog, NOT the picker list: `modelInfos` is
    // never rendered (picker rows come from `models.availableModels`) — it
    // feeds capability lookups and `resolveModelPreference` (refusal
    // fallback), which must keep seeing deprecated rows (R4.3,
    // visibility-only filter).
    const modelInfos = fallbackModelInfo
      ? [
          ...catalogModels,
          {
            ...fallbackModelInfo,
            value: models.currentModelId,
            displayName: models.currentModelId,
            description: "",
            resolvedModel: undefined,
          },
        ]
      : catalogModels;
    const { modes, autoModeFallbackWarningPending } = await this.sessionModes.initialize({
      query: q,
      requestedMode: initialPermissionMode,
      currentModelInfo,
      currentModelId: models.currentModelId,
      allowBypass,
    });

    const agents = await discoverCustomAgents(q);
    // Only adopt the requested agent as the selected value if it's one we
    // actually surface in the picker. A built-in (filtered out above) or
    // otherwise-unknown name would leave the config option's `currentValue`
    // pointing at an entry not in its own `options` list, which clients render
    // as a blank/invalid selection.
    const requestedAgent = userProvidedOptions?.agent;
    const currentAgent =
      requestedAgent && agents.some((a) => a.name === requestedAgent)
        ? requestedAgent
        : DEFAULT_AGENT_ID;

    // Seed Fast mode from the SDK's reported state so the UI reflects reality
    // (the CLI may start a session with fast mode already on, or force it off
    // when `fastModePerSessionOptIn` is set). The toggle is only surfaced while
    // the resolved model advertises `supportsFastMode`.
    const fastModeEnabled =
      initializationResult.fast_mode_state !== undefined &&
      fastModeStateEnabled(initializationResult.fast_mode_state);
    // `fast_mode_disabled_reason` reflects the post-switch model since SDK
    // 0.3.219 (the initialize response used to answer from the spawn-time
    // model). A fresh SDK session reports `sdk_opt_in_required` — the toggle IS
    // the opt-in — which normalizes away, so only real blockers are retained.
    const fastModeDisabledReason = fastModeEnabled
      ? undefined
      : normalizeFastModeDisabledReason(initializationResult.fast_mode_disabled_reason);
    const fastMode: FastModeOptionState = {
      supported: currentModelInfo?.supportsFastMode ?? false,
      enabled: fastModeEnabled,
      useBooleanOption: clientSupportsBooleanConfigOptions(this.clientCapabilities),
      disabledReason: fastModeDisabledReason,
    };

    const workflowsDisabled = settingsManager.getSettings().disableWorkflows === true;
    const configOptions = buildConfigOptions(
      modes,
      models,
      // Catalog-based (see `modelInfos` above), matching the model-switch
      // rebuild (which passes `session.modelInfos`): `buildConfigOptions`
      // reads this argument only for the current model's effort capabilities
      // — picker rows come from `models.availableModels` — so a deprecated
      // current model keeps its effort option without leaking hidden rows
      // (R4.3).
      modelInfos,
      settingsManager.getSettings().effortLevel,
      agents,
      currentAgent,
      fastMode,
      // A fresh session's Thinking intent is untouched (undefined), so the
      // display follows the env-driven state. `thinking` already holds
      // effectiveThinkingConfig(undefined, MAX_THINKING_TOKENS) from above, so
      // reusing it avoids re-parsing (and re-logging an invalid) env var —
      // exactly one error log per query creation.
      thinking !== undefined,
      {
        // Seeded from settings, not inferred from the level: `Settings.ultracode`
        // is what the user (or a `--settings` payload) actually asked for, while
        // `xhigh` on its own is a legitimate selection that is not Ultracode.
        available: isUltracodeAvailable(
          currentModelInfo?.supportsEffort ? (currentModelInfo.supportedEffortLevels ?? []) : [],
          { disableWorkflows: workflowsDisabled },
        ),
        enabled: settingsManager.getSettings().ultracode === true,
      },
      {
        disableWorkflows: workflowsDisabled,
        // Both halves of the selector, resolved above alongside the env they
        // produced — so the row the client renders and the configuration
        // directory the query was actually started with cannot disagree.
        accounts: declaredAccounts,
        currentAccount: accountEntry?.value,
      },
    );

    // Apply the initial effort level to the SDK so it matches the UI default
    const initialEffort = configOptions.find((o) => o.id === EFFORT_CONFIG_ID);
    // The picker's resolved value, not the raw setting: `buildConfigOptions`
    // has already dropped Ultracode if this model cannot reach `xhigh`, and the
    // session must track what is displayed rather than what was requested.
    const initialUltracode =
      typeof initialEffort?.currentValue === "string" &&
      isUltracodeValue(initialEffort.currentValue);
    if (
      initialEffort &&
      typeof initialEffort.currentValue === "string" &&
      initialEffort.currentValue !== "default"
    ) {
      await q.applyFlagSettings(ultracodeFlagSettings(initialEffort.currentValue));
    }
    // Seed the context window WITHOUT any extra IPC on the session/new path.
    // On session/load, the resumed session's own `getContextUsage` report — a
    // response `getAvailableModels` already awaited to learn the live model
    // (resumed sessions ARE serviced pre-turn, unlike fresh ones) — is
    // authoritative and wins. That one response also carries how much of the
    // window is already occupied, seeded onto `contextUsedTokens` below.
    // Otherwise: the cached authoritative window if a prior turn has learned
    // it for this model (`result.modelUsage`, cross-session), else the text
    // heuristic, else the default. We deliberately do NOT issue a
    // getContextUsage call here: on a fresh session that control request is
    // not serviced until the first prompt turn runs, so awaiting it — as
    // 0.59.0 did — made session/new take ~15s (issues #886/#880). The
    // authoritative window arrives on the first `result.modelUsage` and is
    // cached from there.
    //
    // Text inference alone misses aliases that resolve to extended-context
    // models with no "1m" token anywhere in their id or description (e.g.
    // `sonnet` → claude-sonnet-5, natively ~1M): those stream
    // `usage_update.size: 200000` until the first result's modelUsage corrects
    // it — but the cache means only the FIRST session to ever run a turn on such
    // a model eats that window, not every fresh session after a process
    // restart (issue #596; a post-restart session/load is covered by the
    // resumed report above).
    //
    // The inference fallback is deliberately keyed to the catalog entry (the
    // fork's unfiltered lookup, see `catalogModelInfo` above): a
    // fallback-resolved sibling's resolvedModel/displayName/description can
    // describe a different context lane than the verbatim live id (e.g. an
    // "opus[1m]" row matched for a bare 200k id), so on the fallback path only
    // the id itself is a trustworthy window signal.
    const seededWindow =
      resumedContextWindow !== null
        ? { size: resumedContextWindow, authoritative: true }
        : immediateContextWindow(providerCacheKey, models.currentModelId, catalogModelInfo);

    this.sessions[sessionId] = {
      query: q,
      input: input,
      cancelled: false,
      cwd: params.cwd,
      // Recorded so `recreateSessionQuery` (lazy Thinking application, R1.3)
      // can rebuild an equivalent query without re-running this assembly.
      queryOptions: options,
      sessionFingerprint: computeSessionFingerprint(params),
      creationParams: params,
      settingsManager,
      titles: new SessionTitles(this, sessionId),
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      modes,
      models,
      // Catalog-based, NOT the picker list: `modelInfos` is never rendered
      // (picker rows come from `models.availableModels`) — it feeds
      // capability lookups and `resolveModelPreference` (refusal fallback),
      // which must keep seeing deprecated rows (R4.3, visibility-only filter).
      modelInfos,
      autoModeFallbackWarningShown: false,
      autoModeFallbackWarningPending,
      configOptions,
      agents,
      currentAgent,
      ultracode: initialUltracode,
      workflowsDisabled,
      declaredAccounts,
      currentAccount: accountEntry?.value,
      accountEnv,
      fastModeEnabled,
      fastModeDisabledReason,
      abortController,
      emitRawSDKMessages: sessionMeta?.claudeCode?.emitRawSDKMessages ?? false,
      forwardSubagentText,
      contextWindowSize: seededWindow.size,
      contextWindowAuthoritative: seededWindow.authoritative,
      // A resumed session's occupancy, from that same report. `null` means it
      // was never read — a fresh session, or a resumed one whose model pin
      // re-asserted (see `getAvailableModels`) — which is precisely what the
      // field's `undefined` states, so the two map onto each other. A read
      // zero is carried through AS zero: an empty resumed session has used
      // nothing, and that is a measurement, not a missing one.
      contextUsedTokens: resumedContextUsedTokens ?? undefined,
      providerCacheKey,
      taskState,
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
      messageIdToUuid: new Map(),
      sessionFailureState: createSessionFailureState(),
      fileChangeReportRequestIds: new Set(),
      fileChangeAuditSupport,
      accountUsage: new AccountUsageTracker(),
    };

    // R1.1: the account quota bars are born filled rather than waiting for a
    // push that only arrives when a limit is nearly hit. Deliberately NOT
    // awaited — for the same reason the context window above is seeded without
    // one: on a FRESH session a control request is not serviced until the first
    // turn runs, so awaiting it here would stall `session/new` for ~15s (issues
    // #886/#880). R1.1 only requires the report to be asked for before the
    // first prompt is answered, which issuing it here satisfies; the windows
    // land whenever the response does. `publishAccountUsage` never rejects, so
    // this cannot become an unhandled rejection.
    void this.publishAccountUsage(sessionId, this.sessions[sessionId]);
    // A guessed window seed (text heuristic / default) is refined the same way,
    // unawaited; a resumed session's authoritative seed makes it a no-op.
    this.refreshContextWindowInBackground(sessionId, this.sessions[sessionId]);

    return {
      sessionId,
      modes,
      configOptions,
    };
  }

  /**
   * Provider routing is baked into the environment of each SDK Query. Wait for
   * all submitted turns to settle, close every query, then resume each Claude
   * session with the same ID so subsequent turns inherit the new environment.
   */
  private async enqueueProviderUpdate(config: ProviderConfig | undefined): Promise<void> {
    const previous = this.providerUpdate?.catch(() => undefined) ?? Promise.resolve();
    const update = previous.then(async () => {
      const sessions = Object.entries(this.sessions);
      const activeTurns = sessions.flatMap(([, session]) =>
        (session.turnQueue ?? []).flatMap((turn) => (turn.completion ? [turn.completion] : [])),
      );
      if (activeTurns.length > 0) {
        this.logger.log(
          `Waiting for ${activeTurns.length} active Claude turn(s) before provider update`,
        );
        await Promise.all(activeTurns);
      }

      this.providerConfig = config;
      for (const [sessionId, session] of sessions) {
        if (this.sessions[sessionId] !== session || !session.creationParams) {
          continue;
        }
        this.logger.log(`Recreating Claude session ${sessionId} for provider update`);
        this.closeQueryStream(session);
        delete this.sessions[sessionId];
        await this.createSession(session.creationParams, { resume: sessionId });
      }
    });
    this.providerUpdate = update;
    try {
      await update;
    } finally {
      if (this.providerUpdate === update) {
        this.providerUpdate = null;
      }
    }
  }
}

function shouldEmitRawMessage(
  config: boolean | SDKMessageFilter[],
  message: { type: string; subtype?: string; origin?: SDKMessageOrigin },
): boolean {
  if (config === true) return true;
  if (config === false) return false;
  return config.some(
    (f) =>
      f.type === message.type &&
      (f.subtype === undefined || f.subtype === message.subtype) &&
      (f.origin === undefined || f.origin === message.origin?.kind),
  );
}

function sessionUsage(session: Session) {
  return {
    inputTokens: session.accumulatedUsage.inputTokens,
    outputTokens: session.accumulatedUsage.outputTokens,
    cachedReadTokens: session.accumulatedUsage.cachedReadTokens,
    cachedWriteTokens: session.accumulatedUsage.cachedWriteTokens,
    totalTokens:
      session.accumulatedUsage.inputTokens +
      session.accumulatedUsage.outputTokens +
      session.accumulatedUsage.cachedReadTokens +
      session.accumulatedUsage.cachedWriteTokens,
  };
}

/** Sum all four fields as a proxy for post-turn context occupancy: the current
 *  turn's output becomes next turn's input. Per the Anthropic API, input_tokens
 *  excludes cache tokens — cache_read and cache_creation are reported
 *  separately — so summing all four is not double-counting. */
function totalTokens(usage: UsageSnapshot): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  );
}

/** Error kinds this adapter invents itself, alongside the SDK's categorical
 *  `SDKAssistantMessageError` kinds: `no_result` marks a turn the SDK declared
 *  over without ever emitting its result (issue #825). */
type AgentErrorKind = SDKAssistantMessageError | "no_result";

/**
 * Build the `data` payload attached to a `RequestError.internalError` when we
 * have a categorical error — from the Claude SDK, or one of the adapter's own
 * kinds. Returns `undefined` when no categorical error is available, matching
 * the previous behavior of passing `undefined` to `RequestError.internalError`.
 *
 * The `errorKind` field is a convention for ACP clients to dispatch on
 * without having to pattern-match the human-readable message text. Clients
 * that don't understand it fall back to the existing message-based rendering.
 */
function errorKindData(
  errorKind: AgentErrorKind | undefined,
): { errorKind: AgentErrorKind } | undefined {
  return errorKind ? { errorKind } : undefined;
}

/** Project a nullable API usage object into our non-null snapshot shape.
 *  Both SDK message_start and assistant message `usage` have `number | null`
 *  cache fields; we coerce absent values to 0 so `totalTokens` never hits
 *  NaN. `input_tokens`/`output_tokens` are typed `number` by the SDK but
 *  synthetic or third-party-backend stream events have been observed emitting
 *  them as null/undefined — coerce those too so a malformed upstream event
 *  can't leak NaN into the wire `used` field. Delta events have different
 *  semantics (cumulative + prev fallback) and are handled inline. */
function snapshotFromUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): UsageSnapshot {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Adapt a legacy gateway `authenticate` request into the shared
 * {@link ProviderConfig} shape. Returns `null` when no gateway request is
 * present. `methodId` selects the protocol: `gateway-bedrock` → bedrock,
 * otherwise anthropic.
 */
function gatewayRequestToProviderConfig(request?: GatewayAuthRequest): ProviderConfig | null {
  if (!request?._meta) {
    return null;
  }
  return {
    apiType: request.methodId === "gateway-bedrock" ? "bedrock" : "anthropic",
    baseUrl: request._meta.gateway.baseUrl,
    headers: request._meta.gateway.headers,
  };
}

/**
 * Map a resolved provider config into the Claude Code env vars that redirect API
 * traffic and inject headers. Returns an empty object when routing is
 * unconfigured. The token/bypass placeholders (`" "`) are required so the CLI
 * skips its normal login/credential checks when a gateway is in use.
 */
function createEnvForProvider(config: ProviderConfig | null): Record<string, string> {
  if (!config) {
    return {};
  }
  const resetRouting = {
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_BEDROCK_BASE_URL: "",
    ANTHROPIC_VERTEX_BASE_URL: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    ANTHROPIC_VERTEX_PROJECT_ID: "",
    CLOUD_ML_REGION: "",
    AWS_REGION: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
  const customHeaders = Object.entries(config.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  if (config.apiType === "bedrock") {
    return {
      ...resetRouting,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "acp-proxy", // Bypass local AWS credential checks
      ANTHROPIC_BEDROCK_BASE_URL: config.baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    };
  }

  if (config.apiType === "vertex") {
    // `config.vertex` is guaranteed present for vertex by `unstable_setProvider`
    // validation; fall back to empty strings defensively.
    return {
      ...resetRouting,
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_BASE_URL: config.baseUrl,
      ANTHROPIC_VERTEX_PROJECT_ID: config.vertex?.projectId ?? "",
      CLOUD_ML_REGION: config.vertex?.region ?? "",
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    };
  }

  return {
    ...resetRouting,
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    ANTHROPIC_AUTH_TOKEN: "acp-proxy", // Bypass local Claude login checks
  };
}

/**
 * Validate a provider base URL: must be a non-empty absolute http(s) URL.
 */
function isValidBaseUrl(baseUrl: string): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

// `supportedAgents()` always returns Claude Code's built-in subagents — the
// ones used for Task-tool delegation (Explore, Plan, etc.) — even when the user
// has configured none of their own. Those aren't meaningful *main-thread*
// personas, so we filter them out and only surface the Agent picker when the
// user (or a plugin/project) has configured custom agents. Update this set if
// the SDK's built-in roster changes.
export const BUILTIN_AGENT_NAMES = new Set([
  "claude",
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
]);

// Value of the synthetic "Default" entry in the agent picker, which maps to the
// standard Claude Code agent (`applyFlagSettings({ agent: null })`). It is a
// reserved sentinel: a custom agent named exactly this would collide with it
// (two options sharing the value, selection silently routing to `null`), so we
// exclude that name from discovery.
/** Discover user/plugin/project-configured main-thread agents, excluding the
 *  built-in subagents and the reserved "default" sentinel. Returns an empty
 *  list if discovery fails so a flaky control request never blocks session
 *  creation. */
export async function discoverCustomAgents(q: Query): Promise<AgentInfo[]> {
  try {
    const agents = await q.supportedAgents();
    return agents.filter((a) => !BUILTIN_AGENT_NAMES.has(a.name) && a.name !== DEFAULT_AGENT_ID);
  } catch {
    return [];
  }
}

/** Stable ids for the session config options surfaced via `configOptions`.
 *  Centralized so the option declarations in `buildConfigOptions` and the
 *  handlers in `setSessionConfigOption`/`applyConfigOptionValue` reference the
 *  same identifiers and can't drift apart. */
export { MODE_CONFIG_ID };
export const MODEL_CONFIG_ID = "model";
export const AGENT_CONFIG_ID = "agent";
export const FAST_MODE_CONFIG_ID = "fast";

/** Select-fallback values used when the client has not opted into boolean
 *  config options (see {@link createFastModeConfigOption}). */
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";
const FAST_MODE_DESCRIPTION = "Faster responses on supported models";

/** Map the SDK's tri-state `fast_mode_state` onto the boolean config toggle.
 *  `cooldown` (fast mode temporarily suspended after a rate limit, per the SDK
 *  docs) keeps the toggle on so it reflects the user's intent — only an
 *  explicit `off` clears it. */
export function fastModeStateEnabled(state: FastModeState): boolean {
  return state !== "off";
}

/** User-facing explanations for the SDK's `fast_mode_disabled_reason` values
 *  that a user can act on (or at least wants to know about). Deliberately
 *  partial — the omitted reasons are not worth surfacing:
 *   - `sdk_opt_in_required`: every SDK session starts here (the toggle IS the
 *     opt-in), so it describes the default, not a problem.
 *   - `preference`: the user turned Fast mode off themselves.
 *   - `pending`: eligibility is still resolving; the next report supersedes it.
 *   - `unknown`: nothing meaningful to say.
 *  Unknown future reasons fall through the same way (open set — the SDK's docs
 *  say to ignore values you don't handle). */
const FAST_MODE_UNAVAILABLE_EXPLANATIONS: Partial<Record<FastModeDisabledReason, string>> = {
  free: "not available on the free plan",
  extra_usage_disabled: "requires extra usage to be enabled for this account",
  model_not_allowed: "not available for the selected model",
  not_first_party: "not available on this API provider",
  disabled_by_env: "disabled by environment configuration",
  network_error: "eligibility could not be verified (network error)",
};

/** Normalize an SDK-reported `fast_mode_disabled_reason` to the one we retain:
 *  a reason we have an explanation for, else `undefined`. Keeping only
 *  explainable reasons means state comparisons (see `syncFastModeState`) track
 *  exactly what the user can see, so routine reports like
 *  `sdk_opt_in_required` never churn the config option. */
export function normalizeFastModeDisabledReason(
  reason: FastModeDisabledReason | undefined,
): FastModeDisabledReason | undefined {
  return reason && FAST_MODE_UNAVAILABLE_EXPLANATIONS[reason] ? reason : undefined;
}

/** Whether the Client advertised support for boolean session config options
 *  (`session.configOptions.boolean`). Agents MUST only send `type: "boolean"`
 *  config options to Clients that opt in; otherwise we fall back to a `select`.
 *  See https://agentclientprotocol.com/rfds/boolean-config-option. */
export function clientSupportsBooleanConfigOptions(
  clientCapabilities?: ClientCapabilities | null,
): boolean {
  return clientCapabilities?.session?.configOptions?.boolean != null;
}

/** Build the Fast mode config option. When the Client supports boolean config
 *  options we expose a native `type: "boolean"` toggle; otherwise we degrade to
 *  a two-value `select` ("on"/"off") so older Clients still get a usable
 *  control.
 *
 *  `disabledReason` (the SDK's `fast_mode_disabled_reason`) is folded into the
 *  description while the toggle reads off, so a user whose account or provider
 *  can't serve Fast mode sees why instead of a switch that silently refuses to
 *  stay on. Ignored while enabled: a reason reported alongside an `on`/`cooldown`
 *  state isn't blocking anything right now. */
export function createFastModeConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
  disabledReason?: FastModeDisabledReason,
): SessionConfigOption {
  const explanation = enabled
    ? undefined
    : disabledReason && FAST_MODE_UNAVAILABLE_EXPLANATIONS[disabledReason];
  const base = {
    id: FAST_MODE_CONFIG_ID,
    name: "Fast mode",
    description: explanation ? `${FAST_MODE_DESCRIPTION} — ${explanation}` : FAST_MODE_DESCRIPTION,
    category: "model_config",
  } as const;

  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }

  return {
    ...base,
    type: "select",
    currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF,
    options: [
      { value: FAST_MODE_ON, name: "On" },
      { value: FAST_MODE_OFF, name: "Off" },
    ],
  };
}

/** Resolve the requested Fast mode value from a `session/set_config_option`
 *  request. Accepts a native boolean (boolean-capable Clients) or the
 *  "on"/"off" select-fallback strings. */
export function resolveFastModeEnabled(params: SetSessionConfigOptionRequest): boolean {
  const value = params.value;
  if (typeof value === "boolean") {
    return value;
  }
  if (value === FAST_MODE_ON) {
    return true;
  }
  if (value === FAST_MODE_OFF) {
    return false;
  }
  throw new Error(`Invalid value for config option ${FAST_MODE_CONFIG_ID}: ${value}`);
}

/** Per-model Fast mode state threaded into {@link buildConfigOptions}. The
 *  option is only surfaced when the current model `supported`s fast mode. */
export type FastModeOptionState = {
  supported: boolean;
  enabled: boolean;
  /** Whether the Client opted into boolean config options. */
  useBooleanOption: boolean;
  /** Latest explainable `fast_mode_disabled_reason`, folded into the option's
   *  description while the toggle reads off. */
  disabledReason?: FastModeDisabledReason;
};

export function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
  agents: AgentInfo[] = [],
  currentAgent: string = DEFAULT_AGENT_ID,
  fastMode?: FastModeOptionState,
  /** Display state for the Thinking toggle: the session's tri-state intent
   *  already collapsed to a boolean by the caller
   *  (`intent ?? (effectiveThinkingConfig(undefined, env, logger) !== undefined)`).
   *  Both session call sites always supply it (R1.1); `undefined` (direct
   *  callers/tests) omits the row. */
  thinkingEnabled?: boolean,
  /** Display state for the Ultracode entry of the effort picker. Omitted by
   *  direct callers/tests, in which case availability is derived from
   *  `settings` and the entry renders unselected. */
  ultracode?: UltracodeOptionState,
  /** Resolved session settings, read for `disableWorkflows` — the half of the
   *  Ultracode gate that is not a model capability — and, alongside them, the
   *  declared accounts plus the one in force, which decide whether an account
   *  selector is advertised at all (R6.1/R6.2). `accounts` is not a field of
   *  the SDK's `Settings`, so it is carried beside them rather than picked
   *  from them. */
  settings?: Pick<Settings, "disableWorkflows"> & AccountOptionState,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    SessionModeManager.configOption(modes),
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: models.currentModelId,
      options: models.availableModels.map((m) => {
        if (m.modelId === "default") {
          const defaultInfo = modelInfos.find((mi) => mi.value === "default");
          const resolvedModel = defaultInfo?.resolvedModel;
          if (resolvedModel) {
            const namedMatch = modelInfos.find(
              (mi) => mi.value !== "default" && mi.resolvedModel === resolvedModel,
            );
            return {
              value: m.modelId,
              name: m.name,
              description: namedMatch?.displayName ?? resolvedModel,
            };
          }
        }
        return { value: m.modelId, name: m.name, description: m.description ?? undefined };
      }),
    },
  ];

  // Add effort level option based on the currently selected model
  const currentModelInfo = modelInfos.find((m) => m.value === models.currentModelId);
  const supportedLevels = currentModelInfo?.supportsEffort
    ? (currentModelInfo.supportedEffortLevels ?? [])
    : [];

  if (supportedLevels.length > 0) {
    // Ultracode rides the effort picker as one extra entry past the last level,
    // which is where the VS Code extension draws it too. It is NOT a level (see
    // `ultracode.ts`): the entry stands for `xhigh` plus workflow orchestration,
    // and it is offered only when both halves are reachable.
    const ultracodeAvailable =
      ultracode?.available ?? isUltracodeAvailable(supportedLevels as string[], settings);

    const effortOptions = [
      { value: "default", name: "Default" },
      ...supportedLevels.map((level) => ({
        value: level,
        name: level
          .split(/[_-]/)
          .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
          .join(" "),
      })),
      ...(ultracodeAvailable
        ? [{ value: ULTRACODE_OPTION_VALUE, name: ULTRACODE_OPTION_NAME }]
        : []),
    ];

    const includes = (l: string) =>
      l === "default" ||
      (supportedLevels as string[]).includes(l) ||
      (ultracodeAvailable && l === ULTRACODE_OPTION_VALUE);
    // `effortOptionValue` resolves the flag against the level BEFORE validation,
    // so an Ultracode session on a model that dropped `xhigh` falls back to
    // "Default" through the same path any unsupported level does.
    const displayedEffort = effortOptionValue(currentEffortLevel, {
      available: ultracodeAvailable,
      enabled: ultracode?.enabled ?? false,
    });
    const validEffort = displayedEffort && includes(displayedEffort) ? displayedEffort : "default";

    options.push({
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue: validEffort,
      options: effortOptions,
    });
  }

  // Surface the Fast mode toggle only when the current model supports it. The
  // option renders as a native boolean toggle for Clients that opted in, and a
  // two-value select otherwise.
  if (fastMode?.supported) {
    options.push(
      createFastModeConfigOption(
        fastMode.enabled,
        fastMode.useBooleanOption,
        fastMode.disabledReason,
      ),
    );
  }

  // Surface the Thinking toggle whenever the caller supplies its display
  // state. Unlike Fast mode it is model-independent — no `supported` gate —
  // and select-only ("on"/"off"), so every session shows it (R1.1).
  if (thinkingEnabled !== undefined) {
    options.push(createThinkingConfigOption(thinkingEnabled));
  }

  // Only surface the Agent picker when there's a real choice — i.e. the user
  // has configured at least one custom agent (built-ins are filtered out in
  // discoverCustomAgents). With none configured, "Default" would be the only
  // entry, so we omit the option entirely.
  if (agents.length > 0) {
    options.push({
      id: AGENT_CONFIG_ID,
      name: "Agent",
      description: "Main-thread agent persona",
      type: "select",
      currentValue: currentAgent,
      options: [
        { value: DEFAULT_AGENT_ID, name: "Default", description: "Standard Claude Code agent" },
        ...agents.map((a) => ({
          value: a.name,
          name: a.name,
          description: a.description || undefined,
        })),
      ],
    });
  }

  // The account selector, last because it is the least often touched of the
  // rows and the only one that governs the NEXT thread rather than this one.
  // `createAccountConfigOption` returns undefined below two declared accounts,
  // so the row is genuinely absent there rather than present and empty (D8,
  // R6.2).
  const accountOption = createAccountConfigOption(
    settings?.accounts ?? [],
    settings?.currentAccount,
  );
  if (accountOption) {
    options.push(accountOption);
  }

  return options;
}

// Claude Code CLI persists display strings like "opus[1m]" in settings,
// but the SDK model list uses IDs like "claude-opus-4-6-1m".
const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;

// The id-suffix spelling of a context hint ("-1m" in "claude-opus-4-6-1m");
// shared by the strip and canonicalize helpers below so the two can't drift.
const CONTEXT_HINT_SUFFIX_PATTERN = /-(\d+m)$/i;

/** Remove context-window hints — the display form "[1m]" and the SDK id
 *  suffix form "-1m" — from a model string. Those digits describe context
 *  size, not model identity or generation version. */
function stripContextHints(s: string): string {
  return s.replace(/\[\d+m\]/gi, "").replace(CONTEXT_HINT_SUFFIX_PATTERN, "");
}

/** Canonicalize a model id for exact comparison: trimmed, lowercased, with
 *  the id-suffix hint spelling unified to the bracket form ("-1m" → "[1m]").
 *  The hint itself is kept — bare and 1M ids must stay distinct. */
function canonicalizeModelId(s: string): string {
  return s.trim().toLowerCase().replace(CONTEXT_HINT_SUFFIX_PATTERN, "[$1]");
}

/** The context hint a model string carries ("1m" for either spelling), or
 *  null for a bare id. */
function contextHintOf(s: string): string | null {
  return canonicalizeModelId(s).match(MODEL_CONTEXT_HINT_PATTERN)?.[1] ?? null;
}

// Captures a model family version: `4-6`/`4.7` for dated generations, or a
// bare `5` for single-number ones like "Sonnet 5". Used to keep a pinned
// `claude-opus-4-6` from matching the `opus` alias once it points at 4.7.
const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)(?:[-.](\d+))?\b/;

function extractModelFamilyVersion(s: string): string | null {
  const match = stripContextHints(s).match(MODEL_FAMILY_VERSION_PATTERN);
  if (!match) return null;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function modelVersionsCompatible(preference: string, candidate: ModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference);
  if (!preferred) return true;
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description);
  if (!candidateVersion) return true;
  return preferred === candidateVersion;
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint?: string } {
  const lower = model.trim().toLowerCase();
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase();

  const normalized = lower.replace(MODEL_CONTEXT_HINT_PATTERN, " $1 ");
  const rawTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = rawTokens
    .map((token) => {
      if (token === "opusplan") return "opus";
      if (token === "best" || token === "default") return "";
      return token;
    })
    .filter((token) => token && token !== "claude")
    .filter((token) => /[a-z]/.test(token) || token.endsWith("m"));

  return { tokens, contextHint };
}

function scoreModelMatch(model: ModelInfo, tokens: string[], contextHint?: string): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase();
  let score = 0;
  let nonHintMatched = false;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      if (token !== contextHint) nonHintMatched = true;
      score += token === contextHint ? 3 : 1;
    }
  }
  if (contextHint && !nonHintMatched) return 0;
  return score;
}

export function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null {
  const trimmed = preference.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Exact match on value or display name. Values compare on the canonical
  // hint spelling so "opus-1m" hits an "opus[1m]" row (and vice versa).
  const canonicalPreference = canonicalizeModelId(trimmed);
  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      canonicalizeModelId(model.value) === canonicalPreference ||
      model.displayName.toLowerCase() === lower,
  );
  if (directMatch) return directMatch;

  // Exact match on the alias's canonical resolved id (e.g. a pinned
  // "claude-sonnet-5" against the "sonnet" row's `resolvedModel`). SDK-
  // reported and unambiguous, so it's tried before the fuzzier tiers below.
  // Compared on the canonical hint spelling so a "-1m"-suffix pin matches a
  // "[1m]"-spelled resolvedModel instead of falling into the substring tier
  // (which would land on the bare 200k sibling). "default" is skipped first
  // since it shares a resolvedModel with whichever alias the CLI currently
  // recommends — a specific pin should land on that named alias, not
  // "default".
  const matchesResolved = (model: ModelInfo) =>
    model.resolvedModel != null && canonicalizeModelId(model.resolvedModel) === canonicalPreference;
  const resolvedMatch =
    models.find((model) => model.value !== "default" && matchesResolved(model)) ??
    models.find(matchesResolved);
  if (resolvedMatch) return resolvedMatch;

  // Substring match. Skips candidates whose context hint disagrees with the
  // preference's — a bare row must not absorb a 1M-hinted preference (nor
  // vice versa); such pairs fall through to the tokenized tier, which
  // weighs hints in its scoring and still finds the best same-family row.
  const preferenceHint = contextHintOf(trimmed);
  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false;
    if (contextHintOf(model.value) !== preferenceHint) return false;
    const value = model.value.toLowerCase();
    const display = model.displayName.toLowerCase();
    return value.includes(lower) || display.includes(lower) || lower.includes(value);
  });
  if (includesMatch) return includesMatch;

  // Tokenized matching for aliases like "opus[1m]"
  const { tokens, contextHint } = tokenizeModelPreference(trimmed);
  if (tokens.length === 0) return null;

  let bestMatch: ModelInfo | null = null;
  let bestScore = 0;
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue;
    const score = scoreModelMatch(model, tokens, contextHint);
    if (0 < score && (!bestMatch || bestScore < score)) {
      bestMatch = model;
      bestScore = score;
    }
  }

  return bestMatch;
}

/** Map the live model reported by a resumed session onto the picker's model
 *  list. The CLI restores a resumed session's model from the transcript's
 *  last assistant message, which records the concrete API id (e.g.
 *  "claude-opus-4-6") with any "[1m]" context hint dropped. Tiers, in order:
 *  1. Exact match with the Default entry's resolution — when a named alias
 *     shares Default's resolvedModel verbatim, the live id can't tell the
 *     two apart, and a never-customized session should stay on Default.
 *  2. Exact resolvedModel match on a named row. Checked before the
 *     hint-stripped Default comparison so a live "claude-sonnet-5[1m]" lands
 *     on the "sonnet[1m]" row rather than a Default that resolves to the
 *     bare "claude-sonnet-5" — the two rows differ in context window, which
 *     drives `contextWindowSize` and capability gating downstream.
 *  3. Hint-stripped match with Default's resolution — a session that never
 *     left the default resumes as the bare transcript id, and shouldn't show
 *     a concrete picker entry.
 *  4. `resolveModelPreference` over the picker entries.
 *  5. A model with no picker counterpart (e.g. excluded by an
 *     `availableModels` allowlist) is tracked verbatim, mirroring
 *     `syncModelAfterRefusalFallback`: the picker shows no selection, but the
 *     model-dependent bookkeeping stays truthful to what the SDK is running. */
export function matchResumedModel(models: ModelInfo[], liveModel: string): ModelInfo {
  const live = canonicalizeModelId(liveModel);
  const defaultEntry = models.find((m) => m.value === "default");
  const defaultResolved = defaultEntry?.resolvedModel
    ? canonicalizeModelId(defaultEntry.resolvedModel)
    : undefined;

  if (defaultEntry && defaultResolved === live) {
    return defaultEntry;
  }

  // No default-row exclusion needed: a default row matching `live` exactly
  // already returned at the tier above.
  const exactMatch = models.find(
    (m) => m.resolvedModel && canonicalizeModelId(m.resolvedModel) === live,
  );
  if (exactMatch) return exactMatch;

  if (
    defaultEntry &&
    defaultResolved &&
    stripContextHints(defaultResolved) === stripContextHints(live)
  ) {
    return defaultEntry;
  }

  return (
    resolveModelPreference(models, liveModel) ?? {
      value: liveModel,
      displayName: liveModel,
      description: "",
    }
  );
}

function resolveSettingsModel(
  models: ModelInfo[],
  settingsModel: unknown,
  logger: Logger,
): ModelInfo | null {
  if (settingsModel === undefined) {
    return null;
  }
  if (typeof settingsModel !== "string") {
    const typeLabel = settingsModel === null ? "null" : typeof settingsModel;
    logger.error(`Ignoring model from settings: expected a string, got ${typeLabel}.`);
    return null;
  }
  return resolveModelPreference(models, settingsModel);
}

/**
 * Deprecation-UNfiltered core of {@link applyAvailableModelsAllowlist}:
 * restrict the SDK's model list to the user's `availableModels` allowlist
 * (already merged-and-deduped across settings sources by `SettingsManager`).
 * The user's exact entries become the model IDs surfaced via configOptions
 * and passed to `setModel`, which prevents Claude Code from silently
 * substituting a date-pinned variant (e.g. `haiku` →
 * `claude-haiku-4-5-20251001`) that the user may not have access to.
 *
 * Display info and capability flags are copied from the closest SDK match so
 * the UI still renders sensible names and effort levels.
 *
 * Kept separate from the exported boundary so session creation can obtain the
 * allowlist-applied-but-unfiltered CATALOG that preference resolution and
 * capability lookups read (R4.3 — the deprecation filter is visibility-only).
 *
 * Semantics from https://code.claude.com/docs/en/model-config#restrict-model-selection:
 * - `undefined` is handled by the caller (no allowlist applied).
 * - The Default option is unaffected by `availableModels` — it always remains
 *   available, even when the allowlist is `[]`.
 */
function buildAllowlistedModels(
  sdkModels: ModelInfo[],
  allowlist: string[],
  settingsModelOverrides?: Record<string, string>,
): ModelInfo[] {
  // Default is always preserved per the docs. Synthesize one if the SDK
  // didn't surface it so downstream code (e.g. `getAvailableModels` picking
  // `models[0]` as a fallback) still has something to work with.
  const defaultModel = sdkModels.find((m) => m.value === "default") ?? {
    value: "default",
    displayName: "Default",
    description: "",
  };
  const result: ModelInfo[] = [defaultModel];
  const seen = new Set<string>([defaultModel.value]);

  const sdkModelsWithoutDefault = sdkModels.filter((m) => m.value !== "default");

  // Bedrock/Vertex deployments enforce short aliases (e.g. "claude-opus-4-6")
  // in availableModels but require provider-specific IDs at the API. We still
  // resolve `sdkMatch` against the alias (`trimmed`) — that's what the
  // matching heuristics above are built for, and override targets (ARNs,
  // opaque provider IDs) often won't textually resemble anything in
  // `sdkModelsWithoutDefault`. Only the entry's surfaced `value` becomes the
  // override target, so it's what `setModel` ends up passing to the API.
  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;

    const overridden = settingsModelOverrides?.[trimmed];
    const effective = overridden ?? trimmed;
    if (seen.has(effective)) continue;

    const sdkMatch = resolveModelPreference(sdkModelsWithoutDefault, trimmed);
    if (sdkMatch) {
      result.push({ ...sdkMatch, value: effective });
    } else {
      result.push({ value: effective, displayName: trimmed, description: "" });
    }
    seen.add(effective);
  }

  // The custom model option (ANTHROPIC_CUSTOM_MODEL_OPTION) is exempt from the
  // allowlist, the same way Default is. Per the model-config docs it adds an
  // entry "without replacing the built-in aliases" and "appears at the bottom of
  // the /model picker", so we append it last and skip the allowlist filter; this
  // keeps a slim alias allowlist from hiding the custom model row.
  // https://code.claude.com/docs/en/model-config#add-a-custom-model-option
  const customModelOption = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim();
  if (customModelOption && !seen.has(customModelOption)) {
    const customModel = sdkModels.find((m) => m.value === customModelOption);
    if (customModel) {
      result.push(customModel);
      seen.add(customModel.value);
    }
  }

  return result;
}

/**
 * Visibility filter for PICKER-bound model lists (R4.2): drop rows
 * {@link filterDeprecatedModels} flags as deprecated/legacy. Every
 * list-building site applies this same helper — via
 * {@link applyAvailableModelsAllowlist} when an allowlist is configured, or
 * directly on the raw SDK list otherwise — so the picker never renders a
 * deprecated row regardless of configuration.
 *
 * This is visibility-only: preference resolution and capability lookups keep
 * reading the UNfiltered catalog (R4.3), so a persisted preference pointing at
 * a deprecated model is still honored.
 *
 * Edge: if the filter would hide EVERY row, fall back to the unfiltered input
 * so config-option building never receives an empty model list, and log it.
 * The logger is optional because this is also reached from the free exported
 * boundary (tests, library callers) where no agent logger exists.
 */
function hideDeprecatedModels(models: ModelInfo[], logger?: Logger): ModelInfo[] {
  const visible = filterDeprecatedModels(models);
  if (visible.length === 0 && models.length > 0) {
    logger?.error(
      "Deprecation filter would hide every available model; showing the unfiltered list instead.",
    );
    return models;
  }
  return visible;
}

/**
 * Recency filter for the DEFAULT picker list: drop rows
 * {@link filterSupersededModels} finds to be an older generation of a family
 * the catalogue also offers current, so the picker shows one choice per family
 * rather than a version history.
 *
 * **Applied ONLY where no `availableModels` allowlist is configured**, which is
 * the one place it differs from {@link hideDeprecatedModels}. The two look
 * alike and the asymmetry is deliberate: a deprecated row is one the VENDOR
 * retired, so hiding it even when an allowlist names it is doing the user a
 * favour; a superseded row is one the user may have named ON PURPOSE — pinning
 * `claude-opus-4-8` for reproducibility is a real thing to want, and silently
 * returning fewer models than were asked for would make the setting a lie.
 * Recency tidies a list nobody curated; it never overrides one somebody did.
 *
 * The two also answer different questions, and neither subsumes the other: the
 * deprecation heuristic reads human-facing PROSE for a marker the vendor chose
 * to write, this reads the VERSION and needs no such cooperation. Measured
 * 2026-09-23, the live catalogue's six superseded rows (`claude-opus-4-6` …
 * `claude-fable-5`) carried no marker at all, so the heuristic passed every one
 * of them through.
 *
 * Visibility-only on the same terms as the sibling: preference resolution reads
 * the UNfiltered catalog, so a persisted preference on a superseded model is
 * still honored — the row leaves the picker, never the session. Same empty-list
 * fallback, for the same reason.
 */
function hideSupersededModels(models: ModelInfo[], logger?: Logger): ModelInfo[] {
  const visible = filterSupersededModels(models);
  if (visible.length === 0 && models.length > 0) {
    logger?.error(
      "Recency filter would hide every available model; showing the unfiltered list instead.",
    );
    return models;
  }
  return visible;
}

/**
 * The exported picker-list boundary: {@link buildAllowlistedModels} (the
 * user's `availableModels` allowlist semantics — see its doc) composed with
 * {@link hideDeprecatedModels} (the deprecation visibility filter, R4.2).
 *
 * The filter runs on the allowlist RESULT, not on `sdkModels`: allowlisted
 * entries copy `displayName`/`description` from their closest SDK match, so a
 * deprecated row is hidden even when the allowlist names it explicitly.
 * Entries with no SDK match copy the entry text itself into `displayName`
 * ({@link buildAllowlistedModels}), so the heuristic DOES read user-authored
 * text: a custom entry containing "legacy"/"deprecated" is hidden from the
 * picker (rare, accepted false positive — the model stays reachable via
 * `settings.model` / `ANTHROPIC_MODEL`, which resolve over the unfiltered
 * catalog).
 */
export function applyAvailableModelsAllowlist(
  sdkModels: ModelInfo[],
  allowlist: string[],
  settingsModelOverrides?: Record<string, string>,
  logger?: Logger,
): ModelInfo[] {
  return hideDeprecatedModels(
    buildAllowlistedModels(sdkModels, allowlist, settingsModelOverrides),
    logger,
  );
}

/** Read the model a resumed session is actually running (via the
 *  `getContextUsage` control request — the same source `/context` prints) and
 *  map it onto the picker, along with the report's authoritative context
 *  window (`rawMaxTokens`) and the occupancy already filling it
 *  (`totalTokens`). Resumed sessions get this request serviced before
 *  any turn runs in the new process — unlike fresh sessions, where it stalls
 *  until the first prompt turn (issues #886/#880) — so the same response that
 *  restores the live model (issue #845) also seeds the window for free,
 *  covering post-restart reloads of models the text heuristic misses (issue
 *  #596), and the occupancy with it: a thread reloaded carrying 150k of
 *  context otherwise reports `used: 0` until its first turn ends, and the
 *  client assigns that number to the ring unconditionally. All three come out
 *  of ONE response — nothing here adds a control request.
 *  Best-effort: a control-request failure is logged and returns nulls
 *  so callers keep their current choice; failing the whole session/load over
 *  an unreadable report would be worse. */
async function readResumedLiveModel(
  query: Query,
  models: ModelInfo[],
  logger: Logger,
  sessionId?: string,
): Promise<{
  model: ModelInfo | null;
  contextWindow: number | null;
  contextUsedTokens: number | null;
}> {
  // The local transcript is asked FIRST and in parallel, never instead. It is
  // the same field Claude Code itself restores a resumed query from, it is a
  // file read rather than IPC, and it answers when the control request cannot
  // — which is the case this ordering exists for: `getContextUsage` rejecting
  // used to return `model: null` and hand the session back the freshly-computed
  // default, reopening issue #845 exactly when the session was least healthy.
  //
  // Parallel, not sequential, because the two are independent and only one of
  // them is slow. It does NOT make the load faster: `Promise.allSettled`
  // finishes with the control request, so the critical path is still whatever
  // that costs. Taking the request OFF the path is the next step and it is not
  // taken here, because this fork reads THREE values out of that one response
  // — model, `rawMaxTokens` and `totalTokens` — and the window and occupancy
  // have no second source. Upstream could drop the call in #1089 because it
  // only ever wanted the model. Deferring the other two means letting
  // `session/load` answer with the default window and correcting it a turn
  // later, which is a UX decision backed by a measurement nobody has taken;
  // the `SessionTiming` phases below are what that measurement would read.
  const [transcript, usageResult] = await Promise.allSettled([
    sessionId ? readResumedSession(sessionId, logger) : Promise.resolve<ResumedSessionSnapshot>({}),
    query.getContextUsage(),
  ]);

  const timing = sessionId ? new SessionTiming(logger, "resume-model", sessionId) : null;
  const transcriptModel =
    transcript.status === "fulfilled" ? (transcript.value.model ?? null) : null;
  timing?.phase(
    "read-transcript",
    ` model=${transcriptModel ?? "unknown"} outcome=${transcript.status}`,
  );

  if (usageResult.status === "rejected") {
    timing?.phase("context-usage", " outcome=rejected");
    logger.error("Failed to read the resumed session's live model:", usageResult.reason);
    // The transcript still answers the model even though the report did not.
    return {
      model: transcriptModel ? matchResumedModel(models, transcriptModel) : null,
      contextWindow: null,
      contextUsedTokens: null,
    };
  }

  const usage = usageResult.value;
  timing?.phase("context-usage", ` model=${usage.model ?? "unknown"}`);
  {
    return {
      // Transcript first: both name the same running model, and the transcript
      // is the record the CLI itself resumes from.
      model:
        (transcriptModel ? matchResumedModel(models, transcriptModel) : null) ??
        (usage.model ? matchResumedModel(models, usage.model) : null),
      contextWindow: usage.rawMaxTokens > 0 ? usage.rawMaxTokens : null,
      // Deliberately NOT the `> 0` test the window uses: the two zeros say
      // different things. A window of zero tokens is not a window, so 0 there
      // can only be a report with nothing to say — but an occupancy of zero is
      // an answer, the genuinely empty resumed session, and folding it into
      // null would hand that session back the "absent read as 0" this seeding
      // exists to remove. Only a value that cannot be an occupancy at all
      // (negative, or a non-number from a response whose own declaration says
      // it may change shape) falls back to "not read".
      contextUsedTokens:
        Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : null,
    };
  }
}

async function getAvailableModels(
  query: Query,
  /** Deprecation-UNfiltered catalog (allowlist-applied when configured):
   *  preference resolution and the default pick read this list so a persisted
   *  deprecated preference still resolves (R4.3). */
  models: ModelInfo[],
  /** Deprecation-filtered picker list: becomes the rendered `availableModels`
   *  rows (R4.2). The resolved `currentModelId` may legitimately be absent
   *  from these rows (deprecated persisted preference) — the picker then
   *  shows no selection, mirroring the refusal-fallback bookkeeping. */
  pickerModels: ModelInfo[],
  sdkModels: ModelInfo[],
  settingsManager: SettingsManager,
  logger: Logger,
  isResumedSession: boolean,
  /** The resumed session's id, when this IS a resume. Carried only so the
   *  local transcript can be read for the live model; `isResumedSession` stays
   *  the flag every branch below tests, because a caller may legitimately know
   *  it is resuming without having an id to hand. */
  resumedSessionId?: string,
): Promise<{
  modelState: SessionModelState;
  resumedContextWindow: number | null;
  resumedContextUsedTokens: number | null;
}> {
  const settings = settingsManager.getSettings();

  let currentModel = models[0];
  let resolvedFromInput: string | undefined;
  // The context window reported alongside a resumed session's live model, and
  // the occupancy already filling it. Both stay null unless the report was
  // read, and it is read on exactly the paths where `currentModel` IS the live
  // model (no env/settings override, or an override whose re-assert failed) —
  // so the window always describes the model the session actually runs, and
  // the occupancy the context that model actually carries.
  //
  // A resumed session whose env/settings pin re-asserts SUCCESSFULLY is
  // therefore seeded with neither: the report was never asked for, and asking
  // for one here purely to seed would put a second control request on the
  // session/load path, serialized on the one channel behind the `setModel`
  // below — the cost every seeding comment in this file is written to avoid
  // (issues #886/#880). Such a session reports `used: 0` until its first turn
  // ends, exactly as every resumed session did before this seeding existed.
  let resumedContextWindow: number | null = null;
  let resumedContextUsedTokens: number | null = null;

  // Model priority (highest to lowest):
  // 1. ANTHROPIC_MODEL environment variable
  // 2. settings.model (user configuration)
  // 3. the resumed session's live model (resumed sessions only)
  // 4. models[0] (default first model)
  if (process.env.ANTHROPIC_MODEL) {
    const match = resolveModelPreference(models, process.env.ANTHROPIC_MODEL);
    if (match) {
      currentModel = match;
      resolvedFromInput = process.env.ANTHROPIC_MODEL;
    }
  } else if (typeof settings.model === "string") {
    const match = resolveSettingsModel(models, settings.model, logger);
    if (match) {
      currentModel = match;
      resolvedFromInput = settings.model;
    }
  }

  // A resumed session restores the model it was previously running (the CLI
  // re-reads it from the transcript), so without an env/settings override the
  // freshly-computed default above can disagree with what the session actually
  // runs — session/load then reports a model the session isn't using (issue
  // #845). Ask the CLI for the live model and reflect it. No `setModel` here:
  // the SDK is already running this model, and pushing a picker alias back
  // (e.g. "opus[1m]") could change the live model rather than describe it.
  if (resolvedFromInput === undefined && isResumedSession) {
    const live = await readResumedLiveModel(query, models, logger, resumedSessionId);
    currentModel = live.model ?? currentModel;
    resumedContextWindow = live.contextWindow;
    resumedContextUsedTokens = live.contextUsedTokens;
  }

  // Skip the setModel round-trip when we can prove the SDK has already landed
  // on the same model. Two cases qualify:
  //  (a) No override applied — currentModel is the SDK's own default (or, on
  //      resume, the live model read back from the SDK above); nothing to sync.
  //  (b) The resolver returned the user's input verbatim AND that value exists
  //      in the SDK's original model list — meaning no fuzzy match or
  //      allowlist rewrite was involved, and the SDK (which reads the same
  //      ANTHROPIC_MODEL / settings.json) will have arrived at the same entry.
  //      This only holds for fresh sessions: a resumed session lands on the
  //      transcript's model regardless of env/settings, so the override must
  //      be re-asserted to keep the reported model truthful.
  // Anything else (fuzzy match, allowlist-synthesized value, alias) gets a
  // setModel call so we don't drift from the user's intended pin.
  const sdkSawSameValue = sdkModels.some((m) => m.value === currentModel.value);
  const skipSetModel =
    resolvedFromInput === undefined ||
    (!isResumedSession && currentModel.value === resolvedFromInput && sdkSawSameValue);
  if (!skipSetModel) {
    try {
      await query.setModel(currentModel.value);
    } catch (error) {
      // On a fresh session the pin is a defining option — fail loudly. A
      // resumed session already runs fine on the transcript's model, so
      // failing the whole session/load over the re-assert would be worse
      // than loading with the pin unapplied (mirrors the setPermissionMode
      // containment in createSession). The SDK then stayed on the
      // transcript's model, so read that back rather than reporting the
      // pin the session isn't running.
      if (!isResumedSession) throw error;
      logger.error(`Failed to re-assert model "${currentModel.value}" on resume:`, error);
      const live = await readResumedLiveModel(query, models, logger, resumedSessionId);
      currentModel = live.model ?? currentModel;
      resumedContextWindow = live.contextWindow;
      resumedContextUsedTokens = live.contextUsedTokens;
    }
  }

  return {
    modelState: {
      // Picker rows come from the DEPRECATION-FILTERED list (`pickerModels`),
      // not the raw catalog upstream maps here: the filter is visibility-only,
      // so preference resolution and capability lookups elsewhere keep reading
      // the unfiltered catalog (R4.3).
      availableModels: pickerModels.map((model) => ({
        modelId: model.value,
        name: model.displayName,
        description: model.description,
      })),
      currentModelId: currentModel.value,
    },
    resumedContextWindow,
    resumedContextUsedTokens,
  };
}

function getAvailableSlashCommands(
  commands: SlashCommand[],
  // Names the CLI tagged terminal-bound on `system`/init (their UX lives in
  // the CLI's own terminal, which ACP clients aren't) — filtered alongside
  // the static list. Raw CLI names, matched before the MCP rename.
  terminalCommands?: readonly string[],
): AvailableCommand[] {
  const UNSUPPORTED_COMMANDS = [
    "clear",
    "cost",
    "keybindings-help",
    "login",
    "logout",
    "output-style:new",
    "release-notes",
    "todos",
  ];

  const advertised: AvailableCommand[] = commands
    .filter((command) => !terminalCommands?.includes(command.name))
    .map((command) => {
      const input = command.argumentHint
        ? {
            hint: Array.isArray(command.argumentHint)
              ? command.argumentHint.join(" ")
              : command.argumentHint,
          }
        : null;
      let name = command.name;
      if (command.name.endsWith(" (MCP)")) {
        name = `mcp:${name.replace(" (MCP)", "")}`;
      }
      return {
        name,
        description: command.description || "",
        input,
      };
    })
    .filter((command: AvailableCommand) => !UNSUPPORTED_COMMANDS.includes(command.name));

  // `/rewind` is handled fully locally by the adapter (story 006, R3.1), so it
  // is absent from the SDK command list; advertise it here with an input hint.
  // Deduped by name so a same-named SDK command (should one ever appear) wins.
  if (!advertised.some((command) => command.name === "rewind")) {
    advertised.push({
      name: "rewind",
      description: "List file checkpoints, or restore files to one with `/rewind <n>`.",
      input: { hint: "checkpoint number (omit to list)" },
    });
  }

  return advertised;
}

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7); // Remove "file://"
      const name = path.split("/").pop() || path;
      return `[@${name}](${uri})`;
    } else if (uri.startsWith("zed://")) {
      const parts = uri.split("/");
      const name = parts[parts.length - 1] || uri;
      return `[@${name}](${uri})`;
    }
    return uri;
  } catch {
    return uri;
  }
}

export function promptToClaude(prompt: PromptRequest): SDKUserMessage {
  const content: any[] = [];
  const context: any[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text": {
        let text = chunk.text;
        // change /mcp:server:command args -> /server:command (MCP) args
        const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(?:\s(.*))?$/);
        if (mcpMatch) {
          const [, server, command, args] = mcpMatch;
          text = `/${server}:${command} (MCP)${args ? ` ${args}` : ""}`;
        }
        content.push({ type: "text", text });
        break;
      }
      case "resource_link": {
        const formattedUri = formatUriAsLink(chunk.uri);
        content.push({
          type: "text",
          text: formattedUri,
        });
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          const formattedUri = formatUriAsLink(chunk.resource.uri);
          content.push({
            type: "text",
            text: formattedUri,
          });
          context.push({
            type: "text",
            text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
          });
        }
        // Ignore blob resources (unsupported)
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              data: chunk.data,
              media_type: chunk.mimeType,
            },
          });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: chunk.uri,
            },
          });
        }
        break;
      // Ignore audio and other unsupported types
      default:
        break;
    }
  }

  content.push(...context);

  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    session_id: prompt.sessionId,
    parent_tool_use_id: null,
    // ACP prompts are the user's own input relayed by the client. Stamp the
    // provenance explicitly: per the SDK, a host wrapping keyboard input must
    // send `{kind: "human"}` — an absent `origin` is treated as unattributed
    // and fails closed at the CLI's strict isHuman() trust gates (e.g. the
    // ultracode keyword opt-in honors only human-originated turns).
    origin: { kind: "human" },
  };
}

/**
 * Resolves the ACP `messageId` for a Claude SDK message (live) or a persisted
 * transcript message (replay) so chunk grouping is identical in both views.
 *
 * Assistant turns are keyed by the Anthropic API message id (`message.id`),
 * which is identical at `message_start`, on the consolidated assistant message,
 * and in the persisted transcript — unlike the per-`stream_event` uuid, which is
 * unique per event and never persisted. User messages have no API id, but they
 * are never streamed, so their (stable) SDK uuid is used instead. ACP message
 * ids are opaque strings, so no particular format is required.
 */
export function messageIdForGrouping(message: {
  type?: string;
  uuid?: string | null;
  message?: unknown;
}): string | undefined {
  if (message.type === "assistant") {
    const inner = message.message;
    const apiId =
      inner && typeof inner === "object" && "id" in inner
        ? (inner as { id?: unknown }).id
        : undefined;
    if (typeof apiId === "string" && apiId.length > 0) {
      return apiId;
    }
  }
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : undefined;
}

/**
 * Stamps an ACP `messageId` onto a session update, but only on the message/
 * thought chunk variants that carry one — tool_call/plan/etc. updates never do.
 * No-op when `messageId` is falsy, so callers can pass it through unconditionally.
 */
function applyMessageId(
  update: SessionNotification["update"],
  messageId: string | undefined,
): void {
  if (
    messageId &&
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk")
  ) {
    update.messageId = messageId;
  }
}

/** Built-in tools that drive the task list (headless/SDK sessions use these
 *  instead of TodoWrite). Their tool_use/tool_result are surfaced as `plan`
 *  snapshots rather than as tool_calls. */
function isTaskTool(toolName: string): boolean {
  return (
    toolName === "TaskCreate" ||
    toolName === "TaskUpdate" ||
    toolName === "TaskList" ||
    toolName === "TaskGet"
  );
}

/** Whether the streamed tool_use path surfaces this tool as a standalone
 *  `tool_call`. TodoWrite is rendered as a `plan` and Task* tools are
 *  suppressed (their plan snapshot is emitted at tool_result time), so neither
 *  produces a streamed tool_call/tool_call_update — which means a
 *  permission-surfaced tool_call for them (see `ensureToolCallEmitted`) must be
 *  resolved explicitly at tool_result time. */
function shouldEmitToolCall(toolName: string): boolean {
  return toolName !== "TodoWrite" && !isTaskTool(toolName) && !isFileChangeAuditTool(toolName);
}

/** Build the Claude Code-specific metadata for a tool call. Shell (Bash and
 *  PowerShell) descriptions are kept out of ACP's standard `title`, which
 *  clients may use as the shell command preview, while still giving clients
 *  access to Claude's concise human-readable title. */
function claudeCodeMetaFromToolUse(
  toolUse: {
    name: string;
    input?: unknown;
  },
  cwd?: string,
): NonNullable<ToolUpdateMeta["claudeCode"]> {
  const description =
    (toolUse.name === "Bash" || toolUse.name === "PowerShell") &&
    toolUse.input !== null &&
    typeof toolUse.input === "object" &&
    "description" in toolUse.input &&
    typeof toolUse.input.description === "string"
      ? toolUse.input.description
      : undefined;
  const skillName =
    toolUse.name === "Skill"
      ? (toolUse.input as { skill?: string } | null | undefined)?.skill
      : undefined;
  const skillPath = skillName ? resolveSkillPath(skillName, cwd) : undefined;
  return {
    toolName: toolUse.name,
    ...(description ? { title: description } : {}),
    ...((toolUse.name === "Agent" || toolUse.name === "Task") && { subagent: true as const }),
    ...(skillName ? { skill: skillName } : {}),
    ...(skillPath ? { skillPath } : {}),
  };
}

/** Roots a skill's directory may sit under, relative to the directory the scope resolves to. */
const SKILL_CONTAINER_DIRS = [".claude/skills", ".agents/skills"] as const;

/**
 * Absolute path of a skill's `SKILL.md`, or `undefined` when none of the known layouts holds one.
 *
 * The `Skill` tool reports only the skill's name, so the file has to be located by probing the layouts skills
 * actually use: project- and user-level `.claude/skills` (plus this repo's `.agents/skills` source of truth), and
 * for a `<prefix>:<name>` spelling either a plugin (`.claude/plugins/<prefix>/skills/<name>`) or a
 * directory-scoped skill (`<prefix>/.claude/skills/<name>`), which share that spelling. Only a path that exists
 * on disk is returned, so a wrong guess costs nothing and clients never render a link to a missing file.
 */
function resolveSkillPath(skillName: string, cwd?: string): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const colon = skillName.indexOf(":");
  const scope = colon < 0 ? undefined : skillName.slice(0, colon);
  const name = colon < 0 ? skillName : skillName.slice(colon + 1);
  if (!name) {
    return undefined;
  }
  const candidates: string[] = [];
  const addCandidates = (base: string) => {
    for (const container of SKILL_CONTAINER_DIRS) {
      candidates.push(path.join(base, container, name, "SKILL.md"));
    }
  };
  if (scope) {
    // A `<prefix>:<name>` skill is either directory-scoped or a plugin's; both spellings look identical.
    addCandidates(path.join(cwd, scope));
    candidates.push(path.join(cwd, ".claude/plugins", scope, "skills", name, "SKILL.md"));
  }
  addCandidates(cwd);
  addCandidates(os.homedir());
  return candidates.find((candidate) => existsSync(candidate));
}

/** Build the `tool_call` (or, with `refine`, the `tool_call_update`)
 *  notification for a tool_use. Shared by every site that surfaces a tool call:
 *  the streamed tool_use path (first encounter → tool_call, later encounter →
 *  refine) and the permission flow (`ensureToolCallEmitted`), so they can't
 *  drift. The initial `tool_call` carries `status: "pending"` and, for shell
 *  tools, the `terminal_info` _meta that the later `terminal_output`/`terminal_exit`
 *  updates key off of, and the programmatic tool `name` (ACP's tool-call-name
 *  RFD); a refining `tool_call_update` carries none of these. `name` is set
 *  once at first report — on a v1 update, omitting it means "unchanged", and
 *  the tool behind a `toolCallId` never changes. */
function toolCallNotification(
  toolUse: { id: string; name: string; input: unknown },
  rawInput: unknown,
  supportsTerminalOutput: boolean,
  cwd?: string,
  refine = false,
): SessionNotification["update"] {
  if (refine) {
    return {
      _meta: { claudeCode: claudeCodeMetaFromToolUse(toolUse, cwd) } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      rawInput,
      ...toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd),
    };
  }
  return {
    _meta: {
      claudeCode: claudeCodeMetaFromToolUse(toolUse, cwd),
      ...((toolUse.name === "Bash" || toolUse.name === "PowerShell") && supportsTerminalOutput
        ? { terminal_info: { terminal_id: toolUse.id } }
        : {}),
    } satisfies ToolUpdateMeta,
    toolCallId: toolUse.id,
    sessionUpdate: "tool_call",
    name: toolUse.name,
    rawInput,
    status: "pending",
    ...toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd),
  };
}

/** Refine a pending tool call from the complete top-level fields recovered
 *  from its still-streaming input. Shares `toolInfoFromToolUse` with the
 *  consolidated path but never carries `content`: content built from partial
 *  input is misleading (an Edit missing its `new_string` renders as a pure
 *  deletion) or invalid (a Write diff without `content` lacks the required
 *  `newText`), and the consolidated message supplies it moments later. */
function streamedInputRefinement(
  toolUse: { id: string; name: string },
  input: Record<string, unknown>,
  supportsTerminalOutput: boolean,
  cwd?: string,
): SessionNotification["update"] | undefined {
  // TodoWrite/Task* never surfaced a tool_call to refine (plan lane).
  if (!shouldEmitToolCall(toolUse.name)) {
    return undefined;
  }
  const { title, kind, locations } = toolInfoFromToolUse(
    { ...toolUse, input },
    supportsTerminalOutput,
    cwd,
  );
  return {
    _meta: {
      claudeCode: claudeCodeMetaFromToolUse({ ...toolUse, input }, cwd),
    } satisfies ToolUpdateMeta,
    toolCallId: toolUse.id,
    sessionUpdate: "tool_call_update",
    rawInput: input,
    title,
    kind,
    ...(locations ? { locations } : {}),
  };
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    // Tracks tool_use ids already emitted as a `tool_call` so a permission
    // request (which emits the tool_call eagerly) and the streamed tool_use
    // chunk don't both emit one — whichever arrives second emits a
    // `tool_call_update` instead. Mutated in place. When omitted, the
    // tool_call/update decision falls back to `toolUseCache` presence (the
    // historical single-source behavior).
    emittedToolCalls?: Set<string>;
    // Opaque id identifying the message these chunks belong to (ACP message ids
    // are opaque strings — no particular format is required). Attached to
    // user/agent message and thought chunks so clients can group streamed chunks
    // into a single message. Omit it (leave undefined) when unknown — never send
    // an explicit `null`.
    messageId?: string;
    // The SDK user message's `tool_use_result`: the structured Output object of
    // the tool_result this message carries (shape is per-tool). Used to render
    // Agent/Task results from the structured subagent report instead of the raw
    // text (which ends in a model-directed agentId/usage trailer).
    toolUseResult?: unknown;
    // The SDK user message's `tool_result_meta` sidecar, passed raw (it's
    // untyped in sdk.d.ts) and validated by `parseToolResultMeta`. Stamps
    // denied/interrupted tool_call_updates with why the tool never ran.
    toolResultMeta?: unknown;
  },
): SessionNotification[] {
  const taskState = options?.taskState ?? new Map();
  const registerHooks = options?.registerHooks !== false;
  const supportsTerminalOutput = options?.clientCapabilities?._meta?.["terminal_output"] === true;
  if (typeof content === "string") {
    if (content.length === 0 || containsFileChangeAuditMarker(content)) {
      return [];
    }
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };
    applyMessageId(update, options?.messageId);

    if (options?.parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId: options.parentToolUseId,
        },
      };
    }

    return [{ sessionId, update }];
  }

  // `tool_use_result` is message-level and carries no tool_use_id of its own:
  // it describes "the" tool_result block of the message it rode in on. If
  // several tool_result blocks were ever batched into one message it couldn't
  // be attributed, so it is only honored when the message carries exactly one.
  const toolUseResult =
    options?.toolUseResult !== undefined &&
    content.filter((c) => typeof c === "object" && c !== null && c.type === "tool_result")
      .length === 1
      ? options.toolUseResult
      : undefined;

  // Unlike `tool_use_result`, entries carry their own tool_use_id, so batched
  // messages need no single-block guard.
  const toolResultMeta = parseToolResultMeta(options?.toolResultMeta);
  // A report-phase assistant message may contain a short text preface and the
  // internal tool call in the same content array. Hide the whole message, not
  // only the tool block, so it stays absent on session replay as well as live.
  const containsFileChangeAuditToolUse = content.some(
    (chunk) =>
      (chunk.type === "tool_use" ||
        chunk.type === "server_tool_use" ||
        chunk.type === "mcp_tool_use") &&
      isFileChangeAuditTool(chunk.name),
  );

  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
      case "text_delta": {
        if (
          chunk.text &&
          !containsFileChangeAuditToolUse &&
          !containsFileChangeAuditMarker(chunk.text)
        ) {
          update = {
            sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            content: {
              type: "text",
              text: chunk.text,
            },
          };
        }
        break;
      }
      case "image":
        if (!containsFileChangeAuditToolUse)
          update = {
            sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            content: {
              type: "image",
              data: chunk.source.type === "base64" ? chunk.source.data : "",
              mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
              uri: chunk.source.type === "url" ? chunk.source.url : undefined,
            },
          };
        break;
      case "thinking":
      case "thinking_delta": {
        // Recent models default `thinking.display` to "omitted", which streams
        // signature-only thinking blocks whose text is empty.
        if (chunk.thinking && !containsFileChangeAuditToolUse) {
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: chunk.thinking,
            },
          };
        }
        break;
      }
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;
        if (isFileChangeAuditTool(chunk.name)) {
          // Wrapper-owned audit protocol: never surface or register generic
          // PostToolUse callbacks for the internal tool.
        } else if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object or undefined
          if (Array.isArray(chunk.input?.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else if (isTaskTool(chunk.name)) {
          // Task* tool_use is suppressed; the plan update is emitted at
          // tool_result time once we have the task ID (for TaskCreate) and
          // confirmation that the change took effect.
        } else {
          // Only register hooks on first encounter to avoid double-firing
          if (registerHooks && !alreadyCached) {
            // Capture the tool name in the closure rather than re-reading the
            // cache when the hook fires. The cache entry is pruned at
            // tool_result time, and a PostToolUse hook can fire after that, so
            // closing over the name keeps the diff working without depending on
            // (or pinning) the cache entry's lifetime.
            const toolName = chunk.name;
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                // Both `Edit` and `Write` produce a structuredPatch in their
                // PostToolUse tool_response. For Edit the diff replaces the
                // optimistic content built at tool_use time. For Write the
                // optimistic content (built from `input.content` alone with
                // `oldText: null`) shows "creation" semantics regardless of
                // whether the file existed; the structuredPatch from the
                // hook lets us emit the real diff for `type: "update"`. The
                // helper returns `{}` if the response shape isn't usable.
                const editDiff =
                  toolName === "Edit" || toolName === "Write"
                    ? toolUpdateFromDiffToolResponse(toolResponse)
                    : {};
                const update: SessionNotification["update"] = {
                  _meta: {
                    claudeCode: {
                      toolResponse,
                      toolName,
                    },
                  } satisfies ToolUpdateMeta,
                  toolCallId: toolUseId,
                  sessionUpdate: "tool_call_update",
                  ...editDiff,
                };
                await client.sessionUpdate({
                  sessionId,
                  update,
                });
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }

          // Emit a `tool_call` only the first time this id surfaces to the
          // client; afterwards refine it with a `tool_call_update`. The first
          // surface may be this stream chunk OR an earlier permission request
          // (see `ensureToolCallEmitted`), so emission is tracked separately
          // from `toolUseCache`. Without an `emittedToolCalls` set we fall back
          // to cache presence — the historical streaming-only behavior.
          const emittedToolCalls = options?.emittedToolCalls;
          const alreadyEmitted = emittedToolCalls ? emittedToolCalls.has(chunk.id) : alreadyCached;
          emittedToolCalls?.add(chunk.id);

          if (alreadyEmitted) {
            // Already surfaced (full assistant message after streaming, or a
            // permission request emitted it first) — refine with a
            // tool_call_update rather than emitting a duplicate tool_call.
            update = toolCallNotification(
              chunk,
              rawInput,
              supportsTerminalOutput,
              options?.cwd,
              true,
            );
          } else {
            // First surface (streaming content_block_start or replay) — send as
            // tool_call (with terminal_info for Bash).
            update = toolCallNotification(chunk, rawInput, supportsTerminalOutput, options?.cwd);
          }
        }
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        const wasEmitted = options?.emittedToolCalls?.has(chunk.tool_use_id) === true;
        options?.emittedToolCalls?.delete(chunk.tool_use_id);
        // Why this is_error result carries harness prose instead of tool
        // output (user-rejected / interrupted / …), when the SDK said so.
        // Spread into the claudeCode meta of every update emitted below; the
        // untracked-tool fallback can't carry it (claudeCode metas always
        // carry `toolName`, which is unknown there).
        const nonExecution = toolResultMeta?.get(chunk.tool_use_id);
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          // The permission flow may have surfaced this tool_call even though
          // its tool_use never reached the cache (e.g. the assistant message
          // carrying it was dropped by the cancelled-turn guard and a straggler
          // result landed later). Resolve the surfaced call anyway so it can't
          // stay pending in the client forever; without the cache entry the
          // tool name is unknown, so no claudeCode meta is attached.
          if (wasEmitted) {
            output.push({
              sessionId,
              update: {
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
                status:
                  "is_error" in chunk && chunk.is_error
                    ? ("failed" as const)
                    : ("completed" as const),
                rawOutput: chunk.content,
              },
            });
          }
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (isFileChangeAuditTool(toolUse.name)) {
          delete toolUseCache[chunk.tool_use_id];
          break;
        }

        // A permission request may have surfaced a plan-rendered (TodoWrite) or
        // suppressed (Task*) tool as a real tool_call so the request referenced
        // a tool call the client knows about (see `ensureToolCallEmitted`,
        // issue #851). The branches below never emit a tool_call_update for
        // those tools, which would leave the surfaced call pending in the
        // client forever — resolve it here. `wasEmitted` is only ever true for
        // these tools via the permission flow: the streamed plan/suppressed
        // branches don't record emissions.
        if (wasEmitted && !shouldEmitToolCall(toolUse.name)) {
          output.push({
            sessionId,
            update: {
              _meta: {
                claudeCode: {
                  toolName: toolUse.name,
                  ...(nonExecution ?? {}),
                  ...(options?.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}),
                },
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.tool_use_id,
              sessionUpdate: "tool_call_update" as const,
              status:
                "is_error" in chunk && chunk.is_error
                  ? ("failed" as const)
                  : ("completed" as const),
              rawOutput: chunk.content,
            },
          });
        }

        if (isTaskTool(toolUse.name)) {
          // Headless/SDK sessions emit Task* tools instead of TodoWrite.
          // TaskCreate / TaskUpdate mutate the accumulated task list. TaskList
          // reconciles it from the SDK's authoritative snapshot, which repairs
          // resumed or compacted sessions whose creating calls are no longer in
          // replay history. TaskGet is read-only and remains suppressed. Plan
          // updates always carry the full accumulated snapshot, mirroring the
          // legacy TodoWrite behavior.
          const isError = "is_error" in chunk && chunk.is_error;
          let shouldEmitTaskPlan = false;
          if (!isError) {
            if (toolUse.name === "TaskCreate") {
              applyTaskCreate(
                taskState,
                toolUse.input as Parameters<typeof applyTaskCreate>[1],
                parseTaskCreateOutput(toolUseResult) ?? parseTaskCreateOutput(chunk.content),
              );
              shouldEmitTaskPlan = true;
            } else if (toolUse.name === "TaskUpdate") {
              const input = toolUse.input as Parameters<typeof applyTaskUpdate>[1];
              const output =
                parseTaskUpdateOutput(toolUseResult, input?.taskId) ??
                parseTaskUpdateOutput(chunk.content, input?.taskId);
              // Older CLI transcripts have no structured output, so retain the
              // input-based fallback. When an output is available, only apply a
              // confirmed update for the same task.
              if (!output || (output.success && output.taskId === input?.taskId)) {
                applyTaskUpdate(taskState, input);
                shouldEmitTaskPlan = true;
              }
            } else if (toolUse.name === "TaskList") {
              const output =
                parseTaskListOutput(toolUseResult) ?? parseTaskListOutput(chunk.content);
              if (output) {
                applyTaskList(taskState, output);
                shouldEmitTaskPlan = true;
              }
            }
          }
          if (shouldEmitTaskPlan) {
            update = {
              sessionUpdate: "plan",
              entries: taskStateToPlanEntries(taskState),
            };
          }
        } else if (toolUse.name !== "TodoWrite") {
          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput,
            toolUseResult,
          );

          // When terminal output is supported, send terminal_output as a
          // separate notification to match codex-acp's streaming lifecycle:
          //   1. tool_call       → _meta.terminal_info  (already sent above)
          //   2. tool_call_update → _meta.terminal_output (sent here)
          //   3. tool_call_update → _meta.terminal_exit  (sent below with status)
          if (toolMeta?.terminal_output) {
            output.push({
              sessionId,
              update: {
                _meta: {
                  terminal_output: toolMeta.terminal_output,
                  ...(options?.parentToolUseId
                    ? { claudeCode: { parentToolUseId: options.parentToolUseId } }
                    : {}),
                },
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
              },
            });
          }

          update = {
            _meta: {
              claudeCode: {
                toolName: toolUse.name,
                ...(nonExecution ?? {}),
              },
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            // terminal_output already carried the exact bytes in the preceding
            // update. Repeating them as rawOutput wastes bandwidth and lets a
            // client accidentally render the same output twice.
            ...(toolMeta?.terminal_output
              ? {}
              : { rawOutput: exitPlanModeRawOutput(toolUse.name, chunk.content) }),
            ...toolUpdate,
          };
        }
        // The tool_use is fully resolved now — drop it so a long session doesn't
        // retain every tool call. The PostToolUse hook (Edit/Write diffs) closes
        // over the tool name and no longer reads the cache, so pruning here is
        // safe regardless of hook/result ordering.
        delete toolUseCache[chunk.tool_use_id];
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
      case "compaction":
      case "compaction_delta":
      case "advisor_tool_result":
      case "fallback":
      case "mcp_tool_listing":
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      if (options?.parentToolUseId) {
        update._meta = {
          ...update._meta,
          claudeCode: {
            ...(update._meta?.claudeCode || {}),
            parentToolUseId: options.parentToolUseId,
          },
        };
      }
      applyMessageId(update, options?.messageId);
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
    emittedToolCalls?: Set<string>;
    messageId?: string;
    streamedToolInputs?: StreamedToolInputCache;
  },
): SessionNotification[] {
  const event = message.event;
  const streamKey = message.parent_tool_use_id ?? "";
  const streamedToolInputs = options?.streamedToolInputs;
  const forwardedOptions = {
    clientCapabilities: options?.clientCapabilities,
    parentToolUseId: message.parent_tool_use_id,
    cwd: options?.cwd,
    taskState: options?.taskState,
    emittedToolCalls: options?.emittedToolCalls,
    messageId: options?.messageId,
  };
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      if (
        streamedToolInputs &&
        (block.type === "tool_use" ||
          block.type === "server_tool_use" ||
          block.type === "mcp_tool_use")
      ) {
        let inputsForMessage = streamedToolInputs.get(streamKey);
        if (!inputsForMessage) {
          inputsForMessage = new Map();
          streamedToolInputs.set(streamKey, inputsForMessage);
        }
        inputsForMessage.set(event.index, {
          id: block.id,
          name: block.name,
          partialJson: "",
          scannedTo: 0,
          inString: false,
          escaped: false,
          objectDepth: 0,
          arrayDepth: 0,
          lastTopLevelComma: -1,
          emittedThroughComma: -1,
        });
      }
      return toAcpNotifications(
        [block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        forwardedOptions,
      );
    }
    case "content_block_delta": {
      if (event.delta.type === "input_json_delta") {
        const streamedInput = streamedToolInputs?.get(streamKey)?.get(event.index);
        if (!streamedInput) return [];

        streamedInput.partialJson += event.delta.partial_json;
        if (scanStreamedToolInput(streamedInput)) {
          // Input complete: the consolidated assistant message replays the
          // block with its full input and refines the call there; emitting
          // here too would send a duplicate identical update.
          const inputsForMessage = streamedToolInputs?.get(streamKey);
          inputsForMessage?.delete(event.index);
          if (inputsForMessage?.size === 0) streamedToolInputs?.delete(streamKey);
          return [];
        }
        if (streamedInput.lastTopLevelComma <= streamedInput.emittedThroughComma) {
          return [];
        }
        streamedInput.emittedThroughComma = streamedInput.lastTopLevelComma;
        const input = recoveredToolInput(
          streamedInput.partialJson.slice(0, streamedInput.lastTopLevelComma),
        );
        if (!input) return [];
        const supportsTerminalOutput =
          options?.clientCapabilities?._meta?.["terminal_output"] === true;
        const update = streamedInputRefinement(
          streamedInput,
          input,
          supportsTerminalOutput,
          options?.cwd,
        );
        if (!update) return [];
        if (message.parent_tool_use_id) {
          update._meta = {
            ...update._meta,
            claudeCode: {
              ...(update._meta?.claudeCode || {}),
              parentToolUseId: message.parent_tool_use_id,
            },
          };
        }
        applyMessageId(update, options?.messageId);
        return [{ sessionId, update }];
      }
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        forwardedOptions,
      );
    }
    // No content. `ping` is a Messages-API keep-alive event that the SDK's
    // `BetaRawMessageStreamEvent` union doesn't include even though the
    // wire format emits it; the `as never` cast lets us no-op it here
    // instead of letting it fall through to `unreachable`.
    case "ping" as never:
    case "message_delta":
      return [];
    // A message boundary ends every input stream on this lane: message_stop is
    // the normal end, and a message_start clears anything a prior message on
    // the lane left behind (e.g. a stream cut short mid-block).
    case "message_start":
    case "message_stop":
      streamedToolInputs?.delete(streamKey);
      return [];
    case "content_block_stop": {
      const inputsForMessage = streamedToolInputs?.get(streamKey);
      inputsForMessage?.delete(event.index);
      if (inputsForMessage?.size === 0) streamedToolInputs?.delete(streamKey);
      return [];
    }

    default:
      unreachable(event, logger);
      return [];
  }
}

/** Run a `session/prompt` while honoring `$/cancel_request` for it. ACP clients
 *  normally stop a turn with the `session/cancel` notification, but `signal`
 *  (the prompt request's abort signal) also fires when the client sends the
 *  generic `$/cancel_request` for this prompt — the protocol's complementary
 *  cancellation fallback. Route that to the same `agent.cancel` path so a client
 *  using only the generic mechanism still stops the turn (and the prompt
 *  resolves "cancelled" instead of running to completion).
 *
 *  The listener is scoped to this call: once the prompt settles it is removed,
 *  so a later teardown-time abort of the (per-request) signal can't cancel a
 *  subsequent turn. `signal` also aborts on connection close, in which case
 *  cancelling the in-flight turn is the desired behavior anyway. */
export async function runPromptWithCancellation(
  agent: Pick<ClaudeAcpAgent, "prompt" | "cancel" | "logger">,
  params: PromptRequest,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const onAbort = () => {
    // Fire-and-forget: nothing awaits this listener, so swallow (and log) any
    // rejection rather than surfacing it as an unhandled rejection.
    agent.cancel({ sessionId: params.sessionId }).catch((error) => {
      agent.logger.error(`Failed to cancel prompt via $/cancel_request: ${error}`);
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await agent.prompt(params);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function runAcp(logger?: Logger) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);

  // `connect(...)` returns a connection-scoped peer handle (`connection.client`)
  // that stays valid for the whole connection, so the agent captures it once.
  // Handlers close over `agent`, which is assigned synchronously right after
  // `connect()` returns — before the connection processes any inbound message.
  // It cannot be `const`: its value depends on `connection.client`, which does
  // not exist until `connect()` has been called.
  // eslint-disable-next-line prefer-const
  let agent: ClaudeAcpAgent;
  const connection = acpAgent({ name: agentName })
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
    .onRequest(methods.agent.session.fork, (ctx) => agent.unstable_forkSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      agent.setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
    .onRequest(methods.agent.providers.list, (ctx) => agent.unstable_listProviders(ctx.params))
    .onRequest(methods.agent.providers.set, (ctx) => agent.unstable_setProvider(ctx.params))
    .onRequest(methods.agent.providers.disable, (ctx) => agent.unstable_disableProvider(ctx.params))
    .onRequest(methods.agent.logout, (ctx) => agent.logout(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) =>
      runPromptWithCancellation(agent, ctx.params, ctx.signal),
    )
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .onRequest<SteerRequest, SteerResponse>(STEER_METHOD, { parse: parseSteerRequest }, (ctx) =>
      agent.steer(ctx.params),
    )
    .onRequest<GoalRequest, GoalControlResponse>(
      GOAL_CONTROL_METHOD,
      { parse: parseGoalRequest },
      (ctx) => agent.goal(ctx.params),
    )
    .connect(stream);

  agent = new ClaudeAcpAgent(new ClientConnection(connection.client), logger);
  return { connection, agent };
}

function commonPrefixLength(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i;
}

/** Best-effort first guess of a model's context window, used to seed the
 *  window synchronously (via `immediateContextWindow`) until a `result` message
 *  arrives with the authoritative `modelUsage` value.
 *
 *  Anthropic 1M-context variants encode "1m" as a distinct token in the SDK
 *  model ID (e.g., "claude-opus-4-6-1m"), which `\b1m\b` catches without also
 *  matching things like "10m" or embedded substrings. Semantic aliases like
 *  `default` carry no such token in the ID, but their `resolvedModel` and the
 *  SDK's human-facing `displayName`/`description` can (e.g.
 *  "claude-opus-4-8[1m]", "Opus 4.7 (1M context)"), so callers pass those too.
 *  This text scan can't catch every model — some resolve to extended-context
 *  models with no "1m" anywhere (e.g. `sonnet` → claude-sonnet-5, natively
 *  ~1M). Such a miss falls back to the default window and is corrected by
 *  `result.modelUsage` (and cached) within one turn. We do NOT consult the
 *  SDK's `getContextUsage` to close that gap: on a fresh session it is not
 *  serviced before the first prompt turn (issues #886/#880, see
 *  `contextWindowCache`; resumed sessions do get it, via
 *  `readResumedLiveModel`). */
function inferContextWindowFromModel(...texts: Array<string | undefined>): number | null {
  if (texts.some((text) => text != null && /\b1m\b/i.test(text))) return 1_000_000;
  return null;
}

/** Fetch the SDK's authoritative context-window occupancy via the
 *  `getContextUsage` control request. Unlike the per-message API usage numbers
 *  (which only count message tokens), this `totalTokens` includes the system
 *  prompt, tool schemas, MCP tools, and memory-file overhead — the real
 *  occupancy the user sees. Returns `null` on any control-request failure. */
async function fetchContextUsedTokens(query: Query, logger: Logger): Promise<number | null> {
  try {
    const usage = await query.getContextUsage();
    return usage.totalTokens;
  } catch (error) {
    logger.error("Failed to fetch context usage from SDK:", error);
    return null;
  }
}

/** Cross-session cache of authoritative context windows, keyed by
 *  `${providerCacheKey}\0${modelId}` (see {@link contextWindowCacheKey}).
 *  The window is a property of (model id, backend): the same resolved model id
 *  (e.g. "claude-sonnet-5[1m]", the spelling of the `result.modelUsage` keys)
 *  can name different context lanes behind different base URLs, routing
 *  headers, or credentials, so the key carries both. Caching it module-level
 *  lets a later session/new or switch that resolves to the same (backend,
 *  model) — in this session or any other, within the adapter's lifetime — seed
 *  the correct window synchronously with no IPC. Keying on the resolved id
 *  (rather than the picker value) means aliases that resolve to the same
 *  concrete model share one entry; the result handler additionally writes the
 *  bare assistant-message spelling so seed-time reads that fall back to a
 *  verbatim live id (rows without `resolvedModel`) can hit too.
 *
 *  Populated authoritatively by each `result.modelUsage` a turn confirms (see
 *  the consumer's result handler). We deliberately never populate it from a
 *  fresh session's `getContextUsage`: before that session's first prompt turn
 *  has run the control request is not serviced (it stalls ~15s, and serializes
 *  ahead of an awaited `setModel` — issues #886/#880, regressed in 0.59.0), so
 *  it can neither beat the first `result` nor be issued cheaply before one.
 *  Resumed sessions are the exception — their report IS serviced pre-turn, and
 *  the session/load path seeds (but does not cache) the window from the same
 *  response that restores the live model, see `readResumedLiveModel`.
 *  Cleared on `logout`: 1M-context entitlement can differ per account/tier, so
 *  windows learned under one login must not seed sessions under the next. */
const contextWindowCache = new Map<string, number>();

/** The env vars that determine which LLM backend — and which context lane on
 *  it — a query's API traffic reaches: endpoint selection (base URLs and the
 *  Bedrock/Vertex switches with their project/region), routing/beta headers
 *  (an `anthropic-beta: context-1m-…` header flips the same model id at the
 *  same endpoint between context lanes), and credential identity (extended
 *  context is entitlement-gated per account). Used to derive the
 *  provider-cache key from the exact env a query is created with, so
 *  `providers/set` config, per-session `_meta` env overrides, and ambient
 *  process env are all distinguished exactly as the CLI will see them. */
const PROVIDER_ROUTING_ENV_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "AWS_REGION",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Stable identifier for the LLM backend a session's query is created against,
 *  used to scope {@link contextWindowCache} per backend. Positional `\0`-join
 *  of {@link PROVIDER_ROUTING_ENV_VARS} values, so no segment can masquerade
 *  as another and unset vars everywhere yield one stable "default" bucket.
 *  Header/credential values can be secrets; the key only ever lives as an
 *  in-memory Map key and is never logged or surfaced. Over-keying is the safe
 *  side: a var change that didn't really change the backend costs one cache
 *  miss (heuristic seed until the next result), while under-keying would serve
 *  one backend's window for another's. */
function providerCacheKeyFor(env: Record<string, string | undefined>): string {
  return PROVIDER_ROUTING_ENV_VARS.map((name) => env[name] ?? "").join("\0");
}

/** Compose the `contextWindowCache` key from a session's provider key and a
 *  model id. `\0`-joined so the model segment can't collide with a provider
 *  segment. */
function contextWindowCacheKey(providerCacheKey: string, modelId: string): string {
  return `${providerCacheKey}\0${modelId}`;
}

function cacheContextWindow(modelKey: string, window: number): void {
  if (window > 0) {
    contextWindowCache.set(modelKey, window);
  }
}

/** The context window to report *right now* for a model, with NO IPC on the
 *  critical path: the cached authoritative value if we've learned it (from a
 *  prior turn's `result.modelUsage`, this or any session on the same backend),
 *  else the text heuristic over the model row's identity strings, else the
 *  default. Derives the cache key itself — `modelInfo?.resolvedModel ?? modelId`,
 *  the same rule at every seed site — so read keys can't drift from the write
 *  site's spelling. `authoritative` reports whether the value came from the
 *  cache: an authoritative window can legitimately equal
 *  DEFAULT_CONTEXT_WINDOW, so the value alone can't tell the caller. */
function immediateContextWindow(
  providerCacheKey: string,
  modelId: string,
  modelInfo?: Pick<ModelInfo, "resolvedModel" | "displayName" | "description">,
): { size: number; authoritative: boolean } {
  const cached = contextWindowCache.get(
    contextWindowCacheKey(providerCacheKey, modelInfo?.resolvedModel ?? modelId),
  );
  if (cached !== undefined) return { size: cached, authoritative: true };
  return {
    size:
      inferContextWindowFromModel(
        modelId,
        modelInfo?.resolvedModel,
        modelInfo?.displayName,
        modelInfo?.description,
      ) ?? DEFAULT_CONTEXT_WINDOW,
    authoritative: false,
  };
}

function parseModelConfig(
  raw: string | undefined,
): { modelOverrides?: Record<string, string>; availableModels?: string[] } | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLAUDE_MODEL_CONFIG must be a JSON object");
  }
  const result: { modelOverrides?: Record<string, string>; availableModels?: string[] } = {};
  if (parsed.modelOverrides !== undefined) result.modelOverrides = parsed.modelOverrides;
  if (parsed.availableModels !== undefined) result.availableModels = parsed.availableModels;
  return Object.keys(result).length > 0 ? result : undefined;
}

function getMatchingModelUsage(modelUsage: Record<string, ModelUsage>, currentModel: string) {
  let bestKey: string | null = null;
  let bestLen = 0;

  for (const key of Object.keys(modelUsage)) {
    const len = commonPrefixLength(key, currentModel);
    if (len > bestLen) {
      bestLen = len;
      bestKey = key;
    }
  }

  if (bestKey) {
    // `bestKey` is the SDK's resolved model id (e.g. "claude-sonnet-5[1m]"),
    // the same spelling as ModelInfo.resolvedModel — the primary key the
    // window is cached under. `currentModel` (the assistant message's
    // `.model`) can be the bare form (e.g. "claude-sonnet-5"); the result
    // handler caches under that spelling too, for seed-time reads that fall
    // back to a bare id (rows without `resolvedModel`).
    return { key: bestKey, usage: modelUsage[bestKey] };
  }
}
