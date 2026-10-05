// Story 022, task 1.1 — TaskFeed holds quick foreground shell tasks back (R2.1–R2.7, R5.1).
//
// Claude Code registers every shell command as an SDK task, foreground ones included, with the
// command text as its description. The feed must publish only background work, subagents, and
// foreground shells still running after FOREGROUND_SHELL_HOLD_MS, each shell labelled with its
// tool call's own description. Assertions read the snapshot only. Hostile fixtures come first.

import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { FOREGROUND_SHELL_HOLD_MS, TaskFeed } from "../task-feed.js";

const SESSION = "hold-session";
const START = 1_759_500_000_000;
/** What the SDK sends as a foreground shell's description: the command line itself. */
const COMMAND = "cat > f.json <<'EOF'\n{\"a\": 1}\nEOF";
/** The command line as `SDKTaskStartedMessage.prompt`: never copied anywhere. */
const PROMPT = "PROMPT-NEVER-PUBLISHED cat > f.json";

function started(taskId: string, fields: Record<string, unknown> = {}): any {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: COMMAND,
    prompt: PROMPT,
    task_type: "local_bash",
    is_backgrounded: false,
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

function progress(taskId: string, tokens: number): any {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: COMMAND,
    usage: { total_tokens: tokens, tool_uses: 2, duration_ms: 3_000 },
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
    output_file: "",
    summary: "exit code 0",
    uuid: randomUUID(),
    session_id: SESSION,
    ...fields,
  };
}

function makeFeed() {
  let now = START;
  const feed = new TaskFeed(() => now);
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

const ids = (snapshot: { tasks: { id: string }[] }) => snapshot.tasks.map((t) => t.id);
const byId = (snapshot: { tasks: any[] }, id: string) => snapshot.tasks.find((t) => t.id === id);

describe("TaskFeed — the hold constant", () => {
  it("holds a foreground shell for 5 seconds", () => {
    expect(FOREGROUND_SHELL_HOLD_MS).toBe(5_000);
  });
});

describe("TaskFeed — a foreground shell is held back (R2.1)", () => {
  it("publishes nothing for a started foreground shell", () => {
    const { feed } = makeFeed();
    const change = feed.onStarted(started("f1"));
    expect(change).not.toBe("progress");
    expect(change).not.toBe("terminal");
    expect(publish(feed).tasks).toEqual([]);
  });

  it("treats a shell with no is_backgrounded flag as foreground", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("f1", { is_backgrounded: undefined }));
    expect(publish(feed).tasks).toEqual([]);
  });

  it("still publishes a background shell at once (R5.1)", () => {
    const { feed } = makeFeed();
    expect(feed.onStarted(started("b1", { is_backgrounded: true }))).toBe("progress");
    expect(ids(publish(feed))).toEqual(["b1"]);
  });
});

describe("TaskFeed — a quick foreground shell is dropped silently (R2.4)", () => {
  it("publishes neither the start nor the ending of a shell that ends within 5 s", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"));
    at(START + 2_000);
    expect(feed.onNotification(notification("f1"))).toBe("none");
    expect(publish(feed).tasks).toEqual([]);

    at(START + 60_000);
    feed.promoteDue();
    expect(publish(feed).tasks).toEqual([]);
    expect(feed.nextHoldDue()).toBeNull();
  });

  it("drops a held shell ended by a terminal task_updated, whatever the ending", () => {
    for (const status of ["completed", "failed", "killed"]) {
      const { feed, at } = makeFeed();
      feed.onStarted(started("f1"));
      at(START + 1_000);
      expect(feed.onUpdated(updated("f1", { status }))).toBe("none");
      at(START + 60_000);
      feed.promoteDue();
      expect(publish(feed).tasks, status).toEqual([]);
    }
  });

  // Hostile (wrong collapse): dropping one held shell must not drop or end another task.
  it("drops only the ended shell, not another held shell nor a published one", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"));
    feed.onStarted(started("f2"));
    feed.onStarted(started("b1", { is_backgrounded: true }));
    at(START + 1_000);
    feed.onNotification(notification("f1"));

    at(START + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    const snapshot = publish(feed);
    expect(ids(snapshot).sort()).toEqual(["b1", "f2"]);
    expect(byId(snapshot, "b1").status).toBe("running");
    expect(byId(snapshot, "f2").status).toBe("running");
  });
});

