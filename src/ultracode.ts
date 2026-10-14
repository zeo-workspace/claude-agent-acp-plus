/**
 * Ultracode — an independent, session-scoped boolean option.
 *
 * **What it is.** The SDK's `Settings.ultracode` is *"standing
 * dynamic-workflow orchestration at any effort level"*, session-scoped and
 * applied through `apply_flag_settings`. It is not an effort level and it does
 * not imply one: the CLI (`/effort ultracode on|off`, "any effort level, this
 * session only") and the VS Code extension (a switch in the effort popover)
 * both model it as a toggle beside effort. An earlier version of this module
 * followed an older extension tooltip ("xhigh + workflows") and drew it as a
 * notch in the effort select that forced `xhigh`; that silently raised the
 * effort of a session started with `ultracode: true`, cleared it on any effort
 * pick, and lost it on a model switch (PARITY-REPORT §21.2).
 *
 * **The wire contract** (`applyFlagSettings`, unchanged SDK 0.3.285..0.3.299):
 * - `ultracode: true|false` turns it on or off and leaves effort alone;
 * - an `effortLevel` change sent WITHOUT the key turns it off;
 * - `null` resets it to off.
 * Hence the two payload rules below: the toggle sends `{ultracode:true}` or
 * `{ultracode:null}`, and every effort change re-sends `ultracode:true` while
 * the intent is on — and never `null`.
 *
 * **Intent is not availability.** The CLI keeps the request and computes "in
 * effect = requested and available", where available means workflows are
 * enabled and the model supports `xhigh`. The adapter mirrors that: the
 * session holds the intent, the option is shown only while available, and a
 * model switch never drops the intent. The CLI reports both through the
 * `get_settings` control request (`applied.{ultracode, ultracodeRequested,
 * ultracodeAvailable}`), which the SDK runtime exposes as `Query.getSettings()`
 * but `sdk.d.ts` does not declare — {@link readUltracodeState} wraps it.
 *
 * Kept self-contained — no import from `acp-agent.ts` — for the reason
 * `thinking-option.ts` and `rewind-command.ts` state: that file is ~10,000
 * lines and moves upstream almost daily, so every coupling to it is paid again
 * at each sync.
 */

import type { SessionConfigOption, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import type { EffortLevel, Settings } from "@anthropic-ai/claude-agent-sdk";

/** Config option id. */
export const ULTRACODE_CONFIG_ID = "ultracode";

/** Display name, matching the CLI's and the extension's label. */
export const ULTRACODE_OPTION_NAME = "Ultracode";

const ULTRACODE_DESCRIPTION = "Run dynamic workflows on every task";

/** Select-fallback values for clients without boolean config options. The
 *  same spelling Fast mode uses, so one client-side mapping serves both. */
export const ULTRACODE_ON = "on";
export const ULTRACODE_OFF = "off";

/** The effort level the model must support for Ultracode to be available.
 *  Availability only: Ultracode never SETS this level. */
export const ULTRACODE_EFFORT_LEVEL: EffortLevel = "xhigh";

/** The value the old effort-select notch carried. Accepted for one release
 *  from clients that still send it (see {@link isLegacyUltracodeEffort}). */
export const LEGACY_ULTRACODE_EFFORT_VALUE = "ultracode";

/** Display state for the option, resolved by the caller. Mirrors
 *  `FastModeOptionState`: availability and value are different questions. */
export interface UltracodeOptionState {
  /** Whether the option is shown at all. */
  available: boolean;
  /** The session's intent — shown as the option's value. */
  requested: boolean;
  /** Whether the client opted into boolean config options. */
  useBooleanOption: boolean;
}

/**
 * The fallback availability check, used until (or instead of) the CLI's own
 * `applied.ultracodeAvailable`:
 *
 * 1. workflows are not disabled — Ultracode *is* workflow orchestration;
 * 2. the current model supports `xhigh`.
 *
 * Partial by nature: the CLI also checks managed settings, org policy,
 * `enableWorkflows` and `CLAUDE_CODE_DISABLE_WORKFLOWS`. An absent
 * `disableWorkflows` opens the gate, the same direction the extension's
 * `=== !0` comparison takes.
 */
export function isUltracodeAvailable(
  supportedEffortLevels: readonly string[],
  settings: Pick<Settings, "disableWorkflows"> | undefined,
): boolean {
  if (settings?.disableWorkflows === true) return false;
  return supportedEffortLevels.includes(ULTRACODE_EFFORT_LEVEL);
}

/** Build the option: a native boolean for clients that opted in, an on/off
 *  select otherwise (the ACP boolean-config-option RFD makes that a MUST). */
export function createUltracodeConfigOption(
  requested: boolean,
  useBooleanOption: boolean,
): SessionConfigOption {
  const base = {
    id: ULTRACODE_CONFIG_ID,
    name: ULTRACODE_OPTION_NAME,
    description: ULTRACODE_DESCRIPTION,
    category: "model_config",
  } as const;
  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: requested };
  }
  return {
    ...base,
    type: "select",
    currentValue: requested ? ULTRACODE_ON : ULTRACODE_OFF,
    options: [
      { value: ULTRACODE_ON, name: "On" },
      { value: ULTRACODE_OFF, name: "Off" },
    ],
  };
}

