import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";

/**
 * Story 065 — each Agent-tool subagent as a child session under the ACP
 * subagents RFD (agentclientprotocol/agent-client-protocol#1992).
 *
 * The fork's tool-call conversion is unchanged: a subagent's updates still
 * leave it stamped with `_meta.claudeCode.parentToolUseId`, and `route` only
 * swaps their `sessionId` for the child's. The child's id is the SDK agent id
 * (`task_started.task_id`, the name of its transcript
 * `subagents/agent-<id>.jsonl`), never a fresh one, so a replay or a restore
 * names the same child (design.md, Data Models).
 *
 * Zed `a5c4ca8b`'s v1 client has no early-traffic buffer: a child's traffic
 * before its `subagent_update` is dropped, so `launch` is awaited before the
 * stream that follows `task_started` is converted.
 */

/** Why a child stopped, in the RFD's `IdleStateUpdate.stopReason` vocabulary. */
export type ChildStopReason = "end_turn" | "cancelled" | "error";

type ChildRecord = {
  childId: string;
  /** The session the SDK stream runs on — the root of every nested child. */
  parentSessionId: string;
  /** Where the child is announced and its state reported: the root, or the
   *  child whose agent launched it (`task_started.parent_task_id`). */
  announcedOn: string;
  /** The last state sent, so an unchanged state is not re-sent. */
  state?: "running" | "requires_action" | "idle";
  /** Open permission requests and elicitations on the child. */
  openAsks: number;
  /** Stopped by `session/cancel` and not resumed since. */
  cancelled?: boolean;
  /** Restored from a transcript without being announced on this connection
   *  (a resume): the next launch announces it in full. */
  unannounced?: boolean;
  /** The `cwd` the client holds for the child (upstream #1496): absent while it inherits its
   *  parent's working directory. */
  reportedCwd?: string;
};

/** Hooks can report a child's `cwd` before it is announced; bound what waits for one. */
const MAX_PENDING_CWDS = 64;

export type ChildLaunch = {
  parentSessionId: string;
  /** `task_started.parent_task_id`: the subagent whose agent launched this one, if any. */
  launcherTaskId?: string;
  /** The Agent call's tool use id: what the child's stream names as its parent. */
  toolUseId: string;
  /** The SDK agent id — the child's session id. */
  agentId: string;
  title: string;
  /** The child's role; absent when it is already the title (upstream #1479). */
  description?: string;
  prompt?: string;
  /** True when the SDK can stop this subagent on its own (`Query.stopTask`). */
  cancellable: boolean;
};

type Send = (notification: SessionNotification) => Promise<void>;

/** A subagent's SDK task status mapped onto the RFD's idle stop reason. */
export function childStopReasonOf(status: string | undefined): ChildStopReason | undefined {
  switch (status) {
    case "completed":
      return "end_turn";
    case "failed":
      return "error";
    case "stopped":
    case "killed":
      return "cancelled";
    default:
      return undefined;
  }
}

/** Far above the tool calls one turn keeps in flight; only the oldest, long
 *  finished placements are ever evicted. */
const TOOL_CALL_PLACEMENT_CAP = 4096;

const launchKey = (parentSessionId: string, toolUseId: string) =>
  `${parentSessionId}\0${toolUseId}`;

export class ChildSessionRouter {
  private readonly byChild = new Map<string, ChildRecord>();
  /** Keyed by parent and tool use id: tool use ids are unique only within a session. */
  private readonly byToolUse = new Map<string, ChildRecord>();
  /** Tool calls already placed — on a child, or (`null`) nested in the parent
   *  because they went out before their launch was known. A tool call never
   *  moves once the client has seen it, and an update the conversion did not
   *  stamp (a progress beat, an edit diff) follows its call, even after its
   *  child settled. Keyed like `byToolUse`; bounded by `place`. */
  private readonly toolCalls = new Map<string, string | null>();
  /** A child's working directory reported before its announcement, when it differs from its
   *  parent's. Taken by the announcement. */
  private readonly pendingCwds = new Map<string, string>();

  constructor(
    private readonly send: Send,
    private readonly debug: (line: string) => void,
  ) {}

  isChild(sessionId: string): boolean {
    return this.byChild.has(sessionId);
  }

  /** The parent session a child belongs to. */
  parentOf(childId: string): string | undefined {
    return this.byChild.get(childId)?.parentSessionId;
  }

  /** The child a parent's Agent call launched, if that call launched one. */
  childFor(parentSessionId: string, toolUseId: string | null | undefined): string | undefined {
    if (!toolUseId) return undefined;
    return this.byToolUse.get(launchKey(parentSessionId, toolUseId))?.childId;
  }