describe("TaskFeed — a foreground shell still running at 5 s is published (R2.2)", () => {
  it("is not promoted one millisecond early, and is promoted at 5 s as a running foreground task", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"));

    at(START + FOREGROUND_SHELL_HOLD_MS - 1);
    expect(feed.promoteDue()).toBe("none");
    expect(publish(feed).tasks).toEqual([]);

    at(START + FOREGROUND_SHELL_HOLD_MS);
    expect(feed.promoteDue()).toBe("progress");
    const task = byId(publish(feed), "f1");
    expect(task).toMatchObject({
      id: "f1",
      toolCallId: "toolu_f1",
      type: "shell",
      background: false,
      status: "running",
      startedAt: START,
      endedAt: null,
    });
  });

  it("publishes the ending of a promoted shell as any other ending", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"));
    at(START + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    publish(feed);

    at(START + 30_000);
    expect(feed.onNotification(notification("f1"))).toBe("terminal");
    expect(byId(publish(feed), "f1")).toMatchObject({
      status: "completed",
      endedAt: START + 30_000,
    });
  });

  it("reports the earliest hold due, and none once nothing is held", () => {
    const { feed, at } = makeFeed();
    expect(feed.nextHoldDue()).toBeNull();
    feed.onStarted(started("f1"));
    at(START + 3_000);
    feed.onStarted(started("f2"));
    expect(feed.nextHoldDue()).toBe(START + FOREGROUND_SHELL_HOLD_MS);

    at(START + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    expect(ids(publish(feed))).toEqual(["f1"]);
    expect(feed.nextHoldDue()).toBe(START + 3_000 + FOREGROUND_SHELL_HOLD_MS);

    at(START + 3_000 + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    expect(ids(publish(feed)).sort()).toEqual(["f1", "f2"]);
    expect(feed.nextHoldDue()).toBeNull();
  });

  it("keeps the progress heard while held, silently, and carries it once promoted", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"));
    at(START + 1_000);
    expect(feed.onProgress(progress("f1", 42))).toBe("none");
    expect(publish(feed).tasks).toEqual([]);

    at(START + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    expect(byId(publish(feed), "f1").usage).toEqual({ tokens: 42, toolUses: 2, durationMs: 3_000 });
  });
});

describe("TaskFeed — a held shell moved to the background is published at once (R2.3)", () => {
  it("publishes it running in the background before the hold expires", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"));
    at(START + 1_000);
    expect(feed.onUpdated(updated("f1", { is_backgrounded: true }))).not.toBe("none");
    expect(byId(publish(feed), "f1")).toMatchObject({
      status: "running",
      background: true,
      startedAt: START,
    });
  });

  // Hostile (wrong split): promotion on backgrounding, then the hold expiring, is still one task.
  it("stays one entry when the hold later expires", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"));
    at(START + 1_000);
    feed.onUpdated(updated("f1", { is_backgrounded: true }));
    at(START + FOREGROUND_SHELL_HOLD_MS + 1);
    feed.promoteDue();
    expect(ids(publish(feed))).toEqual(["f1"]);
    expect(feed.nextHoldDue()).toBeNull();
  });
});

describe("TaskFeed — the shell's label is its tool call's description (R2.5, R2.6)", () => {
  it("publishes the tool description of a background shell", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1", { is_backgrounded: true }), "Write the fixture file");
    expect(byId(publish(feed), "b1").description).toBe("Write the fixture file");
  });

  it("publishes the tool description of a promoted foreground shell", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"), "Build the release");
    at(START + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    expect(byId(publish(feed), "f1").description).toBe("Build the release");
  });

  // Hostile: a later patch carrying the command text must not replace the tool description.
  it("keeps the tool description when a task_updated patch carries another description", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("f1"), "Build the release");
    at(START + 1_000);
    feed.onUpdated(updated("f1", { description: "make -j16 release" }));
    feed.onUpdated(updated("f1", { is_backgrounded: true }));
    expect(byId(publish(feed), "f1").description).toBe("Build the release");
  });

  it("falls back to the SDK description when the tool call carried none or an empty one", () => {
    for (const toolDescription of [undefined, ""]) {
      const { feed } = makeFeed();
      feed.onStarted(started("b1", { is_backgrounded: true }), toolDescription);
      expect(byId(publish(feed), "b1").description, String(toolDescription)).toBe(COMMAND);
    }
  });

  it("never copies the command line given as prompt into the snapshot", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("b1", { is_backgrounded: true }), "Write the fixture file");
    feed.onStarted(started("f1"), "Build the release");
    at(START + FOREGROUND_SHELL_HOLD_MS);
    feed.promoteDue();
    expect(JSON.stringify(publish(feed))).not.toContain("PROMPT-NEVER-PUBLISHED");
  });
});

describe("TaskFeed — subagents are published as today (R2.7)", () => {
  // Hostile: the hold keys on the task type, not on the foreground flag alone.
  it("publishes a foreground subagent at once", () => {
    const { feed } = makeFeed();
    expect(
      feed.onStarted(
        started("a1", { task_type: "local_agent", is_backgrounded: false, description: "Explore" }),
      ),
    ).toBe("progress");
    expect(byId(publish(feed), "a1")).toMatchObject({
      type: "subagent",
      status: "running",
      background: false,
    });
  });

  it("publishes a background subagent at once", () => {
    const { feed } = makeFeed();
    feed.onStarted(
      started("a1", { task_type: "local_agent", is_backgrounded: true, description: "Explore" }),
    );
    expect(ids(publish(feed))).toEqual(["a1"]);
  });

  it("keeps a subagent's own description even when a tool description is given", () => {
    const { feed } = makeFeed();
    feed.onStarted(
      started("a1", {
        task_type: "local_agent",
        is_backgrounded: false,
        description: "Explore the feed",
      }),
      "Agent tool description",
    );
    expect(byId(publish(feed), "a1").description).toBe("Explore the feed");
  });

  it("ends a quick foreground subagent with a published ending", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(
      started("a1", { task_type: "local_agent", is_backgrounded: false, description: "Explore" }),
    );
    publish(feed);
    at(START + 500);
    expect(feed.onNotification(notification("a1"))).toBe("terminal");
    expect(byId(publish(feed), "a1").status).toBe("completed");
  });
});

describe("TaskFeed — a background shell's lifecycle is unchanged (R5.1)", () => {
  it("goes running, then completed, then out of the snapshot", () => {
    const { feed, at } = makeFeed();
    feed.onStarted(started("b1", { is_backgrounded: true }));
    expect(byId(publish(feed), "b1").status).toBe("running");
    at(START + 2_000);
    feed.onNotification(notification("b1"));
    expect(byId(publish(feed), "b1").status).toBe("completed");
    expect(publish(feed).tasks).toEqual([]);
  });

  it("is interrupted by a process restart", () => {
    const { feed } = makeFeed();
    feed.onStarted(started("b1", { is_backgrounded: true }));
    publish(feed);
    expect(feed.onProcessRestart()).toBe("terminal");
    expect(byId(publish(feed), "b1").status).toBe("interrupted");
  });
});