/** The option for a resolved state, or `undefined` while unavailable. */
export function ultracodeConfigOption(
  state: UltracodeOptionState | undefined,
): SessionConfigOption | undefined {
  if (!state?.available) return undefined;
  return createUltracodeConfigOption(state.requested, state.useBooleanOption);
}

/**
 * Put the option where it belongs in an existing list — right after `effort`
 * (after `model` when the model has no effort option), before `fast` — or
 * remove it when `next` is undefined. Used when a background readback changes
 * availability without a full rebuild.
 */
export function placeUltracodeOption(
  options: SessionConfigOption[],
  next: SessionConfigOption | undefined,
): SessionConfigOption[] {
  const rest = options.filter((o) => o.id !== ULTRACODE_CONFIG_ID);
  if (!next) return rest;
  let anchor = rest.findIndex((o) => o.id === "effort");
  if (anchor < 0) anchor = rest.findIndex((o) => o.id === "model");
  const at = anchor < 0 ? rest.length : anchor + 1;
  return [...rest.slice(0, at), next, ...rest.slice(at)];
}

/** Resolve the requested value from `session/set_config_option`: a native
 *  boolean, or the on/off select-fallback strings. */
export function resolveUltracodeRequested(params: SetSessionConfigOptionRequest): boolean {
  const value = params.value;
  if (typeof value === "boolean") return value;
  if (value === ULTRACODE_ON) return true;
  if (value === ULTRACODE_OFF) return false;
  throw new Error(`Invalid value for config option ${ULTRACODE_CONFIG_ID}: ${String(value)}`);
}

/** The toggle's payload. Off is an explicit `null`: `undefined` is dropped by
 *  JSON transport, and the SDK only clears a flag on `null`. */
export function ultracodeTogglePayload(requested: boolean): { ultracode: true | null } {
  return { ultracode: requested ? true : null };
}

/**
 * The `apply_flag_settings` payload for an effort change — a user pick, the
 * model-switch fallback, the initial effort, or a recreate's replay.
 *
 * An `effortLevel` change sent without `ultracode` turns Ultracode off, so the
 * key rides along whenever the intent is on. It is never sent as `null` here:
 * an effort change is not a request to turn Ultracode off.
 *
 * @param value the effort select's value — `"default"`, an `EffortLevel`, or
 *   `undefined` when the model has no effort option.
 */
export function effortFlagSettings(
  value: string | undefined,
  ultracodeRequested: boolean,
): { effortLevel: EffortLevel | null; ultracode?: true } {
  const effortLevel = value === undefined || value === "default" ? null : (value as EffortLevel);
  return ultracodeRequested ? { effortLevel, ultracode: true } : { effortLevel };
}

/** Whether an effort value is the retired Ultracode notch. Clients that saved
 *  it get `{effortLevel:'xhigh', ultracode:true}` for one release. */
export function isLegacyUltracodeEffort(value: unknown): boolean {
  return value === LEGACY_ULTRACODE_EFFORT_VALUE;
}

/** What the CLI reported. Each field is absent when the CLI did not say. */
export interface UltracodeReadback {
  requested?: boolean;
  available?: boolean;
}

/**
 * Read `applied.{ultracodeRequested, ultracodeAvailable}` through the SDK's
 * untyped `Query.getSettings()`.
 *
 * Structural, never trusting: an SDK without the method, a rejected request,
 * or a response without `applied` all resolve to `undefined`, and the caller
 * keeps the heuristic. Never rejects.
 *
 * **Call it in the background, never inline.** Control requests are
 * serialized and queue ahead of interrupt and close (upstream #1216), and on a
 * fresh session the CLI does not service them until the first turn.
 */
