// Contract tests for the TaskFeed reducer (story 012, R1.1, R1.2, R1.5–R1.9).
//
// The feed folds the SDK's task messages into a per-session table and renders
// it as the `_claude/tasks` snapshot of design.md's Data Models. These tests
// drive it with SDK-shaped messages and assert the snapshot only, so they
// describe what the feed publishes, never how it stores it.

import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { FOREGROUND_SHELL_HOLD_MS, TaskFeed } from "../task-feed.js";

const SESSION = "test-session";

function started(taskId: string, fields: Record<string, unknown> = {}): any {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: `task ${taskId}`,
    task_type: "local_bash",
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: SESSION,
    ...fields,
  };
}

function progress(taskId: string, fields: Record<string, unknown> = {}): any {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: `task ${taskId}`,
    usage: { total_tokens: 100, tool_uses: 1, duration_ms: 1000 },
    uuid: randomUUID(),
    session_id: SESSION,
    ...fields,
  };
}

function updated(taskId: string, patch: Record<string, unknown>): any {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch,
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

function notification(taskId: string, fields: Record<string, unknown> = {}): any {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status: "completed",
    output_file: `/tmp/${taskId}.output`,
    summary: `summary of ${taskId}`,
    uuid: randomUUID(),
    session_id: SESSION,
    ...fields,
  };
}

/** A feed with a settable clock: `at(ms)` moves time before the next message,
 *  so start and end stamps are whatever the test says they are. */
function makeFeed(start = 1_000_000) {
  let now = start;
  const feed = new TaskFeed(() => now);
  return {
    feed,
    at(ms: number) {
      now = ms;
    },
  };
}

/** What a successful send does: take the snapshot, then mark its endings
 *  published. `snapshot()` alone marks nothing (a failed send must not lose an
 *  ending). */
function publish(feed: TaskFeed) {
  const { snapshot, endedIds } = feed.snapshot();
  feed.markPublished(endedIds);
  return snapshot;
}

const ids = (snapshot: { tasks: { id: string }[] }) => snapshot.tasks.map((t) => t.id);
const byId = (snapshot: { tasks: any[] }, id: string) => snapshot.tasks.find((t) => t.id === id);

describe("TaskFeed — a started task (R1.1)", () => {
  it("publishes a started background shell as running with every R1.1 field", () => {
    const { feed, at } = makeFeed();
    at(1_759_500_000_000);
    feed.onStarted(
      started("b1", {
        tool_use_id: "toolu_shell",
        description: "Run sleep 20",
        task_type: "local_bash",
        is_backgrounded: true,
      }),
    );

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
        },
      ],
    });
  });

  it("stamps startedAt from the injected clock at the moment the task starts", () => {
    const { feed, at } = makeFeed();
    at(5_000);
    feed.onStarted(started("t1"));
    at(9_000);
    feed.onStarted(started("t2"));
    at(20_000);

    const snapshot = publish(feed);
    expect(byId(snapshot, "t1").startedAt).toBe(5_000);
    expect(byId(snapshot, "t2").startedAt).toBe(9_000);
  });

  it("carries a foreground subagent's spawn depth, and defaults depth to 0 and toolCallId to null", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(
      started("a1", { task_type: "local_agent", is_backgrounded: false, spawn_depth: 2 }),
    );
    feed.onStarted(started("b1", { tool_use_id: undefined, is_backgrounded: undefined }));
    // Story 022: a foreground shell is held back until FOREGROUND_SHELL_HOLD_MS.
    at(1_000_000 + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();

    const snapshot = publish(feed);
    expect(byId(snapshot, "a1")).toMatchObject({
      type: "subagent",
      background: false,
      depth: 2,
      toolCallId: "toolu_a1",
    });
    expect(byId(snapshot, "b1")).toMatchObject({ depth: 0, toolCallId: null, background: false });
  });

  it("normalises the SDK task types and passes an unknown type through raw", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("s", { task_type: "local_bash" }));
    at(2);
    feed.onStarted(started("a", { task_type: "local_agent" }));
    at(3);
    feed.onStarted(started("w", { task_type: "local_workflow" }));
    at(4);
    feed.onStarted(started("m", { task_type: "mcp_task" }));
    at(5);
    feed.onStarted(started("x", { task_type: "some_future_kind" }));

    expect(publish(feed).tasks.map((t: any) => [t.id, t.type])).toEqual([
      ["s", "shell"],
      ["a", "subagent"],
      ["w", "workflow"],
      ["m", "mcp"],
      ["x", "some_future_kind"],
    ]);
  });

  it("orders the snapshot by start time ascending", () => {
    const { feed, at } = makeFeed();
    at(300);
    feed.onStarted(started("late"));
    at(100);
    feed.onStarted(started("early"));

    expect(ids(publish(feed))).toEqual(["early", "late"]);
  });

  it("never puts the shell command line into the snapshot", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1", { description: "Sleep a while", prompt: "sleep 20 && rm -rf x" }));

    expect(JSON.stringify(publish(feed))).not.toContain("rm -rf");
  });
});

