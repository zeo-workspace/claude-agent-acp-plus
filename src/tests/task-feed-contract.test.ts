// Contract test for the `_claude/tasks` snapshot (story 012, R1.1, R1.2, R1.4, Q12).
//
// `fixtures/claude-tasks-snapshot.json` is the single example of the snapshot
// that patch 0032 (and stories 013 and 014) consume; Zed's acp_thread test
// parses a byte-identical copy. This test proves the adapter's TaskFeed
// produces exactly that document from SDK messages, so the fixture can never
// describe a shape the producer does not emit.
//
// Version 2 (story 041): `fixtures/claude-tasks-snapshot.json` is now the
// version 2 document, proved against TaskFeed by `task-feed-v2.test.ts`. The
// version 1 document lives on as `fixtures/claude-tasks-snapshot-v1.json`, the
// twin of patch 0034's Zed copy. Version 1 messages alone produce exactly that
// document plus `hasOutput: false` and `tail: null` on every task: nothing
// confirmed an output, and no tail was read.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "crypto";
import { TaskFeed } from "../task-feed.js";

const SESSION = "contract-session";
const base = () => ({ type: "system", uuid: randomUUID(), session_id: SESSION });

async function fixture(name = "claude-tasks-snapshot.json") {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

/** The version 1 fixture, as a version 2 feed publishes it from v1 messages. */
async function v1FixtureAsV2() {
  const doc = await fixture("claude-tasks-snapshot-v1.json");
  return { tasks: doc.tasks.map((t: object) => ({ ...t, hasOutput: false, tail: null })) };
}

describe("_claude/tasks snapshot contract", () => {
  it("TaskFeed produces exactly the version 1 fixture, plus the two version 2 fields", async () => {
    let now = 0;
    const feed = new TaskFeed(() => now);

    now = 1759500000000;
    feed.onStarted({
      ...base(),
      subtype: "task_started",
      task_id: "b7k2m9x1q",
      tool_use_id: "toolu_01ShellSleep20",
      description: "Run sleep 20 in the background",
      task_type: "local_bash",
      is_backgrounded: true,
    } as any);

    now = 1759500001000;
    feed.onStarted({
      ...base(),
      subtype: "task_started",
      task_id: "a3f8c2d4e5b6",
      tool_use_id: "toolu_01ExploreFeed",
      description: "Explore the task feed",
      task_type: "local_agent",
      subagent_type: "Explore",
      is_backgrounded: false,
      spawn_depth: 1,
    } as any);

    now = 1759500002000;
    feed.onStarted({
      ...base(),
      subtype: "task_started",
      task_id: "c9d1e2f3g",
      tool_use_id: "toolu_01RunLinter",
      description: "Run the linter",
      task_type: "local_bash",
      is_backgrounded: true,
    } as any);

    now = 1759500004000;
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

    now = 1759500005000;
    feed.onNotification({
      ...base(),
      subtype: "task_notification",
      task_id: "c9d1e2f3g",
      tool_use_id: "toolu_01RunLinter",
      status: "completed",
      output_file: "/tmp/c9d1e2f3g.output",
      summary: 'Background command "Run the linter" completed (exit code 0)',
    } as any);

    // Round-trip through JSON: the wire carries the serialised form.
    const { snapshot, endedIds } = feed.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(await v1FixtureAsV2());
    expect(endedIds).toEqual(["c9d1e2f3g"]);
  });

  it("uses exactly the documented keys, so a consumer never meets an unknown field", async () => {
    const keys = [
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
    const v1 = await fixture("claude-tasks-snapshot-v1.json");
    expect(Object.keys(v1)).toEqual(["tasks"]);
    for (const task of v1.tasks) expect(Object.keys(task).sort()).toEqual(keys);
    const v2Keys = [...keys, "hasOutput", "tail"].sort();
    const doc = await fixture();
    expect(Object.keys(doc)).toEqual(["tasks"]);
    for (const task of doc.tasks) {
      expect(Object.keys(task).sort()).toEqual(v2Keys);
      expect(["running", "completed", "failed", "stopped", "interrupted"]).toContain(task.status);
      if (task.usage !== null) {
        expect(Object.keys(task.usage).sort()).toEqual(["durationMs", "tokens", "toolUses"]);
      }
    }
  });
});
