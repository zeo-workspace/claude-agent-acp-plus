// Tests for MCP server and settings delivery to the Claude CLI (upstream #1647, #1669).
//
// With the SDK default ('argv') a client MCP server's `env`/`headers` and the session's settings
// sit on the CLI's command line, readable by other users of the machine. The bundled CLI takes
// them over stdin ('initialize'); a CLI named by CLAUDE_CODE_EXECUTABLE keeps 'argv'.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { cliDelivery } from "../cli-delivery.js";

let capturedOptions: Options | undefined;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Options }) => {
      capturedOptions = args.options;
      return makeMockQuery({
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-6",
              displayName: "Sonnet",
              description: "d",
              supportsAutoMode: true,
            },
          ],
        }),
      });
    },
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return { ...actual, registerHookCallback: vi.fn() };
});

describe("cliDelivery", () => {
  it("sends both over stdin for the bundled CLI", () => {
    expect(cliDelivery(undefined, {})).toEqual({
      mcpServersDelivery: "initialize",
      settingsDelivery: "initialize",
    });
  });

  it("keeps both on argv for a CLI named by CLAUDE_CODE_EXECUTABLE", () => {
    expect(cliDelivery(undefined, { CLAUDE_CODE_EXECUTABLE: "/opt/bin/claude" })).toEqual({
      mcpServersDelivery: "argv",
      settingsDelivery: "argv",
    });
  });

  it.each([["settings"], ["sdk-url"], ["sdk-url=ws://x"]])(
    "keeps settings on argv when the client's extraArgs carry %s",
    (name) => {
      expect(cliDelivery({ [name]: "x" }, {})).toEqual({
        mcpServersDelivery: "initialize",
        settingsDelivery: "argv",
      });
    },
  );
});

describe("session options carry the delivery", () => {
  let acp: typeof import("../acp-agent.js");
  let agent: ClaudeAcpAgentType;

  beforeEach(async () => {
    capturedOptions = undefined;
    vi.resetModules();
    delete process.env.CLAUDE_CODE_EXECUTABLE;
    acp = await import("../acp-agent.js");
    agent = new acp.ClaudeAcpAgent({ sessionUpdate: async () => {} } as unknown as AcpClient);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a new session sends MCP servers and settings over stdin", async () => {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(capturedOptions).toMatchObject({
      mcpServersDelivery: "initialize",
      settingsDelivery: "initialize",
    });
  });

  it("a client's own delivery option wins", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { options: { mcpServersDelivery: "argv" } } },
    });
    expect(capturedOptions?.mcpServersDelivery).toBe("argv");
  });
});
