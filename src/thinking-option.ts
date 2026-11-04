/**
 * "Thinking" session config option (story 006, R1.1/R1.4/R1.5/R1.6): the
 * select-option factory surfaced via `configOptions`, the value resolver for
 * `session/set_config_option`, and the ONE precedence point that combines the
 * session's thinking intent with the legacy `MAX_THINKING_TOKENS` env
 * resolution into the SDK's `thinking` option.
 *
 * Kept self-contained — no import from `acp-agent.ts`; what this module needs
 * from the adapter (a logger, the raw env value) is injected instead, which
 * also leaves the logic unit-testable in isolation. This mirrors the
 * `rewind-command.ts` precedent, likewise isolated from the adapter so it can
 * be unit tested without a live SDK session. The reason is merge cost:
 * `acp-agent.ts` is a ~7,900-line file that changes upstream almost daily, so
 * every coupling to it is paid again at each sync. `acp-agent.ts` wires these
 * helpers into `buildConfigOptions`, `setSessionConfigOption` and query
 * creation.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import type { ModelInfo, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

/** Stable id for the Thinking session config option. */
export const THINKING_CONFIG_ID = "thinking";
/** Select value that turns extended thinking on. */
export const THINKING_ON = "on";
/** Select value that turns extended thinking off. */
export const THINKING_OFF = "off";
const THINKING_DESCRIPTION = "Extended thinking before responding";
const ALWAYS_THINKS_DESCRIPTION =
  "Extended thinking before responding. This model always thinks: it cannot turn thinking off";

/**
 * Minimal logging surface this module needs — structurally compatible with
 * acp-agent's `Logger` (`{ log, error }`), declared locally so the module
 * stays free of `acp-agent.ts` imports.
 */
export interface ThinkingLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Build the Thinking config option: a two-value "on"/"off" `select` in the
 * exact shape of the Fast mode select fallback (R1.1). Unlike Fast mode there
 * is no boolean variant — the option is select-only from day one.
 *
 * On a model that cannot turn thinking off (story 071, R2.2) the row stays —
 * an option missing from one rebuild drops from the picker — but offers "on"
 * alone, reads "on" whatever the retained intent, and says why: since agent
 * SDK 0.3.300 a `disabled` there runs adaptive thinking, so an "Off" shown on
 * that model would be a promise the SDK does not keep.
 *
 * @param enabled Whether extended thinking is currently on for the session;
 *   reflected in `currentValue`.
 * @param canDisable `modelCanDisableThinking` for the selected model.
 */
export function createThinkingConfigOption(
  enabled: boolean,
  canDisable: boolean = true,
): SessionConfigOption {
  return {
    id: THINKING_CONFIG_ID,
    name: "Thinking",
    description: canDisable ? THINKING_DESCRIPTION : ALWAYS_THINKS_DESCRIPTION,
    category: "model_config",
    type: "select",
    currentValue: enabled || !canDisable ? THINKING_ON : THINKING_OFF,
    options: canDisable
      ? [
          { value: THINKING_ON, name: "On" },
          { value: THINKING_OFF, name: "Off" },
        ]
      : [{ value: THINKING_ON, name: "On" }],
  };
}

/**
 * Whether the model can run with thinking off (story 071, R2.2). The CLI
 * states it per model as `ModelInfo.supportsThinkingOff`, a runtime field the
 * SDK's `sdk.d.ts` does not declare, so it is narrowed from `unknown` here.
 * Only an explicit `false` means "always thinks": a CLI that predates the field
 * (absent), an unknown model, or a malformed value keep today's behaviour —
 * the SDK, not a list of model names, is the one source. The CLI marks the
 * field internal, so a CLI that stops sending it puts every model back on
 * `disabled`, which the CLI itself turns into adaptive where it must.
 *
 * The row is matched by its picker `value`, else by `resolvedModel` — both by
 * exact equality, so `claude-haiku-5-5` and `claude-haiku-5-5[1m]` stay apart.
 *
 * @param infos The session's `ModelInfo` rows (`supportedModels()`).
 * @param modelId The selected model's id.
 */
export function modelCanDisableThinking(
  infos: readonly ModelInfo[],
  modelId: string | undefined,
): boolean {
  if (modelId === undefined) return true;
  const row =
    infos.find((info) => info.value === modelId) ??
    infos.find((info) => info.resolvedModel === modelId);
  return (row as { supportsThinkingOff?: unknown } | undefined)?.supportsThinkingOff !== false;
}

/**
 * Resolve a `session/set_config_option` value for the Thinking option into the
 * session's thinking intent. Only the select values are meaningful: `"on"` →
 * `true`, `"off"` → `false`. Anything else — booleans included, since the
 * option never had a legacy boolean shape (unlike Fast mode) — resolves to
 * `null` (unrecognized).
 *
 * @param value Raw value from the request (untrusted; narrowed here).
 */
export function resolveThinkingSelection(value: unknown): boolean | null {
  if (value === THINKING_ON) return true;
  if (value === THINKING_OFF) return false;
  return null;
}

/**
 * Translate the legacy `MAX_THINKING_TOKENS` env var into the SDK's `thinking`
 * option: unset → `undefined` (SDK default, adaptive on models that support
 * it); `0` → disabled; a positive integer → a fixed token budget. Anything
 * else is ignored with a logged error, i.e. treated as unset.
 *
 * This is the single source of truth for that translation: `acp-agent.ts`
 * carries no copy of it and reaches it only through `effectiveThinkingConfig`
 * below.
 *
 * @param raw The raw `MAX_THINKING_TOKENS` value (pass
 *   `process.env.MAX_THINKING_TOKENS`).
 * @param logger Sink for the invalid-value error.
 */
export function resolveThinkingConfig(
  raw: string | undefined,
  logger: ThinkingLogger,
): ThinkingConfig | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.error(`Ignoring MAX_THINKING_TOKENS: expected a non-negative integer, got '${raw}'.`);
    return undefined;
  }
  return parsed === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: parsed };
}

/**
 * The ONE precedence point combining the session's Thinking intent with the
 * legacy `MAX_THINKING_TOKENS` env resolution:
 *
 * - `intent === false` → `{ type: "disabled" }`, the SDK's documented
 *   no-extended-thinking value — except on a model that cannot turn thinking
 *   off (story 071), where the SDK would run `disabled` as adaptive anyway:
 *   there it sends `{ type: "adaptive" }`, what the model will really do.
 *   Either way the option beats the env var (R1.5).
 * - `intent === true` → the env resolution when the env var is set (R1.4);
 *   with the env var unset — or invalid, which is logged and treated as unset
 *   — the SDK's documented enabled default `{ type: "adaptive" }` ("Claude
 *   decides when and how much to think").
 * - `intent === undefined` → exactly today's env-driven behavior, including
 *   `undefined` (SDK default) when the env var is unset (R1.6).
 *
 * @param intent The session's Thinking selection: `true`/`false` once the
 *   client has set the option, `undefined` while untouched.
 * @param env The raw `MAX_THINKING_TOKENS` value (pass
 *   `process.env.MAX_THINKING_TOKENS`).
 * @param logger Sink for the invalid-env error.
 * @param canDisable `modelCanDisableThinking` for the model the query runs.
 */
export function effectiveThinkingConfig(
  intent: boolean | undefined,
  env: string | undefined,
  logger: ThinkingLogger,
  canDisable: boolean = true,
): ThinkingConfig | undefined {
  if (intent === false) return canDisable ? { type: "disabled" } : { type: "adaptive" };
  if (intent === true) return resolveThinkingConfig(env, logger) ?? { type: "adaptive" };
  return resolveThinkingConfig(env, logger);
}
