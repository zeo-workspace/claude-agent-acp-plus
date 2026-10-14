import { describe, it, expect, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk";
import { randomUUID } from "crypto";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { normalizeUtilization } from "../account-usage.js";
import { formatUsageResponse, isUsageCommandText, parseUsageResponse } from "../usage-markdown.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * R2.3 / R2.4 - `/usage` renders the structured report as Markdown, and each of
 * the three ways out forwards Claude Code's ORIGINAL output unchanged.
 *
 * Design D5: the bound is load-bearing rather than defensive. Control requests
 * on a fresh session are not serviced until the first turn runs (SDK issues
 * #886/#880), so an unbounded wait would hang a command that has already
 * produced its answer. The slow case below therefore asserts that the original
 * text still reaches the client - not merely that nothing crashed.
 */

const usageResponse = {
  session: {
    total_cost_usd: 0.33,
    total_api_duration_ms: 20_000,
    total_duration_ms: 69_000,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {
      "claude-opus-4-1": {
        inputTokens: 4,
        outputTokens: 872,
        cacheReadInputTokens: 98_700,
        cacheCreationInputTokens: 25_300,
        webSearchRequests: 0,
        costUSD: 0.33,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
  },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 3, resets_at: "2026-09-04T16:59:00.000Z" },
    seven_day: { utilization: 0, resets_at: "2026-09-04T17:59:00.000Z" },
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: null }],
  },
  behaviors: {
    day: {
      request_count: 34,
      session_count: 3,
      behaviors: [],
      agents: [],
      skills: [],
      plugins: [],
      mcp_servers: [{ name: "ccd_session_mgmt", pct: 13 }],
    },
    week: {
      request_count: 43,
      session_count: 5,
      behaviors: [],
      agents: [],
      skills: [],
      plugins: [],
      mcp_servers: [{ name: "claude_agent_acp", pct: 3 }],
    },
  },
} as unknown as SDKControlGetUsageResponse;

/** The raw text Claude Code itself prints for `/usage`. Every fallback case
 *  below asserts this reaches the client byte-for-byte. */
const RAW_OUTPUT = "Current session\nCost: $0.33\n5-hour limit: 3% used";