export async function readUltracodeState(
  query: unknown,
  onError?: (error: unknown) => void,
): Promise<UltracodeReadback | undefined> {
  const getSettings = (query as { getSettings?: unknown } | null | undefined)?.getSettings;
  if (typeof getSettings !== "function") return undefined;
  let response: unknown;
  try {
    response = await (getSettings as () => Promise<unknown>).call(query);
  } catch (error) {
    onError?.(error);
    return undefined;
  }
  const applied = (response as { applied?: unknown } | null | undefined)?.applied;
  if (typeof applied !== "object" || applied === null) return undefined;
  const { ultracodeRequested, ultracodeAvailable } = applied as Record<string, unknown>;
  const readback: UltracodeReadback = {};
  if (typeof ultracodeRequested === "boolean") readback.requested = ultracodeRequested;
  if (typeof ultracodeAvailable === "boolean") readback.available = ultracodeAvailable;
  return readback.requested === undefined && readback.available === undefined
    ? undefined
    : readback;
}

/**
 * The slice of a session these helpers read and write. Structural, so this
 * module does not import the `Session` type from `acp-agent.ts`.
 */
export interface UltracodeSession {
  query: { applyFlagSettings(settings: Record<string, unknown>): Promise<void> };
  configOptions: SessionConfigOption[];
  /** The intent: what the user (or settings, or the CLI's readback) asked for. */
  ultracodeRequested: boolean;
  /** Whether the option is shown: the CLI's `applied.ultracodeAvailable` when
   *  read, else {@link isUltracodeAvailable}'s heuristic. */
  ultracodeAvailable: boolean;
}

/** Rebuild the option in place from the session's state. */
export function refreshUltracodeOption(session: UltracodeSession, useBooleanOption: boolean): void {
  session.configOptions = placeUltracodeOption(
    session.configOptions,
    ultracodeConfigOption({
      available: session.ultracodeAvailable,
      requested: session.ultracodeRequested,
      useBooleanOption,
    }),
  );
}

/** Toggle the intent. Applies first, then records — a rejected control
 *  request leaves the session and its option untouched, as Fast mode does. */
export async function applyUltracodeToggle(
  session: UltracodeSession,
  requested: boolean,
  useBooleanOption: boolean,
): Promise<void> {
  await session.query.applyFlagSettings(ultracodeTogglePayload(requested));
  session.ultracodeRequested = requested;
  refreshUltracodeOption(session, useBooleanOption);
}

/**
 * The one-release migration for clients that still send the retired notch:
 * `effort = "ultracode"` becomes `{effortLevel:'xhigh', ultracode:true}`.
 * Returns `false`, sending nothing, when this model's effort select does not
 * offer `xhigh` — the caller then rejects the value like any other.
 */
export async function applyLegacyUltracodeEffort(
  session: UltracodeSession,
  useBooleanOption: boolean,
): Promise<boolean> {
  const effort = session.configOptions.find((o) => o.id === "effort");
  const offersXhigh =
    effort?.type === "select" &&
    effort.options.some((o) => "value" in o && o.value === ULTRACODE_EFFORT_LEVEL);
  if (!offersXhigh) return false;
  await session.query.applyFlagSettings(effortFlagSettings(ULTRACODE_EFFORT_LEVEL, true));
  session.ultracodeRequested = true;
  session.configOptions = session.configOptions.map((o) =>
    o.id === "effort" && o.type === "select" ? { ...o, currentValue: ULTRACODE_EFFORT_LEVEL } : o,
  );
  refreshUltracodeOption(session, useBooleanOption);
  return true;
}

/**
 * Fold a CLI readback into the session. Availability is always taken; the
 * intent only when `seedIntent` (session start — a model switch keeps the
 * intent it has). Returns whether the option the client sees changed, i.e.
 * whether a `config_option_update` is owed.
 */
export function applyUltracodeReadback(
  session: UltracodeSession,
  readback: UltracodeReadback,
  seedIntent: boolean,
  useBooleanOption: boolean,
): boolean {
  const before = JSON.stringify(session.configOptions.find((o) => o.id === ULTRACODE_CONFIG_ID));
  if (readback.available !== undefined) session.ultracodeAvailable = readback.available;
  if (seedIntent && readback.requested !== undefined) {
    session.ultracodeRequested = readback.requested;
  }
  refreshUltracodeOption(session, useBooleanOption);
  const after = JSON.stringify(session.configOptions.find((o) => o.id === ULTRACODE_CONFIG_ID));
  return before !== after;
}
