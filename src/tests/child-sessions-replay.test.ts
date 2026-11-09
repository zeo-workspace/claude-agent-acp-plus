// Story 065, Task 4.1 — children keep their ids across load and restart
// (R4.1, R4.2, R4.3; Q10).
//
// Integration: the real `ClaudeAcpAgent`, the real SDK transcript readers and
// transcripts on disk in a throwaway CLAUDE_CONFIG_DIR
// (child-sessions-transcripts.ts); only `query()` is scripted. A child's id is
// its SDK agent id, the name of its transcript, which is also the
// `task_started.task_id` it had live (child-sessions.test.ts asserts that
// half), so a replay that derives it from the transcript reuses the live id.
//
// Hostile halves first: two children of one parent must not collapse into one,
// a child must not split into two (once per message, or once under its Agent
// call's id), and a third session's child on the same disk must not join.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  agentEnded,
  agentStarted,
  agentTextOn,
  announcedChildren,
  announcement,
  assistant,
  type Launch,
  subagentUpdates,
  toolResult,
  waitFor,
} from "./child-sessions-harness.js";
import {
  connect,
  disconnectAll,
  NESTED_CAPABILITIES,
  RFD_CAPABILITIES,
} from "./child-sessions-connection.js";
import { type TranscriptChild, writeSessionWithChildren } from "./child-sessions-transcripts.js";

const configDir = vi.hoisted(() => {
  // Read once into a module constant by acp-agent.ts: set before it loads.
  const dir = `${process.env.TMPDIR ?? "/tmp"}/rfd-replay-${process.pid}-${Date.now()}`;
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

afterEach(async () => {
  await disconnectAll();
  rmSync(cwd, { recursive: true, force: true });
});
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

const PARENT = "5e1d0c2a-7b3f-4c9e-8a61-2f4d6b8c0e13";
const OTHER = "9a7c5e3b-1d2f-4e6a-8b0c-3e5f7a9b1c2d";
const PARSER: TranscriptChild = {
  agentId: "a3f9c1d2e4b5a6c7",
  toolUseId: "toolu_01ParserLaunch",
  name: "parser-finder",
  agentType: "Explore",
  description: "Find the parser",
  prompt: "Find where the config parser lives.",
  said: "The parser is src/config.rs.",
};
// Same name, role, description and prompt: only the ids tell the two apart.
const TWIN: TranscriptChild = {
  ...PARSER,
  agentId: "b8e2d4f6a1c3e5d7",
  toolUseId: "toolu_01TwinLaunch",
  said: "The parser is src/settings.rs.",
};
const STRANGER: TranscriptChild = {
  ...PARSER,
  agentId: "e4c6a8b0d2f4e6a8",
  toolUseId: "toolu_01StrangerLaunch",
  said: "I belong to another session.",
};

const u = (n: SessionNotification) => n.update as Record<string, any>;
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "rfd-replay-cwd-"));
  await writeSessionWithChildren(configDir, cwd, PARENT, [PARSER, TWIN]);
  await writeSessionWithChildren(configDir, cwd, OTHER, [STRANGER]);
});

async function loadParent(capabilities: Record<string, unknown> = RFD_CAPABILITIES) {
  const c = await connect(capabilities);
  await c.agent.loadSession({ sessionId: PARENT, cwd, mcpServers: [] });
  return c;
}

describe("child sessions — replay and restore (R4.1, R4.2, R4.3)", () => {
  it("replays two children of one parent as two, and no child of another session", async () => {
    const c = await loadParent();

    expect(announcedChildren(c.updates, PARENT).sort()).toEqual(
      [PARSER.agentId, TWIN.agentId].sort(),
    );
    expect(subagentUpdates(c.updates).map((n) => u(n).sessionId)).not.toContain(STRANGER.agentId);
  });

  it("replays each child once, under its agent id and never under its Agent call's id", async () => {
    const c = await loadParent();

    for (const child of [PARSER, TWIN]) {
      const titled = subagentUpdates(c.updates).filter(
        (n) => u(n).sessionId === child.agentId && u(n).title !== undefined,
      );
      expect(titled).toHaveLength(1);
    }
    const named = subagentUpdates(c.updates).map((n) => u(n).sessionId);
    expect(named).not.toContain(PARSER.toolUseId);
    expect(named).not.toContain(TWIN.toolUseId);
  });

  it("replays each child's transcript on its own session, after its announcement, and not on the parent's", async () => {
    const c = await loadParent();

    for (const [child, sibling] of [
      [PARSER, TWIN],
      [TWIN, PARSER],
    ] as const) {
      expect(agentTextOn(c.updates, child.agentId)).toContain(child.said);
      expect(agentTextOn(c.updates, child.agentId)).not.toContain(sibling.said);
      const announced = c.updates.indexOf(announcement(c.updates, child.agentId)!);
      const firstOnChild = c.updates.findIndex((n) => n.sessionId === child.agentId);
      expect(announced).toBeGreaterThanOrEqual(0);
      expect(firstOnChild).toBeGreaterThan(announced);
    }
  });

  it("replays a child's title and description and no live state", async () => {
    const c = await loadParent();

    const first = announcement(c.updates, PARSER.agentId);
    expect(first?.sessionId).toBe(PARENT);
    expect(typeof u(first!).title).toBe("string");
    expect(u(first!).title.trim()).not.toBe("");
    // The same labels as a live launch (upstream #1479): title the name, description the role.
    expect(u(first!).title).toBe("parser-finder");
    expect(u(first!).description).toBe("Explore");
    for (const n of subagentUpdates(c.updates)) {
      expect(u(n)).not.toHaveProperty("state");
    }
  });

  it("replays no child to a client that did not ask, as before (R1.2)", async () => {
    const c = await loadParent(NESTED_CAPABILITIES);

    // The fixture was read: the parent's own answer came back.
    expect(agentTextOn(c.updates, PARENT)).toContain("Both subagents answered.");
    expect(subagentUpdates(c.updates)).toEqual([]);
    expect(c.updates.every((n) => n.sessionId === PARENT)).toBe(true);
  });

  it("restores a resumed parent's subagent under its previous id when it is continued after a restart", async () => {
    // A fresh adapter process: nothing of the earlier one survives but the transcripts.
    const c = await connect(RFD_CAPABILITIES);
    await c.agent.resumeSession({ sessionId: PARENT, cwd, mcpServers: [] });
    const s = c.session(PARENT);
    const resumed: Launch = {
      toolUseId: "toolu_01SendAgain",
      agentId: PARSER.agentId,
      name: PARSER.name,
      subagentType: PARSER.agentType,
      description: PARSER.description,
      prompt: "Check again: is it still src/config.rs?",
    };

    const response = s.prompt("ask the parser finder again");
    s.push(
      assistant(PARENT, [
        {
          type: "tool_use",
          id: resumed.toolUseId,
          name: "SendMessage",
          input: { to: PARSER.agentId, message: resumed.prompt },
        },
      ]),
    );
    s.push(agentStarted(PARENT, resumed));
    // Claude Code streams a resumed run under the call that first launched the agent.
    s.push(assistant(PARENT, [{ type: "text", text: "Still src/config.rs." }], PARSER.toolUseId));
    s.push(agentEnded(PARENT, resumed));
    s.push(toolResult(PARENT, resumed.toolUseId, "Message delivered."));
    s.endTurn();
    await response;
    await waitFor(() => c.updates.length > 0, "any update");

    expect(announcedChildren(c.updates, PARENT)).toEqual([PARSER.agentId]);
    expect(agentTextOn(c.updates, PARSER.agentId)).toContain("Still src/config.rs.");
  });
});
