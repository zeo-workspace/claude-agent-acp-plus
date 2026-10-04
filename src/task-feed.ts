/**
 * The agent's task feed: background shells, subagents, monitors and workflows,
 * folded from the SDK's task messages into the `_claude/tasks` snapshot.
 *
 * The SDK reports tasks as a stream of bookends (`task_started`,
 * `task_progress`, `task_updated`, `task_notification`) plus a level
 * (`background_tasks_changed`). Zeo needs one table it can render, so
 * `TaskFeed` keeps that table per session and renders it as a snapshot. The
 * snapshot is a LEVEL, not a stream: every publish carries every live task,
 * so a lost update is repaired by the next one, and the client replaces its
 * list instead of merging.
 *
 * An ended task appears in exactly one successful snapshot with its final
 * status, then drops out. `snapshot()` marks nothing; the publisher calls
 * `markPublished()` only after the send carrying the endings succeeded, so a
 * failed send never loses an ending.
 *
 * `TaskFeedPublisher` decides WHEN to publish: at most once per second during
 * progress, at once on an ending, and once more after a burst so the latest
 * values are not lost.
 *
 * Neither class ever copies a command line (`SDKTaskStartedMessage.prompt`)
 * into an entry or a log line.
 */

import type {
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The `session_info_update._meta` key the snapshot is published under. */
export const TASKS_META_KEY = "_claude/tasks";

export type TaskStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export type TaskUsage = { tokens: number; toolUses: number; durationMs: number };

/** One row of the snapshot — design.md's Data Models, field for field. */
export type TaskEntry = {
  id: string;
  toolCallId: string | null;
  type: string;
  description: string;
  background: boolean;
  depth: number;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
  usage: TaskUsage | null;
  lastTool: string | null;
  summary: string | null;
};

export type TasksSnapshot = { tasks: TaskEntry[] };

/** What a message did to the table; the publisher decides timing from it. */
export type TaskChange = "none" | "progress" | "terminal";

/** How long a running background task may be missing from the level before
 *  it is ended as `interrupted`. The level and the bookends race (the level
 *  may arrive first), so a real ending gets this long to land. */
export const RECONCILE_GRACE_MS = 2_000;

/** Minimum gap between two progress publishes of one session. */
export const PUBLISH_INTERVAL_MS = 1_000;

export type TaskFeedLog = {
  /** Diagnostics nobody acts on (an unknown task id). Omitted = dropped. */
  debug?: (message: string) => void;
  /** Degraded but self-recovered (a task ended by reconciliation). */
  warn?: (message: string) => void;
};

const TASK_TYPES: Record<string, string> = {
  local_bash: "shell",
  local_agent: "subagent",
  local_workflow: "workflow",
  mcp_task: "mcp",
  monitor: "monitor",
};

function normaliseType(raw: string | undefined): string {
  if (!raw) return "shell";
  return TASK_TYPES[raw] ?? raw;
}

/**
 * The one place the SDK's ending vocabulary becomes the wire's. The same stop
 * arrives as `task_updated.patch.status = "killed"` and as
 * `task_notification.status = "stopped"`; both are `stopped`. Returns null for
 * a non-terminal status (`pending`, `running`, `paused`).
 */
export function normaliseStatus(
  status: string | undefined,
  reason?: string,
): Exclude<TaskStatus, "running"> | null {
  if (reason === "worker_restart") return "interrupted";
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return null;
  }
}

/** The SDK types usage as `number`; Zeo parses it as an unsigned integer and
 *  rejects the whole snapshot on one fractional or negative value. */
function wholeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function usageOf(
  usage: { total_tokens: number; tool_uses: number; duration_ms: number } | undefined,
): TaskUsage | null {
  if (!usage) return null;
  return {
    tokens: wholeNumber(usage.total_tokens),
    toolUses: wholeNumber(usage.tool_uses),
    durationMs: wholeNumber(usage.duration_ms),
  };
}

export class TaskFeed {
  private readonly tasks = new Map<string, TaskEntry>();
  /** Ended tasks whose final snapshot was sent successfully: never shown again. */
  private readonly published = new Set<string>();
  /** Ambient task ids: never shown, and their later messages are not news. */
  private readonly ambient = new Set<string>();
  /** task id → its current life; bumped on every start. */
  private readonly lives = new Map<string, number>();
  /** task id → the life the latest snapshot carried as ended. */
  private readonly snapshotLives = new Map<string, number>();
  /** task id → time after which a missing bookend means `interrupted`. */
  private readonly deadlines = new Map<string, number>();

  constructor(
    private readonly clock: () => number,
    private readonly log: TaskFeedLog = {},
    private readonly sessionId = "",
  ) {}

