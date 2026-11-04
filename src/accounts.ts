/**
 * The account selector (story 009 R6, from story 005's preserved D1/D2/D4/D8):
 * the declared-account list, the `select` config option built from it, and the
 * one environment overlay a selection resolves to.
 *
 * Kept self-contained — nothing here imports `acp-agent.ts`; what the module
 * needs from the adapter (the resolved settings object, a logger) is injected
 * instead, which also leaves the logic unit-testable in isolation. Same reason
 * as `thinking-option.ts` and `account-usage.ts`: `acp-agent.ts` is a ~9,900
 * line file that changes upstream almost daily, so every coupling to it is paid
 * again at each sync. `acp-agent.ts` wires these helpers into
 * `buildConfigOptions`, `applyConfigOptionValue` and query creation.
 *
 * Two notions this module never conflates (D3):
 *   - the ADAPTER's configuration home is `acp-agent.ts`'s module-level
 *     `CLAUDE_CONFIG_DIR`, computed once from the process environment. A switch
 *     does NOT move it — if it did, the adapter would begin reading its own
 *     `settings.json` out of the switched account's directory, silently and
 *     only for the readers that ran after the switch;
 *   - the SESSION's account home is the overlay {@link envForAccount} builds,
 *     handed to the SDK per session (`Options.env`, `sdk.d.ts:1525`) and to
 *     nothing else. No Zed patch is involved: the client already renders any
 *     config option the adapter advertises.
 *
 * NO FILE IS OPENED HERE, and no directory is scanned. Accounts are DECLARED,
 * never discovered (D4): this reads a list someone wrote down. What it puts on
 * the wire is display names — the configuration directory is what points at the
 * credentials, so it stays on this side of the protocol (R6.4).
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";

/** Stable id for the account session config option (D1). */
export const ACCOUNT_CONFIG_ID = "account";

/** Below this many declared accounts the option is not offered at all (D8,
 *  R6.2): an empty or single-entry selector occupies a menu row to say
 *  nothing. */
const MINIMUM_SELECTABLE_ACCOUNTS = 2;

/** The variable that points the CLI at an account's configuration directory.
 *  Credentials live under that directory, so pointing the CLI at another one
 *  *is* pointing it at another account (D2) — nothing new is invented to make
 *  that true. */
const ACCOUNT_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/** What the option is called, and D7 in one line: the selection governs the
 *  next thread, never the one on screen. A session id belongs to one account's
 *  local history, so a live thread cannot be carried across a switch. */
const ACCOUNT_OPTION_NAME = "Account";
const ACCOUNT_OPTION_DESCRIPTION =
  "Account new threads start under — the current thread keeps the one it began with";

/**
 * Minimal logging surface this module needs — structurally compatible with
 * acp-agent's `Logger`, declared locally so the module stays free of
 * `acp-agent.ts` imports.
 */
export interface AccountLogger {
  error: (...args: unknown[]) => void;
}

/**
 * One declared account: a display name, and the configuration directory whose
 * credentials it stands for (D4).
 *
 * `configDir` never leaves the adapter. It is the input to
 * {@link envForAccount} and to the profile half of an identity, and nothing
 * else — the selector transports {@link AccountSelectorEntry.value}, which is
 * a name.
 */
export type DeclaredAccount = {
  name: string;
  configDir: string;
};

/** One selectable row: the declared account, and the identifier the client
 *  names it by. */
export type AccountSelectorEntry = {
  account: DeclaredAccount;
  /** What `session/set_config_option` carries for this account. A display
   *  string, never a path and never anything that authenticates (R6.4). */
  value: string;
};

/**
 * What {@link buildConfigOptions} needs to decide whether to advertise the
 * selector, and with which row selected.
 *
 * Carried alongside the resolved settings rather than inside them because
 * `accounts` is a declared list (settings) while `currentAccount` is the
 * session's own selection — the two arrive together and are read together.
 */
export type AccountOptionState = {
  /** The declared accounts, already validated by {@link readDeclaredAccounts}. */
  accounts?: readonly DeclaredAccount[];
  /** The selector value in force for this session, if any. */
  currentAccount?: string;
};

/** Whether an entry declares both halves of an account. Anything else is a
 *  configuration error, not an account: it would put a row in the menu that
 *  selects nothing, or point the CLI at no directory at all. */
function toDeclaredAccount(entry: unknown): DeclaredAccount | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { name, configDir } = entry as { name?: unknown; configDir?: unknown };
  if (typeof name !== "string" || typeof configDir !== "string") {
    return undefined;
  }
  // The name is a LABEL, so surrounding whitespace is noise and is trimmed.
  // The directory is a PATH the CLI opens, so it is NOT trimmed — a trailing
  // space is legal in one — but a blank one names nothing and is refused.
  const label = name.trim();
  if (label.length === 0 || configDir.trim().length === 0) {
    return undefined;
  }
  return { name: label, configDir };
}

/**
 * The accounts declared in the resolved settings (D4), in declaration order.
 *
 * Read as `unknown` and validated here because it arrives from a settings file
 * a user edits: the SDK's `Settings` carries an index signature, so the key is
 * typed as nothing in particular and anything at all can be under it. A
 * malformed entry costs that entry and is reported — silently dropping it would
 * leave a selector missing a row with nothing to explain why.
 *
 * @param settings The resolved settings object (pass `settingsManager.getSettings()`).
 * @param logger Sink for the malformed-entry errors.
 */
