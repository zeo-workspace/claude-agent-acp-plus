// Story 041, task 2.1 — `_claude/tasks` version 2 in the TaskFeed: `hasOutput`, `tail`, the
// output paths and the ended-output registry (R1.1, R1.7, R1.8, R2.6, R2.9, R7.5; Q12).
//
// Contract (design.md §`TaskFeed` extensions): `TaskEntry.hasOutput: boolean`,
// `TaskEntry.tail: string[] | null`; `onOutputPath(taskId, path)`; `setTail(taskId, lines | null,
// readable)` returning `"none"` when nothing changed; `runningOutputs(): { taskId, path }[]`;
// `outputPathFor(taskId): string | null`; `TASKS_CONTRACT_VERSION = 2`.
//
// The contract test at the end replays the version 1 fixture's SDK messages (the same ones
// `task-feed-contract.test.ts` replays) and then gives each fixture task the output state the
// fixture says it has, so the version 2 fixture task 1.1 writes can never describe a document the
// producer does not emit. It assumes 1.1 kept every version 1 task and field and only added the
// two fields; if 1.1 changed a version 1 value, adjust `replayV1` only.
//
// Hostile halves first: two shell tasks whose ids share a prefix (`t1`, `t10`) must keep their
// own paths and tails; the 256th most recent ended output must still be served while the 257th is
// evicted; a subagent offered an output path must still publish `false`/`null`.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "crypto";
import { TASKS_CONTRACT_VERSION, TaskFeed } from "../task-feed.js";

const SESSION = "v2-session";
const base = () => ({ type: "system", uuid: randomUUID(), session_id: SESSION });

const V1_KEYS = [
  "background",
  "depth",
  "description",
  "endedAt",
  "id",
  "lastTool",
  "startedAt",
  "status",
  "summary",
  "toolCallId",
  "type",
  "usage",
];
const V2_KEYS = [...V1_KEYS, "hasOutput", "tail"].sort();

function started(taskId: string, fields: Record<string, unknown> = {}): any {
  return {
    ...base(),
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: `task ${taskId}`,
    task_type: "local_bash",
    is_backgrounded: true,
    ...fields,
  };
}

function notification(taskId: string, fields: Record<string, unknown> = {}): any {
  return {
    ...base(),
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status: "completed",
    output_file: `/tmp/claude-test/tasks/${taskId}.output`,
    summary: `summary of ${taskId}`,
    ...fields,
  };
}

function makeFeed() {
  let now = 1_000_000;
  const feed = new TaskFeed(() => now, {}, SESSION);
  return {
    feed,
    at(ms: number) {
      now = ms;
    },
  };
}

function publish(feed: TaskFeed) {
  const { snapshot, endedIds } = feed.snapshot();
  feed.markPublished(endedIds);
  return snapshot;
}

const byId = (snapshot: { tasks: any[] }, id: string) => snapshot.tasks.find((t) => t.id === id);
const pathOf = (id: string) => `/tmp/claude-test/tasks/${id}.output`;

describe("contract version", () => {
  it("is 2", () => {
    expect(TASKS_CONTRACT_VERSION).toBe(2);
  });
});

describe("every entry carries hasOutput and tail (R1.8, R2.9)", () => {
  it("publishes a fresh shell with hasOutput false and tail null, and every version 1 field as before", () => {
    const { feed, at } = makeFeed();
    at(1_759_500_000_000);
    feed.onStarted(started("b1", { tool_use_id: "toolu_shell", description: "Run sleep 20" }));

    expect(publish(feed)).toEqual({
      tasks: [
        {
          id: "b1",
          toolCallId: "toolu_shell",
          type: "shell",
          description: "Run sleep 20",
          background: true,
          depth: 0,
          status: "running",
          startedAt: 1_759_500_000_000,
          endedAt: null,
          usage: null,
          lastTool: null,
          summary: null,
          hasOutput: false,
          tail: null,
        },
      ],
    });
  });

  // Hostile: a non-shell task offered a path and a tail must still read false/null.
  it("keeps a subagent, a monitor and a workflow at false/null even when offered an output path", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("a1", { task_type: "local_agent", is_backgrounded: false }));
    feed.onStarted(started("m1", { task_type: "monitor" }));
    feed.onStarted(started("w1", { task_type: "local_workflow" }));
    for (const id of ["a1", "m1", "w1"]) feed.onOutputPath(id, pathOf(id));

    expect(feed.runningOutputs()).toEqual([]);
    for (const id of ["a1", "m1", "w1"]) expect(feed.outputPathFor(id)).toBeNull();
    const snapshot = publish(feed);
    for (const id of ["a1", "m1", "w1"]) {
      expect(byId(snapshot, id)).toMatchObject({ hasOutput: false, tail: null });
    }
  });

  it("uses exactly the version 1 keys plus hasOutput and tail", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onStarted(started("a1", { task_type: "local_agent" }));
    for (const task of publish(feed).tasks) expect(Object.keys(task).sort()).toEqual(V2_KEYS);
  });
});

