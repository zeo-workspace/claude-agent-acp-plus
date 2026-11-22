/**
 * MCP-over-ACP, agent side (§6.69 step 3 / §6.13's plus half).
 *
 * A client such as Zeo can declare an MCP server with `type: "acp"` in
 * `session/new`: the server keeps running inside the client, and the agent
 * reaches it by sending `mcp/message` requests back over the ACP connection it
 * already has. No second process, no API key in an agent's argv, and it works
 * for a jailed agent that cannot see the client's files or sockets.
 *
 * The Claude CLI cannot speak that binding itself, so each declared server is
 * handed to the Claude SDK as an in-process `sdk` server whose `instance` is the
 * proxy below. The CLI speaks ordinary, stateful MCP to it over the SDK's
 * in-process transport; the proxy translates to the binding, which is MCP
 * 2026-07-28 and stateless (ACP SDK 2.6.0 `mcp/core.d.ts`; Rust ACP 5.4.0
 * `mcp_server/active_session.rs` rejects `initialize`):
 *
 * - `initialize` is answered here, from one `server/discover` sent to the client.
 *   Discovery is what the stateless revision has instead of a handshake.
 * - `ping` is answered here; `notifications/initialized` is absorbed.
 * - every other request is forwarded verbatim through `McpOverAcpCaller`, which
 *   adds the per-request protocol `_meta` the binding requires. It is a generic
 *   pass-through on purpose: `tools/*`, `resources/*`, `prompts/*` and
 *   `completion/complete` need no per-method code, and a method added to MCP later
 *   reaches the server without a change here.
 * - `notifications/cancelled` aborts the forwarded request; the request-scoped
 *   notifications the server sends back (progress) are relayed to the CLI.
 *
 * Not in this version: change notifications (`list_changed`, resource updates).
 * Over the binding a notification belongs to an active request, so a server
 * that adds tools mid-session is only seen by the next session. The
 * capabilities the proxy reports therefore withhold `listChanged` and
 * `subscribe`, so the CLI does not wait for events that cannot arrive.
 */

import type {
  McpNotification,
  McpOutcome,
  McpRequestOptions,
} from "@agentclientprotocol/sdk/unstable";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "./acp-agent.js";

/** Sends one MCP request to a server the client declared over ACP; resolves with
 *  the inner MCP outcome and rejects on an outer ACP/binding failure. */
export type McpOverAcpRequest = (
  serverId: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: Pick<McpRequestOptions, "signal" | "onNotification">,
) => Promise<McpOutcome>;

/** The subset of the MCP SDK's `Transport` that the Claude SDK hands to an
 *  `sdk` server's `instance.connect` (sdk.mjs `connectSdkMcpServer`). Typed here
 *  so Plus does not import `@modelcontextprotocol/sdk`, which it only has as a
 *  dependency of the Claude SDK. */
type InProcessTransport = {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
};

type JsonRpcId = string | number;
type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** The fallback when the CLI names no revision (it always does today). */
const FALLBACK_PROTOCOL_VERSION = "2025-11-25";
/** JSON-RPC internal error, for an outer failure with no usable code. */
const INTERNAL_ERROR = -32603;

export type AcpMcpProxyOptions = {
  /** The name the client declared; it is also the SDK server's name. */
  name: string;
  serverId: string;
  sessionId: string;
  request: McpOverAcpRequest;
  logger: Logger;
};

type DiscoveredServer = {
  capabilities: Record<string, unknown>;
  serverInfo: Record<string, unknown>;
  instructions?: string;
};

/** An outer failure: the client could not serve the server at all. */
type DiscoveryFailure = { failure: { code: number; message: string } };

/** Builds the SDK server config for one ACP-declared MCP server. */
export function acpMcpServerConfig(options: AcpMcpProxyOptions): McpSdkServerConfigWithInstance {
  return {
    type: "sdk",
    name: options.name,
    // The Claude SDK only ever calls `instance.connect(transport)` on an sdk
    // server (sdk.mjs `connectSdkMcpServer`); the MCP SDK's `McpServer` class
    // is the declared type, not a requirement.
    instance: createAcpMcpProxy(options) as unknown as McpSdkServerConfigWithInstance["instance"],
  };
}

/** The proxy object. `connect` may be called more than once — a query that is
 *  recreated mid-session (model or thinking swap) reuses the same options — and
 *  each transport gets its own in-flight table. Discovery is shared. */
