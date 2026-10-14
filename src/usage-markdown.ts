/**
 * `/usage` rendered as Markdown, and the bounded wait that decides whether it
 * renders at all (story 011, R2.3/R2.4, design D5).
 *
 * The command ALWAYS runs through Claude Code. What this module produces is a
 * best-effort overlay on top of an answer the user already has, so every
 * failure here costs the overlay and nothing else — the caller forwards Claude
 * Code's own text byte-for-byte instead. Three ways out, all of them ending in
 * `null` from {@link structuredUsageMarkdown}:
 *
 *   1. unavailable  — the control request rejects, or the method is gone
 *   2. incompatible — the response does not match the shape the renderer reads
 *   3. slow         — the response does not arrive inside the bound below
 *
 * THE BOUND IS LOAD-BEARING, NOT DEFENSIVE. Control requests on a fresh session
 * are not serviced until the first turn runs (SDK issues #886/#880), and
 * `/usage` is frequently that first turn — so an unbounded wait would withhold
 * an answer the CLI had already printed, forever. That is why the race below
 * has three legs and not one: the report, a timeout, and the turn's abort
 * signal.
 *
 * ONE READER FOR THE REPORT'S NUMBERS. `account-usage.ts` already maps this same
 * `SDKControlGetUsageResponse` onto the client's rate-limit `_meta`, and it owns
 * the two scalar readings the report needs: `normalizeUtilization` (0..100 ->
 * 0..1, clamped) and `toEpochSeconds` (ISO 8601 -> Unix seconds). Both are
 * imported here rather than re-derived, so the bar this module draws and the bar
 * the client's usage panel draws cannot disagree about what `utilization: 3`
 * means. What is NOT shared is validation: `account-usage.ts` reads defensively
 * and never rejects a report, because a missing field there costs one window,
 * while here an unreadable report has to become a hard "no" so way out 2 can
 * fire. Different questions, so different code — but the same answers to the
 * two questions both of them ask.
 *
 * Kept self-contained — no import from `acp-agent.ts`, mirroring
 * `thinking-option.ts` and `context-compaction.ts`. The reason is merge cost:
 * `acp-agent.ts` is a ~9,700-line file that changes upstream almost daily, so
 * every coupling to it is paid again at each sync. `acp-agent.ts` wires this in
 * at the `/usage` turn: it decides which turn owns a structured render, and
 * publishes the result at most once across the message shapes the SDK can
 * deliver one local command through.
 */

