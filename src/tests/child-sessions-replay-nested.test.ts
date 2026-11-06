// Story 065, Task 4.1 tech review: replay cases beyond the replay suite — a
// nested subagent (its launch lives in its launcher's transcript, its meta
// names `parentAgentId`), a child whose transcript is missing, and history
// children never offering Stop.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  agentStarted,
  agentTextOn,
  announcement,
  assistant,
  subagentUpdates,
  toolResult,
} from "./child-sessions-harness.js";
import { connect, disconnectAll, RFD_CAPABILITIES } from "./child-sessions-connection.js";
import { type TranscriptChild, writeSessionWithChildren } from "./child-sessions-transcripts.js";

const configDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/rfd-replay-nested-${process.pid}-${Date.now()}`;
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

// A fresh parent per test: the SDK caches transcript reads within the process,
// so a test that deletes a transcript must not share a session another test read.
let PARENT: string;
const OUTER: TranscriptChild = {
  agentId: "d1e3f5a7b9c1d3e5",
  toolUseId: "toolu_01OuterLaunch",
  name: "planner",
  agentType: "Plan",
  description: "Plan the fix",
  prompt: "Plan the fix and delegate the search.",
  said: "Delegating the search.",
};
const INNER = {
  agentId: "f6a8b0c2d4e6f8a0",
  toolUseId: "toolu_01InnerLaunch",
  description: "Search the code",
  prompt: "Search for the parser.",
  said: "Found it in src/config.rs.",
};

let cwd: string;
const subagentsDir = () =>
  path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), PARENT, "subagents");

afterEach(async () => {
  await disconnectAll();
  rmSync(cwd, { recursive: true, force: true });
});
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

beforeEach(async () => {
  PARENT = randomUUID();
  cwd = await mkdtemp(path.join(os.tmpdir(), "rfd-replay-nested-cwd-"));
  await writeSessionWithChildren(configDir, cwd, PARENT, [OUTER]);
  // OUTER's transcript launches INNER; INNER's meta names OUTER as its launcher.
  const base = { sessionId: PARENT, cwd, version: "2.1.300", userType: "external" };
  const launchLine = {
    ...base,
    isSidechain: true,
    agentId: OUTER.agentId,
    type: "assistant",
    timestamp: "2026-10-25T00:00:01.000Z",
    uuid: `${OUTER.agentId.slice(0, 8)}-0000-4000-8000-00000000000c`,
    parentUuid: `${OUTER.agentId.slice(0, 8)}-0000-4000-8000-00000000000b`,
    message: {
      id: `msg_${OUTER.agentId}_launch`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: INNER.toolUseId,
          name: "Agent",
          input: { description: INNER.description, prompt: INNER.prompt, subagent_type: "Explore" },
        },
      ],
    },
  };
  await appendFile(
    path.join(subagentsDir(), `agent-${OUTER.agentId}.jsonl`),
    JSON.stringify(launchLine) + "\n",
  );
  const inner = { ...base, isSidechain: true, agentId: INNER.agentId };
  await writeFile(
    path.join(subagentsDir(), `agent-${INNER.agentId}.jsonl`),
    [
      {
        ...inner,
        type: "user",
        timestamp: "2026-10-25T00:00:02.000Z",
        uuid: `${INNER.agentId.slice(0, 8)}-0000-4000-8000-00000000000a`,
        parentUuid: null,
        message: { role: "user", content: INNER.prompt },
      },
      {
        ...inner,
        type: "assistant",
        timestamp: "2026-10-25T00:00:03.000Z",
        uuid: `${INNER.agentId.slice(0, 8)}-0000-4000-8000-00000000000b`,
        parentUuid: `${INNER.agentId.slice(0, 8)}-0000-4000-8000-00000000000a`,
        message: {
          id: `msg_${INNER.agentId}_said`,
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: INNER.said }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  await writeFile(
    path.join(subagentsDir(), `agent-${INNER.agentId}.meta.json`),
    JSON.stringify({
      toolUseId: INNER.toolUseId,
      agentType: "Explore",
      description: INNER.description,
      parentAgentId: OUTER.agentId,
      spawnDepth: 2,
    }),
  );
});

const u = (n: SessionNotification) => n.update as Record<string, any>;

describe("child sessions — nested and missing replay", () => {
  it("replays a nested subagent under its own id, announced on the child that launched it", async () => {
    const c = await connect(RFD_CAPABILITIES);
    await c.agent.loadSession({ sessionId: PARENT, cwd, mcpServers: [] });

    expect(announcement(c.updates, OUTER.agentId)?.sessionId).toBe(PARENT);
    expect(announcement(c.updates, INNER.agentId)?.sessionId).toBe(OUTER.agentId);
    expect(agentTextOn(c.updates, INNER.agentId)).toContain(INNER.said);
    expect(agentTextOn(c.updates, OUTER.agentId)).not.toContain(INNER.said);
  });

  it("offers no Stop on a replayed child: history is not a task the CLI holds", async () => {
    const c = await connect(RFD_CAPABILITIES);
    await c.agent.loadSession({ sessionId: PARENT, cwd, mcpServers: [] });

    for (const n of subagentUpdates(c.updates)) expect(u(n).capabilities).toBeUndefined();
  });

  it("logs a child whose transcript is missing and still replays the parent", async () => {
    await rm(path.join(subagentsDir(), `agent-${OUTER.agentId}.jsonl`));
    const c = await connect(RFD_CAPABILITIES);
    await c.agent.loadSession({ sessionId: PARENT, cwd, mcpServers: [] });

    expect(agentTextOn(c.updates, PARENT)).toContain("Both subagents answered.");
    expect(
      c.lines.some(
        (line) => line.includes("outcome=no_transcript") && line.includes(OUTER.agentId),
      ),
    ).toBe(true);
  });

  it("replays each child once even when a damaged meta points a launch into its own transcript", async () => {
    // INNER's meta claims the launch that OUTER's transcript holds for INNER,
    // and OUTER's meta claims a launch in INNER's transcript: a cycle.
    await writeFile(
      path.join(subagentsDir(), `agent-${OUTER.agentId}.meta.json`),
      JSON.stringify({ toolUseId: OUTER.toolUseId, description: OUTER.description }),
    );
    await appendFile(
      path.join(subagentsDir(), `agent-${INNER.agentId}.jsonl`),
      JSON.stringify({
        sessionId: PARENT,
        cwd,
        isSidechain: true,
        agentId: INNER.agentId,
        type: "assistant",
        timestamp: "2026-10-25T00:00:04.000Z",
        uuid: `${INNER.agentId.slice(0, 8)}-0000-4000-8000-00000000000c`,
        parentUuid: `${INNER.agentId.slice(0, 8)}-0000-4000-8000-00000000000b`,
        message: {
          id: `msg_${INNER.agentId}_loop`,
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "tool_use", id: OUTER.toolUseId, name: "Agent", input: { prompt: "again" } },
          ],
        },
      }) + "\n",
    );
    const c = await connect(RFD_CAPABILITIES);
    await c.agent.loadSession({ sessionId: PARENT, cwd, mcpServers: [] });

    const titled = (id: string) =>
      subagentUpdates(c.updates).filter((n) => u(n).sessionId === id && u(n).title !== undefined);
    expect(titled(OUTER.agentId)).toHaveLength(1);
    expect(titled(INNER.agentId)).toHaveLength(1);
  });

  it("restores a nested subagent under its launcher on resume, announced when it runs again", async () => {
    const c = await connect(RFD_CAPABILITIES);
    await c.agent.resumeSession({ sessionId: PARENT, cwd, mcpServers: [] });
    const s = c.session(PARENT);
    const response = s.prompt("continue");
    s.push(
      agentStarted(PARENT, {
        toolUseId: "toolu_01OuterAgain",
        agentId: OUTER.agentId,
        description: OUTER.description,
        subagentType: OUTER.agentType,
      }),
    );
    s.push(
      agentStarted(PARENT, {
        toolUseId: "toolu_01InnerAgain",
        agentId: INNER.agentId,
        description: INNER.description,
        subagentType: "Explore",
      }),
    );
    s.push(assistant(PARENT, [{ type: "text", text: "Again." }], INNER.toolUseId));
    s.push(toolResult(PARENT, "toolu_01OuterAgain", "done"));
    s.endTurn();
    await response;

    expect(announcement(c.updates, INNER.agentId)?.sessionId).toBe(OUTER.agentId);
    expect(agentTextOn(c.updates, INNER.agentId)).toContain("Again.");
  });
});
