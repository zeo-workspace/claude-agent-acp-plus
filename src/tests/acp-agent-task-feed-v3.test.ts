// Story 065, Task 6.1 — `_claude/tasks` names each subagent's child session
// (contract v3) in the RFD form, and is unchanged otherwise (R6.1–R6.4).
//
// Integration: the real `initialize`, `newSession` and session loop over a
// scripted SDK stream (child-sessions-harness.ts); assertions read the wire.
//
// `childSessionId` is a derived value whose one job is to let Zeo show each
// subagent once, so the hostile cases come first: two subagents must name two
// different children, each the one its own `subagent_update` announced — not
// the Agent call's tool use id; a shell, a workflow and a monitor must name
// none. The form-off bytes are pinned to what the adapter sends today for the
// same input (captured 2026-10-25 from the fork at e5b5f06, which carries
// 0.30.1's feed), with `startedAt` zeroed because it is a clock reading.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  agentStarted,
  agentToolUse,
  announcement,
  assistant,
  type Launch,
  waitFor,
} from "./child-sessions-harness.js";
import {
  connect,
  disconnectAll,
  NESTED_CAPABILITIES,
  RFD_CAPABILITIES,
} from "./child-sessions-connection.js";
import { taskStarted } from "./task-feed-harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { capturingQuery } = await import("./child-sessions-harness.js");
  return { ...actual, query: vi.fn(capturingQuery) };
});

afterEach(disconnectAll);

const TASKS = "_claude/tasks";
const PARSER: Launch = {
  toolUseId: "toolu_01ParserLaunch",
  agentId: "a3f9c1d2e4b5a6c7",
  name: "parser-finder",
  subagentType: "Explore",
  description: "Find the parser",
  prompt: "Find it.",
};
const TWIN: Launch = { ...PARSER, toolUseId: "toolu_01TwinLaunch", agentId: "b8e2d4f6a1c3e5d7" };

/** The `_claude/tasks` snapshot 0.30.1 sends for {@link startFourTasks}, `startedAt` zeroed. */
const V2_FOUR_TASKS =
  '{"tasks":[' +
  '{"id":"a3f9c1d2e4b5a6c7","toolCallId":"toolu_01ParserLaunch","type":"subagent","description":"Find the parser","background":false,"depth":0,"status":"running","startedAt":0,"endedAt":null,"usage":null,"lastTool":null,"summary":null,"hasOutput":false,"tail":null},' +
  '{"id":"bsh7k2m9q","toolCallId":"toolu_01Shell","type":"shell","description":"Sleep twenty seconds","background":true,"depth":0,"status":"running","startedAt":0,"endedAt":null,"usage":null,"lastTool":null,"summary":null,"hasOutput":false,"tail":null},' +
  '{"id":"wf3n8p1","toolCallId":"toolu_01Workflow","type":"workflow","description":"Release workflow","background":true,"depth":0,"status":"running","startedAt":0,"endedAt":null,"usage":null,"lastTool":null,"summary":null,"hasOutput":false,"tail":null},' +
  '{"id":"mon5r4t","toolCallId":"toolu_01Monitor","type":"monitor","description":"Watch the log","background":true,"depth":0,"status":"running","startedAt":0,"endedAt":null,"usage":null,"lastTool":null,"summary":null,"hasOutput":false,"tail":null}' +
  "]}";

type Entry = Record<string, any> & { id: string };
const snapshots = (updates: SessionNotification[]) =>
  updates
    .map((n) => (n.update._meta as Record<string, any> | undefined)?.[TASKS])
    .filter(Boolean) as { tasks: Entry[] }[];
const zeroed = (snapshot: { tasks: Entry[] }) => ({
  tasks: snapshot.tasks.map((t) => ({ ...t, startedAt: 0 })),
});

/** One turn that starts a subagent, a background shell, a workflow and a
 *  monitor; resolves with the first snapshot that carries all four. */
async function startFourTasks(capabilities: Record<string, unknown>) {
  const c = await connect(capabilities);
  const s = await c.open();
  void s.prompt();
  s.push(assistant(s.sessionId, [agentToolUse(PARSER)]));
  s.push(agentStarted(s.sessionId, PARSER));
  s.push(
    taskStarted(s.sessionId, "bsh7k2m9q", {
      tool_use_id: "toolu_01Shell",
      description: "Sleep twenty seconds",
      task_type: "local_bash",
      is_backgrounded: true,
    }),
    taskStarted(s.sessionId, "wf3n8p1", {
      tool_use_id: "toolu_01Workflow",
      description: "Release workflow",
      task_type: "local_workflow",
      is_backgrounded: true,
      workflow_name: "release",
    }),
    taskStarted(s.sessionId, "mon5r4t", {
      tool_use_id: "toolu_01Monitor",
      description: "Watch the log",
      task_type: "monitor",
      is_backgrounded: true,
    }),
  );
  await waitFor(
    () => snapshots(c.updates).some((snap) => snap.tasks.length === 4),
    "a snapshot of all four tasks",
  );
  const snapshot = snapshots(c.updates).find((snap) => snap.tasks.length === 4)!;
  return { c, s, snapshot };
}

