// F3 of the Zeo next proposal (docs/ZEO-NEXT-PROPOSAL.md §5.3), two defects:
//
// 1. A turn cancel did not end that turn's foreground tasks. When the CLI
//    omitted their closing event, only background tasks were reconciled
//    (`reconcile` skips `!task.background`), so a foreground row stayed
//    "running" in Zeo's Tasks card until the session ended.
// 2. `teardownSession` disposed the publisher a second time after
//    `retireTaskFeed` had disposed it with `{ flush: true }`. The second call
//    reset the flush, so a terminal snapshot queued behind an in-flight send
//    — the `interrupted` endings of the retirement — was dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { TaskFeed, TaskFeedPublisher } from "../task-feed.js";
import { AcpClient, ClaudeAcpAgent, TASKS_META_KEY } from "../acp-agent.js";
import { lastScriptedQuery, running, taskStarted, waitFor } from "./task-feed-harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { scriptedQuery } = await import("./task-feed-harness.js");
  return { ...actual, query: vi.fn(scriptedQuery) };
});

const SESSION = "test-session";

function started(taskId: string, fields: Record<string, unknown> = {}): any {
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
    ...fields,
  };
}

describe("TaskFeed.onTurnCancelled — the turn's foreground tasks end with it", () => {
  it("ends a running foreground task as interrupted and leaves background tasks running", () => {
    let now = 1;
    const feed = new TaskFeed(() => now);
    feed.onStarted(started("fg", { is_backgrounded: false }));
    feed.onStarted(started("bg"));

    now = 40;
    expect(feed.onTurnCancelled()).toBe("terminal");

    const tasks = feed.snapshot().snapshot.tasks;
    expect(tasks.find((t) => t.id === "fg")).toMatchObject({
      status: "interrupted",
      endedAt: 40,
    });
    expect(tasks.find((t) => t.id === "bg")).toMatchObject({ status: "running" });
  });

  it("drops a foreground shell still held back — it was never shown", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("sh", { task_type: "local_bash", is_backgrounded: false }));

    expect(feed.onTurnCancelled()).toBe("none");
    expect(feed.snapshot().snapshot.tasks).toEqual([]);
    expect(feed.nextHoldDue()).toBeNull();
  });

  it("reports no change when the turn had no foreground task", () => {
    const feed = new TaskFeed(() => 1);
    feed.onStarted(started("bg"));

    expect(feed.onTurnCancelled()).toBe("none");
  });
});

describe("TaskFeedPublisher.dispose — a second call keeps the first one's flush", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const timers = {
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  };

  it("still sends the publish queued behind an in-flight send", async () => {
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
    // teardownSession's own dispose, after retireTaskFeed's.
    publisher.dispose();
    release();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent).toEqual([["x:running"], ["x:interrupted"]]);
  });
});

describe("session/cancel — the agent ends the turn's foreground tasks", () => {
  it("publishes a foreground task as interrupted, and a background task stays running", async () => {
    const snapshots: any[] = [];
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        const meta = n.update._meta as Record<string, any> | undefined;
        if (n.update.sessionUpdate === "session_info_update" && meta?.[TASKS_META_KEY]) {
          snapshots.push(meta[TASKS_META_KEY]);
        }
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    // The scripted query accepts the interrupt but never yields a result, as a
    // wedged CLI would: the force-cancel floor settles the turn "cancelled".
    agent.forceCancelGraceMs = 20;
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const query = lastScriptedQuery();

    const response = agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    query.out.push(running(sessionId));
    query.out.push(
      taskStarted(sessionId, "fg", { task_type: "local_agent", is_backgrounded: false }),
    );
    query.out.push(taskStarted(sessionId, "bg", { task_type: "local_agent" }));
    await waitFor(
      () => snapshots.some((s) => s.tasks.some((t: any) => t.id === "fg")),
      "the running snapshot",
    );

    await agent.cancel({ sessionId });
    await response;

    await waitFor(
      () =>
        snapshots.some((s) => s.tasks.some((t: any) => t.id === "fg" && t.status !== "running")),
      "the foreground task's ending",
    );
    const last = snapshots[snapshots.length - 1];
    expect(last.tasks.find((t: any) => t.id === "fg")).toMatchObject({ status: "interrupted" });
    expect(last.tasks.find((t: any) => t.id === "bg")).toMatchObject({ status: "running" });
  });
});
