// Integration tests: the task feed wired into the session loop (story 012,
// R1.1, R1.4, R1.6, R1.9, R1.10).
//
// Sessions are created by the real `newSession` over a scripted SDK query
// (see task-feed-harness.ts), and the client records every
// `session_info_update`. Assertions read the wire payload only.

import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  AcpClient,
  BACKGROUND_TASKS_META_KEY,
  ClaudeAcpAgent,
  TASKS_META_KEY,
} from "../acp-agent.js";
import {
  backgroundTasksChanged,
  idle,
  lastScriptedQuery,
  result,
  running,
  taskNotification,
  taskProgress,
  taskStarted,
  waitFor,
} from "./task-feed-harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { scriptedQuery } = await import("./task-feed-harness.js");
  return { ...actual, query: vi.fn(scriptedQuery) };
});

type Published = { at: number; meta: Record<string, any> };

async function startSession(options: { failTasksSend?: boolean } = {}) {
  const published: Published[] = [];
  const errors: string[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      const meta = notification.update._meta as Record<string, any> | undefined;
      if (notification.update.sessionUpdate !== "session_info_update" || !meta) return;
      if (options.failTasksSend && meta[TASKS_META_KEY]) {
        throw new Error("client went away");
      }
      published.push({ at: Date.now(), meta });
    },
  } as unknown as AcpClient;
  const logger = {
    log: () => {},
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
  };
  const agent = new ClaudeAcpAgent(client, logger);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const query = lastScriptedQuery();

  const tasksSnapshots = () =>
    published.filter((p) => p.meta[TASKS_META_KEY]).map((p) => p.meta[TASKS_META_KEY]);
  const backgroundLevels = () =>
    published
      .filter((p) => p.meta[BACKGROUND_TASKS_META_KEY])
      .map((p) => p.meta[BACKGROUND_TASKS_META_KEY]);

  /** Run one turn that starts the given tasks and ends normally. */
  async function turn(...messages: unknown[]) {
    const response = agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    query.out.push(running(sessionId));
    for (const message of messages) query.out.push(message);
    query.out.push(result(sessionId));
    query.out.push(idle(sessionId));
    return response;
  }

  return { agent, sessionId, query, published, errors, tasksSnapshots, backgroundLevels, turn };
}

const find = (snapshot: any, id: string) => snapshot?.tasks?.find((t: any) => t.id === id);

