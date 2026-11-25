// Upstream #1708: under a managed `disableSideloadFlags`, Claude Code refuses to start a session
// that brings client MCP servers (`sideload_flags_disabled`). The session starts again without
// them, keeps the original params for its next start, and reports them in one notice.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import {
  clientMcpServerNames,
  refusedMcpServersNotice,
  withoutClientMcpServers,
} from "../refused-mcp-servers.js";

const starts: Options[] = [];
let refuse: "never" | "with-servers" | "always" = "never";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery, startupFailure } = await import("./helpers.js");
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Options }) => {
      starts.push(args.options);
      const hasClient = Object.keys(args.options.mcpServers ?? {}).some((n) => n === "files");
      const refused = refuse === "always" || (refuse === "with-servers" && hasClient);
      return makeMockQuery({
        initializationResult: async () => {
          if (refused) {
            throw startupFailure(
              "sideload_flags_disabled",
              "--mcp-config is disabled by your organization's managed settings (disableSideloadFlags)",
            );
          }
          return {
            models: [
              {
                value: "claude-sonnet-4-6",
                displayName: "Sonnet",
                description: "d",
                supportsAutoMode: true,
              },
            ],
          };
        },
      });
    },
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return { ...actual, registerHookCallback: vi.fn() };
});

const files = { name: "files", command: "/bin/true", args: [], env: [] };

describe("refused-mcp-servers helpers", () => {
  it("names ACP and _meta option servers once each", () => {
    expect(
      clientMcpServerNames({
        cwd: "/",
        mcpServers: [files],
        _meta: { claudeCode: { options: { mcpServers: { docs: {}, files: {} } } } },
      }),
    ).toEqual(["files", "docs"]);
  });

  it("drops both kinds and keeps every other option", () => {
    const out = withoutClientMcpServers({
      cwd: "/",
      mcpServers: [files],
      _meta: { other: 1, claudeCode: { options: { mcpServers: { docs: {} }, model: "m" } } },
    });
    expect(out.mcpServers).toEqual([]);
    expect(out._meta).toEqual({ other: 1, claudeCode: { options: { model: "m" } } });
  });

  it("groups several servers in one notice", () => {
    const notice = refusedMcpServersNotice(["a", "b", "c"]);
    expect(notice.title).toBe("3 MCP servers failed to start");
    expect(notice.description).toContain('"a", "b" and "c"');
    expect(notice.description).toContain("disableSideloadFlags");
    expect(refusedMcpServersNotice(["a"]).title).toBe('MCP server "a" failed to start');
  });
});

describe("a session Claude Code refuses to start with its MCP servers", () => {
  let agent: ClaudeAcpAgentType;

  beforeEach(async () => {
    starts.length = 0;
    vi.resetModules();
    const acp = await import("../acp-agent.js");
    agent = new acp.ClaudeAcpAgent({ sessionUpdate: async () => {} } as unknown as AcpClient);
  });

  it("starts once more without them, and remembers them for the notice and the next start", async () => {
    refuse = "with-servers";
    const params = { cwd: process.cwd(), mcpServers: [files] };
    const res = await agent.newSession(params);
    expect(starts).toHaveLength(2);
    expect(Object.keys(starts[0].mcpServers ?? {})).toContain("files");
    expect(Object.keys(starts[1].mcpServers ?? {})).not.toContain("files");
    const session = agent.sessions[res.sessionId];
    expect(session.refusedMcpServers).toEqual(["files"]);
    expect(session.creationParams?.mcpServers).toEqual([files]);
  });

  it("does not retry a session without client MCP servers", async () => {
    refuse = "always";
    await expect(agent.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toMatchObject({
      data: { startupFailureReason: "sideload_flags_disabled" },
    });
    expect(starts).toHaveLength(1);
  });

  it("throws a second refusal (e.g. over plugins)", async () => {
    refuse = "always";
    await expect(
      agent.newSession({ cwd: process.cwd(), mcpServers: [files] }),
    ).rejects.toMatchObject({ data: { startupFailureReason: "sideload_flags_disabled" } });
    expect(starts).toHaveLength(2);
  });
});
