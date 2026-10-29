/**
 * Plan updates — a session-scoped boolean option that turns on the CLI's todo
 * tools, so Zed's plan view fills on current models.
 *
 * **Why it exists.** The CLI enables `TodoWrite` only on legacy models unless
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set (upstream #1380); on Opus 5.x the
 * adapter never sees a todo call and never emits a `plan` session update. The
 * variable is read once, at CLI spawn, so the option drives the query env and
 * a live toggle recreates the query (the lazy path Thinking uses).
 *
 * **An env the user already wrote wins** (story 062, R1.3): a value in the
 * client-supplied or process env, or in the settings env the CLI applies
 * after the spawn env, is kept and decides the option's starting value. Only
 * a toggle overrides it, and only for that session.
 *
 * **Off does not reach every model.** The CLI keeps the todo tools on for
 * legacy models whatever the variable says, so "Off" removes them only where
 * the option is what turned them on. Managed settings, and settings edited
 * after spawn, are not read here.
 *
 * Kept self-contained — no import from `acp-agent.ts` — for the reason
 * `ultracode.ts` states: that file moves upstream almost daily.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionConfigOption, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import { PLAN_UPDATES_CONFIG_ID } from "./session-config-ids.js";

export const TODO_TOOLS_ENV = "CLAUDE_CODE_ENABLE_TODO_TOOLS";
export const PLAN_UPDATES_OPTION_NAME = "Plan updates";
const PLAN_UPDATES_DESCRIPTION = "Show the agent's todo list in the plan view";
/** The select-fallback spelling Fast mode and Ultracode use. */
export const PLAN_UPDATES_ON = "on";
export const PLAN_UPDATES_OFF = "off";

/** `1`/`true`/`yes`/`on` read as on — the bundled CLI 2.1.296's own truthy
 *  env spelling — and any other value present as off; `undefined` when the
 *  variable is absent. */
export function readTodoToolsEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** The spawn-time state. `settingsValue` is set when a settings tier defines
 *  the variable: both outrank the spawn env, so a toggle must override it in
 *  the programmatic tier, which outranks the settings files too. */
export interface PlanUpdatesSpawnState {
  enabled: boolean;
  /** Whether the adapter must add `"1"` to the spawn env. */
  inject: boolean;
  settingsValue?: boolean;
}

/**
 * @param settingsEnv the merged user/project/local settings files' env.
 * @param programmaticEnv the env of the settings the adapter passes on the
 *   command line (`options.settings`), which the CLI ranks above the files.
 */
export function resolvePlanUpdatesAtSpawn(
  spawnEnv: Record<string, string | undefined>,
  settingsEnv: Record<string, string> | undefined,
  programmaticEnv?: Record<string, string>,
): PlanUpdatesSpawnState {
  const settingsValue =
    readTodoToolsEnv(programmaticEnv?.[TODO_TOOLS_ENV]) ??
    readTodoToolsEnv(settingsEnv?.[TODO_TOOLS_ENV]);
  const envValue = readTodoToolsEnv(spawnEnv[TODO_TOOLS_ENV]);
  // The CLI applies settings env after the spawn env, so that is what it
  // would actually run with.
  const pinned = settingsValue ?? envValue;
  if (pinned !== undefined) return { enabled: pinned, inject: false, settingsValue };
  return { enabled: true, inject: true };
}

export function createPlanUpdatesConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
): SessionConfigOption {
  const base = {
    id: PLAN_UPDATES_CONFIG_ID,
    name: PLAN_UPDATES_OPTION_NAME,
    description: PLAN_UPDATES_DESCRIPTION,
  } as const;
  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }
  return {
    ...base,
    type: "select",
    currentValue: enabled ? PLAN_UPDATES_ON : PLAN_UPDATES_OFF,
    options: [
      { value: PLAN_UPDATES_ON, name: "On" },
      { value: PLAN_UPDATES_OFF, name: "Off" },
    ],
  };
}

/** A native boolean, or the on/off select-fallback strings; anything else
 *  throws before the session is touched. */
export function resolvePlanUpdatesRequested(params: SetSessionConfigOptionRequest): boolean {
  const value = params.value;
  if (typeof value === "boolean") return value;
  if (value === PLAN_UPDATES_ON) return true;
  if (value === PLAN_UPDATES_OFF) return false;
  throw new Error(`Invalid value for config option ${PLAN_UPDATES_CONFIG_ID}: ${String(value)}`);
}

/**
 * Write the session's intent into a replacement query's options. The spawn
 * env always carries it; the settings tier too whenever it defines the
 * variable, because there it would otherwise win — every time, so a toggle
 * back to the settings value undoes an earlier override in the recorded
 * options. A settings path (string) cannot be overridden here, and is
 * reported back as `false`.
 */
export function applyPlanUpdatesToOptions(
  options: Options,
  enabled: boolean,
  settingsValue: boolean | undefined,
): boolean {
  const value = enabled ? "1" : "0";
  options.env = { ...options.env, [TODO_TOOLS_ENV]: value };
  if (settingsValue === undefined) return true;
  const settings = options.settings;
  if (typeof settings === "string") return false;
  options.settings = { ...settings, env: { ...settings?.env, [TODO_TOOLS_ENV]: value } };
  return true;
}
