/**
 * Shared test doubles. Deliberately vitest-free so `vi.mock` async factories
 * can `await import("./helpers.js")` without ordering hazards; tests supply
 * their own vi.fn spies via `overrides`.
 */

/** The context-usage report the base mock query returns. `rawMaxTokens`
 *  matches the agent's DEFAULT_CONTEXT_WINDOW so window-related assertions
 *  don't shift in tests that don't care about context usage. */
export const DEFAULT_CONTEXT_USAGE = { totalTokens: 0, rawMaxTokens: 200000 };

/** The structured usage report for a session where plan rate limits do not
 *  apply (API key, Bedrock, Vertex): `rate_limits` is null and no quota window
 *  is emitted from it. */
export const NO_PLAN_RATE_LIMITS = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: null,
  rate_limits_available: false,
  rate_limits: null,
  behaviors: null,
};

/**
 * Base stub for the SDK `query()` return object, covering the surface
 * ClaudeAcpAgent touches unconditionally at session creation. Tests pass
 * `overrides` for the parts they assert on (spies, custom models, rejecting
 * getContextUsage, …).
 *
 * When the agent starts calling a new SDK method on every session, add it
 * here once — the getContextUsage adoption required hand-editing ~10 inline
 * mocks across five files, and any missed copy didn't fail: it silently
 * rerouted that test through the error-fallback branch and re-polluted test
 * output.
 */
export function makeMockQuery(overrides: Record<string, unknown> = {}) {
  return {
    initializationResult: async () => ({ models: [] }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedCommands: async () => [],
    getContextUsage: async () => DEFAULT_CONTEXT_USAGE,
    // The structured `/usage` report (story 002). Defaults to a session where
    // plan rate limits do not apply, so a suite that does not care about quota
    // windows sees no extra notification; suites that do care override it.
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      ...NO_PLAN_RATE_LIMITS,
    }),
    close: () => {},
    interrupt: async () => undefined,
    [Symbol.asyncIterator]: async function* () {},
    ...overrides,
  };
}

/**
 * The error `initializationResult()` rejects with when Claude Code refuses to
 * start with `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` set, as SDK 0.3.316 builds
 * it from the CLI's error result (same message prefix and fields).
 */
export function startupFailure(reason: string, cliMessage: string): Error {
  return Object.assign(new Error(`Claude Code returned an error result: ${cliMessage}`), {
    telemetryMessage: "Claude Code returned an error result",
    errorClass: "error_result",
    startupFailureReason: reason,
  });
}