describe("task feed wiring — a background shell's life (R1.1, R1.4, R1.6)", () => {
  it("publishes the started task as running, stamped by the adapter", async () => {
    const s = await startSession();
    const before = Date.now();

    const response = await s.turn(
      taskStarted(s.sessionId, "b1", {
        tool_use_id: "toolu_sleep",
        description: "Sleep twenty seconds",
        task_type: "local_bash",
        is_backgrounded: true,
      }),
    );
    expect(response.stopReason).toBe("end_turn");
    await waitFor(() => s.tasksSnapshots().length > 0, "a _claude/tasks snapshot");

    const task = find(s.tasksSnapshots()[0], "b1");
    expect(task).toMatchObject({
      id: "b1",
      toolCallId: "toolu_sleep",
      type: "shell",
      description: "Sleep twenty seconds",
      background: true,
      depth: 0,
      status: "running",
      endedAt: null,
    });
    expect(task.startedAt).toBeGreaterThanOrEqual(before);
    expect(task.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("publishes the ending past the turn, at once, then omits the task from later snapshots", async () => {
    const s = await startSession();
    await s.turn(taskStarted(s.sessionId, "b1"));
    await waitFor(() => s.tasksSnapshots().length > 0, "the running snapshot");

    const sentAt = Date.now();
    s.query.out.push(taskNotification(s.sessionId, "b1", { summary: "exit code 0" }));
    await waitFor(
      () => s.tasksSnapshots().some((snap) => find(snap, "b1")?.status === "completed"),
      "the completed snapshot",
    );
    const ending = s.published.find(
      (p) => find(p.meta[TASKS_META_KEY], "b1")?.status === "completed",
    )!;
    expect(ending.at - sentAt).toBeLessThan(1_000);
    expect(find(ending.meta[TASKS_META_KEY], "b1")).toMatchObject({
      status: "completed",
      summary: "exit code 0",
    });
    expect(typeof find(ending.meta[TASKS_META_KEY], "b1").endedAt).toBe("number");

    // Any later snapshot — here one caused by a new task — no longer carries b1.
    const count = s.tasksSnapshots().length;
    await s.turn(taskStarted(s.sessionId, "b2"));
    await waitFor(() => s.tasksSnapshots().length > count, "a later snapshot");
    for (const snapshot of s.tasksSnapshots().slice(count)) {
      expect(find(snapshot, "b1")).toBeUndefined();
    }
  });

  it("does not publish an ambient task", async () => {
    const s = await startSession();
    await s.turn(
      taskStarted(s.sessionId, "watch", { ambient: true }),
      taskStarted(s.sessionId, "b1"),
    );
    await waitFor(() => s.tasksSnapshots().length > 0, "a snapshot");

    for (const snapshot of s.tasksSnapshots()) {
      expect(find(snapshot, "watch")).toBeUndefined();
    }
  });

  it("carries progress for a running subagent in a later snapshot", async () => {
    const s = await startSession();
    await s.turn(taskStarted(s.sessionId, "a1", { task_type: "local_agent" }));
    await waitFor(() => s.tasksSnapshots().length > 0, "the running snapshot");

    s.query.out.push(
      taskProgress(s.sessionId, "a1", {
        usage: { total_tokens: 4242, tool_uses: 3, duration_ms: 9000 },
        last_tool_name: "Grep",
      }),
    );
    await waitFor(
      () => s.tasksSnapshots().some((snap) => find(snap, "a1")?.usage?.tokens === 4242),
      "a snapshot carrying the progress",
      2_500,
    );
  });
});

describe("task feed wiring — the old key is untouched (R1.10)", () => {
  it("keeps publishing _claude/backgroundTasks with its current shape and timing", async () => {
    const s = await startSession();
    await s.turn(
      taskStarted(s.sessionId, "b1"),
      backgroundTasksChanged(s.sessionId, [{ task_id: "b1" }]),
    );
    s.query.out.push(taskNotification(s.sessionId, "b1"));
    s.query.out.push(backgroundTasksChanged(s.sessionId, []));
    await waitFor(() => s.backgroundLevels().length === 2, "two background levels");
    await waitFor(
      () => s.tasksSnapshots().some((snap) => find(snap, "b1")?.status === "completed"),
      "the tasks feed alongside it",
    );

    expect(s.backgroundLevels()).toEqual([
      { count: 1, tasks: [{ id: "b1", type: "local_bash", description: "sleep" }] },
      { count: 0, tasks: [] },
    ]);
  });
});

describe("task feed wiring — process restart (R1.9)", () => {
  it("publishes tasks that were running as interrupted when the session's query is re-created", async () => {
    const s = await startSession();
    await s.turn(taskStarted(s.sessionId, "b1"), taskStarted(s.sessionId, "b2"));
    await waitFor(
      () => s.tasksSnapshots().some((snap) => find(snap, "b1") && find(snap, "b2")),
      "both tasks running",
    );
    const count = s.tasksSnapshots().length;

    const session = (s.agent as any).sessions[s.sessionId];
    await (s.agent as any).recreateSessionQuery(s.sessionId, session);

    await waitFor(() => s.tasksSnapshots().length > count, "a snapshot after the restart");
    const after = s.tasksSnapshots().slice(count);
    const interrupted = after.flatMap((snap: any) =>
      snap.tasks.filter((t: any) => t.status === "interrupted").map((t: any) => t.id),
    );
    expect(interrupted.sort()).toEqual(["b1", "b2"]);

    // Nothing was disposed by the restart: the same session keeps publishing on the
    // replacement query, and the interrupted endings were published once only.
    const afterRestart = s.tasksSnapshots().length;
    const replacement = lastScriptedQuery();
    expect(replacement).not.toBe(s.query);
    const response = s.agent.prompt({
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "again" }],
    });
    replacement.out.push(running(s.sessionId));
    replacement.out.push(taskStarted(s.sessionId, "b3"));
    replacement.out.push(result(s.sessionId));
    replacement.out.push(idle(s.sessionId));
    await response;
    await waitFor(
      () =>
        s
          .tasksSnapshots()
          .slice(afterRestart)
          .some((snap: any) => find(snap, "b3")),
      "a snapshot from the replacement query",
    );
    for (const snapshot of s.tasksSnapshots().slice(afterRestart)) {
      expect(find(snapshot, "b1")).toBeUndefined();
      expect(find(snapshot, "b2")).toBeUndefined();
    }
  });
});

describe("task feed wiring — failures and teardown", () => {
  it("logs a failed snapshot send with the session id and keeps the session working", async () => {
    const s = await startSession({ failTasksSend: true });

    const response = await s.turn(taskStarted(s.sessionId, "b1"));

    expect(response.stopReason).toBe("end_turn");
    await waitFor(
      () => s.errors.some((line) => line.includes(s.sessionId) && /tasks/i.test(line)),
      "an error line naming the session",
    );
    await s.agent.closeSession({ sessionId: s.sessionId }); // stops the 1 s retries
  });

  it("sends nothing for the session after it is closed, even from a pending throttle timer", async () => {
    const s = await startSession();
    await s.turn(taskStarted(s.sessionId, "a1", { task_type: "local_agent" }));
    await waitFor(() => s.tasksSnapshots().length > 0, "the running snapshot");
    s.query.out.push(
      taskProgress(s.sessionId, "a1", { usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }),
    );
    s.query.out.push(
      taskProgress(s.sessionId, "a1", { usage: { total_tokens: 2, tool_uses: 1, duration_ms: 2 } }),
    );
    await new Promise((r) => setTimeout(r, 50));

    await s.agent.closeSession({ sessionId: s.sessionId });
    const count = s.tasksSnapshots().length;
    await new Promise((r) => setTimeout(r, 1_300));

    expect(s.tasksSnapshots().length).toBe(count);
  });
});