import type { Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { normalizeUtilization, toEpochSeconds } from "./account-usage.js";

/**
 * How long the structured report may take before the original output wins.
 *
 * Not a guess at network latency: the request may never be serviced at all (see
 * the header), so this is the ceiling on how long a user waits for a decoration
 * on an answer that is already sitting in the buffer.
 */
export const STRUCTURED_USAGE_TIMEOUT_MS = 5_000;

const countSchema = z.number().finite().nonnegative();
const percentSchema = countSchema.max(100);
const usageWindowSchema = z
  .object({ utilization: percentSchema.nullable(), resets_at: z.string().nullable() })
  .nullable()
  .optional();
const contributionSchema = z.object({ name: z.string(), pct: percentSchema });
const behaviorPeriodSchema = z.object({
  request_count: countSchema,
  session_count: countSchema,
  mcp_servers: z.array(contributionSchema),
});
const modelUsageSchema = z.object({
  inputTokens: countSchema,
  outputTokens: countSchema,
  cacheReadInputTokens: countSchema,
  cacheCreationInputTokens: countSchema,
});

const usageResponseSchema = z.object({
  session: z.object({
    total_cost_usd: countSchema,
    total_api_duration_ms: countSchema,
    total_duration_ms: countSchema,
    model_usage: z.record(z.string(), modelUsageSchema),
  }),
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: usageWindowSchema,
      seven_day: usageWindowSchema,
      seven_day_oauth_apps: usageWindowSchema,
      seven_day_opus: usageWindowSchema,
      seven_day_sonnet: usageWindowSchema,
      model_scoped: z
        .array(
          z.object({
            display_name: z.string(),
            utilization: percentSchema.nullable(),
            resets_at: z.string().nullable(),
          }),
        )
        .optional(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: countSchema.nullable(),
          used_credits: countSchema.nullable(),
          utilization: percentSchema.nullable(),
          currency: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  behaviors: z.object({ day: behaviorPeriodSchema, week: behaviorPeriodSchema }).nullable(),
});

/**
 * Validate the experimental SDK response at the runtime boundary — way out 2.
 * Null means "this is not a report this renderer can read", which the caller
 * turns into Claude Code's original text.
 */
export function parseUsageResponse(value: unknown): SDKControlGetUsageResponse | null {
  const parsed = usageResponseSchema.safeParse(value);
  // Validate only the fields the renderer reads, but preserve the COMPLETE
  // response rather than the schema's stripped output. The API's own doc
  // comment says the shape may change; a value added to a subtree nobody reads
  // must not cost the already-validated part that renders fine.
  return parsed.success ? (value as SDKControlGetUsageResponse) : null;
}

/**
 * Whether a prompt is exactly the local `/usage` command.
 *
 * Exact, not a prefix: `/usage now` is an argument form this renderer has no
 * mapping for, and prose that merely mentions the word is a model turn.
 */
export function isUsageCommandText(text: string): boolean {
  return text.trim() === "/usage";
}

/**
 * The local command a synthetic assistant frame answers, or undefined.
 *
 * CLI 2.1.280 answers `/usage` with a top-level assistant frame whose model is
 * `<synthetic>` and whose `local_command_run` names the command — not with the
 * `local_command_output` message or the `<local-command-stdout>` user frame the
 * other interception points read. The SDK's message type does not declare the
 * field, so it is narrowed from `unknown` here rather than cast.
 */
export function syntheticLocalCommand(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("local_command_run" in message)) {
    return undefined;
  }
  const run = (message as { local_command_run: unknown }).local_command_run;
  if (!run || typeof run !== "object" || !("command" in run)) {
    return undefined;
  }
  const command = (run as { command: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/** Cells in a progress bar. Fixed width, so bars line up under one another. */
const USAGE_BAR_CELLS = 20;

/**
 * A bar for a utilization already normalised to 0..1 by
 * {@link normalizeUtilization} — which is what keeps this bar and the client's
 * own rate-limit bar on the same scale.
 *
 * A non-zero fraction always fills at least one cell: rounding 0.6% to an empty
 * bar would render "some usage" and "none" identically.
 */
function usageBar(fraction: number): string {
  const filled = fraction === 0 ? 0 : Math.max(1, Math.round(fraction * USAGE_BAR_CELLS));
  return `${"\u2588".repeat(filled)}${"\u2591".repeat(USAGE_BAR_CELLS - filled)}`;
}

/** Server-supplied text is DATA, not Markdown: neutralise it before inlining. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>|])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

/** Milliseconds per second — {@link toEpochSeconds} answers in the latter. */
const MILLISECONDS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / MILLISECONDS_PER_SECOND));
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainder = seconds % SECONDS_PER_MINUTE;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

const COUNT_FORMAT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const RESET_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/**
 * The reset suffix for a limit row, or empty when the report carried no instant.
 *
 * Parsed through {@link toEpochSeconds} so this module and the quota-window
 * transport agree on which instants are readable at all. An instant that reader
 * rejects is still SHOWN, verbatim and escaped: the report said something, and
 * printing it is more useful than silently dropping it.
 */
function formatReset(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const seconds = toEpochSeconds(value);
  if (seconds === undefined) {
    return ` \u00b7 Resets ${escapeMarkdown(value)}`;
  }
  return ` \u00b7 Resets ${RESET_FORMAT.format(new Date(seconds * MILLISECONDS_PER_SECOND))}`;
}

/** One limit window as the report states it: a percentage and a reset instant. */
type ReportedLimitWindow = {
  utilization: number | null;
  resets_at: string | null;
};

/**
 * One limit row — heading, then its bar — or nothing when the report supplied no
 * usable utilization for that window.
 *
 * The percentage is printed as the report stated it while the BAR is drawn from
 * the normalised fraction. That split is deliberate: the number is the report's
 * own claim, the bar is the shared 0..1 scale, and `normalizeUtilization` is the
 * single place that decides whether a value is usable at all (null, absent and
 * non-finite all collapse to "no row").
 */
function appendLimit(
  lines: string[],
  label: string,
  window: ReportedLimitWindow | null | undefined,
): void {
  const fraction = normalizeUtilization(window?.utilization);
  if (!window || fraction === undefined) {
    return;
  }
  lines.push(
    `**${escapeMarkdown(label)}** \u2014 **${window.utilization}%**${formatReset(window.resets_at)}`,
    "",
    `\`${usageBar(fraction)}\``,
    "",
  );
}

/** How many MCP servers one contribution table lists. */
const TOP_CONTRIBUTIONS = 3;

/**
 * Labels for the usage patterns (`behaviors[].key`) the pinned SDK types
 * define, worded as Claude Code's own `/usage` dialog words them (CLI 2.1.285:
 * "41% of your usage hit a >100k-token cache miss"). A key not listed here — a
 * newer CLI adds them ahead of the SDK types — renders from its own name, so it
 * shows without a code change.
 */
const BEHAVIOR_LABELS: Record<string, string> = {
  cache_miss: "Hit a >100k-token cache miss",
  long_context: "At >150k context",
  subagent_heavy: "Subagent-heavy sessions",
  high_parallel: "While 4+ sessions ran in parallel",
  cron: "Sessions active for 8+ hours",
};

/** `max_effort` -> "Max effort", escaped: the key is the CLI's, not ours. */
function behaviorLabel(key: string): string {
  const known = BEHAVIOR_LABELS[key];
  if (known !== undefined) return known;
  const words = key.replace(/_+/g, " ").trim();
  return escapeMarkdown(words.charAt(0).toUpperCase() + words.slice(1));
}

/**
 * A period's usage patterns, read defensively: the schema does not validate
 * `behaviors[]`, so a report from a CLI that reshaped it still renders
 * everything else. An entry with no usable key or share is skipped, and so is
 * one with no share at all — the CLI sends every pattern it knows, most at 0%.
 */
function readBehaviors(period: unknown): { key: string; pct: number; count: number | null }[] {
  const raw = (period as { behaviors?: unknown } | null)?.behaviors;
  if (!Array.isArray(raw)) return [];
  const rows: { key: string; pct: number; count: number | null }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, pct, count } = entry as { key?: unknown; pct?: unknown; count?: unknown };
    if (typeof key !== "string" || key.trim() === "") continue;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0) continue;
    rows.push({
      key,
      pct,
      count: typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null,
    });
  }
  return rows.sort((a, b) => b.pct - a.pct);
}

