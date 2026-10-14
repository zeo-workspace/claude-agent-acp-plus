// Parity item 92 (upstream #1312): the display terminal of a command sent to the
// background keeps running until the command's task ends.
//
// A Bash call with `run_in_background` returns as soon as the command detaches.
// Its tool result used to carry `terminal_exit` (code 0), so a client that
// renders terminals showed the command as exited at launch while it still ran.
// Now the exit is withheld while the task is live and sent when the task ends,
// with the code Claude Code's summary names when it names one.
//
// Runs a real session over the scripted SDK query; assertions read only what
// reaches the client.

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
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

function bashToolUse(sessionId: string, toolUseId: string, parent: string | null = null) {
  return {
    type: "assistant",
    message: {
      id: `msg_${toolUseId}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "sleep 5; exit 3", run_in_background: true, description: "Wait" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function bashBackgroundResult(
  sessionId: string,
  toolUseId: string,
  taskId: string,
  parent: string | null = null,
) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [
            {
              type: "text",
              text: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output`,
            },
          ],
        },
      ],
    },
    tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: taskId },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

const taskUpdated = (sessionId: string, taskId: string, patch: Record<string, unknown>) => ({
  type: "system",
  subtype: "task_updated",
  task_id: taskId,
  patch,
  uuid: randomUUID(),
  session_id: sessionId,
});

async function startSession(terminalOutput = true) {
  const updates: SessionNotification[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(JSON.parse(JSON.stringify(notification)));
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: terminalOutput ? { _meta: { terminal_output: true } } : {},
  });
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
  const exits = (toolCallId: string) =>
    updates
      .map((n) => n.update as any)
      .filter((u) => u.toolCallId === toolCallId && u._meta?.terminal_exit)
      .map((u) => u._meta);
  const completed = (toolCallId: string) =>
    updates.some(
      (n) =>
        (n.update as any).toolCallId === toolCallId && (n.update as any).status === "completed",
    );
  return { agent, sessionId, query, updates, turn, exits, completed };
}

/** Starts background shell `taskId` (tool call `toolu_<taskId>`), task live at the result. */
async function backgroundShell(s: Awaited<ReturnType<typeof startSession>>, taskId: string) {
  const toolUseId = `toolu_${taskId}`;
  await s.turn(
    bashToolUse(s.sessionId, toolUseId),
    taskStarted(s.sessionId, taskId, { tool_use_id: toolUseId }),
    bashBackgroundResult(s.sessionId, toolUseId, taskId),
  );
  return toolUseId;
}