export function createAcpMcpProxy(options: AcpMcpProxyOptions) {
  const { name, serverId, sessionId, request, logger } = options;
  let discovery: Promise<DiscoveredServer | DiscoveryFailure> | undefined;

  const log = (event: string, fields: string) =>
    logger.log(
      `[mcp/acp] event=${event} sessionId=${sessionId} server=${JSON.stringify(name)} serverId=${JSON.stringify(serverId)} ${fields}`,
    );

  /** An inner MCP error (a server that does not implement `server/discover`)
   *  falls back to a tools-only description. An outer failure (no
   *  registration, a broken binding) fails `initialize`, so the CLI marks the
   *  server failed and the session gets its "failed to start" notice instead
   *  of a server that answers nothing. */
  function discover(): Promise<DiscoveredServer | DiscoveryFailure> {
    discovery ??= request(serverId, "server/discover", {}, {}).then(
      (outcome) => {
        if ("result" in outcome && isObject(outcome.result)) {
          const result = outcome.result;
          return {
            capabilities: withoutChangeNotifications(
              isObject(result.capabilities) ? result.capabilities : {},
            ),
            serverInfo: isObject(result.serverInfo) ? result.serverInfo : { name, version: "0" },
            ...(typeof result.instructions === "string" && { instructions: result.instructions }),
          };
        }
        const code = "error" in outcome ? outcome.error.code : "none";
        log("discover-failed", `code=${code}`);
        return fallbackDiscovery(name);
      },
      (error: unknown): DiscoveryFailure => {
        const code = errorCode(error);
        log("discover-failed", `code=${code} outer=true`);
        // Forget the failure so the next `initialize` (a reconnect) asks again.
        discovery = undefined;
        return {
          failure: {
            code: typeof code === "number" ? code : INTERNAL_ERROR,
            message: `MCP server "${name}" over ACP: ${errorMessage(error)}`,
          },
        };
      },
    );
    return discovery;
  }

  return {
    async connect(transport: InProcessTransport): Promise<void> {
      const inFlight = new Map<JsonRpcId, AbortController>();
      const reply = (message: Omit<JsonRpcMessage, "jsonrpc">) =>
        transport.send({ jsonrpc: "2.0", ...message }).catch((error: unknown) => {
          // The CLI closed the transport while a reply was pending: nothing to
          // answer any more, and nothing the caller can do about it.
          log("reply-dropped", `reason=${JSON.stringify(String(error))}`);
        });

      const forward = async (id: JsonRpcId, method: string, params?: Record<string, unknown>) => {
        const controller = new AbortController();
        inFlight.set(id, controller);
        const started = Date.now();
        try {
          const outcome = await request(serverId, method, params, {
            signal: controller.signal,
            onNotification: (notification: McpNotification) =>
              void reply({
                method: notification.method,
                ...(notification.params ? { params: notification.params } : {}),
              }),
          });
          const ms = Date.now() - started;
          if ("result" in outcome) {
            log("request", `method=${method} outcome=result ms=${ms}`);
            await reply({ id, result: outcome.result ?? {} });
          } else {
            log("request", `method=${method} outcome=error code=${outcome.error.code} ms=${ms}`);
            await reply({ id, error: outcome.error });
          }
        } catch (error) {
          const code = errorCode(error);
          log(
            "request",
            `method=${method} outcome=failed code=${code} cancelled=${controller.signal.aborted} ms=${Date.now() - started}`,
          );
          await reply({
            id,
            error: {
              code: typeof code === "number" ? code : INTERNAL_ERROR,
              message: `MCP server "${name}" over ACP: ${errorMessage(error)}`,
            },
          });
        } finally {
          inFlight.delete(id);
        }
      };

      transport.onmessage = (message: JsonRpcMessage) => {
        const { id, method } = message;
        if (method === undefined) return; // a response: the proxy never asks the CLI anything
        if (id === undefined) {
          if (method === "notifications/cancelled") {
            const target = message.params?.requestId;
            if (typeof target === "string" || typeof target === "number") {
              inFlight.get(target)?.abort();
            }
          }
          // `notifications/initialized` and anything else client-to-server: the
          // binding is stateless, so there is no session to tell.
          return;
        }
        if (method === "initialize") {
          const requested = message.params?.protocolVersion;
          void discover().then((server) =>
            "failure" in server
              ? reply({ id, error: server.failure })
              : reply({
                  id,
                  result: {
                    protocolVersion:
                      typeof requested === "string" ? requested : FALLBACK_PROTOCOL_VERSION,
                    ...server,
                  },
                }),
          );
          return;
        }
        if (method === "ping") {
          void reply({ id, result: {} });
          return;
        }
        void forward(id, method, message.params);
      };
      transport.onclose = () => {
        for (const controller of inFlight.values()) controller.abort();
        inFlight.clear();
      };
      await transport.start();
    },
    async close(): Promise<void> {},
  };
}

function fallbackDiscovery(name: string): DiscoveredServer {
  // Without discovery nothing is known; tools are the one capability every
  // server the client proxies is expected to have, and an unsupported method
  // comes back as an ordinary MCP error.
  return { capabilities: { tools: {} }, serverInfo: { name, version: "0" } };
}

/** Drops `listChanged` and `subscribe`: see the module comment. */
function withoutChangeNotifications(capabilities: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    if (isObject(value)) {
      const rest = { ...value };
      delete rest.listChanged;
      delete rest.subscribe;
      out[key] = rest;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): number | "none" {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : "none";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