describe("usage Markdown - parsing and rendering", () => {
  it("accepts the report shape it renders and rejects an incompatible one", () => {
    expect(parseUsageResponse(usageResponse)).toEqual(usageResponse);
    expect(
      parseUsageResponse({ ...usageResponse, session: { total_cost_usd: "broken" } }),
    ).toBeNull();
  });

  it("tolerates unknown fields the experimental API may add", () => {
    // The API's own doc comment says the shape may change. A future value in a
    // subtree the renderer does not read must not cost the whole render.
    expect(
      parseUsageResponse({
        ...usageResponse,
        session: {
          ...usageResponse.session,
          model_usage: {
            "claude-opus-4-1": {
              ...(usageResponse.session.model_usage["claude-opus-4-1"] as object),
              costBasis: "a-future-value",
            },
          },
        },
      }),
    ).not.toBeNull();
  });

  it("renders limits with progress bars, session totals, and MCP contributions", () => {
    const formatted = formatUsageResponse(usageResponse);

    expect(formatted).toContain("## Usage");
    expect(formatted).toContain("**5-hour limit** — **3%**");
    expect(formatted).toContain("**Weekly · Fable** — **0%**");
    expect(formatted).toContain("### This session");
    expect(formatted).toContain("| $0.33 | 20s | 1m 9s |");
    expect(formatted).toContain("| Cache read | 98.7K |");
    expect(formatted).toContain("**Last 24h** · 34 requests · 3 sessions");
    // A progress bar, not a bare number - R2.3 names the bars specifically.
    expect(formatted).toMatch(/`[█░]{20}`/);
  });

  it("escapes Markdown metacharacters and keeps only the top contributions", () => {
    const formatted = formatUsageResponse({
      ...usageResponse,
      behaviors: {
        ...(usageResponse as any).behaviors,
        day: {
          ...(usageResponse as any).behaviors.day,
          mcp_servers: [
            { name: "lowest", pct: 1 },
            { name: "pipe|name", pct: 40 },
            { name: "second", pct: 30 },
            { name: "third", pct: 20 },
          ],
        },
      },
    } as unknown as SDKControlGetUsageResponse);

    expect(formatted).toContain("pipe\\|name");
    expect(formatted).toContain("second");
    expect(formatted).toContain("third");
    expect(formatted).not.toContain("lowest");
  });

  // Parity item 100: the report's `behaviors[]` (usage patterns) used to be
  // dropped. Every key the pinned SDK types define renders with a label, and a
  // key a newer CLI adds renders from its own name, with no code change.
  describe("usage patterns (item 100)", () => {
    const withBehaviors = (behaviors: unknown[]) =>
      formatUsageResponse({
        ...usageResponse,
        behaviors: {
          ...(usageResponse as any).behaviors,
          week: { ...(usageResponse as any).behaviors.week, behaviors },
        },
      } as unknown as SDKControlGetUsageResponse);

    it("renders every behavior key the SDK types define", () => {
      const formatted = withBehaviors([
        { key: "cache_miss", pct: 41, count: 12 },
        { key: "long_context", pct: 22, count: 9 },
        { key: "subagent_heavy", pct: 18, count: 7 },
        { key: "high_parallel", pct: 12, count: 4 },
        { key: "cron", pct: 5, count: 2 },
      ]);
      expect(formatted).toContain("| Usage pattern | Usage | Requests |");
      expect(formatted).toMatch(/\| Hit a >100k-token cache miss \| `[█░]{20}` 41% \| 12 \|/);
      expect(formatted).toContain("| At >150k context |");
      expect(formatted).toContain("| Subagent-heavy sessions |");
      expect(formatted).toContain("| While 4+ sessions ran in parallel |");
      expect(formatted).toContain("| Sessions active for 8+ hours |");
    });

    it("passes a key the pinned SDK does not know through, from its own name", () => {
      const formatted = withBehaviors([
        { key: "max_effort", pct: 30, count: 3 },
        { key: "large_tool_results", pct: 11, count: 1 },
      ]);
      expect(formatted).toContain("| Max effort |");
      expect(formatted).toContain("| Large tool results |");
    });

    it("ranks by share, skips empty and malformed entries, and escapes names", () => {
      const formatted = withBehaviors([
        { key: "cron", pct: 0, count: 0 },
        { key: "pipe|key", pct: 9, count: 1 },
        { key: "long_context", pct: 50, count: 5 },
        { key: 7, pct: 10, count: 1 },
        { key: "cache_miss", pct: "lots", count: 1 },
      ]);
      expect(formatted).not.toContain("Sessions active for 8+ hours");
      expect(formatted).toContain("Pipe\\|key");
      expect(formatted.indexOf("At >150k context")).toBeLessThan(formatted.indexOf("Pipe\\|key"));
      expect(formatted).not.toContain("cache miss");
    });

    it("renders no pattern table when the period has none", () => {
      expect(formatUsageResponse(usageResponse)).not.toContain("Usage pattern");
    });
  });

  it("omits the limits section when every utilization is unavailable", () => {
    const formatted = formatUsageResponse({
      ...usageResponse,
      rate_limits: {
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: null, resets_at: null },
      },
    } as unknown as SDKControlGetUsageResponse);

    expect(formatted).not.toContain("### Limits");
    expect(formatted).toContain("### This session");
  });

  it("recognizes only the exact local usage command", () => {
    expect(isUsageCommandText(" /usage ")).toBe(true);
    expect(isUsageCommandText("/cost")).toBe(false);
    expect(isUsageCommandText("/usage now")).toBe(false);
    expect(isUsageCommandText("please review /usage")).toBe(false);
  });

  it("reads the same numbers the account-usage reader already derives", () => {
    // One payload, two readers: `account-usage.ts` maps this report onto the
    // client's rate-limit meta, and the renderer prints it. They must not
    // disagree about what `utilization: 3` means - two parsers for one payload
    // is the divergence this project keeps finding.
    const formatted = formatUsageResponse(usageResponse);
    const fiveHour = (usageResponse as any).rate_limits.five_hour.utilization as number;

    expect(formatted).toContain(`**${fiveHour}%**`);
    expect(normalizeUtilization(fiveHour)).toBeCloseTo(fiveHour / 100, 10);
  });
});

describe("usage Markdown - the /usage turn and its three ways out", () => {
  function setup(usageImpl: () => Promise<unknown>) {
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
    async function* messages() {
      const user = await input[Symbol.asyncIterator]().next();
      yield userEcho(user.value);
      yield {
        type: "system",
        subtype: "local_command_output",
        content: RAW_OUTPUT,
        uuid: randomUUID(),
        session_id: "test-session",
      };
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
    const query = wrapQuery(messages());
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = vi.fn(usageImpl);
    agent.sessions["test-session"] = mockSessionState({ query, input });

    return { agent, updates, query };
  }

  function chunkText(updates: SessionNotification[]): string {
    return updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.update as any).content.text)
      .join("");
  }

  it("replaces the raw /usage output with the rendered Markdown", async () => {
    const { agent, updates } = setup(async () => usageResponse);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/usage" }] });

    const text = chunkText(updates);
    expect(text).toContain("## Usage");
    expect(text).toContain("### This session");
    expect(text).not.toContain(RAW_OUTPUT);
  });

  it("way out 1 - the structured report is unavailable: the original text, unchanged", async () => {
    const { agent, updates } = setup(async () => {
      throw new Error("control request rejected");
    });

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/usage" }] });

    expect(chunkText(updates)).toBe(RAW_OUTPUT);
  });

  it("way out 2 - the report is incompatible: the original text, unchanged", async () => {
    const { agent, updates } = setup(async () => ({
      ...usageResponse,
      session: { total_cost_usd: "broken" },
    }));

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/usage" }] });

    expect(chunkText(updates)).toBe(RAW_OUTPUT);
  });

  it("way out 3 - the report never arrives: a bounded wait forwards the original instead of hanging", async () => {
    // D5. On a fresh session this control request is not serviced until the
    // first turn runs, so the wait must be bounded: the command already
    // produced its answer, and an unbounded wait would withhold it forever.
    // A never-resolving report is exactly that state.
    const { agent, updates } = setup(() => new Promise<never>(() => {}));

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/usage" }] });

    expect(chunkText(updates)).toBe(RAW_OUTPUT);
  }, 20_000);
});
