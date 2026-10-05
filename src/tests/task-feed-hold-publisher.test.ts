// Story 022, task 1.2 — the publisher's hold timer (R2.2, R2.3, R2.4).
//
// A held foreground shell must reach the client 5 s after it started without any other SDK
// message, and a shell that ends before then must never reach it. Time is vitest's fake clock,
// handed to the publisher through its `timers` argument.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import {
  FOREGROUND_SHELL_HOLD_MS,
  PUBLISH_INTERVAL_MS,
  TaskFeed,
  TaskFeedPublisher,
} from "../task-feed.js";

const SESSION = "hold-publisher-session";
const START = 1_759_500_000_000;

const startedShell = (taskId: string, background = false): any => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  description: `command of ${taskId}`,
  task_type: "local_bash",
  is_backgrounded: background,
  uuid: randomUUID(),
  session_id: SESSION,
});

const ended = (taskId: string): any => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  status: "completed",
  output_file: "",
  summary: "done",
  uuid: randomUUID(),
  session_id: SESSION,
});

const backgrounded = (taskId: string): any => ({
  type: "system",
  subtype: "task_updated",
  task_id: taskId,
  patch: { is_backgrounded: true },
  uuid: randomUUID(),
  session_id: SESSION,
});

const timers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};

type Sent = { at: number; snapshot: any };

function makeSession() {
  const feed = new TaskFeed(() => Date.now());
  const sent: Sent[] = [];
  const publisher = new TaskFeedPublisher(
    feed,
    async (snapshot) => {
      sent.push({ at: Date.now(), snapshot });
    },
    timers as any,
  );
  return {
    feed,
    publisher,
    sent,
    start(taskId: string, background = false) {
      publisher.notify(feed.onStarted(startedShell(taskId, background)));
    },
    end(taskId: string) {
      publisher.notify(feed.onNotification(ended(taskId)));
    },
    background(taskId: string) {
      publisher.notify(feed.onUpdated(backgrounded(taskId)));
    },
    firstSendWith(taskId: string): Sent | undefined {
      return sent.find((s) => s.snapshot.tasks.some((t: any) => t.id === taskId));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskFeedPublisher — the hold timer (R2.2)", () => {
  it("publishes a held shell 5 s after it started, with no other SDK message", async () => {
    const s = makeSession();
    s.start("f1");
    await vi.advanceTimersByTimeAsync(FOREGROUND_SHELL_HOLD_MS - 1);
    expect(s.firstSendWith("f1")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const first = s.firstSendWith("f1");
    expect(first).toBeDefined();
    expect(first!.at).toBe(START + FOREGROUND_SHELL_HOLD_MS);
    expect(first!.snapshot.tasks.find((t: any) => t.id === "f1")).toMatchObject({
      status: "running",
      background: false,
    });
  });

  it("re-arms for a second held shell and publishes each at its own due time", async () => {
    const s = makeSession();
    s.start("f1");
    await vi.advanceTimersByTimeAsync(3_000);
    s.start("f2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.firstSendWith("f1")!.at).toBe(START + FOREGROUND_SHELL_HOLD_MS);
    expect(s.firstSendWith("f2")!.at).toBe(START + 3_000 + FOREGROUND_SHELL_HOLD_MS);
  });
});

describe("TaskFeedPublisher — a quick shell never reaches the client (R2.4)", () => {
  it("sends no snapshot mentioning a shell that ended after 2 s", async () => {
    const s = makeSession();
    s.start("f1");
    await vi.advanceTimersByTimeAsync(2_000);
    s.end("f1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.firstSendWith("f1")).toBeUndefined();
  });

  // Hostile: dropping a quick shell must not cancel the timer of another held shell.
  it("still publishes another held shell when one ends quickly", async () => {
    const s = makeSession();
    s.start("f1");
    s.start("f2");
    await vi.advanceTimersByTimeAsync(1_000);
    s.end("f1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.firstSendWith("f1")).toBeUndefined();
    expect(s.firstSendWith("f2")?.at).toBe(START + FOREGROUND_SHELL_HOLD_MS);
  });
});

describe("TaskFeedPublisher — moved to the background (R2.3)", () => {
  it("publishes at once, well before the hold expires", async () => {
    const s = makeSession();
    s.start("f1");
    await vi.advanceTimersByTimeAsync(1_000);
    s.background("f1");
    await vi.advanceTimersByTimeAsync(0);
    const first = s.firstSendWith("f1");
    expect(first).toBeDefined();
    expect(first!.at).toBeLessThan(START + FOREGROUND_SHELL_HOLD_MS);
  });
});

describe("TaskFeedPublisher — dispose", () => {
  it("clears the hold timer: a disposed publisher sends nothing for a held shell", async () => {
    const s = makeSession();
    s.start("f1");
    s.publisher.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sent).toEqual([]);
  });
});

describe("TaskFeedPublisher — a failed send from the hold timer", () => {
  // The hold timer publishes outside the SDK loop, so no caller handles its errors: a rejected
  // send must reach the error handler (which logs ids only) and never escape as an unhandled
  // rejection, and the publish is retried.
  it("hands the failure to the error handler, leaks no rejection, and retries", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const feed = new TaskFeed(() => Date.now());
      const sent: Sent[] = [];
      const failure = new Error("client connection closed");
      let calls = 0;
      const errors: unknown[] = [];
      const publisher = new TaskFeedPublisher(
        feed,
        async (snapshot) => {
          calls += 1;
          if (calls === 1) throw failure;
          sent.push({ at: Date.now(), snapshot });
        },
        timers as any,
        (error) => errors.push(error),
      );
      publisher.notify(feed.onStarted(startedShell("f1")));

      await vi.advanceTimersByTimeAsync(FOREGROUND_SHELL_HOLD_MS);
      expect(calls).toBe(1);
      expect(errors).toEqual([failure]);
      expect(sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
      expect(sent.some((s) => s.snapshot.tasks.some((t: any) => t.id === "f1"))).toBe(true);
      // Let any stray rejection surface before checking: a real macrotask, since the fake
      // clock also fakes setImmediate.
      publisher.dispose();
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