describe("TaskFeed — progress (R1.2)", () => {
  it("carries tokens, tool uses, elapsed time, last tool and summary from the latest progress", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("a1", { task_type: "local_agent", is_backgrounded: false }));

    expect(
      feed.onProgress(
        progress("a1", {
          usage: { total_tokens: 500, tool_uses: 2, duration_ms: 3_000 },
          last_tool_name: "Read",
          summary: "Reading the config",
        }),
      ),
    ).toBe("progress");
    feed.onProgress(
      progress("a1", {
        usage: { total_tokens: 900, tool_uses: 4, duration_ms: 6_000 },
        last_tool_name: "Grep",
        summary: "Searching for callers",
      }),
    );

    expect(byId(publish(feed), "a1")).toMatchObject({
      status: "running",
      usage: { tokens: 900, toolUses: 4, durationMs: 6_000 },
      lastTool: "Grep",
      summary: "Searching for callers",
    });
  });

  it("leaves summary null when the SDK sent none", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("a1", { task_type: "local_agent" }));
    feed.onProgress(progress("a1", { last_tool_name: "Read" }));

    expect(byId(publish(feed), "a1").summary).toBeNull();
  });

  it("ignores progress for a task it never saw start, and does not invent it", () => {
    const { feed } = makeFeed();

    expect(feed.onProgress(progress("ghost"))).toBe("none");
    expect(publish(feed)).toEqual({ tasks: [] });
  });

  it("applies progress to the task it names and to no other task", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("a1", { task_type: "local_agent", description: "same text" }));
    at(2);
    feed.onStarted(started("a2", { task_type: "local_agent", description: "same text" }));
    feed.onProgress(progress("a2", { usage: { total_tokens: 7, tool_uses: 1, duration_ms: 5 } }));

    const snapshot = publish(feed);
    expect(byId(snapshot, "a1").usage).toBeNull();
    expect(byId(snapshot, "a2").usage).toEqual({ tokens: 7, toolUses: 1, durationMs: 5 });
  });
});

