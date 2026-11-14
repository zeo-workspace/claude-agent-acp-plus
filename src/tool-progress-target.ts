/**
 * The tool call that a `tool_progress` beat reports on, of the calls the client
 * holds (`held`), or undefined for a beat to drop. Ported from upstream
 * claude-agent-acp #1612 (`progressToolCallId`), so the rule lives in one place.
 *
 * Not every beat reports under the id of a call the client has seen: a tool's
 * heartbeat derives `<tool_use_id>-heartbeat-<n>`, and the `agent_api_retry`
 * beats behind `subagentRetry` report under `agent_<assistant_message_id>`.
 * Forwarding those ids leaves the client resolving a call it was never told
 * about (#851). The SDK stamps `parent_tool_use_id` with the id of the executing
 * tool on them, so they go to that call. A beat under the id of a held call
 * keeps it: a subagent's `bash_progress`, whose parent is the Agent call that
 * spawned it.
 *
 * Dropped:
 * - a beat for a call the client does not hold: never announced, or returned
 *   (an id leaves `held` at its tool result, so a late beat cannot reopen it);
 * - the heartbeat of a hook that runs long (`hook-<event>-<id>-heartbeat-<n>`,
 *   since Claude Code 2.1.323). Its `tool_name` is the hook event and its
 *   elapsed time is the hook's. For a PreToolUse or PostToolUse hook its
 *   `parent_tool_use_id` is the tool call, which is not running then: sent on,
 *   it would mark the call `in_progress`, name it `PreToolUse` and restart its
 *   elapsed time. Hooks have no ACP surface, as `hook_started`/`hook_response`
 *   already show by being ignored.
 */
export function progressToolCallId(
  beat: { tool_use_id: string; parent_tool_use_id: string | null },
  held: ReadonlySet<string>,
): string | undefined {
  if (held.has(beat.tool_use_id)) return beat.tool_use_id;
  if (beat.tool_use_id.startsWith("hook-")) return undefined;
  const parent = beat.parent_tool_use_id;
  return parent !== null && held.has(parent) ? parent : undefined;
}