const entry = (snapshot: { tasks: Entry[] }, id: string) => snapshot.tasks.find((t) => t.id === id);

describe("_claude/tasks v3 — the version advertised at initialize (R6.2, R6.3)", () => {
  it("advertises version 2 to a client that opted into nested subagent transcripts only", async () => {
    const c = await connect({ _meta: { "subagent-transcript": true } });
    expect((c.init.agentCapabilities?._meta as any)?.[TASKS]).toEqual({ version: 2 });
  });

  it("advertises version 2 to a client that did not ask for the RFD", async () => {
    const c = await connect(NESTED_CAPABILITIES);
    expect((c.init.agentCapabilities?._meta as any)?.[TASKS]).toEqual({ version: 2 });
  });

  it("advertises version 3 to a client that asked for the RFD", async () => {
    const c = await connect(RFD_CAPABILITIES);
    expect((c.init.agentCapabilities?._meta as any)?.[TASKS]).toEqual({ version: 3 });
  });
});

describe("_claude/tasks v3 — childSessionId on subagent entries (R6.1, R6.4)", () => {
  it("names two different children for two subagents, each the child its own subagent_update announced", async () => {
    const c = await connect(RFD_CAPABILITIES);
    const s = await c.open();
    void s.prompt();
    s.push(assistant(s.sessionId, [agentToolUse(PARSER), agentToolUse(TWIN)]));
    s.push(agentStarted(s.sessionId, PARSER), agentStarted(s.sessionId, TWIN));
    await waitFor(
      () =>
        snapshots(c.updates).some(
          (snap) => entry(snap, PARSER.agentId) && entry(snap, TWIN.agentId),
        ),
      "both subagents in one snapshot",
    );
    const snapshot = snapshots(c.updates).find(
      (snap) => entry(snap, PARSER.agentId) && entry(snap, TWIN.agentId),
    )!;

    const parser = entry(snapshot, PARSER.agentId)!;
    const twin = entry(snapshot, TWIN.agentId)!;
    expect(parser.childSessionId).not.toBe(twin.childSessionId);
    expect(parser.childSessionId).not.toBe(PARSER.toolUseId);
    for (const [task, launch] of [
      [parser, PARSER],
      [twin, TWIN],
    ] as const) {
      const announced = announcement(c.updates, launch.agentId);
      expect(announced).toBeDefined();
      expect(task.childSessionId).toBe((announced!.update as any).sessionId);
    }
  });

  it("names no child on a shell, a workflow or a monitor, and leaves their entries as version 2 sends them", async () => {
    const { snapshot } = await startFourTasks(RFD_CAPABILITIES);
    const v2 = JSON.parse(V2_FOUR_TASKS) as { tasks: Entry[] };

    for (const id of ["bsh7k2m9q", "wf3n8p1", "mon5r4t"]) {
      expect(entry(snapshot, id)).not.toHaveProperty("childSessionId");
      expect({ ...entry(snapshot, id)!, startedAt: 0 }).toEqual(entry(v2, id));
    }
    expect(entry(snapshot, PARSER.agentId)?.childSessionId).toBe(PARSER.agentId);
  });

  it("adds only childSessionId to a subagent entry", async () => {
    const { snapshot } = await startFourTasks(RFD_CAPABILITIES);
    const v2 = JSON.parse(V2_FOUR_TASKS) as { tasks: Entry[] };

    const { childSessionId, ...rest } = entry(snapshot, PARSER.agentId)!;
    expect(childSessionId).toBe(PARSER.agentId);
    expect({ ...rest, startedAt: 0 }).toEqual(entry(v2, PARSER.agentId));
  });
});

describe("_claude/tasks v3 — the form off is byte-identical to version 2 (R6.3)", () => {
  it("sends 0.30.1's bytes for the same input, with no childSessionId anywhere", async () => {
    const { snapshot } = await startFourTasks(NESTED_CAPABILITIES);

    expect(JSON.stringify(zeroed(snapshot))).toBe(V2_FOUR_TASKS);
    expect(JSON.stringify(snapshot)).not.toContain("childSessionId");
  });
});
