// Contract tests for TaskFeedPublisher (story 012, R1.3, R1.4, R1.11).
//
// The publisher decides WHEN a snapshot goes out: at most once per second per
// session during progress, at once on an ending, and once more after a burst
// so the latest values are not lost. Time is vitest's fake clock; the
// publisher receives it through its `timers` argument.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { TaskFeed, TaskFeedPublisher } from "../task-feed.js";

const SESSION = "test-session";

function started(taskId: string): any {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: `task ${taskId}`,
    task_type: "local_agent",
    is_backgrounded: true,
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
    description: `task ${taskId}`,
    usage: { total_tokens: tokens, tool_uses: 1, duration_ms: tokens },
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

function notification(taskId: string): any {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status: "completed",
    output_file: "",
    summary: "done",
    uuid: randomUUID(),
    session_id: SESSION,
  };
}

/** Timers backed by vitest's fake clock. */
const timers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};

type Sent = { at: number; snapshot: any };

/** One session: a feed, a publisher and the record of every successful send.
 *  `failNext` makes the next N sends reject (recorded in `failed`). */
function makeSession() {
  const feed = new TaskFeed(() => Date.now());
  const sent: Sent[] = [];
  const failed: Sent[] = [];
  const control = { failNext: 0 };
  const send = vi.fn(async (snapshot: any) => {
    if (control.failNext > 0) {
      control.failNext--;
      failed.push({ at: Date.now(), snapshot });
      throw new Error("client went away");
    }
    sent.push({ at: Date.now(), snapshot });
  });
  const publisher = new TaskFeedPublisher(feed, send, timers as any);
  return {
    feed,
    publisher,
    sent,
    failed,
    control,
    start(taskId: string) {
      publisher.notify(feed.onStarted(started(taskId)));
    },
    progress(taskId: string, tokens: number) {
      publisher.notify(feed.onProgress(progress(taskId, tokens)));
    },
    end(taskId: string) {
      publisher.notify(feed.onNotification(notification(taskId)));
    },
    level(taskIds: string[]) {
      publisher.notify(feed.onLevel(taskIds.map((task_id) => ({ task_id }))));
    },
  };
}

const tokensOf = (s: Sent, id: string) =>
  s.snapshot.tasks.find((t: any) => t.id === id)?.usage?.tokens;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_759_500_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskFeedPublisher — progress throttle (R1.3)", () => {
  // Hostile half: a publisher that sends on every event would split one
  // second of progress into many snapshots.
  it("publishes at most once per second while progress arrives every 100 ms for 10 s", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(0);
    const afterStart = s.sent.length;

    for (let i = 1; i <= 100; i++) {
      await vi.advanceTimersByTimeAsync(100);
      s.progress("a1", i);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    const progressSends = s.sent.slice(afterStart);
    expect(progressSends.length).toBeGreaterThan(0);
    expect(progressSends.length).toBeLessThanOrEqual(11);
    for (let i = 1; i < s.sent.length; i++) {
      expect(s.sent[i].at - s.sent[i - 1].at).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("publishes the first progress at once when nothing was published in the last second", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);
    const before = s.sent.length;

    s.progress("a1", 42);
    await vi.advanceTimersByTimeAsync(0);

    expect(s.sent.length).toBe(before + 1);
    expect(tokensOf(s.sent.at(-1)!, "a1")).toBe(42);
  });

  // Third element: the window is per session. A throttle shared across
  // sessions would make session B wait for session A's window.
  it("keeps one throttle window per session", async () => {
    const a = makeSession();
    const b = makeSession();
    a.start("a1");
    b.start("b1");
    await vi.advanceTimersByTimeAsync(5_000);

    a.progress("a1", 1);
    await vi.advanceTimersByTimeAsync(100);
    const bBefore = b.sent.length;
    b.progress("b1", 2);
    await vi.advanceTimersByTimeAsync(0);

    expect(b.sent.length).toBe(bBefore + 1);
    expect(tokensOf(b.sent.at(-1)!, "b1")).toBe(2);
  });
});

describe("TaskFeedPublisher — trailing snapshot after a burst (R1.11)", () => {
  // Hostile half, the converse: a leading-edge-only throttle would collapse
  // the burst's tail into nothing and leave stale values on screen.
  it("publishes a final snapshot with the latest values within one second of the burst's end", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);

    s.progress("a1", 1);
    await vi.advanceTimersByTimeAsync(100);
    s.progress("a1", 2);
    await vi.advanceTimersByTimeAsync(100);
    s.progress("a1", 3);
    const burstEnd = Date.now();

    await vi.advanceTimersByTimeAsync(1_000);

    const last = s.sent.at(-1)!;
    expect(tokensOf(last, "a1")).toBe(3);
    expect(last.at - burstEnd).toBeLessThanOrEqual(1_000);
  });

  it("arms one trailing publish, not one per suppressed event", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);
    s.progress("a1", 1);
    await vi.advanceTimersByTimeAsync(0);
    const afterLeading = s.sent.length;

    for (let i = 2; i <= 9; i++) {
      await vi.advanceTimersByTimeAsync(100);
      s.progress("a1", i);
    }
    await vi.advanceTimersByTimeAsync(3_000);

    expect(s.sent.length).toBe(afterLeading + 1);
    expect(tokensOf(s.sent.at(-1)!, "a1")).toBe(9);
  });
});

