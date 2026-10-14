// The changes that must ride the SDK 0.3.285 -> 0.3.296 bump (parity report 21.1, item 86).
//
// - Upstream #1271: from SDK 0.3.292 every task_* event carries a `run_id`. A resumed task keeps
//   its `task_id` and gets a new run, so a queued frame of the finished run can arrive after the
//   resume; applied, it would end the new run. Such a frame is dropped.
// - Upstream #1271/#1330: the bundled CLI accepts input aliases (Grep `file_path`, `-l`/`-c`,
//   Bash `command_description`), plus Agent `effort` and WebFetch `offset`, while the streamed
//   tool_use keeps the spelling the model sent. Titles and descriptions read them the way the CLI
//   validates them, the canonical key winning when both are present.
//
// Sessions are created by the real `newSession` over a scripted SDK query (task-feed-harness.ts).

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent, TASKS_META_KEY } from "../acp-agent.js";
import { toolInfoFromToolUse } from "../tools.js";
import {
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

function bashToolUse(sessionId: string, toolUseId: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: {
      id: `msg_${toolUseId}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function taskUpdated(
  sessionId: string,
  taskId: string,
  patch: Record<string, unknown>,
  runId?: string,
) {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch,
    ...(runId !== undefined ? { run_id: runId } : {}),
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

async function startSession() {
  const published: Record<string, any>[] = [];
  const logs: string[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      const meta = notification.update._meta as Record<string, any> | undefined;
      if (notification.update.sessionUpdate !== "session_info_update" || !meta) return;
      if (meta[TASKS_META_KEY]) published.push(meta[TASKS_META_KEY]);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: () => {},
  });
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const query = lastScriptedQuery();

  async function turn(...messages: unknown[]) {
    const response = agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    query.out.push(running(sessionId));
    for (const message of messages) query.out.push(message);
    query.out.push(result(sessionId));
    query.out.push(idle(sessionId));
    return response;
  }

  const latest = (id: string) =>
    published
      .flatMap((snapshot) => snapshot.tasks)
      .filter((t: any) => t.id === id)
      .at(-1);

  return { agent, sessionId, published, logs, turn, latest };
}

describe("a late frame of an earlier task run is dropped (upstream #1271)", () => {
  it("keeps the resumed run live when the finished run's notification arrives late", async () => {
    const s = await startSession();
    await s.turn(
      taskStarted(s.sessionId, "b1", { run_id: "run-2" }),
      taskNotification(s.sessionId, "b1", { run_id: "run-1" }),
      taskUpdated(s.sessionId, "b1", { status: "completed" }, "run-1"),
      taskProgress(s.sessionId, "b1", { run_id: "run-1" }),
      // A fence after the late frames: once it is published, they were processed.
      taskStarted(s.sessionId, "fence", { run_id: "run-1" }),
    );
    await waitFor(() => s.latest("fence") !== undefined, "the fence published");
    expect(s.latest("b1")?.status).toBe("running");
    expect(s.agent.sessions[s.sessionId]?.liveBackgroundTasks.has("b1")).toBe(true);
    const dropped = s.logs.filter((line) => line.startsWith("[task/late-run]"));
    expect(dropped).toEqual([
      "[task/late-run] dropped=task_notification task=b1 run=run-1",
      "[task/late-run] dropped=task_updated task=b1 run=run-1",
      "[task/late-run] dropped=task_progress task=b1 run=run-1",
    ]);
  });

  it("still ends the current run, and never drops a frame without a run_id", async () => {
    const s = await startSession();
    await s.turn(
      taskStarted(s.sessionId, "b1", { run_id: "run-2" }),
      taskNotification(s.sessionId, "b1", { run_id: "run-2" }),
      taskStarted(s.sessionId, "b2"),
      taskNotification(s.sessionId, "b2"),
    );
    await waitFor(
      () => s.latest("b1")?.status === "completed" && s.latest("b2")?.status === "completed",
      "both ended",
    );
    expect(s.logs.filter((line) => line.startsWith("[task/late-run]"))).toEqual([]);
  });
});

describe("CLI input aliases (upstream #1271, #1330)", () => {
  const title = (name: string, input: Record<string, unknown>) =>
    toolInfoFromToolUse({ id: "toolu_1", name, input }).title;

  it("reads the Grep file_path alias like path, the canonical key winning", () => {
    expect(title("Grep", { pattern: "a", file_path: "/work/src" })).toBe('grep "a" /work/src');
    expect(title("Grep", { pattern: "a", path: "/p", file_path: "/f" })).toBe('grep "a" /p');
  });

  it("reads Grep -l and -c as the output mode when output_mode is unset", () => {
    expect(title("Grep", { pattern: "a", "-l": true })).toBe('grep -l "a"');
    expect(title("Grep", { pattern: "a", "-c": "true" })).toBe('grep -c "a"');
    expect(title("Grep", { pattern: "a", "-l": "yes" })).toBe('grep "a"');
    expect(title("Grep", { pattern: "a", output_mode: "content", "-l": true })).toBe('grep "a"');
  });

  it("shows a Bash command_description, the canonical description winning", () => {
    const content = (input: Record<string, unknown>) =>
      toolInfoFromToolUse({ id: "toolu_1", name: "Bash", input }).content;
    expect(content({ command: "ls", command_description: "List files" })).toEqual([
      { type: "content", content: { type: "text", text: "List files" } },
    ]);
    expect(
      content({ command: "ls", description: "Canonical", command_description: "Alias" }),
    ).toEqual([{ type: "content", content: { type: "text", text: "Canonical" } }]);
  });

  it("shows a requested Agent effort and a WebFetch offset in the title", () => {
    expect(title("Agent", { description: "Explore", prompt: "Inspect", effort: "high" })).toBe(
      "Explore (high effort)",
    );
    expect(title("Agent", { description: "Explore", prompt: "Inspect" })).toBe("Explore");
    expect(title("WebFetch", { url: "https://e.com", prompt: "p", offset: 100000 })).toBe(
      "Fetch https://e.com (from char 100000)",
    );
    expect(title("WebFetch", { url: "https://e.com", prompt: "p" })).toBe("Fetch https://e.com");
  });

  it("labels a background shell task with its command_description", async () => {
    const s = await startSession();
    await s.turn(
      bashToolUse(s.sessionId, "toolu_bg", {
        command: "sleep 30",
        command_description: "Wait a while",
        run_in_background: true,
      }),
      taskStarted(s.sessionId, "b1", { tool_use_id: "toolu_bg", description: "sleep 30" }),
    );
    await waitFor(() => s.latest("b1") !== undefined, "b1 published");
    expect(s.latest("b1")?.description).toBe("Wait a while");
  });
});