export function readDeclaredAccounts(
  settings: { readonly [key: string]: unknown } | null | undefined,
  logger?: AccountLogger,
): DeclaredAccount[] {
  const declared = settings?.accounts;
  if (declared === undefined || declared === null) {
    return [];
  }
  if (!Array.isArray(declared)) {
    logger?.error(
      `Ignoring "accounts" in settings: expected an array of { name, configDir }, got ${typeof declared}.`,
    );
    return [];
  }
  const accounts: DeclaredAccount[] = [];
  declared.forEach((entry, index) => {
    const account = toDeclaredAccount(entry);
    if (account === undefined) {
      logger?.error(
        `Ignoring accounts[${index}] in settings: expected { name, configDir } with two non-empty strings.`,
      );
      return;
    }
    accounts.push(account);
  });
  return accounts;
}

/**
 * One selectable entry per declared account, in declaration order.
 *
 * The value is the declared display name. A name declared twice denotes two
 * DIFFERENT credential homes, and a selector that merged them into one row
 * would hand a user the account they did not pick — so a duplicated name is
 * numbered, in the order the accounts were declared.
 *
 * Numbered rather than told apart by the directory, deliberately. The profile
 * name (`accountIdentity`) would read better — and it is what story 002 already
 * shows for the account IN FORCE — but here it would put a fragment of a
 * credential home on the wire for accounts the user is merely being offered.
 * R6.4 asks that the selection be routed by an identifier the client can name;
 * a declaration position is exactly that, and it reveals nothing the user did
 * not already write down (D4).
 */
export function accountSelectorEntries(
  accounts: readonly DeclaredAccount[],
): AccountSelectorEntry[] {
  const nameCounts = new Map<string, number>();
  for (const account of accounts) {
    nameCounts.set(account.name, (nameCounts.get(account.name) ?? 0) + 1);
  }
  const numbered = new Map<string, number>();
  const taken = new Set<string>();
  return accounts.map((account, index) => {
    const ordinal = (numbered.get(account.name) ?? 0) + 1;
    numbered.set(account.name, ordinal);
    const duplicated = (nameCounts.get(account.name) ?? 0) > 1;
    let value = duplicated ? `${account.name} (${ordinal})` : account.name;
    // Last resort, for a list that already spells its own numbering (a "work"
    // twice over beside one literally declared as "work (1)"). The 1-based
    // declaration position is unique by construction and the string grows on
    // every pass, so this terminates and stays deterministic.
    while (taken.has(value)) {
      value = `${value} (${index + 1})`;
    }
    taken.add(value);
    return { account, value };
  });
}

/**
 * The account a session runs under: the selection when it names a declared
 * account, else the first declared one — declaration order is the contract
 * (D4), and a selector must report a value that is really in force. `undefined`
 * when nothing is declared, in which case no overlay is applied and the
 * process's own configuration home stands, exactly as before this option
 * existed.
 */
export function accountInForce(
  accounts: readonly DeclaredAccount[],
  selected: string | undefined,
): AccountSelectorEntry | undefined {
  const entries = accountSelectorEntries(accounts);
  return entries.find((entry) => entry.value === selected) ?? entries[0];
}

/** The declared account a selector value denotes, or `undefined` when the value
 *  was never declared — which is what makes an undeclared account refusable
 *  rather than silently applied (R6.3). */
export function accountForValue(
  accounts: readonly DeclaredAccount[],
  value: string,
): DeclaredAccount | undefined {
  return accountSelectorEntries(accounts).find((entry) => entry.value === value)?.account;
}

/**
 * The per-session environment overlay an account contributes: its configuration
 * directory, and nothing else (D2).
 *
 * One variable, because one is enough — credentials live under that directory,
 * so this is a reuse of what the CLI already does rather than an invention. It
 * is merged into the SDK's per-session `env` at query creation and is never
 * written back into `process.env`: that constant is read once into the
 * adapter's own configuration home (D3).
 */
export function envForAccount(account: DeclaredAccount): Record<string, string> {
  return { [ACCOUNT_CONFIG_DIR_ENV]: account.configDir };
}

/**
 * The account selector, or `undefined` when fewer than two accounts are
 * declared (D8, R6.2 — genuinely absent, not an empty row).
 *
 * @param accounts The declared accounts, in declaration order.
 * @param currentAccount The selector value in force; an unrecognized one (or
 *   none) falls back to the first declared account, which is what
 *   {@link accountInForce} applies, so the displayed row and the environment
 *   the session was started with agree.
 */
export function createAccountConfigOption(
  accounts: readonly DeclaredAccount[],
  currentAccount: string | undefined,
): SessionConfigOption | undefined {
  const entries = accountSelectorEntries(accounts);
  if (entries.length < MINIMUM_SELECTABLE_ACCOUNTS) {
    return undefined;
  }
  const current = entries.find((entry) => entry.value === currentAccount) ?? entries[0];
  return {
    id: ACCOUNT_CONFIG_ID,
    name: ACCOUNT_OPTION_NAME,
    description: ACCOUNT_OPTION_DESCRIPTION,
    type: "select",
    currentValue: current.value,
    // Names only. No `configDir`, and no per-account usage: the account in
    // force is the only one whose quota is reported (R6.4, D5), because a menu
    // showing every account's headroom side by side argues for spreading work
    // across them.
    options: entries.map((entry) => ({ value: entry.value, name: entry.value })),
  };
}