  onStarted(msg: SDKTaskStartedMessage): TaskChange {
    if (msg.ambient) {
      this.ambient.add(msg.task_id);
      return "none";
    }
    if (this.tasks.get(msg.task_id)?.status === "running") return "none";
    // A known id starting again is a new life of the same task — a resumed
    // subagent is re-registered under its agent id. It replaces the ended
    // entry, published or not: the running state supersedes an ending the
    // client has not seen yet, and a published id must be shown again.
    this.published.delete(msg.task_id);
    this.lives.set(msg.task_id, (this.lives.get(msg.task_id) ?? 0) + 1);
    this.tasks.set(msg.task_id, {
      id: msg.task_id,
      toolCallId: msg.tool_use_id ?? null,
      type: normaliseType(msg.task_type),
      description: msg.description,
      background: msg.is_backgrounded ?? false,
      depth: msg.spawn_depth ?? 0,
      status: "running",
      startedAt: this.clock(),
      endedAt: null,
      usage: null,
      lastTool: null,
      summary: null,
    });
    return "progress";
  }

  onProgress(msg: SDKTaskProgressMessage): TaskChange {
    const task = this.running(msg.task_id, "task_progress");
    if (!task) return "none";
    task.usage = usageOf(msg.usage);
    task.lastTool = msg.last_tool_name ?? task.lastTool;
    task.summary = msg.summary ?? task.summary;
    return "progress";
  }

  onUpdated(msg: SDKTaskUpdatedMessage): TaskChange {
    const task = this.running(msg.task_id, "task_updated");
    if (!task) return "none";
    const ending = normaliseStatus(msg.patch.status);
    if (msg.patch.description !== undefined) task.description = msg.patch.description;
    if (msg.patch.is_backgrounded !== undefined) task.background = msg.patch.is_backgrounded;
    if (ending) {
      this.end(task, ending);
      return "terminal";
    }
    return "progress";
  }

  onNotification(msg: SDKTaskNotificationMessage): TaskChange {
    const task = this.running(msg.task_id, "task_notification");
    if (!task) return "none";
    const ending = normaliseStatus(msg.status, msg.reason) ?? "completed";
    if (msg.summary) task.summary = msg.summary;
    const usage = usageOf(msg.usage);
    if (usage) task.usage = usage;
    this.end(task, ending);
    return "terminal";
  }

  /**
   * The SDK's level: every live background task. It never adds or ends a task
   * by itself — it may precede the `task_started` that names a task, or the
   * bookend that ends one. A running background task the level omits gets a
   * reconcile deadline; a level that lists it again clears it.
   */
  onLevel(level: { task_id: string }[]): TaskChange {
    const listed = new Set(level.map((t) => t.task_id));
    const now = this.clock();
    for (const task of this.tasks.values()) {
      if (task.status !== "running" || !task.background) continue;
      if (listed.has(task.id)) this.deadlines.delete(task.id);
      else if (!this.deadlines.has(task.id)) this.deadlines.set(task.id, now + RECONCILE_GRACE_MS);
    }
    return "none";
  }

  nextReconcileAt(): number | null {
    let next: number | null = null;
    for (const at of this.deadlines.values()) if (next === null || at < next) next = at;
    return next;
  }

  /** Ends as `interrupted` every task whose deadline passed with no bookend. */
  reconcile(now: number): TaskChange {
    let change: TaskChange = "none";
    for (const [id, at] of this.deadlines) {
      if (at > now) continue;
      const task = this.tasks.get(id);
      if (task?.status === "running") {
        this.log.warn?.(
          `[tasks/reconcile] sessionId=${this.sessionId} taskId=${id} outcome=interrupted reason=missing_from_level`,
        );
        this.end(task, "interrupted", now);
        change = "terminal";
      }
      this.deadlines.delete(id);
    }
    return change;
  }

  /** The CLI process restarted: whatever was running did not survive it. */
  onProcessRestart(): TaskChange {
    let change: TaskChange = "none";
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      this.end(task, "interrupted");
      change = "terminal";
    }
    return change;
  }

  /** True when the feed holds `taskId` as running — the stop request's gate. */
  isRunning(taskId: string): boolean {
    return this.tasks.get(taskId)?.status === "running";
  }

  /** Running tasks plus ended tasks not yet published, oldest start first.
   *  Marks nothing: see `markPublished`. */
  snapshot(): { snapshot: TasksSnapshot; endedIds: string[] } {
    const tasks = [...this.tasks.values()]
      .filter((t) => t.status === "running" || !this.published.has(t.id))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((t) => ({ ...t, usage: t.usage ? { ...t.usage } : null }));
    const endedIds = tasks.filter((t) => t.status !== "running").map((t) => t.id);
    for (const id of endedIds) this.snapshotLives.set(id, this.lives.get(id) ?? 0);
    return { snapshot: { tasks }, endedIds };
  }

  /** Called after the send carrying these endings succeeded. Their entries are
   *  dropped; the ids are remembered so a late bookend cannot resurrect them. */
  markPublished(endedIds: string[]): void {
    for (const id of endedIds) {
      // Only the life the snapshot carried: a task that started again while
      // the send was in flight is a new life the client has not seen end.
      if (this.snapshotLives.get(id) !== this.lives.get(id)) continue;
      if (this.tasks.get(id)?.status === "running") continue;
      this.snapshotLives.delete(id);
      this.published.add(id);
      this.tasks.delete(id);
    }
  }

  private running(taskId: string, kind: string): TaskEntry | undefined {
    const task = this.tasks.get(taskId);
    if (task?.status === "running") return task;
    if (!task && !this.published.has(taskId) && !this.ambient.has(taskId)) {
      this.log.debug?.(`[tasks/feed] sessionId=${this.sessionId} taskId=${taskId} ignored=${kind}`);
    }
    return undefined;
  }

  private end(task: TaskEntry, status: Exclude<TaskStatus, "running">, at = this.clock()): void {
    task.status = status;
    task.endedAt = at;
    this.deadlines.delete(task.id);
  }
}

