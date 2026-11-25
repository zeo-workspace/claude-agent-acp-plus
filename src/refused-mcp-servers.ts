import type { NewSessionRequest } from "@agentclientprotocol/sdk/unstable";
import type { SessionNotice } from "./session-notices.js";

/**
 * Helpers for a session that Claude Code refused to start with its client MCP servers
 * (`sideload_flags_disabled`, SDK 0.3.331; upstream claude-agent-acp #1708).
 */

/** What the user is told of the servers a managed `disableSideloadFlags` keeps out (upstream's text). */
const NOT_FROM_AN_APPROVED_SOURCE =
  "Your organization's managed settings (disableSideloadFlags) let Claude Code use MCP servers only from sources that your administrator approved.";

type ClaudeCodeOptionsMeta = {
  claudeCode?: { options?: { mcpServers?: Record<string, unknown> } };
};

/** The names of a session's client MCP servers: its ACP servers and `_meta.claudeCode.options.mcpServers`. */
export function clientMcpServerNames(params: NewSessionRequest): string[] {
  const meta = params._meta as ClaudeCodeOptionsMeta | undefined;
  return [
    ...new Set([
      ...(params.mcpServers ?? []).map((server) => server.name),
      ...Object.keys(meta?.claudeCode?.options?.mcpServers ?? {}),
    ]),
  ];
}

/** The same request with no client MCP servers, the `_meta` options' ones included. */
export function withoutClientMcpServers(params: NewSessionRequest): NewSessionRequest {
  const meta = params._meta as (Record<string, unknown> & ClaudeCodeOptionsMeta) | undefined;
  const options = meta?.claudeCode?.options;
  if (!meta || !options?.mcpServers) return { ...params, mcpServers: [] };
  const { mcpServers: _dropped, ...rest } = options;
  void _dropped;
  return {
    ...params,
    mcpServers: [],
    _meta: { ...meta, claudeCode: { ...meta.claudeCode, options: rest } },
  };
}

/** One notice for every server the session started without. */
export function refusedMcpServersNotice(names: readonly string[]): SessionNotice {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length === 1) {
    return {
      severity: "warning",
      title: `MCP server ${quoted[0]} failed to start`,
      description: `Its tools are unavailable in this session. ${NOT_FROM_AN_APPROVED_SOURCE}`,
    };
  }
  return {
    severity: "warning",
    title: `${quoted.length} MCP servers failed to start`,
    description: `The tools of ${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)} are unavailable in this session. ${NOT_FROM_AN_APPROVED_SOURCE}`,
  };
}
