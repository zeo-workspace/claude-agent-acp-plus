/**
 * Scripted SDK query for the task-feed suites (story 012).
 *
 * `scriptedQuery` stands in for the SDK's `query()`: it echoes every pushed user
 * message (so a prompt is promoted to a turn) and otherwise yields whatever the
 * test pushes onto `out`. Sessions are therefore built by the real
 * `newSession`, so whatever a session owns for its task feed is created by
 * production code, not by a test double.
 *
 * Deliberately vitest-free, like `helpers.ts`, so a `vi.mock` factory can
 * `await import` it.
 */

import { randomUUID } from "crypto";
import { Pushable } from "../utils.js";

export type ScriptedQuery = {
  out: Pushable<any>;
  stopTaskCalls: string[];
  backgroundTasksCalls: (string | undefined)[];
  /** What `stopTask()` does after recording the call; a test replaces it to throw. */
  stopTaskImpl: (taskId: string) => Promise<void>;
  /** What `backgroundTasks()` does; a test replaces it to answer false or throw. */
  backgroundTasksImpl: (toolUseId?: string) => Promise<boolean>;
  closed: boolean;
};

/** Every query the mocked SDK has created, oldest first. */
export const scriptedQueries: ScriptedQuery[] = [];

export function lastScriptedQuery(): ScriptedQuery {
  const q = scriptedQueries.at(-1);
  if (!q) throw new Error("no scripted query was created");
  return q;
}

export function scriptedQuery({ prompt }: { prompt: AsyncIterable<any> }) {
  const out = new Pushable<any>();
  const state: ScriptedQuery = {
    out,
    stopTaskCalls: [],
    backgroundTasksCalls: [],
    stopTaskImpl: async () => {},
    backgroundTasksImpl: async () => true,
    closed: false,
  };
  scriptedQueries.push(state);

  void (async () => {
    for await (const u of prompt) {
      out.push({
        type: "user",
        message: u.message,
        parent_tool_use_id: null,
        uuid: u.uuid,
        session_id: "scripted",
        isReplay: true,
      });
    }
  })();

  async function* stream() {
    for await (const message of out) yield message;
  }

  return Object.assign(stream(), {
    initializationResult: async () => ({
      models: [{ value: "id", displayName: "name", description: "d", supportsAutoMode: true }],
    }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    applyFlagSettings: async () => undefined,
    supportedCommands: async () => [],
    getContextUsage: async () => ({ totalTokens: 0, rawMaxTokens: 200000 }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({}),
    interrupt: async () => undefined,
    close: () => {
      state.closed = true;
      out.end();
    },
    stopTask: async (taskId: string) => {
      state.stopTaskCalls.push(taskId);
      return state.stopTaskImpl(taskId);
    },
    backgroundTasks: async (toolUseId?: string) => {
      state.backgroundTasksCalls.push(toolUseId);
      return state.backgroundTasksImpl(toolUseId);
    },
  });
}

// ---- SDK message builders ---------------------------------------------------

export const running = (sessionId: string) => ({
  type: "system",
  subtype: "session_state_changed",
  state: "running",
  uuid: randomUUID(),
  session_id: sessionId,
});

export const idle = (sessionId: string) => ({
  type: "system",
  subtype: "session_state_changed",
  state: "idle",
  uuid: randomUUID(),
  session_id: sessionId,
});

export const result = (sessionId: string) => ({
  type: "result",
  subtype: "success",
  stop_reason: "end_turn",
  is_error: false,
  result: "",
  errors: [],
  duration_ms: 0,
  duration_api_ms: 0,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
  uuid: randomUUID(),
  session_id: sessionId,
});

export const taskStarted = (
  sessionId: string,
  taskId: string,
  fields: Record<string, unknown> = {},
) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  description: `Task ${taskId}`,
  task_type: "local_bash",
  is_backgrounded: true,
  uuid: randomUUID(),
  session_id: sessionId,
  ...fields,
});

export const taskProgress = (
  sessionId: string,
  taskId: string,
  fields: Record<string, unknown> = {},
) => ({
  type: "system",
  subtype: "task_progress",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  description: `Task ${taskId}`,
  usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
  uuid: randomUUID(),
  session_id: sessionId,
  ...fields,
});

export const taskNotification = (
  sessionId: string,
  taskId: string,
  fields: Record<string, unknown> = {},
) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  status: "completed",
  output_file: "",
  summary: `Task ${taskId} done`,
  uuid: randomUUID(),
  session_id: sessionId,
  ...fields,
});

export const backgroundTasksChanged = (
  sessionId: string,
  tasks: { task_id: string; ambient?: boolean }[],
) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: tasks.map((task) => ({ task_type: "local_bash", description: "sleep", ...task })),
  uuid: randomUUID(),
  session_id: sessionId,
});

/** Poll until `cond` holds, yielding to the event loop between checks. */
export async function waitFor(cond: () => boolean, what = "condition", timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${what}`);
}
