// §6.69 / §6.13 (plus half): MCP servers a client declares in `session/new`.
//
// Two halves. First, every server Plus cannot use is logged, by name, transport
// and reason — before this, an `acp` entry (or any unknown type) vanished with no
// trace. Second, MCP-over-ACP end to end: a real ACP client built on the ACP SDK's
// own `McpOverAcpProvider` declares a server with `type: "acp"`, `runAcp` hands
// it to the (mocked) Claude SDK as an in-process `sdk` server, and the test then
// plays the Claude CLI's part on that server's transport — `initialize`,
// `tools/list`, `tools/call`, cancellation, progress — so every request crosses the
// ACP pipe back to the client, as it will with Zeo.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  client as acpClient,
  McpOverAcpProvider,
  McpProtocolError,
  methods,
  ndJsonStream,
  type McpOperationContext,
  type McpOutcome,
} from "@agentclientprotocol/sdk/unstable";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";

let capturedOptions: Options[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: (args: { options: Options }) => {
      capturedOptions.push(args.options);
      return makeMockQuery({
        initializationResult: async () => ({
          models: [{ value: "claude-sonnet-4-6", displayName: "Sonnet", description: "Fast" }],
        }),
      });
    },
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return { ...actual, registerHookCallback: vi.fn() };
});

function capturingLogger() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, logger: { log: push, error: push } };
}

/** `key=value` fields of a log line; a quoted value keeps its spaces. */
function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
    out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return out;
}

const droppedLines = (lines: string[]) =>
  lines.filter((l) => l.includes("[mcp/servers]") && l.includes("event=dropped"));

let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
let runAcp: (typeof import("../acp-agent.js"))["runAcp"];

beforeEach(async () => {
  capturedOptions = [];
  vi.resetModules();
  const mod = await import("../acp-agent.js");
  ClaudeAcpAgent = mod.ClaudeAcpAgent;
  runAcp = mod.runAcp;
});

const agents: ClaudeAcpAgentType[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose().catch(() => {});
});

function bareClient(): AcpClient {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as unknown as AcpClient;
}

describe("servers Plus drops are logged (§6.69 step 1)", () => {
  it("logs an acp entry it cannot route, with name, transport and reason", async () => {
    const { lines, logger } = capturingLogger();
    const agent = new ClaudeAcpAgent(bareClient(), logger);
    agents.push(agent);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [{ type: "acp", name: "zeo lsp", serverId: "srv-1" } as any],
    });

    const dropped = droppedLines(lines);
    expect(dropped).toHaveLength(1);
    expect(fields(dropped[0])).toMatchObject({
      sessionId,
      server: "zeo lsp",
      transport: "acp",
      reason: "no-acp-bridge",
    });
    expect(capturedOptions.at(-1)!.mcpServers).not.toHaveProperty("zeo lsp");
  });

  it("logs an entry of an unknown transport instead of dropping it silently", async () => {
    const { lines, logger } = capturingLogger();
    const agent = new ClaudeAcpAgent(bareClient(), logger);
    agents.push(agent);
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [
        { type: "websocket", name: "future", url: "ws://x" } as any,
        { name: "local", command: "/bin/true", args: [], env: [] },
        { type: "http", name: "remote", url: "https://example.invalid/mcp", headers: [] },
      ],
    });

    const dropped = droppedLines(lines);
    expect(dropped).toHaveLength(1);
    expect(fields(dropped[0])).toMatchObject({
      server: "future",
      transport: "websocket",
      reason: "unsupported-transport",
    });
    const servers = capturedOptions.at(-1)!.mcpServers!;
    expect(servers.local).toMatchObject({ type: "stdio", command: "/bin/true" });
    expect(servers.remote).toMatchObject({ type: "http", url: "https://example.invalid/mcp" });
  });

  it("never logs a server's command, arguments, environment or headers", async () => {
    const { lines, logger } = capturingLogger();
    const agent = new ClaudeAcpAgent(bareClient(), logger);
    agents.push(agent);
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [
        {
          type: "future",
          name: "x",
          command: "/bin/SECRET-CMD",
          args: ["--api-key=SECRET-ARG"],
          env: [{ name: "TOKEN", value: "SECRET-ENV" }],
          headers: [{ name: "Authorization", value: "SECRET-HEADER" }],
        } as any,
      ],
    });
    expect(droppedLines(lines)).toHaveLength(1);
    for (const line of lines) expect(line).not.toMatch(/SECRET-/);
  });
});

// ---- MCP-over-ACP over the wire -------------------------------------------------

/** What the backend server saw, in order. */
type Seen = { method: string; params: Record<string, unknown> | undefined };
/** Holds a slow call open; records whether the caller's cancel reached it. */
type Gate = { release?: () => void; aborted?: boolean };

/** A stand-in for one of Zeo's running MCP servers, served by the ACP SDK's
 *  reference provider: the MCP 2026-07-28 stateless binding, no `initialize`. */