describe("TaskFeedPublisher — endings bypass the throttle (R1.4)", () => {
  it("publishes an ending at once, inside a throttle window", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);
    s.progress("a1", 1);
    await vi.advanceTimersByTimeAsync(100);
    const before = s.sent.length;

    s.end("a1");
    await vi.advanceTimersByTimeAsync(0);

    expect(s.sent.length).toBe(before + 1);
    expect(s.sent.at(-1)!.snapshot.tasks.find((t: any) => t.id === "a1").status).toBe("completed");
  });

  it("cancels the pending trailing publish when an ending goes out", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);
    s.progress("a1", 1);
    await vi.advanceTimersByTimeAsync(100);
    s.progress("a1", 2); // arms the trailing publish
    await vi.advanceTimersByTimeAsync(100);
    s.end("a1");
    await vi.advanceTimersByTimeAsync(0);
    const afterEnding = s.sent.length;

    await vi.advanceTimersByTimeAsync(3_000);

    expect(s.sent.length).toBe(afterEnding);
  });

  it("publishes two endings in one window as two snapshots", async () => {
    const s = makeSession();
    s.start("a1");
    s.start("a2");
    await vi.advanceTimersByTimeAsync(5_000);
    const before = s.sent.length;

    s.end("a1");
    await vi.advanceTimersByTimeAsync(10);
    s.end("a2");
    await vi.advanceTimersByTimeAsync(0);

    expect(s.sent.length).toBe(before + 2);
  });
});

describe("TaskFeedPublisher — dispose", () => {
  it("never sends after dispose, neither from a pending timer nor from a later notify", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);
    s.progress("a1", 1);
    await vi.advanceTimersByTimeAsync(100);
    s.progress("a1", 2); // arms the trailing publish
    const before = s.sent.length;

    s.publisher.dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    s.end("a1");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(s.sent.length).toBe(before);
  });

  it("does not publish for a change of none", async () => {
    const s = makeSession();
    await vi.advanceTimersByTimeAsync(5_000);

    s.publisher.notify("none");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(s.sent).toHaveLength(0);
  });
});

describe("TaskFeedPublisher — a failed send does not lose an ending (R1.4, R1.6)", () => {
  it("retries within about a second and the retry still carries the ending", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);

    s.control.failNext = 1;
    s.end("a1");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.failed).toHaveLength(1);
    const failedAt = s.failed[0].at;

    await vi.advanceTimersByTimeAsync(1_000);

    const retry = s.sent.at(-1)!;
    expect(retry.at - failedAt).toBeLessThanOrEqual(1_000);
    expect(retry.snapshot.tasks.find((t: any) => t.id === "a1")?.status).toBe("completed");
  });

  it("keeps retrying while sends fail, and marks the ending published only after one succeeds", async () => {
    const s = makeSession();
    s.start("a1");
    await vi.advanceTimersByTimeAsync(5_000);

    s.control.failNext = 3;
    s.end("a1");
    await vi.advanceTimersByTimeAsync(3_500);

    expect(s.failed).toHaveLength(3);
    const success = s.sent.filter((x) =>
      x.snapshot.tasks.some((t: any) => t.id === "a1" && t.status === "completed"),
    );
    expect(success).toHaveLength(1);

    // Published once: a later snapshot (caused by a new task) no longer carries it.
    s.start("a2");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.sent.at(-1)!.snapshot.tasks.map((t: any) => t.id)).toEqual(["a2"]);
  });
});

describe("TaskFeedPublisher — level reconciliation timer", () => {
  it("publishes a background task as interrupted when its 2 s grace expires, with no further event", async () => {
    const s = makeSession();
    s.start("b1");
    await vi.advanceTimersByTimeAsync(5_000);

    s.level([]); // b1 missing from the level: deadline in 2 s
    await vi.advanceTimersByTimeAsync(1_900);
    expect(s.sent.some((x) => x.snapshot.tasks.some((t: any) => t.status === "interrupted"))).toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const last = s.sent.at(-1)!;
    expect(last.snapshot.tasks.find((t: any) => t.id === "b1")?.status).toBe("interrupted");
  });

  it("does not interrupt a task whose real ending arrived inside the grace window", async () => {
    const s = makeSession();
    s.start("b1");
    await vi.advanceTimersByTimeAsync(5_000);

    s.level([]);
    await vi.advanceTimersByTimeAsync(500);
    s.end("b1");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(s.sent.some((x) => x.snapshot.tasks.some((t: any) => t.status === "interrupted"))).toBe(
      false,
    );
  });

  it("does not fire the reconcile timer after dispose", async () => {
    const s = makeSession();
    s.start("b1");
    await vi.advanceTimersByTimeAsync(5_000);
    s.level([]);
    const before = s.sent.length;

    s.publisher.dispose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(s.sent.length).toBe(before);
  });
});