describe("a backgrounded command's terminal (item 92, upstream #1312)", () => {
  it("does not exit at launch; exits with the code the summary names when the task fails", async () => {
    const s = await startSession();
    const id = await backgroundShell(s, "b1");
    expect(s.completed(id)).toBe(true);
    expect(s.exits(id)).toEqual([]);

    s.query.out.push(
      taskNotification(s.sessionId, "b1", {
        tool_use_id: id,
        status: "failed",
        summary: 'Background command "Wait" failed with exit code 3',
      }),
    );
    await waitFor(() => s.exits(id).length > 0, "b1's exit");
    expect(s.exits(id)).toEqual([
      { terminal_exit: { terminal_id: id, exit_code: 3, signal: null } },
    ]);
  });

  it("exits with 0 when the summary says the command completed with code 0", async () => {
    const s = await startSession();
    const id = await backgroundShell(s, "b2");
    s.query.out.push(
      taskNotification(s.sessionId, "b2", {
        status: "completed",
        summary: 'Background command "Wait" completed (exit code 0)',
      }),
    );
    await waitFor(() => s.exits(id).length > 0, "b2's exit");
    expect(s.exits(id)[0].terminal_exit.exit_code).toBe(0);
  });

  it("sends no code for a non-zero code Claude Code accepted as a success", async () => {
    const s = await startSession();
    const id = await backgroundShell(s, "b3");
    s.query.out.push(
      taskNotification(s.sessionId, "b3", {
        status: "completed",
        summary: 'Background command "Wait" completed (exit code 1: No matches found)',
      }),
    );
    await waitFor(() => s.exits(id).length > 0, "b3's exit");
    expect(s.exits(id)[0].terminal_exit.exit_code).toBeNull();
  });

  it("never sends null for a failure whose code is not named", async () => {
    const s = await startSession();
    const id = await backgroundShell(s, "b4");
    s.query.out.push(
      taskNotification(s.sessionId, "b4", { status: "failed", summary: "something broke" }),
    );
    await waitFor(() => s.exits(id).length > 0, "b4's exit");
    expect(s.exits(id)[0].terminal_exit.exit_code).toBe(1);
  });

  it("exits at the terminal task_updated when it comes first, and only once", async () => {
    const s = await startSession();
    const id = await backgroundShell(s, "b5");
    s.query.out.push(taskUpdated(s.sessionId, "b5", { status: "failed", end_time: 1 }));
    s.query.out.push(
      taskNotification(s.sessionId, "b5", {
        status: "failed",
        summary: 'Background command "Wait" failed with exit code 3',
      }),
    );
    await waitFor(() => s.exits(id).length > 0, "b5's exit");
    // Let the notification be processed too.
    await new Promise((r) => setTimeout(r, 50));
    expect(s.exits(id)).toHaveLength(1);
    expect(s.exits(id)[0].terminal_exit.exit_code).toBe(1);
  });

  it("exits at the result, with no code, when the task already ended (a fast command)", async () => {
    const s = await startSession();
    const id = "toolu_b6";
    await s.turn(
      bashToolUse(s.sessionId, id),
      taskStarted(s.sessionId, "b6", { tool_use_id: id }),
      taskNotification(s.sessionId, "b6", { tool_use_id: id, status: "completed" }),
      bashBackgroundResult(s.sessionId, id, "b6"),
    );
    expect(s.exits(id).map((m: any) => m.terminal_exit)).toEqual([
      { terminal_id: id, exit_code: null, signal: null },
    ]);
  });

  it("routes a subagent's command exit under the subagent's parent tool call", async () => {
    const s = await startSession();
    const id = "toolu_b7";
    await s.turn(
      bashToolUse(s.sessionId, id, "toolu_agent"),
      taskStarted(s.sessionId, "b7", { tool_use_id: id }),
      bashBackgroundResult(s.sessionId, id, "b7", "toolu_agent"),
    );
    expect(s.exits(id)).toEqual([]);
    s.query.out.push(taskNotification(s.sessionId, "b7", { status: "stopped", summary: "" }));
    await waitFor(() => s.exits(id).length > 0, "b7's exit");
    expect(s.exits(id)[0]).toEqual({
      claudeCode: { parentToolUseId: "toolu_agent" },
      terminal_exit: { terminal_id: id, exit_code: 1, signal: null },
    });
  });

  it("sends no terminal exit at all to a client that does not render terminals", async () => {
    const s = await startSession(false);
    const id = await backgroundShell(s, "b8");
    s.query.out.push(taskNotification(s.sessionId, "b8", { status: "failed", summary: "" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.exits(id)).toEqual([]);
  });
});

describe("backgroundExitCode", () => {
  it("reads a code only at the end of the summary, not inside the description", async () => {
    const { backgroundExitCode } = await import("../acp-agent.js");
    expect(
      backgroundExitCode(
        "completed",
        'Background command "exit code 5 probe" completed (exit code 0)',
      ),
    ).toBe(0);
    expect(
      backgroundExitCode("failed", 'Background command "failed with exit code 3" failed'),
    ).toBe(1);
    expect(backgroundExitCode("failed", undefined)).toBe(1);
    expect(backgroundExitCode("killed", undefined)).toBe(1);
    expect(backgroundExitCode("completed", undefined)).toBeNull();
    expect(
      backgroundExitCode(
        "completed",
        'Background command "x" completed (exit code 2: Files differ)',
      ),
    ).toBeNull();
  });
});