function appendContributions(
  lines: string[],
  label: string,
  period: {
    request_count: number;
    session_count: number;
    mcp_servers: { name: string; pct: number }[];
  },
): void {
  lines.push(
    "",
    `**${label}** \u00b7 ${period.request_count} requests \u00b7 ${period.session_count} sessions`,
  );
  const behaviors = readBehaviors(period);
  if (behaviors.length > 0) {
    lines.push("", "| Usage pattern | Usage | Requests |", "|:--|--:|--:|");
    for (const behavior of behaviors) {
      const bar = usageBar(normalizeUtilization(behavior.pct) ?? 0);
      lines.push(
        `| ${behaviorLabel(behavior.key)} | \`${bar}\` ${behavior.pct}% | ${behavior.count ?? "\u2014"} |`,
      );
    }
  }
  if (period.mcp_servers.length === 0) {
    return;
  }
  lines.push("", "| MCP server | Usage |", "|:--|--:|");
  // Copied before sorting: the report is the caller's object, not ours.
  const ranked = [...period.mcp_servers].sort((a, b) => b.pct - a.pct);
  for (const server of ranked.slice(0, TOP_CONTRIBUTIONS)) {
    const bar = usageBar(normalizeUtilization(server.pct) ?? 0);
    lines.push(`| ${escapeMarkdown(server.name)} | \`${bar}\` ${server.pct}% |`);
  }
}