describe("TaskFeed — endings and status vocabulary (R1.4, R1.5)", () => {
  it("ends a task from task_notification with status, end time and the SDK's final summary", () => {
    const { feed, at } = makeFeed();
    at(1_000);
    feed.onStarted(started("b1"));
    at(4_000);
    expect(
      feed.onNotification(notification("b1", { status: "completed", summary: "exit code 0" })),
    ).toBe("terminal");

    expect(byId(publish(feed), "b1")).toMatchObject({
      status: "completed",
      startedAt: 1_000,
      endedAt: 4_000,
      summary: "exit code 0",
    });
  });

  it("carries the notification's usage when the SDK reports one", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("a1", { task_type: "local_agent" }));
    feed.onNotification(
      notification("a1", { usage: { total_tokens: 1234, tool_uses: 9, duration_ms: 60_000 } }),
    );

    expect(byId(publish(feed), "a1").usage).toEqual({
      tokens: 1234,
      toolUses: 9,
      durationMs: 60_000,
    });
  });

  it("maps a failed notification to failed", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onNotification(notification("b1", { status: "failed" }));

    expect(byId(publish(feed), "b1").status).toBe("failed");
  });

  it("maps task_updated status killed to stopped (R1.5)", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("b1"));
    at(2_000_000);
    expect(feed.onUpdated(updated("b1", { status: "killed" }))).toBe("terminal");

    expect(byId(publish(feed), "b1")).toMatchObject({ status: "stopped", endedAt: 2_000_000 });
  });

  it("maps task_notification status stopped to stopped (R1.5, the other input)", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onNotification(notification("b1", { status: "stopped" }));

    expect(byId(publish(feed), "b1").status).toBe("stopped");
  });

  it("maps task_updated completed and failed to the same words", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("ok"));
    at(2);
    feed.onStarted(started("bad"));
    feed.onUpdated(updated("ok", { status: "completed" }));
    feed.onUpdated(updated("bad", { status: "failed" }));

    const snapshot = publish(feed);
    expect(byId(snapshot, "ok").status).toBe("completed");
    expect(byId(snapshot, "bad").status).toBe("failed");
  });

  it("maps a worker_restart notification to interrupted", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onNotification(notification("b1", { status: "stopped", reason: "worker_restart" }));

    expect(byId(publish(feed), "b1").status).toBe("interrupted");
  });

  it("only ever emits the five wire statuses, even for paused or pending patches", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("p1"));
    at(2);
    feed.onStarted(started("p2"));
    feed.onUpdated(updated("p1", { status: "paused" }));
    feed.onUpdated(updated("p2", { status: "pending" }));

    for (const task of publish(feed).tasks) {
      expect(["running", "completed", "failed", "stopped", "interrupted"]).toContain(task.status);
    }
  });
});

describe("TaskFeed — an ended task is published once (R1.6)", () => {
  // Hostile half first: one ending reported by TWO messages (task_updated
  // killed, then task_notification stopped — design.md's GOTCHA) must not
  // split into two appearances.
  it("does not republish an ended task when a second bookend for the same ending arrives", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onUpdated(updated("b1", { status: "killed" }));
    expect(byId(publish(feed), "b1").status).toBe("stopped");

    feed.onNotification(notification("b1", { status: "stopped" }));

    expect(ids(publish(feed))).not.toContain("b1");
    expect(ids(publish(feed))).not.toContain("b1");
  });

  it("does not resurrect an ended task when a late progress message names it", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("a1", { task_type: "local_agent" }));
    feed.onNotification(notification("a1"));
    publish(feed);

    expect(feed.onProgress(progress("a1"))).toBe("none");
    expect(ids(publish(feed))).not.toContain("a1");
  });

  // Hostile half, the converse: two DIFFERENT tasks must not collapse into
  // one "already published" fact — a second, distinct ending is still news.
  it("still publishes a different task's ending after an earlier ending was published", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("b1"));
    at(2);
    feed.onStarted(started("b2"));
    feed.onNotification(notification("b1"));
    expect(byId(publish(feed), "b1").status).toBe("completed");

    feed.onNotification(notification("b2", { status: "failed" }));
    const second = publish(feed);

    expect(ids(second)).toEqual(["b2"]);
    expect(byId(second, "b2").status).toBe("failed");
  });

  // Third element: tasks that look identical in every field but their id —
  // same description, same type, no tool call id — are still distinct tasks.
  it("keeps look-alike tasks apart: ending one hides neither the other's run nor its ending", () => {
    const { feed, at } = makeFeed();
    const twin = { tool_use_id: undefined, description: "Run tests", task_type: "local_bash" };
    at(10);
    feed.onStarted(started("x1", twin));
    at(10);
    feed.onStarted(started("x2", twin));
    feed.onNotification(notification("x1", { tool_use_id: undefined }));

    const first = publish(feed);
    expect(byId(first, "x1").status).toBe("completed");
    expect(byId(first, "x2").status).toBe("running");

    feed.onNotification(notification("x2", { tool_use_id: undefined }));
    const second = publish(feed);
    expect(ids(second)).toEqual(["x2"]);
    expect(byId(second, "x2").status).toBe("completed");
    expect(publish(feed)).toEqual({ tasks: [] });
  });

  it("shows an ended task in exactly one snapshot and omits it from every later one", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("b1"));
    at(2);
    feed.onStarted(started("b2"));
    feed.onNotification(notification("b1"));

    expect(ids(publish(feed))).toEqual(["b1", "b2"]);
    expect(ids(publish(feed))).toEqual(["b2"]);
    expect(ids(publish(feed))).toEqual(["b2"]);
  });

  it("publishes a task that started and ended between two snapshots, once", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("quick"));
    feed.onNotification(notification("quick"));

    expect(byId(publish(feed), "quick").status).toBe("completed");
    expect(publish(feed)).toEqual({ tasks: [] });
  });
});

