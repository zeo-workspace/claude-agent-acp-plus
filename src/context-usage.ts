/**
 * `_claude/context/usage` — what fills the session's context window, for the
 * context ring's breakdown card and its "View Report" (Zeo proposal §6.34,
 * asks 57 and 58).
 *
 * The SDK's `Query.getContextUsage({ detail })` holds the data: categories
 * with a stable `id` and a `kind`, MCP tools by server, memory files, skills,
 * agents, and `messageBreakdown.toolCallsByType` — the tokens each tool's calls
 * and results take, which is what the operator asked to see. This module keeps
 * those and drops the CLI's visual grid (`gridRows`) and raw API counters, which
 * the client does not draw.
 *
 * Only `used` rows become categories: free space and the compaction buffer are
 * the bar's remainder, and `deferred` rows are tool schemas outside the window.
 * A `kind` this module does not know is dropped, as the SDK asks ("treat an
 * unknown value as absent").
 */
import { RequestError } from "@agentclientprotocol/sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

export const CONTEXT_USAGE_METHOD = "_claude/context/usage";
export const CONTEXT_USAGE_CAPABILITY_KEY = "_claude/context";
export const CONTEXT_USAGE_CAPABILITY_VERSION = 1;

/** `full` makes per-category token-count calls; `summary` estimates locally. */
export type ContextDetail = "full" | "summary";

export type ContextUsageRequest = { sessionId: string };

export type ContextCategory = { id?: string; name: string; tokens: number; color: string };

export type ContextUsageReport =
  | {
      status: "ok";
      detail: ContextDetail;
      model: string;
      totalTokens: number;
      maxTokens: number;
      percentage: number;
      autoCompact: { enabled: boolean; threshold?: number };
      categories: ContextCategory[];
      tools: { name: string; callTokens: number; resultTokens: number }[];
      mcpTools: { name: string; serverName: string; tokens: number }[];
      memoryFiles: { path: string; type: string; tokens: number }[];
      skills: { name: string; source: string; tokens: number }[];
      agents: { agentType: string; source: string; tokens: number }[];
    }
  | { status: "unavailable"; message: string };

type RawContextUsage = Awaited<ReturnType<Query["getContextUsage"]>>;

/** Validate raw JSON-RPC params for `_claude/context/usage`. */
export function parseContextUsageRequest(params: unknown): ContextUsageRequest {
  const sessionId =
    params && typeof params === "object"
      ? (params as Record<string, unknown>).sessionId
      : undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      `${CONTEXT_USAGE_METHOD} params require a non-empty sessionId`,
    );
  }
  return { sessionId };
}

function byTokens<T extends { tokens: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.tokens - a.tokens);
}

/** The client's report, from the SDK's answer. */
export function shapeContextUsage(raw: RawContextUsage, detail: ContextDetail): ContextUsageReport {
  const categories = byTokens(
    raw.categories
      .filter((row) => row.kind === "used")
      .map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        name: row.name,
        tokens: row.tokens,
        color: row.color,
      })),
  );
  const tools = [...(raw.messageBreakdown?.toolCallsByType ?? [])]
    .map(({ name, callTokens, resultTokens }) => ({ name, callTokens, resultTokens }))
    .sort((a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens));
  return {
    status: "ok",
    detail,
    model: raw.model,
    totalTokens: raw.totalTokens,
    maxTokens: raw.maxTokens,
    percentage: raw.percentage,
    autoCompact: {
      enabled: raw.isAutoCompactEnabled,
      ...(raw.autoCompactThreshold !== undefined ? { threshold: raw.autoCompactThreshold } : {}),
    },
    categories,
    tools,
    mcpTools: byTokens(
      (raw.mcpTools ?? []).map(({ name, serverName, tokens }) => ({ name, serverName, tokens })),
    ),
    memoryFiles: (raw.memoryFiles ?? []).map(({ path, type, tokens }) => ({ path, type, tokens })),
    skills: byTokens(
      (raw.skills?.skillFrontmatter ?? []).map(({ name, source, tokens }) => ({
        name,
        source,
        tokens,
      })),
    ),
    agents: byTokens(
      (raw.agents ?? []).map(({ agentType, source, tokens }) => ({ agentType, source, tokens })),
    ),
  };
}

/** Ask the query and shape the answer. Never throws. */
export async function fetchContextReport(
  query: Pick<Query, "getContextUsage">,
  detail: ContextDetail,
): Promise<ContextUsageReport> {
  try {
    return shapeContextUsage(await query.getContextUsage({ detail }), detail);
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