function backendHandler(seen: Seen[], gate: Gate) {
  return async (ctx: McpOperationContext): Promise<McpOutcome> => {
    seen.push({ method: ctx.method, params: ctx.params });
    switch (ctx.method) {
      case "server/discover":
        return {
          result: {
            supportedVersions: ["2026-07-28"],
            serverInfo: { name: "zeo-backend", version: "9.9.9" },
            capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
            instructions: "use the echo tool",
          },
        };
      case "tools/list":
        return {
          result: {
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          },
        };
      case "tools/call": {
        const args = (ctx.params?.arguments ?? {}) as Record<string, unknown>;
        if (args.fail) throw new McpProtocolError(-32602, "bad arguments");
        if (args.slow) {
          await ctx.notify("notifications/progress", {
            progressToken: (ctx.params?._meta as any)?.progressToken,
            progress: 1,
            total: 2,
          });
          await new Promise<void>((resolve) => {
            gate.release = resolve;
            ctx.signal.addEventListener(
              "abort",
              () => {
                gate.aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          if (ctx.signal.aborted) throw new Error("cancelled");
        }
        return { result: { content: [{ type: "text", text: String(args.text) }] } };
      }
      default:
        throw new McpProtocolError(-32601, `method not found: ${ctx.method}`);
    }
  };
}

/** `runAcp` on in-memory streams, and a client that serves one MCP server over
 *  ACP. Same stdin/stdout swap as task-actions.test.ts. */
function wire(logger: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void }) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
  Object.defineProperty(process, "stdin", { value: toAgent, configurable: true });
  Object.defineProperty(process, "stdout", { value: fromAgent, configurable: true });
  let started: ReturnType<typeof runAcp>;
  try {
    started = runAcp(logger);
  } finally {
    Object.defineProperty(process, "stdin", stdin);
    Object.defineProperty(process, "stdout", stdout);
  }
  agents.push(started.agent);
  const provider = new McpOverAcpProvider();
  const connection = acpClient({ name: "mcp-over-acp-test" })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.mcp.message, provider.handleRequest)
    .connect(ndJsonStream(nodeToWebWritable(toAgent), nodeToWebReadable(fromAgent)));
  return { connection, provider };
}

/** Plays the Claude CLI's side of the SDK's in-process MCP transport. */
function cliTransport() {
  const sent: any[] = [];
  const waiters: Array<() => void> = [];
  const transport = {
    onmessage: undefined as undefined | ((message: unknown) => void),
    onclose: undefined as undefined | (() => void),
    onerror: undefined as undefined | ((error: Error) => void),
    start: async () => {},
    send: async (message: unknown) => {
      sent.push(message);
      for (const w of waiters.splice(0)) w();
    },
    close: async () => transport.onclose?.(),
  };
  async function next(predicate: (m: any) => boolean): Promise<any> {
    for (;;) {
      const found = sent.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }
  const response = (id: number) => next((m) => m.id === id);
  const request = (id: number, method: string, params?: Record<string, unknown>) => {
    transport.onmessage!({ jsonrpc: "2.0", id, method, ...(params && { params }) });
    return response(id);
  };
  const notify = (method: string, params?: Record<string, unknown>) =>
    transport.onmessage!({ jsonrpc: "2.0", method, ...(params && { params }) });
  return { transport, sent, next, request, response, notify };
}

describe("MCP-over-ACP round trip (§6.69 step 3, §6.13 plus half)", () => {
  async function openSession() {
    const { lines, logger } = capturingLogger();
    const { connection, provider } = wire(logger);
    const seen: Seen[] = [];
    const gate: Gate = {};
    const registration = provider.registerServer(connection.agent, {
      name: "zeo-lsp",
      serverId: "zeo-lsp-test",
      handler: backendHandler(seen, gate),
    });
    const init = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [registration.declaration],
    });
    const options = capturedOptions.at(-1)!;
    const config = options.mcpServers!["zeo-lsp"] as any;
    return { init, session, options, config, seen, gate, lines, registration };
  }

  it("advertises mcpCapabilities.acp over the wire", async () => {
    const { init } = await openSession();
    expect(init.agentCapabilities?.mcpCapabilities).toMatchObject({
      http: true,
      sse: true,
      acp: true,
    });
  });

  it("hands an acp entry to the SDK as an in-process server, and drops nothing", async () => {
    const { config, lines } = await openSession();
    expect(config).toMatchObject({ type: "sdk", name: "zeo-lsp" });
    expect(typeof config.instance?.connect).toBe("function");
    expect(droppedLines(lines)).toEqual([]);
  });

  it("answers the CLI's initialize from server/discover, without forwarding initialize", async () => {
    const { config, seen } = await openSession();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);

    const reply = await cli.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2" },
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "zeo-backend", version: "9.9.9" },
      instructions: "use the echo tool",
    });
    // Change notifications cannot reach the CLI in this version (they belong to
    // an active request), so the capability that promises them is withheld.
    expect(reply.result.capabilities.tools).toEqual({});
    expect(reply.result.capabilities.resources).toEqual({});
    cli.notify("notifications/initialized");
    expect(seen.map((s) => s.method)).toEqual(["server/discover"]);
  });

  it("forwards tools/list and tools/call to the client's server", async () => {
    const { config, seen } = await openSession();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    await cli.request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {} });

    const list = await cli.request(2, "tools/list", {});
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["echo"]);

    const call = await cli.request(3, "tools/call", {
      name: "echo",
      arguments: { text: "hello over acp" },
    });
    expect(call.result).toEqual({ content: [{ type: "text", text: "hello over acp" }] });
    // Every forwarded request carries the stateless binding's per-request metadata.
    const forwarded = seen.find((s) => s.method === "tools/call")!;
    expect((forwarded.params?._meta as any)?.["io.modelcontextprotocol/protocolVersion"]).toBe(
      "2026-07-28",
    );
  });

  it("returns a backend's MCP error as a JSON-RPC error with the same code", async () => {
    const { config } = await openSession();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    const reply = await cli.request(4, "tools/call", { name: "echo", arguments: { fail: true } });
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatchObject({ code: -32602, message: "bad arguments" });
  });

  it("answers ping locally", async () => {
    const { config, seen } = await openSession();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    const reply = await cli.request(5, "ping");
    expect(reply).toMatchObject({ id: 5, result: {} });
    expect(seen).toEqual([]);
  });

  it("relays progress, and cancels the forwarded request on notifications/cancelled", async () => {
    const { config, seen, gate } = await openSession();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    cli.transport.onmessage!({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "echo", arguments: { slow: true }, _meta: { progressToken: "p-1" } },
    });
    const progress = await cli.next((m) => m.method === "notifications/progress");
    expect(progress.params).toMatchObject({ progressToken: "p-1", progress: 1, total: 2 });

    cli.notify("notifications/cancelled", { requestId: 6, reason: "user" });
    const reply = await cli.response(6);
    expect(reply.error).toBeDefined();
    // The CLI's cancel crossed the ACP pipe and aborted the backend's handler.
    await vi.waitFor(() => expect(gate.aborted).toBe(true));
    expect(seen.filter((s) => s.method === "tools/call")).toHaveLength(1);
  });

  it("logs each forwarded request by server and method, never its arguments", async () => {
    const { config, lines } = await openSession();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    await cli.request(7, "tools/call", { name: "echo", arguments: { text: "SECRET-ARGUMENT" } });
    const requestLines = lines.filter((l) => l.includes("[mcp/acp]") && l.includes("tools/call"));
    expect(requestLines).toHaveLength(1);
    expect(fields(requestLines[0])).toMatchObject({
      server: "zeo-lsp",
      serverId: "zeo-lsp-test",
      method: "tools/call",
      outcome: "result",
    });
    for (const line of lines) expect(line).not.toContain("SECRET-ARGUMENT");
  });

  it("fails the CLI's initialize when the client no longer serves the server", async () => {
    // An outer binding failure (here -33001, no registration) means nothing is
    // there to proxy: the CLI must mark the server failed, so Plus's
    // "failed to start" notice fires, rather than show a server with no tools.
    const { config, registration } = await openSession();
    await registration.dispose();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    const reply = await cli.request(9, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
    });
    expect(reply.result).toBeUndefined();
    expect(reply.error?.code).toBe(-33001);
    expect(reply.error?.message).toMatch(/zeo-lsp/);
  });

  it("falls back to a tools-only server when the client cannot answer server/discover", async () => {
    const { lines, logger } = capturingLogger();
    const { connection, provider } = wire(logger);
    const registration = provider.registerServer(connection.agent, {
      name: "legacy",
      serverId: "legacy-1",
      handler: (ctx) => {
        if (ctx.method === "server/discover") throw new McpProtocolError(-32601, "no discovery");
        return { result: { tools: [] } };
      },
    });
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await connection.agent.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [registration.declaration],
    });
    const config = capturedOptions.at(-1)!.mcpServers!.legacy as any;
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    const reply = await cli.request(1, "initialize", { protocolVersion: "2025-11-25" });
    expect(reply.result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: "legacy" },
    });
    expect(
      lines.some((l) => l.includes("event=discover-failed") && l.includes("code=-32601")),
    ).toBe(true);
  });

  it("serves a second transport after the query is recreated", async () => {
    const { config } = await openSession();
    const first = cliTransport();
    await config.instance.connect(first.transport);
    await first.transport.close();
    const second = cliTransport();
    await config.instance.connect(second.transport);
    const list = await second.request(1, "tools/list", {});
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["echo"]);
  });

  it("answers an MCP error once the client has withdrawn the server", async () => {
    const { config, registration } = await openSession();
    const cli = cliTransport();
    await config.instance.connect(cli.transport);
    await registration.dispose();
    const reply = await cli.request(8, "tools/list", {});
    expect(reply.result).toBeUndefined();
    expect(reply.error?.code).toBeTypeOf("number");
    expect(reply.error?.message).toMatch(/zeo-lsp/);
  });
});