describe("TaskFeed — ambient tasks (R1.7)", () => {
  it("leaves an ambient task out of every snapshot, through its whole life", () => {
    const { feed } = makeFeed();

    expect(feed.onStarted(started("w1", { ambient: true, task_type: "monitor" }))).toBe("none");
    feed.onProgress(progress("w1"));
    expect(publish(feed)).toEqual({ tasks: [] });

    feed.onNotification(notification("w1", { ambient: true }));
    expect(publish(feed)).toEqual({ tasks: [] });
  });

  it("filters only the ambient task, not a non-ambient one that looks the same", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("w1", { ambient: true, description: "Watch logs" }));
    at(2);
    feed.onStarted(started("w2", { ambient: false, description: "Watch logs" }));

    expect(ids(publish(feed))).toEqual(["w2"]);
  });
});

describe("TaskFeed — moving a task to the background (R1.8)", () => {
  it("publishes a foreground task with background: true after task_updated is_backgrounded", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("b1", { is_backgrounded: false }));
    // Story 022: a foreground shell is held back until FOREGROUND_SHELL_HOLD_MS.
    at(1_000_000 + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    expect(byId(publish(feed), "b1").background).toBe(false);

    expect(feed.onUpdated(updated("b1", { is_backgrounded: true }))).not.toBe("none");

    expect(byId(publish(feed), "b1")).toMatchObject({ background: true, status: "running" });
  });

  it("applies a description patch", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1", { description: "old" }));
    feed.onUpdated(updated("b1", { description: "new" }));

    expect(byId(publish(feed), "b1").description).toBe("new");
  });
});

describe("TaskFeed — process restart (R1.9)", () => {
  it("publishes every running task once as interrupted, and leaves already-ended tasks alone", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("r1"));
    at(2);
    feed.onStarted(started("r2", { task_type: "local_agent", is_backgrounded: false }));
    at(3);
    feed.onStarted(started("done"));
    feed.onNotification(notification("done"));
    publish(feed); // "done" has now been published with its final status

    at(50);
    expect(feed.onProcessRestart()).toBe("terminal");
    const after = publish(feed);

    expect(ids(after)).toEqual(["r1", "r2"]);
    for (const task of after.tasks) {
      expect(task).toMatchObject({ status: "interrupted", endedAt: 50 });
    }
    expect(publish(feed)).toEqual({ tasks: [] });
  });
});

