// Regressions found by the story 012 tech review of the acp-agent.ts wiring:
// a session whose CLI process is gone retires its feed (running tasks go out
// as interrupted, nothing is sent afterwards), task actions refuse an ended
// session, and client-supplied ids cannot forge a log field.

import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent, TASKS_META_KEY } from "../acp-agent.js";
import {
  idle,
  lastScriptedQuery,
  result,
  running,
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

async function sessionWithRunningTask() {
  const snapshots: any[] = [];
  const lines: string[] = [];
  const client = {
    sessionUpdate: async (n: SessionNotification) => {
      const meta = n.update._meta as Record<string, any> | undefined;
      if (n.update.sessionUpdate === "session_info_update" && meta?.[TASKS_META_KEY]) {
        snapshots.push(meta[TASKS_META_KEY]);
      }
    },
  } as unknown as AcpClient;
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  const agent = new ClaudeAcpAgent(client, { log: push, error: push });
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const query = lastScriptedQuery();
  const response = agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
  query.out.push(running(sessionId));
  query.out.push(taskStarted(sessionId, "b1"));
  query.out.push(result(sessionId));
  query.out.push(idle(sessionId));
  await response;
  await waitFor(() => snapshots.length > 0, "the running snapshot");
  return { agent, sessionId, query, snapshots, lines };
}

describe("task feed — the session's process ends", () => {
  it("publishes running tasks as interrupted when the stream ends, then sends nothing", async () => {
    const s = await sessionWithRunningTask();

    s.query.out.end();
    await waitFor(
      () => s.snapshots.some((snap) => snap.tasks.some((t: any) => t.status === "interrupted")),
      "an interrupted snapshot",
    );
    const count = s.snapshots.length;
    await new Promise((r) => setTimeout(r, 2_500));

    expect(s.snapshots.length).toBe(count);
  });

  it("refuses a task action on a session whose stream ended", async () => {
    const s = await sessionWithRunningTask();
    s.query.out.end();
    await waitFor(() => (s.agent as any).sessions[s.sessionId]?.queryClosed === true, "closed");

    const stop = await s.agent.stopTask({ sessionId: s.sessionId, taskId: "b1" }).catch((e) => e);
    const background = await s.agent
      .backgroundTask({ sessionId: s.sessionId, toolCallId: "toolu_b1" })
      .catch((e) => e);

    expect(stop?.code).toBe(-32603);
    expect(background?.code).toBe(-32603);
    expect(s.query.stopTaskCalls).toEqual([]);
    expect(s.query.backgroundTasksCalls).toEqual([]);
  });
});

describe("task actions — log fields", () => {
  it("cannot be forged by an id carrying a space or an equals sign", async () => {
    const s = await sessionWithRunningTask();

    await s.agent.stopTask({ sessionId: s.sessionId, taskId: "x outcome=ok" }).catch(() => {});

    const line = s.lines.find((l) => l.includes("[tasks/action]"))!;
    expect(line).toContain("outcome=error");
    expect(line.match(/outcome=/g)).toHaveLength(1);
  });
});
