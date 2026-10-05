// Story 022, task 1.2 — the session loop hands the tool call's description to the task feed,
// and holds quick foreground shells out of `_claude/tasks` (R2.1, R2.3, R2.5, R2.6).
//
// Sessions are created by the real `newSession` over a scripted SDK query (task-feed-harness.ts);
// assertions read the wire payload only. The Bash tool_use reaches the session as an assistant
// message, exactly as the SDK streams it, so the tool description comes from the session's own
// tool-use cache.

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent, TASKS_META_KEY } from "../acp-agent.js";
import {
  idle,
  lastScriptedQuery,
  result,
  running,
  taskNotification,
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

const COMMAND = "cat > f.json <<'EOF'\n{\"a\": 1}\nEOF";

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

function bashToolResult(sessionId: string, toolUseId: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function taskUpdated(sessionId: string, taskId: string, patch: Record<string, unknown>) {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

async function startSession() {
  const published: Record<string, any>[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      const meta = notification.update._meta as Record<string, any> | undefined;
      if (notification.update.sessionUpdate !== "session_info_update" || !meta) return;
      if (meta[TASKS_META_KEY]) published.push(meta[TASKS_META_KEY]);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
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

  const find = (id: string) =>
    published.flatMap((snapshot) => snapshot.tasks).filter((t: any) => t.id === id);

  return { sessionId, query, published, turn, find };
}

describe("task_started — the tool call's description labels a shell (R2.5)", () => {
  it("publishes a background Bash under its tool description, not its command line", async () => {
    const s = await startSession();
    await s.turn(
      bashToolUse(s.sessionId, "toolu_bg", {
        command: COMMAND,
        description: "Write the fixture file",
        run_in_background: true,
      }),
      taskStarted(s.sessionId, "b1", {
        tool_use_id: "toolu_bg",
        description: COMMAND,
        task_type: "local_bash",
        is_backgrounded: true,
      }),
    );
    await waitFor(() => s.find("b1").length > 0, "b1 published");
    for (const task of s.find("b1")) {
      expect(task.description).toBe("Write the fixture file");
    }
    expect(JSON.stringify(s.published)).not.toContain("<<'EOF'");
  });

  // Hostile (wrong collapse): two shells in one turn keep their own tool descriptions; a
  // task whose tool_use_id names no cached tool call, or whose description is not a string,
  // keeps the SDK's description (R2.6).
  it("gives each shell its own tool call's description and falls back when there is none", async () => {
    const s = await startSession();
    await s.turn(
      bashToolUse(s.sessionId, "toolu_one", {
        command: "sleep 30",
        description: "First wait",
        run_in_background: true,
      }),
      bashToolUse(s.sessionId, "toolu_two", {
        command: "sleep 40",
        description: "Second wait",
        run_in_background: true,
      }),
      bashToolUse(s.sessionId, "toolu_odd", {
        command: "sleep 50",
        description: 42,
        run_in_background: true,
      }),
      taskStarted(s.sessionId, "b2", {
        tool_use_id: "toolu_two",
        description: "sleep 40",
        is_backgrounded: true,
      }),
      taskStarted(s.sessionId, "b1", {
        tool_use_id: "toolu_one",
        description: "sleep 30",
        is_backgrounded: true,
      }),
      taskStarted(s.sessionId, "b3", {
        tool_use_id: "toolu_unknown",
        description: "sleep 60",
        is_backgrounded: true,
      }),
      taskStarted(s.sessionId, "b4", {
        tool_use_id: "toolu_odd",
        description: "sleep 50",
        is_backgrounded: true,
      }),
    );
    await waitFor(
      () => ["b1", "b2", "b3", "b4"].every((id) => s.find(id).length > 0),
      "all four published",
    );
    expect(s.find("b1").at(-1).description).toBe("First wait");
    expect(s.find("b2").at(-1).description).toBe("Second wait");
    expect(s.find("b3").at(-1).description).toBe("sleep 60");
    expect(s.find("b4").at(-1).description).toBe("sleep 50");
  });

  // The cache entry is pruned at tool_result: the description must be read at task_started.
  it("keeps the tool description of a foreground shell backgrounded after its tool_result", async () => {
    const s = await startSession();
    await s.turn(
      bashToolUse(s.sessionId, "toolu_fg", {
        command: "make release",
        description: "Build the release",
      }),
      taskStarted(s.sessionId, "f1", {
        tool_use_id: "toolu_fg",
        description: "make release",
        is_backgrounded: false,
      }),
      bashToolResult(s.sessionId, "toolu_fg"),
      taskUpdated(s.sessionId, "f1", { is_backgrounded: true }),
    );
    await waitFor(() => s.find("f1").length > 0, "f1 published once backgrounded");
    for (const task of s.find("f1")) {
      expect(task.description).toBe("Build the release");
    }
  });
});

describe("task_started — a quick foreground shell is never published (R2.1, R2.4)", () => {
  it("publishes nothing for a foreground shell that ends in the same turn", async () => {
    const s = await startSession();
    await s.turn(
      bashToolUse(s.sessionId, "toolu_quick", { command: "ls", description: "List files" }),
      taskStarted(s.sessionId, "f1", { tool_use_id: "toolu_quick", is_backgrounded: false }),
      taskNotification(s.sessionId, "f1"),
      // A background shell after it: its snapshot is the fence proving the feed was published.
      taskStarted(s.sessionId, "fence", { is_backgrounded: true }),
    );
    await waitFor(() => s.find("fence").length > 0, "the fence published");
    expect(s.find("f1")).toEqual([]);
  });
});
