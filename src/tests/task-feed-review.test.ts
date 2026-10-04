// Regressions found by the story 012 tech review of task-feed.ts, beyond the
// pre-authored contract tests: a task id that starts again, two sends in
// flight, and a send or error handler that throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskFeed, TaskFeedPublisher } from "../task-feed.js";

const started = (id: string): any => ({
  type: "system",
  subtype: "task_started",
  task_id: id,
  description: `task ${id}`,
  task_type: "local_agent",
  is_backgrounded: true,
});
const ended = (id: string): any => ({
  type: "system",
  subtype: "task_notification",
  task_id: id,
  status: "completed",
  output_file: "",
  summary: "done",
});

const timers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};

describe("TaskFeed — a task id that starts again", () => {
  it("shows a second life after the first ending was published, and publishes its ending", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("agent1"));
    feed.onNotification(ended("agent1"));
    feed.markPublished(feed.snapshot().endedIds);

    expect(feed.onStarted(started("agent1"))).toBe("progress");
    expect(feed.snapshot().snapshot.tasks.map((t) => t.status)).toEqual(["running"]);

    expect(feed.onNotification(ended("agent1"))).toBe("terminal");
    const { snapshot, endedIds } = feed.snapshot();
    expect(snapshot.tasks.map((t) => t.status)).toEqual(["completed"]);
    expect(endedIds).toEqual(["agent1"]);
  });

  it("lets a second life replace an ending that was not published yet", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("agent1"));
    feed.onNotification(ended("agent1"));

    expect(feed.onStarted(started("agent1"))).toBe("progress");
    expect(feed.isRunning("agent1")).toBe(true);
  });

  it("keeps a second life that started while the first ending's send was in flight", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("agent1"));
    feed.onNotification(ended("agent1"));
    const inFlight = feed.snapshot();
    feed.onStarted(started("agent1"));
    feed.markPublished(inFlight.endedIds);

    expect(feed.isRunning("agent1")).toBe(true);
    expect(feed.snapshot().snapshot.tasks.map((t) => t.status)).toEqual(["running"]);
  });

  it("still publishes a second life's ending once the first send settled", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("agent1"));
    feed.onNotification(ended("agent1"));
    const inFlight = feed.snapshot();
    feed.onStarted(started("agent1"));
    feed.onNotification(ended("agent1"));
    feed.markPublished(inFlight.endedIds);

    const next = feed.snapshot();
    expect(next.snapshot.tasks.map((t) => t.status)).toEqual(["completed"]);
    feed.markPublished(next.endedIds);
    expect(feed.snapshot().snapshot.tasks).toEqual([]);
  });

  it("ignores a duplicate start of a task that is still running", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("a"));
    expect(feed.onStarted(started("a"))).toBe("none");
  });
});

describe("TaskFeedPublisher — sends", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps one send in flight, so an ending is not carried by two successful snapshots", async () => {
    const feed = new TaskFeed(() => Date.now());
    const sent: string[][] = [];
    let release!: () => void;
    let calls = 0;
    const send = async (snapshot: any) => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (release = r));
      sent.push(snapshot.tasks.map((t: any) => `${t.id}:${t.status}`));
    };
    const publisher = new TaskFeedPublisher(feed, send, timers as any);
    feed.onStarted(started("x"));
    feed.onStarted(started("y"));
    publisher.notify(feed.onNotification(ended("x")));
    await vi.advanceTimersByTimeAsync(0);
    publisher.notify(feed.onNotification(ended("y")));
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual([["x:completed", "y:running"], ["y:completed"]]);
  });

  it("never throws into the caller when send throws synchronously, and retries", async () => {
    const feed = new TaskFeed(() => Date.now());
    let fail = true;
    const sent: unknown[] = [];
    const send = (snapshot: any) => {
      if (fail) {
        fail = false;
        throw new Error("sync boom");
      }
      sent.push(snapshot);
      return Promise.resolve();
    };
    const publisher = new TaskFeedPublisher(feed, send, timers as any);
    feed.onStarted(started("x"));

    expect(() => publisher.notify(feed.onNotification(ended("x")))).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
  });

  it("still arms the retry when the error handler itself throws", async () => {
    const feed = new TaskFeed(() => Date.now());
    let failures = 1;
    const sent: unknown[] = [];
    const send = async (snapshot: any) => {
      if (failures-- > 0) throw new Error("client went away");
      sent.push(snapshot);
    };
    const publisher = new TaskFeedPublisher(feed, send, timers as any, () => {
      throw new Error("logger boom");
    });
    feed.onStarted(started("x"));
    publisher.notify(feed.onNotification(ended("x")));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(1);
  });

  it("dispose({ flush: true }) still sends a publish queued behind an in-flight send, once", async () => {
    const feed = new TaskFeed(() => Date.now());
    const sent: string[][] = [];
    let release!: () => void;
    let calls = 0;
    const send = async (snapshot: any) => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (release = r));
      sent.push(snapshot.tasks.map((t: any) => `${t.id}:${t.status}`));
    };
    const publisher = new TaskFeedPublisher(feed, send, timers as any);
    feed.onStarted(started("x"));
    publisher.notify("terminal");
    await vi.advanceTimersByTimeAsync(0);
    publisher.notify(feed.onProcessRestart());
    publisher.dispose({ flush: true });
    release();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent).toEqual([["x:running"], ["x:interrupted"]]);
  });
});

describe("TaskFeed — usage numbers", () => {
  it("publishes usage as whole, non-negative numbers", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("a"));
    feed.onProgress({
      type: "system",
      subtype: "task_progress",
      task_id: "a",
      description: "a",
      usage: { total_tokens: 10.6, tool_uses: -1, duration_ms: Number.NaN },
    } as any);

    expect(feed.snapshot().snapshot.tasks[0].usage).toEqual({
      tokens: 11,
      toolUses: 0,
      durationMs: 0,
    });
  });
});