describe("TaskFeed — snapshot() marks nothing; markPublished() does (R1.6 on success only)", () => {
  it("keeps an ending for the next snapshot when it was never marked published", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1"));
    feed.onNotification(notification("b1"));

    const first = feed.snapshot(); // the send carrying it failed: nothing marked
    expect(first.endedIds).toEqual(["b1"]);
    expect(byId(first.snapshot, "b1").status).toBe("completed");

    const retry = feed.snapshot();
    expect(byId(retry.snapshot, "b1").status).toBe("completed");
    expect(retry.endedIds).toEqual(["b1"]);
  });

  it("lists in endedIds exactly the ended tasks of that snapshot, not the running ones", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("run"));
    at(2);
    feed.onStarted(started("end1"));
    at(3);
    feed.onStarted(started("end2"));
    feed.onNotification(notification("end1"));
    feed.onUpdated(updated("end2", { status: "killed" }));

    expect([...feed.snapshot().endedIds].sort()).toEqual(["end1", "end2"]);
  });

  it("omits only the endings that were marked, keeping an ending that arrived after the snapshot", () => {
    const { feed, at } = makeFeed();
    at(1);
    feed.onStarted(started("b1"));
    at(2);
    feed.onStarted(started("b2"));
    feed.onNotification(notification("b1"));
    const inFlight = feed.snapshot(); // carries b1's ending
    feed.onNotification(notification("b2")); // ends while that send is in flight
    feed.markPublished(inFlight.endedIds); // the send succeeded

    const next = feed.snapshot();
    expect(ids(next.snapshot)).toEqual(["b2"]);
    expect(byId(next.snapshot, "b2").status).toBe("completed");
  });
});

describe("TaskFeed — level reconciliation (background_tasks_changed)", () => {
  it("never adds a task the bookends have not named", () => {
    const { feed } = makeFeed();
    feed.onLevel([{ task_id: "unknown" }]);

    expect(publish(feed)).toEqual({ tasks: [] });
    expect(feed.nextReconcileAt()).toBeNull();
  });

  it("records a 2 s deadline for a running background task the level omits, and ends nothing by itself", () => {
    const { feed, at } = makeFeed();
    at(1_000);
    feed.onStarted(started("b1", { is_backgrounded: true }));
    at(10_000);
    feed.onLevel([]);

    expect(feed.nextReconcileAt()).toBe(12_000);
    expect(byId(publish(feed), "b1").status).toBe("running");
  });

  it("does not end the task before its deadline", () => {
    const { feed, at } = makeFeed();
    at(1_000);
    feed.onStarted(started("b1"));
    at(1_100);
    feed.onLevel([]);

    expect(feed.reconcile(2_000)).toBe("none");
    expect(byId(publish(feed), "b1").status).toBe("running");
  });

  it("ends the task as interrupted once its deadline passed with no bookend", () => {
    const { feed, at } = makeFeed();
    at(1_000);
    feed.onStarted(started("b1"));
    at(10_000);
    feed.onLevel([]);

    at(12_000);
    expect(feed.reconcile(12_000)).toBe("terminal");
    const snapshot = publish(feed);
    expect(byId(snapshot, "b1").status).toBe("interrupted");
    expect(feed.nextReconcileAt()).toBeNull();
  });

  // Hostile half: the level may precede the bookend (design GOTCHA). A real
  // ending that lands inside the grace window must win over "interrupted".
  it("lets a bookend arriving before the deadline clear it", () => {
    const { feed, at } = makeFeed();
    at(1_000);
    feed.onStarted(started("b1"));
    at(10_000);
    feed.onLevel([]);
    at(11_000);
    feed.onNotification(notification("b1", { status: "completed" }));

    expect(feed.nextReconcileAt()).toBeNull();
    expect(feed.reconcile(20_000)).toBe("none");
    expect(byId(publish(feed), "b1").status).toBe("completed");
  });

  it("leaves a foreground task alone: the level only lists background work", () => {
    const { feed, at } = makeFeed();
    at(1_000);
    feed.onStarted(started("f1", { task_type: "local_agent", is_backgrounded: false }));
    at(10_000);
    feed.onLevel([]);

    expect(feed.nextReconcileAt()).toBeNull();
    feed.reconcile(20_000);
    expect(byId(publish(feed), "f1").status).toBe("running");
  });

  it("records no deadline for a background task the level still lists", () => {
    const { feed, at } = makeFeed();
    at(1_000);
    feed.onStarted(started("b1"));
    at(10_000);
    feed.onLevel([{ task_id: "b1" }]);

    expect(feed.nextReconcileAt()).toBeNull();
    feed.reconcile(20_000);
    expect(byId(publish(feed), "b1").status).toBe("running");
  });
});