describe("a running shell's output (R1.1)", () => {
  it("lists a recorded path as running work and serves it", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onOutputPath("b1", pathOf("b1"));

    expect(feed.runningOutputs()).toEqual([{ taskId: "b1", path: pathOf("b1") }]);
    expect(feed.outputPathFor("b1")).toBe(pathOf("b1"));
  });

  it("ignores a path for a task it does not know", () => {
    const { feed } = makeFeed();
    feed.onOutputPath("ghost", pathOf("ghost"));
    expect(feed.runningOutputs()).toEqual([]);
    expect(feed.outputPathFor("ghost")).toBeNull();
  });

  it("publishes a readable tail with hasOutput true, and reports no change for the same tail", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onOutputPath("b1", pathOf("b1"));

    expect(feed.setTail("b1", ["line 1"], true)).not.toBe("none");
    expect(byId(feed.snapshot().snapshot, "b1")).toMatchObject({
      hasOutput: true,
      tail: ["line 1"],
    });

    // An idle file publishes nothing.
    expect(feed.setTail("b1", ["line 1"], true)).toBe("none");
    expect(feed.setTail("b1", ["line 1", "line 2"], true)).not.toBe("none");
    expect(byId(feed.snapshot().snapshot, "b1").tail).toEqual(["line 1", "line 2"]);
  });

  it("publishes tail null and hasOutput false when the file stops being readable (R1.5)", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onOutputPath("b1", pathOf("b1"));
    feed.setTail("b1", ["line 1"], true);

    expect(feed.setTail("b1", null, false)).not.toBe("none");
    expect(byId(feed.snapshot().snapshot, "b1")).toMatchObject({ hasOutput: false, tail: null });
  });

  // Hostile (wrong collapse): ids sharing a prefix keep their own path and tail.
  it("keeps t1's and t10's paths and tails apart", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("t1"));
    feed.onStarted(started("t10"));
    feed.onOutputPath("t1", pathOf("t1"));
    feed.onOutputPath("t10", pathOf("t10"));
    feed.setTail("t10", ["ten"], true);
    feed.setTail("t1", ["one"], true);

    expect(feed.outputPathFor("t1")).toBe(pathOf("t1"));
    expect(feed.outputPathFor("t10")).toBe(pathOf("t10"));
    const snapshot = feed.snapshot().snapshot;
    expect(byId(snapshot, "t1").tail).toEqual(["one"]);
    expect(byId(snapshot, "t10").tail).toEqual(["ten"]);
    expect(feed.runningOutputs()).toHaveLength(2);
  });
});

describe("a shell's ending (R1.7)", () => {
  it("records the notification's output_file, drops the running tail and leaves the poller's list", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onOutputPath("b1", pathOf("b1"));
    feed.setTail("b1", ["line 1"], true);

    feed.onNotification(notification("b1", { output_file: "/tmp/claude-test/tasks/b1.output" }));

    expect(feed.outputPathFor("b1")).toBe("/tmp/claude-test/tasks/b1.output");
    expect(feed.runningOutputs()).toEqual([]);
    expect(byId(feed.snapshot().snapshot, "b1")).toMatchObject({
      status: "completed",
      tail: null,
    });
  });

  // Hostile: hasOutput must not be claimed before anyone checked the file exists.
  it("claims hasOutput only once the file was confirmed readable", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onNotification(notification("b1"));
    expect(byId(feed.snapshot().snapshot, "b1").hasOutput).toBe(false);

    feed.setTail("b1", null, true);
    expect(byId(feed.snapshot().snapshot, "b1")).toMatchObject({ hasOutput: true, tail: null });
  });

  it("records no path for an empty output_file", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onNotification(notification("b1", { output_file: "" }));
    expect(feed.outputPathFor("b1")).toBeNull();
  });
});

describe("the ended-output registry (R2.6)", () => {
  it("still serves an ended shell's path after its ending was published and it left the table", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onNotification(notification("b1"));
    feed.setTail("b1", null, true);
    publish(feed);

    expect(feed.snapshot().snapshot.tasks).toEqual([]);
    expect(feed.outputPathFor("b1")).toBe(pathOf("b1"));
  });

  // Hostile at the bound: the 256 most recent are served, the oldest of 257 is not.
  it("keeps the 256 most recently ended outputs and evicts the oldest", () => {
    const { feed, at } = makeFeed();
    for (let i = 0; i < 257; i++) {
      const id = `s${i}`;
      at(1_000 + i);
      feed.onStarted(started(id));
      feed.onNotification(notification(id));
      feed.setTail(id, null, true);
      publish(feed);
    }

    expect(feed.outputPathFor("s0")).toBeNull();
    expect(feed.outputPathFor("s1")).toBe(pathOf("s1"));
    expect(feed.outputPathFor("s256")).toBe(pathOf("s256"));
  });
});

