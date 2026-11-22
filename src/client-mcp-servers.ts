/**
 * The MCP servers a client declares in `session/new` (and load, resume, fork),
 * mapped onto the Claude SDK's `mcpServers` option.
 *
 * Before §6.69 an entry Plus could not map vanished without a trace: an `acp`
 * entry from a client that speaks MCP-over-ACP looked, from the client's side,
 * like a server the agent had accepted. Every entry that does not reach the SDK
 * is now returned with the reason, for the caller to log; this module only maps.
 */

import type { NewSessionRequest } from "@agentclientprotocol/sdk/unstable";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { acpMcpServerConfig, type McpOverAcpRequest } from "./mcp-over-acp.js";
import type { Logger } from "./acp-agent.js";

export type ClientMcpServerDrop = {
  name: string;
  /** The entry's `type`, or `stdio` for a typeless entry. */
  transport: string;
  reason:
    /** `type: "acp"`, but this connection cannot carry `mcp/message`. */
    | "no-acp-bridge"
    /** A transport Plus does not know. */
    | "unsupported-transport"
    /** The name is taken by a server Plus registers itself. */
    | "reserved-name";
};

export type ClientMcpServersDeps = {
  sessionId: string;
  /** Present when the connection can send `mcp/message` to the client. */
  requestMcp?: McpOverAcpRequest;
  /** Names Plus registers itself; a client entry cannot replace one. */
  reservedNames: ReadonlySet<string>;
  logger: Logger;
};

export function mapClientMcpServers(
  servers: NewSessionRequest["mcpServers"] | undefined,
  deps: ClientMcpServersDeps,
): { servers: Record<string, McpServerConfig>; dropped: ClientMcpServerDrop[] } {
  const mapped: Record<string, McpServerConfig> = {};
  const dropped: ClientMcpServerDrop[] = [];
  if (!Array.isArray(servers)) return { servers: mapped, dropped };

  for (const server of servers) {
    // Read through `unknown`: the point is to cope with entries the schema in
    // this build does not describe.
    const entry = server as unknown as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : String(entry.name);
    const type = "type" in entry ? String(entry.type) : undefined;
    const transport = type ?? "stdio";
    if (deps.reservedNames.has(name)) {
      dropped.push({ name, transport, reason: "reserved-name" });
      continue;
    }
    if ("type" in server && (server.type === "http" || server.type === "sse")) {
      mapped[name] = {
        type: server.type,
        url: server.url,
        headers: server.headers
          ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
          : undefined,
      };
    } else if (!("type" in server)) {
      // Stdio: the ACP schema gives it no `type` field.
      mapped[name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env ? Object.fromEntries(server.env.map((e) => [e.name, e.value])) : undefined,
      };
    } else if (server.type === "acp") {
      if (!deps.requestMcp) {
        dropped.push({ name, transport, reason: "no-acp-bridge" });
        continue;
      }
      mapped[name] = acpMcpServerConfig({
        name,
        serverId: server.serverId,
        sessionId: deps.sessionId,
        request: deps.requestMcp,
        logger: deps.logger,
      });
    } else {
      dropped.push({ name, transport, reason: "unsupported-transport" });
    }
  }
  return { servers: mapped, dropped };
}

/** One `key=value` line per dropped entry. Never the command, arguments,
 *  environment, URL or headers: any of them can carry a credential (§6.64 found
 *  an API key in an extension's argv). */
export function logDroppedClientMcpServers(
  logger: Logger,
  sessionId: string,
  dropped: readonly ClientMcpServerDrop[],
): void {
  for (const drop of dropped) {
    logger.log(
      `[mcp/servers] event=dropped level=warn sessionId=${sessionId} server=${JSON.stringify(drop.name)} transport=${JSON.stringify(drop.transport)} reason=${drop.reason}`,
    );
  }
}