export type PublisherTimers = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: any) => void;
};

const realTimers: PublisherTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class TaskFeedPublisher {
  private lastSendAt = Number.NEGATIVE_INFINITY;
  /** One send at a time: a snapshot taken while another is in flight would
   *  carry that one's endings again, and both would succeed. */
  private inFlight = false;
  /** A publish requested while a send was in flight; `"terminal"` skips the
   *  throttle when it runs. */
  private queued: TaskChange = "none";
  /** The trailing publish or the retry after a failed send — never both. */
  private pending: unknown = null;
  private reconcileTimer: unknown = null;
  private reconcileAt: number | null = null;
  private closed = false;
  /** Set by `dispose({ flush: true })`: a publish queued behind an in-flight
   *  send still goes out once — a retirement's `interrupted` endings. */
  private flushOnSettle = false;

  constructor(
    private readonly feed: TaskFeed,
    private readonly send: (snapshot: TasksSnapshot) => Promise<void>,
    private readonly timers: PublisherTimers = realTimers,
    private readonly onSendError: (error: unknown) => void = () => {},
  ) {}

  notify(change: TaskChange): void {
    if (this.closed) return;
    if (change === "terminal") {
      this.publishNow();
    } else if (change === "progress") {
      const wait = this.lastSendAt + PUBLISH_INTERVAL_MS - this.timers.now();
      if (wait <= 0) this.publishNow();
      else if (this.pending === null) this.arm(wait);
    }
    this.armReconcile();
  }

  dispose(options: { flush?: boolean } = {}): void {
    this.closed = true;
    this.flushOnSettle = options.flush ?? false;
    this.cancelPending();
    if (this.reconcileTimer !== null) this.timers.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    this.reconcileAt = null;
  }

  private publishNow(): void {
    this.cancelPending();
    if (this.inFlight) {
      this.queued = "terminal";
      return;
    }
    this.inFlight = true;
    this.lastSendAt = this.timers.now();
    const { snapshot, endedIds } = this.feed.snapshot();
    // The SDK message loop calls notify; nothing here may throw into it — not
    // a synchronous throw from `send`, and not a throwing error handler.
    void Promise.resolve()
      .then(() => this.send(snapshot))
      .then(
        () => {
          this.feed.markPublished(endedIds);
          this.settle();
        },
        (error) => {
          try {
            this.onSendError(error);
          } catch {
            // The retry below matters more than the log line.
          }
          this.settle();
          if (!this.closed && !this.inFlight && this.pending === null) {
            this.arm(PUBLISH_INTERVAL_MS);
          }
        },
      );
  }

  private settle(): void {
    this.inFlight = false;
    const queued = this.queued;
    this.queued = "none";
    if (queued === "none") return;
    if (!this.closed) {
      this.notify(queued);
    } else if (this.flushOnSettle) {
      // One last send, no retry: the publisher is closed.
      this.flushOnSettle = false;
      void Promise.resolve()
        .then(() => this.send(this.feed.snapshot().snapshot))
        .catch((error) => {
          try {
            this.onSendError(error);
          } catch {
            // Nothing left to arm.
          }
        });
    }
  }

  private arm(ms: number): void {
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      if (!this.closed) this.publishNow();
    }, ms);
  }

  private cancelPending(): void {
    if (this.pending !== null) this.timers.clearTimeout(this.pending);
    this.pending = null;
  }

  private armReconcile(): void {
    const at = this.feed.nextReconcileAt();
    if (at === null || at === this.reconcileAt) return;
    if (this.reconcileTimer !== null) this.timers.clearTimeout(this.reconcileTimer);
    this.reconcileAt = at;
    this.reconcileTimer = this.timers.setTimeout(
      () => {
        this.reconcileTimer = null;
        this.reconcileAt = null;
        if (this.closed) return;
        this.notify(this.feed.reconcile(this.timers.now()));
      },
      Math.max(0, at - this.timers.now()),
    );
  }
}
