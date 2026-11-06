import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable";

/**
 * How a client gets native subagent sessions.
 *
 * `rfd`: the subagents RFD (agentclientprotocol/agent-client-protocol#1992,
 * as revised) — `subagent_update` and `session_message`, which the SDK types.
 * Ported from upstream `src/acp-subagents.ts` without its `air` form: AIR's
 * earlier draft of the RFD has no client in this chain (story 065, design.md).
 */
export type SubagentForm = "rfd";

/** The form of native subagent sessions that the client gets, or none. */
export function subagentForm(capabilities?: ClientCapabilities | null): SubagentForm | undefined {
  return clientSupportsSubagents(capabilities) ? "rfd" : undefined;
}

/**
 * The schema's `SubagentCapabilities` is an object (`{}` or `{ _meta }`); any
 * other shape is not a declaration. Zed drops `subagent_update` and
 * `session_message` from a client that did not advertise it, so a false yes
 * here loses the subagents entirely.
 */
export function clientSupportsSubagents(capabilities?: ClientCapabilities | null): boolean {
  const subagents = capabilities?.subagents;
  return typeof subagents === "object" && subagents !== null && !Array.isArray(subagents);
}
