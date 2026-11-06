// Story 065, Task 5.1 — children are read-only for config and cannot be loaded
// alone (R5.1, R5.2).
//
// Integration: the real `ClaudeAcpAgent` over a scripted SDK stream (a child
// only exists once a launch made one) and, for a child that came back with its
// parent's `session/load`, transcripts on disk (child-sessions-transcripts.ts).
// The refusal is `invalidParams` (-32602) with design.md's message:
// "subagent sessions are read-only and loaded with their parent".
//
// Hostile halves first: the guard must not catch the parent, nor an id that
// names no session at all — those keep the errors and results they have today.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agentEnded,
  agentStarted,
  agentToolUse,
  assistant,
  type Launch,
  toolResult,
} from "./child-sessions-harness.js";
import { connect, disconnectAll, RFD_CAPABILITIES } from "./child-sessions-connection.js";
import { writeSessionWithChildren } from "./child-sessions-transcripts.js";

const configDir = vi.hoisted(() => {
  // Read once into a module constant by acp-agent.ts: set before it loads.
  const dir = `${process.env.TMPDIR ?? "/tmp"}/rfd-read-only-${process.pid}-${Date.now()}`;
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
});

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { capturingQuery } = await import("./child-sessions-harness.js");
  return { ...actual, query: vi.fn(capturingQuery) };
});

const cwds: string[] = [];

afterEach(disconnectAll);
afterAll(() => {
  for (const dir of [configDir, ...cwds]) rmSync(dir, { recursive: true, force: true });
});

const PARSER: Launch = {
  toolUseId: "toolu_01ParserLaunch",
  agentId: "a3f9c1d2e4b5a6c7",
  name: "parser-finder",
  subagentType: "Explore",
  description: "Find the parser",
  prompt: "Find where the config parser lives.",
};

const INVALID_PARAMS = -32602;
const READ_ONLY = /read-only/i;
const WITH_PARENT = /loaded with (their|its) parent/i;

/** A session whose turn made one child, PARSER, and ended. */
async function parentWithChild() {
  const c = await connect(RFD_CAPABILITIES);
  const s = await c.open();
  const response = s.prompt();
  s.push(assistant(s.sessionId, [agentToolUse(PARSER)]));
  s.push(agentStarted(s.sessionId, PARSER));
  s.push(agentEnded(s.sessionId, PARSER));
  s.push(toolResult(s.sessionId, PARSER.toolUseId, "done"));
  s.endTurn();
  await response;
  return { c, s };
}

describe("child sessions — read-only (R5.1, R5.2)", () => {
  it("still sets a config option on the parent", async () => {
    const { c, s } = await parentWithChild();

    await expect(
      c.agent.setSessionConfigOption({ sessionId: s.sessionId, configId: "mode", value: "plan" }),
    ).resolves.toBeDefined();
  });

  it("answers an id that names no session as before, not as a read-only child", async () => {
    const { c } = await parentWithChild();

    const config = c.agent.setSessionConfigOption({
      sessionId: "no-such-session",
      configId: "mode",
      value: "plan",
    });
    await expect(config).rejects.toThrow("Session not found");
    await expect(config).rejects.not.toThrow(READ_ONLY);
    const close = c.agent.closeSession({ sessionId: "no-such-session" });
    await expect(close).rejects.toThrow("Session not found");
    await expect(close).rejects.not.toThrow(WITH_PARENT);
  });

  it("refuses to set a config option on a child, naming it read-only", async () => {
    const { c } = await parentWithChild();

    const config = c.agent.setSessionConfigOption({
      sessionId: PARSER.agentId,
      configId: "mode",
      value: "plan",
    });
    await expect(config).rejects.toMatchObject({ code: INVALID_PARAMS });
    await expect(config).rejects.toThrow(READ_ONLY);
  });

  it.each(["load", "resume", "close"] as const)(
    "refuses to %s a child on its own: children are loaded with their parent",
    async (verb) => {
      const { c } = await parentWithChild();
      const params = { sessionId: PARSER.agentId, cwd: process.cwd(), mcpServers: [] };
      const call =
        verb === "load"
          ? c.agent.loadSession(params)
          : verb === "resume"
            ? c.agent.resumeSession(params)
            : c.agent.closeSession({ sessionId: PARSER.agentId });

      await expect(call).rejects.toMatchObject({ code: INVALID_PARAMS });
      await expect(call).rejects.toThrow(WITH_PARENT);
    },
  );

  it("refuses a config option on a child that came back with its parent's load", async () => {
    const parent = "5e1d0c2a-7b3f-4c9e-8a61-2f4d6b8c0e13";
    const cwd = await mkdtemp(path.join(os.tmpdir(), "rfd-read-only-cwd-"));
    cwds.push(cwd);
    await writeSessionWithChildren(configDir, cwd, parent, [
      {
        agentId: PARSER.agentId,
        toolUseId: PARSER.toolUseId,
        name: PARSER.name!,
        agentType: PARSER.subagentType!,
        description: PARSER.description,
        prompt: PARSER.prompt!,
        said: "The parser is src/config.rs.",
      },
    ]);
    const c = await connect(RFD_CAPABILITIES);
    await c.agent.loadSession({ sessionId: parent, cwd, mcpServers: [] });

    const config = c.agent.setSessionConfigOption({
      sessionId: PARSER.agentId,
      configId: "mode",
      value: "plan",
    });
    await expect(config).rejects.toMatchObject({ code: INVALID_PARAMS });
    await expect(config).rejects.toThrow(READ_ONLY);
  });
});
