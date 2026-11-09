// F1 of the Zeo next proposal (docs/ZEO-NEXT-PROPOSAL.md §5.1): plus sent its
// task list as a legacy `plan`, and Zed drops a legacy plan's completed entries
// when the next message is sent — so a fully completed plan vanished at the
// next turn. Keyed `plan_update` plans (zed#66345) are never pruned.
//
// When the client advertises `clientCapabilities.plan`, the list now goes out
// as `plan_update{ plan: { type: "items", planId: "plan" } }` — upstream's gate
// (`supportsPlanOperations`) and id (`SESSION_PLAN_ID`). A list starts over
// when a TaskCreate arrives and every entry is completed.

import { describe, expect, it } from "vitest";
import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk/unstable";
import {
  AcpClient,
  ClaudeAcpAgent,
  Logger,
  toAcpNotifications,
  ToolUseCache,
} from "../acp-agent.js";
import { applyTaskCreate, applyTaskList, applyTaskUpdate, TaskState } from "../tools.js";
import { planSessionUpdate, SESSION_PLAN_ID, supportsPlanOperations } from "../keyed-plan.js";

const mockClient = {} as AcpClient;
const mockLogger: Logger = { log: () => {}, error: () => {} };
const KEYED: ClientCapabilities = { plan: {} };

/** A TaskCreate tool_use followed by its tool_result, through the converter. */
function createTask(
  taskState: TaskState,
  id: string,
  subject: string,
  clientCapabilities?: ClientCapabilities,
) {
  const toolUseCache: ToolUseCache = {};
  toAcpNotifications(
    [
      { type: "tool_use", id: `u${id}`, name: "TaskCreate", input: { subject, description: "" } },
    ] as any,
    "assistant",
    "test-session",
    toolUseCache,
    mockClient,
    mockLogger,
    { taskState, clientCapabilities },
  );
  return toAcpNotifications(
    [
      {
        type: "tool_result",
        tool_use_id: `u${id}`,
        content: JSON.stringify({ task: { id, subject } }),
        is_error: false,
      },
    ] as any,
    "user",
    "test-session",
    toolUseCache,
    mockClient,
    mockLogger,
    { taskState, clientCapabilities },
  );
}

describe("supportsPlanOperations", () => {
  it("is the presence of clientCapabilities.plan", () => {
    expect(supportsPlanOperations(KEYED)).toBe(true);
    expect(supportsPlanOperations({})).toBe(false);
    expect(supportsPlanOperations(undefined)).toBe(false);
  });
});

describe("planSessionUpdate", () => {
  const entries = [{ content: "A", status: "pending" as const, priority: "medium" as const }];

  it("is a keyed items plan when the client supports plan operations", () => {
    expect(planSessionUpdate(entries, true)).toEqual({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: SESSION_PLAN_ID, entries },
    });
    expect(SESSION_PLAN_ID).toBe("plan");
  });

  it("stays the legacy plan otherwise", () => {
    expect(planSessionUpdate(entries, false)).toEqual({ sessionUpdate: "plan", entries });
  });
});

describe("toAcpNotifications — the Task* plan follows the capability", () => {
  it("sends a keyed plan_update to a client that advertises plan", () => {
    const [update] = createTask(new Map(), "1", "First", KEYED).map((n) => n.update);
    expect(update).toMatchObject({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "plan", entries: [{ content: "First", status: "pending" }] },
    });
  });

  it("keeps the legacy plan for a client that does not", () => {
    const [update] = createTask(new Map(), "1", "First").map((n) => n.update);
    expect(update).toMatchObject({ sessionUpdate: "plan", entries: [{ content: "First" }] });
  });

  it("sends TodoWrite as a keyed plan too", () => {
    const notifications = toAcpNotifications(
      [
        {
          type: "tool_use",
          id: "t1",
          name: "TodoWrite",
          input: { todos: [{ content: "Run tests", status: "completed", activeForm: "Running" }] },
        },
      ] as any,
      "assistant",
      "test-session",
      {},
      mockClient,
      mockLogger,
      { clientCapabilities: KEYED },
    );
    expect(notifications.map((n) => n.update)).toEqual([
      expect.objectContaining({
        sessionUpdate: "plan_update",
        plan: expect.objectContaining({ type: "items", planId: "plan" }),
      }),
    ]);
  });
});

describe("a list starts over when a TaskCreate follows a fully completed one", () => {
  function completedList(): TaskState {
    const state: TaskState = new Map();
    applyTaskCreate(
      state,
      { subject: "Old 1", description: "" } as any,
      { task: { id: "1" } } as any,
    );
    applyTaskCreate(
      state,
      { subject: "Old 2", description: "" } as any,
      { task: { id: "2" } } as any,
    );
    applyTaskUpdate(state, { taskId: "1", status: "completed" } as any);
    applyTaskUpdate(state, { taskId: "2", status: "completed" } as any);
    return state;
  }

  it("drops the completed entries before adding the new one", () => {
    const state = completedList();
    applyTaskCreate(
      state,
      { subject: "New", description: "" } as any,
      { task: { id: "3" } } as any,
    );
    expect([...state.keys()]).toEqual(["3"]);
  });

  it("appends while any entry is still open", () => {
    const state = completedList();
    applyTaskUpdate(state, { taskId: "2", status: "in_progress" } as any);
    applyTaskCreate(
      state,
      { subject: "New", description: "" } as any,
      { task: { id: "3" } } as any,
    );
    expect([...state.keys()]).toEqual(["1", "2", "3"]);
  });

  it("is not undone by a TaskList that still lists the finished tasks", () => {
    const state = completedList();
    applyTaskCreate(
      state,
      { subject: "New", description: "" } as any,
      { task: { id: "3" } } as any,
    );
    // The CLI's own store still holds the finished list.
    applyTaskList(state, {
      tasks: [
        { id: "1", subject: "Old 1", status: "completed", blockedBy: [] },
        { id: "2", subject: "Old 2", status: "completed", blockedBy: [] },
        { id: "3", subject: "New", status: "pending", blockedBy: [] },
      ],
    } as any);
    expect([...state.keys()]).toEqual(["3"]);
  });
});

describe("publishTaskPlan — an emptied list removes the keyed plan", () => {
  async function agentWith(clientCapabilities: ClientCapabilities) {
    const updates: SessionNotification["update"][] = [];
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        updates.push(n.update);
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(client, mockLogger);
    await agent.initialize({ protocolVersion: 1, clientCapabilities });
    return { agent, updates };
  }

  it("sends plan_removed for the session plan when the list is empty", async () => {
    const { agent, updates } = await agentWith(KEYED);
    await (agent as any).publishTaskPlan("s1", new Map());
    expect(updates).toEqual([{ sessionUpdate: "plan_removed", planId: "plan" }]);
  });

  it("sends an empty legacy plan to a client without plan operations", async () => {
    const { agent, updates } = await agentWith({});
    await (agent as any).publishTaskPlan("s1", new Map());
    expect(updates).toEqual([{ sessionUpdate: "plan", entries: [] }]);
  });
});
