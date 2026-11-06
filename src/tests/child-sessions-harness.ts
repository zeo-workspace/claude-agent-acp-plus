/**
 * Story 065 — shared fixture for the child-session suites (child-sessions*.test.ts).
 *
 * A session is built by the real `initialize` + `newSession` over the scripted
 * SDK query of task-feed-harness.ts, so whatever routes subagent traffic is
 * production code. The client records every `session/update` and every
 * `session/request_permission` in arrival order; assertions read only what
 * crossed that boundary.
 *
 * The SDK messages below are shaped the way the bundled CLI streams them: an
 * Agent `tool_use` on the parent (`parent_tool_use_id: null`), then
 * `task_started` whose `task_id` is the subagent's agent id (the same id
 * `canUseTool` receives as `agentID`, and the name of its transcript
 * `subagents/agent-<id>.jsonl`), then the subagent's own messages stamped with
 * `parent_tool_use_id` = the Agent call's id.
 *
 * Deliberately vitest-free, like helpers.ts, so a `vi.mock` factory can
 * `await import` it.
 */

import { randomUUID } from "crypto";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  lastScriptedQuery,
  scriptedQuery,
  type ScriptedQuery,
  waitFor,
} from "./task-feed-harness.js";

// ---- the mocked SDK `query()` ------------------------------------------------

/** One query the mocked SDK created: its script, the options the agent passed
 *  (`canUseTool` among them), and how often the agent interrupted it. */
export type CapturedQuery = {
  script: ScriptedQuery;
  options: Record<string, any>;
  interrupts: number;
};

export const capturedQueries: CapturedQuery[] = [];

/** Stands in for the SDK's `query()`: task-feed-harness's scripted query, with
 *  its options kept and `interrupt()` counted (an interrupt is what cancels
 *  the parent's turn, so a child cancel must not send one). */
export function capturingQuery(args: { prompt: AsyncIterable<any>; options?: any }) {
  const q = scriptedQuery(args) as any;
  const captured: CapturedQuery = {
    script: lastScriptedQuery(),
    options: args.options ?? {},
    interrupts: 0,
  };
  capturedQueries.push(captured);
  q.interrupt = async () => {
    captured.interrupts += 1;
    return undefined;
  };
  return q;
}

/** The query the mocked SDK created last. */
export function lastCaptured(): CapturedQuery {
  const q = capturedQueries.at(-1);
  if (!q) throw new Error("no query was created");
  return q;
}

// ---- the recording client ------------------------------------------------------

export type PendingPermission = {
  params: RequestPermissionRequest;
  answer: (response: RequestPermissionResponse) => void;
};

export function recordingClient() {
  const updates: SessionNotification[] = [];
  const permissions: PendingPermission[] = [];
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    requestPermission: (params: RequestPermissionRequest) =>
      new Promise<RequestPermissionResponse>((answer) => permissions.push({ params, answer })),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  };
  return { client, updates, permissions };
}

export type LogLines = { lines: string[]; logger: { log: any; error: any } };

export function recordingLogger(): LogLines {
  const lines: string[] = [];
  const record = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, logger: { log: record, error: record } };
}

// ---- reading the wire ------------------------------------------------------------

type Update = SessionNotification["update"] & Record<string, any>;

export const kind = (n: SessionNotification) => (n.update as Update).sessionUpdate as string;

/** Every `subagent_update` the agent sent, in order. */
export const subagentUpdates = (updates: SessionNotification[]) =>
  updates.filter((n) => kind(n) === "subagent_update");

/** The child session ids announced on `parentId`, in announcement order, once each. */
export function announcedChildren(updates: SessionNotification[], parentId: string): string[] {
  const ids: string[] = [];
  for (const n of subagentUpdates(updates)) {
    if (n.sessionId !== parentId) continue;
    const id = (n.update as Update).sessionId as string;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The first `subagent_update` that names `childId`. */
export const announcement = (updates: SessionNotification[], childId: string) =>
  subagentUpdates(updates).find((n) => (n.update as Update).sessionId === childId);

/** The `state` objects reported for `childId`, in order (updates without one skipped). */
export const statesOf = (updates: SessionNotification[], childId: string) =>
  subagentUpdates(updates)
    .filter((n) => (n.update as Update).sessionId === childId && (n.update as Update).state)
    .map((n) => (n.update as Update).state as Record<string, unknown>);

/** Notifications that carry a tool call (`tool_call` or `tool_call_update`) with this id. */
export const toolCallNotifications = (updates: SessionNotification[], toolCallId: string) =>
  updates.filter(
    (n) =>
      (kind(n) === "tool_call" || kind(n) === "tool_call_update") &&
      (n.update as Update).toolCallId === toolCallId,
  );

/** The text of every agent message chunk sent on `sessionId`, joined. */
export const agentTextOn = (updates: SessionNotification[], sessionId: string) =>
  updates
    .filter((n) => n.sessionId === sessionId && kind(n) === "agent_message_chunk")
    .map((n) => ((n.update as Update).content?.text as string | undefined) ?? "")
    .join("");

// ---- SDK message builders ----------------------------------------------------------

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** An assistant message; `parent` is the Agent call a subagent's message belongs to. */
export function assistant(sessionId: string, content: unknown[], parent: string | null = null) {
  return {
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

export function toolResult(
  sessionId: string,
  toolUseId: string,
  text: string,
  parent: string | null = null,
) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }],
    },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

export type Launch = {
  /** The Agent call's tool use id. */
  toolUseId: string;
  /** The SDK agent id: `task_started.task_id`. */
  agentId: string;
  description: string;
  prompt?: string;
  name?: string;
  subagentType?: string;
  background?: boolean;
};

export const agentToolUse = (launch: Launch) => ({
  type: "tool_use",
  id: launch.toolUseId,
  name: "Agent",
  input: {
    description: launch.description,
    ...(launch.prompt !== undefined ? { prompt: launch.prompt } : {}),
    ...(launch.name ? { name: launch.name } : {}),
    subagent_type: launch.subagentType ?? "general-purpose",
    ...(launch.background ? { run_in_background: true } : {}),
  },
});

export const agentStarted = (sessionId: string, launch: Launch) => ({
  type: "system",
  subtype: "task_started",
  task_id: launch.agentId,
  tool_use_id: launch.toolUseId,
  description: launch.description,
  subagent_type: launch.subagentType ?? "general-purpose",
  task_type: "local_agent",
  is_backgrounded: launch.background ?? false,
  ...(launch.prompt !== undefined ? { prompt: launch.prompt } : {}),
  uuid: randomUUID(),
  session_id: sessionId,
});

export const agentEnded = (
  sessionId: string,
  launch: Launch,
  status: "completed" | "failed" | "stopped" = "completed",
) => ({
  type: "system",
  subtype: "task_notification",
  task_id: launch.agentId,
  tool_use_id: launch.toolUseId,
  status,
  output_file: "",
  summary: `${launch.description}: ${status}`,
  uuid: randomUUID(),
  session_id: sessionId,
});

export const readToolUse = (id: string, filePath = "/tmp/rfd-fixture.txt") => ({
  type: "tool_use",
  id,
  name: "Read",
  input: { file_path: filePath },
});

/** Poll until `cond` holds; re-exported so suites import one module. */
export { waitFor };

/** Resolves on the next macrotask: lets the session loop drain pushed messages. */
export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