// ---- The shared fixtures (R7.5, Q12) ------------------------------------------------------

async function fixture(name: string) {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

/** The version 1 contract test's messages, unchanged. */
function replayV1(feed: TaskFeed, at: (ms: number) => void) {
  at(1759500000000);
  feed.onStarted(
    started("b7k2m9x1q", {
      tool_use_id: "toolu_01ShellSleep20",
      description: "Run sleep 20 in the background",
    }),
  );
  at(1759500001000);
  feed.onStarted(
    started("a3f8c2d4e5b6", {
      tool_use_id: "toolu_01ExploreFeed",
      description: "Explore the task feed",
      task_type: "local_agent",
      subagent_type: "Explore",
      is_backgrounded: false,
      spawn_depth: 1,
    }),
  );
  at(1759500002000);
  feed.onStarted(
    started("c9d1e2f3g", { tool_use_id: "toolu_01RunLinter", description: "Run the linter" }),
  );
  at(1759500004000);
  feed.onProgress({
    ...base(),
    subtype: "task_progress",
    task_id: "a3f8c2d4e5b6",
    tool_use_id: "toolu_01ExploreFeed",
    description: "Explore the task feed",
    subagent_type: "Explore",
    usage: { total_tokens: 18234, tool_uses: 7, duration_ms: 42000 },
    last_tool_name: "Grep",
    summary: "Reading the SDK task message types",
  } as any);
  at(1759500005000);
  feed.onNotification(
    notification("c9d1e2f3g", {
      tool_use_id: "toolu_01RunLinter",
      output_file: "/tmp/c9d1e2f3g.output",
      summary: 'Background command "Run the linter" completed (exit code 0)',
    }),
  );
}

describe("_claude/tasks version 2 fixture", () => {
  it("holds one running shell with a tail, one ended shell with output, one subagent without", async () => {
    const doc = await fixture("claude-tasks-snapshot.json");
    expect(Object.keys(doc)).toEqual(["tasks"]);
    for (const task of doc.tasks) expect(Object.keys(task).sort()).toEqual(V2_KEYS);

    const running = doc.tasks.filter((t: any) => t.type === "shell" && t.status === "running");
    const ended = doc.tasks.filter((t: any) => t.type === "shell" && t.status !== "running");
    const subagents = doc.tasks.filter((t: any) => t.type === "subagent");
    expect(running).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(subagents).toHaveLength(1);

    expect(running[0].hasOutput).toBe(true);
    expect(Array.isArray(running[0].tail)).toBe(true);
    expect(running[0].tail.length).toBeGreaterThan(0);
    expect(running[0].tail.length).toBeLessThanOrEqual(10);
    for (const line of running[0].tail) {
      expect(typeof line).toBe("string");
      expect([...line].length).toBeLessThanOrEqual(240);
    }
    expect(ended[0]).toMatchObject({ hasOutput: true, tail: null });
    expect(subagents[0]).toMatchObject({ hasOutput: false, tail: null });
  });

  it("TaskFeed produces exactly the version 2 fixture", async () => {
    const doc = await fixture("claude-tasks-snapshot.json");
    // The fixture must be version 2 before the comparison means anything: a version 1 fixture
    // compared with a version 1 feed would agree without proving either side.
    for (const task of doc.tasks) expect(typeof task.hasOutput, task.id).toBe("boolean");
    expect(doc.tasks.some((t: any) => t.hasOutput === true)).toBe(true);
    const { feed, at } = makeFeed();
    replayV1(feed, at);
    for (const task of doc.tasks) {
      if (!task.hasOutput) continue;
      if (task.status === "running") feed.onOutputPath(task.id, pathOf(task.id));
      feed.setTail(task.id, task.tail, true);
    }

    const { snapshot, endedIds } = feed.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(doc);
    expect(endedIds).toEqual(
      doc.tasks.filter((t: any) => t.status !== "running").map((t: any) => t.id),
    );
  });

  it("the output fixture is a truncated result whose content is the end of a longer output", async () => {
    const out = await fixture("claude-tasks-output.json");
    expect(Object.keys(out).sort()).toEqual(["content", "totalBytes", "truncated"]);
    expect(typeof out.content).toBe("string");
    expect(Number.isSafeInteger(out.totalBytes)).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBeGreaterThan(Buffer.byteLength(out.content, "utf8"));
    expect(Buffer.byteLength(out.content, "utf8")).toBeLessThanOrEqual(1_048_576);
  });
});