  /** The child whose traffic a notification belongs to, if any. */
  private childOf(notification: SessionNotification): string | undefined {
    const update = notification.update as {
      toolCallId?: unknown;
      _meta?: Record<string, unknown> | null;
    };
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    const callKey = toolCallId ? launchKey(notification.sessionId, toolCallId) : undefined;
    if (callKey && this.toolCalls.has(callKey)) return this.toolCalls.get(callKey) ?? undefined;
    const parentToolUseId = (update._meta?.claudeCode as { parentToolUseId?: unknown } | undefined)
      ?.parentToolUseId;
    if (typeof parentToolUseId !== "string") {
      // An unstamped call is the parent's own — or a subagent's, sent before
      // its `task_started` was consumed (`canUseTool` racing the stream).
      // Either way the client saw it on the parent, so it stays there.
      if (callKey && notification.update.sessionUpdate === "tool_call") this.place(callKey, null);
      return undefined;
    }
    const childId = this.childFor(notification.sessionId, parentToolUseId);
    if (!childId) {
      this.debug(
        `[subagents/route] outcome=nested reason=unknown_launch sessionId=${notification.sessionId} parentToolUseId=${parentToolUseId}`,
      );
    }
    if (callKey) this.place(callKey, childId ?? null);
    return childId;
  }

  /** Record where a tool call went; the oldest entries go first past the cap,
   *  so a long connection does not keep every tool call it ever saw. */
  private place(callKey: string, childId: string | null): void {
    this.toolCalls.set(callKey, childId);
    if (this.toolCalls.size > TOOL_CALL_PLACEMENT_CAP) {
      this.toolCalls.delete(this.toolCalls.keys().next().value!);
    }
  }

  /**
   * Announce a child on its parent — `subagent_update` with title,
   * description, capabilities and `running` — then the parent's outgoing
   * `session_message` carrying the prompt (R2.1, R2.2). A second launch of a
   * known child (a resumed subagent) only reports it running again.
   */
  async launch(launch: ChildLaunch): Promise<void> {
    const known = this.byChild.get(launch.agentId);
    if (known?.unannounced) {
      // Known from the transcript of a resumed parent, never shown on this
      // connection: the client gets the whole announcement now (R4.3).
      known.unannounced = false;
      known.cancelled = false;
      known.state = "running";
      // A launcher the client was never shown cannot carry it: Zed v1 drops
      // updates for a session it does not know, so it goes on the root.
      if (this.byChild.get(known.announcedOn)?.unannounced) {
        known.announcedOn = known.parentSessionId;
      }
      this.byToolUse.set(launchKey(known.parentSessionId, launch.toolUseId), known);
      await this.announce(known, launch, { state: "running" });
      await this.sendPrompt(known, launch);
      return;
    }
    if (known) {
      // A resumed subagent keeps its task id but runs under a new Agent call
      // (sdk.d.ts SDKTaskStartedMessage): its stream names that call.
      this.byToolUse.set(launchKey(known.parentSessionId, launch.toolUseId), known);
      known.cancelled = false;
      await this.setState(known, { state: "running" });
      await this.sendPrompt(known, launch);
      return;
    }
    const launcher = launch.launcherTaskId ? this.byChild.get(launch.launcherTaskId) : undefined;
    const record: ChildRecord = {
      childId: launch.agentId,
      parentSessionId: launch.parentSessionId,
      announcedOn:
        launcher?.parentSessionId === launch.parentSessionId
          ? launcher.childId
          : launch.parentSessionId,
      state: "running",
      openAsks: 0,
    };
    this.byChild.set(record.childId, record);
    this.byToolUse.set(launchKey(record.parentSessionId, launch.toolUseId), record);
    await this.announce(record, launch, { state: "running" });
    await this.sendPrompt(record, launch);
  }

  /**
   * Register a child read back from its parent's transcript, under the id it
   * had live (R4.1, R4.3). With `announce`, a replay: title, description and
   * prompt go out with no state — replayed history is not live work (R4.2).
   * Without it, a resume: nothing is sent until the child runs again. A child
   * already registered for another parent is left to that parent.
   */
  async restore(launch: ChildLaunch, options: { announce: boolean }): Promise<void> {
    const known = this.byChild.get(launch.agentId);
    if (known && known.parentSessionId !== launch.parentSessionId) {
      this.debug(
        `[subagents/restore] outcome=skipped reason=other_parent childSessionId=${launch.agentId} sessionId=${launch.parentSessionId} owner=${known.parentSessionId}`,
      );
      return;
    }
    const launcher = launch.launcherTaskId ? this.byChild.get(launch.launcherTaskId) : undefined;
    const record: ChildRecord = known ?? {
      childId: launch.agentId,
      parentSessionId: launch.parentSessionId,
      announcedOn:
        launcher?.parentSessionId === launch.parentSessionId
          ? launcher.childId
          : launch.parentSessionId,
      openAsks: 0,
    };
    this.byChild.set(record.childId, record);
    this.byToolUse.set(launchKey(record.parentSessionId, launch.toolUseId), record);
    if (!options.announce) {
      if (!known) record.unannounced = true;
      return;
    }
    record.unannounced = false;
    await this.announce(record, launch);
    await this.sendPrompt(record, launch);
  }

