import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** How an option reaches the Claude CLI: in a flag, or over stdin in the SDK's initialize request. */
export type CliDelivery = NonNullable<Options["mcpServersDelivery"]>;

/**
 * The SDK options that say how a session's MCP servers and its `settings` reach the Claude CLI.
 * Ported from upstream claude-agent-acp #1647 and #1669 (`src/claude-cli.ts` `cliDelivery()`).
 *
 * Why: with the SDK default (`'argv'`) the client's MCP servers travel in one `--mcp-config` flag
 * and the settings in `--settings`, so every stdio server's `env` and every remote server's
 * `headers` (API keys, bearer tokens) sit on the CLI's command line, where any other user of the
 * machine can read them in `/proc/<pid>/cmdline` (SDK 0.3.326 `sdk.d.ts`, `mcpServersDelivery`).
 *
 * - `'initialize'` for the CLI bundled with the SDK (the one plus spawns unless
 *   `CLAUDE_CODE_EXECUTABLE` is set): over stdin, in the SDK's initialize request.
 * - `'argv'` for a CLI that `CLAUDE_CODE_EXECUTABLE` names: its version is unknown, and a CLI too
 *   old to read them over stdin fails the session at startup (CLI 2.1.323: "too old to read MCP
 *   servers from the initialize request", "unknown option '--initialize-fields=settings'").
 * - `settings` stay `'argv'` when the client's `extraArgs` carry `settings` (the CLI refuses both
 *   at once: "--initialize-fields=settings cannot be used with --settings") or `sdk-url` (such a
 *   session cannot read the request at launch, and the SDK keeps its MCP servers in the flag too).
 *
 * The SDK reads `settingsDelivery` (0.3.328) without declaring it in `sdk.d.ts`, so nothing fails
 * to compile if a later SDK drops it. Spread before the client's own options, so a client's
 * explicit `mcpServersDelivery`/`settingsDelivery` wins.
 */
export function cliDelivery(
  clientExtraArgs: Options["extraArgs"],
  env: Record<string, string | undefined> = process.env,
): { mcpServersDelivery: CliDelivery; settingsDelivery: CliDelivery } {
  const delivery: CliDelivery = env.CLAUDE_CODE_EXECUTABLE ? "argv" : "initialize";
  const settingsInFlag = Object.keys(clientExtraArgs ?? {}).some(
    (name) => name === "settings" || name === "sdk-url" || name.startsWith("sdk-url="),
  );
  return { mcpServersDelivery: delivery, settingsDelivery: settingsInFlag ? "argv" : delivery };
}