/**
 * The session's own spend: one row of wall-clock facts, then the token
 * breakdown summed across every model the session used.
 *
 * Summed rather than listed per model: the question `/usage` answers is what
 * this session cost, and a per-model split of four counters is a table nobody
 * reads to answer it.
 */
function appendSessionTotals(
  lines: string[],
  session: SDKControlGetUsageResponse["session"],
): void {
  const totals = Object.values(session.model_usage).reduce(
    (sum, model) => ({
      input: sum.input + model.inputTokens,
      output: sum.output + model.outputTokens,
      cacheRead: sum.cacheRead + model.cacheReadInputTokens,
      cacheWrite: sum.cacheWrite + model.cacheCreationInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  lines.push(
    "",
    "---",
    "",
    "### This session",
    "",
    "| Cost | API time | Active |",
    "|:--|:--|:--|",
    `| $${session.total_cost_usd.toFixed(2)} | ${formatDuration(session.total_api_duration_ms)} | ${formatDuration(session.total_duration_ms)} |`,
    "",
    "| Breakdown | Tokens |",
    "|:--|--:|",
    `| Input | ${formatCount(totals.input)} |`,
    `| Output | ${formatCount(totals.output)} |`,
    `| Cache read | ${formatCount(totals.cacheRead)} |`,
    `| Cache write | ${formatCount(totals.cacheWrite)} |`,
  );
}

/**
 * The plan's rate-limit windows as labelled bars, or nothing at all.
 *
 * `rate_limits_available` GOVERNS, not the presence of data: an API-key,
 * Bedrock or Vertex session can carry a populated `rate_limits` while declaring
 * plan limits inapplicable, and a section of bars would then claim the account
 * is unused rather than unmeasured. Same rule `account-usage.ts` applies.
 */
function appendLimits(lines: string[], usage: SDKControlGetUsageResponse): void {
  if (!usage.rate_limits_available || !usage.rate_limits) {
    return;
  }
  const limitLines: string[] = [];
  appendLimit(limitLines, "5-hour limit", usage.rate_limits.five_hour);
  appendLimit(limitLines, "Weekly \u00b7 all models", usage.rate_limits.seven_day);
  // The server's own per-model buckets when it emits them; the two fixed fields
  // are the older shape and would double-report the same windows.
  const modelWindows = usage.rate_limits.model_scoped ?? [];
  for (const model of modelWindows) {
    appendLimit(limitLines, `Weekly \u00b7 ${model.display_name}`, model);
  }
  if (modelWindows.length === 0) {
    appendLimit(limitLines, "Weekly \u00b7 Opus", usage.rate_limits.seven_day_opus);
    appendLimit(limitLines, "Weekly \u00b7 Sonnet", usage.rate_limits.seven_day_sonnet);
  }
  // A heading with no rows under it claims the limits are unmeasured rather
  // than unavailable, so the section only exists once a row does.
  if (limitLines.length === 0) {
    return;
  }
  if (limitLines.at(-1) === "") {
    limitLines.pop();
  }
  lines.push("", "### Limits", "", ...limitLines);
}

/**
 * What is consuming the plan's limits, as the CLI's own dialog reports it.
 *
 * Null for a session with no claude.ai subscription, or when the local
 * transcript scan behind it failed — in both cases the section is simply
 * absent rather than shown empty.
 */
function appendBehaviors(lines: string[], usage: SDKControlGetUsageResponse): void {
  if (!usage.behaviors) {
    return;
  }
  lines.push(
    "",
    "---",
    "",
    "### What\u2019s using your limits?",
    "",
    "> Approximate, overlapping measures \u00b7 this machine only \u00b7 excludes claude.ai",
  );
  appendContributions(lines, "Last 24h", usage.behaviors.day);
  appendContributions(lines, "Last 7d", usage.behaviors.week);
}

/** Render the SDK's structured `/usage` response as Markdown (R2.3). */
export function formatUsageResponse(usage: SDKControlGetUsageResponse): string {
  const lines = ["## Usage"];
  if (usage.subscription_type) {
    lines.push("", `> Claude ${escapeMarkdown(usage.subscription_type)} subscription usage`);
  }
  appendLimits(lines, usage);
  appendSessionTotals(lines, usage.session);
  appendBehaviors(lines, usage);
  return lines.join("\n");
}

/**
 * The one SDK surface this module needs.
 *
 * `Pick` on the literal method name is the compile-time tripwire the ToDo asks
 * for: when the SDK stabilises this API and renames the method, the key stops
 * being a `keyof Query` and the BUILD fails here. Without it, a rename would
 * only ever surface as `/usage` degrading to way out 1 forever — a silent loss
 * of the whole feature, indistinguishable from a session where the report is
 * genuinely unavailable.
 */
export type UsageReportQuery = Pick<
  Query,
  "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
>;

/** The slice of the adapter's logger this module uses. */
export type UsageMarkdownLogger = { error: (message: string) => void };

/**
 * What the race yields when no report arrived. A symbol rather than `null`, so
 * "the wait ended" can never be confused with a value the SDK sent.
 */
const NO_REPORT = Symbol("structured-usage-unavailable");

/**
 * The structured `/usage` render for one turn, or null when any of the three
 * ways out fired (R2.4). Never throws and never resolves late: the caller is
 * holding a completed local command's output while it awaits this.
 *
 * Raced against BOTH a timeout and the turn's abort signal. The timeout covers
 * a request that is never serviced (see the header); the signal covers a turn
 * that ended — cancelled, or settled — while the request was still in flight,
 * so a dead turn's overlay is abandoned rather than merely ignored.
 */
export async function structuredUsageMarkdown(
  query: UsageReportQuery,
  signal: AbortSignal,
  logger: UsageMarkdownLogger,
): Promise<string | null> {
  if (signal.aborted) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const response = await Promise.race([
      // Written out rather than hidden behind a helper, for the same reason
      // `publishAccountUsage` writes it out: this awful spelling is the only
      // name the real `Query` answers to, and `UsageReportQuery` above pins the
      // same literal.
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<typeof NO_REPORT>((resolve) => {
        timer = setTimeout(() => resolve(NO_REPORT), STRUCTURED_USAGE_TIMEOUT_MS);
        // The overlay must never be the reason the process stays alive.
        timer.unref?.();
      }),
      new Promise<typeof NO_REPORT>((resolve) => {
        onAbort = () => resolve(NO_REPORT);
        // `addEventListener` never fires on an already-aborted signal, so an
        // abort raised between the guard above and this line would otherwise
        // leave this leg permanently pending.
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
    if (response === NO_REPORT) {
      // An aborted turn is not a fault: nobody is waiting for this any more.
      if (!signal.aborted) {
        logger.error("Structured /usage timed out; preserving Claude Code output");
      }
      return null;
    }
    const usage = parseUsageResponse(response);
    if (usage === null) {
      logger.error(
        "Structured /usage returned an incompatible response; preserving Claude Code output",
      );
      return null;
    }
    return formatUsageResponse(usage);
  } catch (error) {
    logger.error(`Structured /usage failed; preserving Claude Code output: ${error}`);
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