  /**
   * Upstream #1496: the child's working directory, from the `cwd` of its own hook. A child that
   * Claude Code runs elsewhere (Agent `isolation: "worktree"`) reports its worktree. The client
   * gets it only when it differs from the parent's -- in the announcement, or in a
   * `subagent_update` right after it -- and `null` when the child is back in the parent's.
   * SubagentStart runs before the child's first model request, so the `cwd` reaches the client
   * before the child's first tool call.
   */
  async reportCwd(childId: string, cwd: string, parentCwd: string): Promise<void> {
    if (!path.isAbsolute(cwd)) return;
    const value = path.resolve(cwd) === path.resolve(parentCwd) ? undefined : cwd;
    const record = this.byChild.get(childId);
    if (!record || record.unannounced) {
      if (value === undefined) this.pendingCwds.delete(childId);
      else if (this.pendingCwds.has(childId) || this.pendingCwds.size < MAX_PENDING_CWDS) {
        this.pendingCwds.set(childId, value);
      }
      return;
    }
    if (record.reportedCwd === value) return;
    record.reportedCwd = value;
    await this.send({
      sessionId: record.announcedOn,
      update: { sessionUpdate: "subagent_update", sessionId: record.childId, cwd: value ?? null },
    });
  }

  private async announce(
    record: ChildRecord,
    launch: ChildLaunch,
    state?: { state: "running" },
  ): Promise<void> {
    const cwd = this.pendingCwds.get(record.childId);
    this.pendingCwds.delete(record.childId);
    if (cwd !== undefined) record.reportedCwd = cwd;
    await this.send({
      sessionId: record.announcedOn,
      update: {
        sessionUpdate: "subagent_update",
        sessionId: record.childId,
        title: launch.title,
        ...(launch.description ? { description: launch.description } : {}),
        ...(record.reportedCwd ? { cwd: record.reportedCwd } : {}),
        // `SubagentSessionCapabilities.cancel` is an object when supported;
        // absent, Zed disables Stop for the child (design.md, Security).
        ...(launch.cancellable ? { capabilities: { cancel: {} } } : {}),
        ...(state ? { state } : {}),
      },
    });
  }

  private async sendPrompt(record: ChildRecord, launch: ChildLaunch): Promise<void> {
    if (!launch.prompt) return;
    await this.send({
      sessionId: record.announcedOn,
      update: {
        sessionUpdate: "session_message",
        // Derived, not random: a replay of the same launch upserts the same
        // message, and each run of a resumed child gets its own.
        messageId: `subagent-prompt-${record.childId}-${launch.toolUseId}`,
        senderSessionId: record.announcedOn,
        recipientSessionId: record.childId,
        content: [{ type: "text", text: launch.prompt }],
      },
    });
  }

  /**
   * The notification as it should cross the wire: a subagent's update moves
   * to its child's session; everything else is returned unchanged. A
   * `parentToolUseId` naming no launch stays nested in the parent (R2.3).
   */
  route(notification: SessionNotification): SessionNotification {
    if (this.byChild.has(notification.sessionId)) return notification;
    const childId = this.childOf(notification);
    return childId ? { ...notification, sessionId: childId } : notification;
  }

  /** A permission request or elicitation opened on the child (R2.4). */
  async askOpened(childId: string): Promise<void> {
    const record = this.byChild.get(childId);
    if (!record) return;
    record.openAsks += 1;
    if (record.state !== "idle") await this.setState(record, { state: "requires_action" });
  }

  /** A permission request or elicitation on the child was answered (R2.4). */
  async askClosed(childId: string): Promise<void> {
    const record = this.byChild.get(childId);
    if (!record) return;
    record.openAsks = Math.max(0, record.openAsks - 1);
    if (record.openAsks === 0 && record.state === "requires_action") {
      await this.setState(record, { state: "running" });
    }
  }

  /** True once the child was cancelled, until it is resumed. */
  isCancelled(childId: string): boolean {
    return this.byChild.get(childId)?.cancelled === true;
  }

  /** The subagent ended: `idle` with its stop reason, sent once (R2.4). */
  async settle(childId: string, stopReason: ChildStopReason): Promise<void> {
    const record = this.byChild.get(childId);
    if (!record) return;
    if (stopReason === "cancelled") record.cancelled = true;
    if (record.state === "idle") return;
    await this.setState(record, { state: "idle", stopReason });
  }

  private async setState(
    record: ChildRecord,
    state:
      { state: "running" | "requires_action" } | { state: "idle"; stopReason: ChildStopReason },
  ): Promise<void> {
    if (record.state === state.state && state.state !== "idle") return;
    record.state = state.state;
    await this.send({
      sessionId: record.announcedOn,
      update: { sessionUpdate: "subagent_update", sessionId: record.childId, state },
    });
  }
}
