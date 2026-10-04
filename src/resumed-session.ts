import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { access, open, readdir } from "node:fs/promises";
import path from "node:path";
import { SessionTiming } from "./session-timing.js";

/** The size of one backward read of a transcript. */
const TAIL_CHUNK_BYTES = 64 * 1024;

type ResumeLogger = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type ResumedSessionSnapshot = {
  messages?: SessionMessage[];
  model?: string;
};

/** Return the concrete model recorded by the last real assistant response.
 * Claude Code restores a resumed query from this same transcript field.
 * Synthetic assistant records use angle-bracket placeholders and do not
 * describe a model the resumed query can run. */
export function resumedModelFromTranscript(messages: SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index];
    if (
      entry?.type !== "assistant" ||
      entry.parent_tool_use_id != null ||
      entry.parent_agent_id != null ||
      !entry.message ||
      typeof entry.message !== "object"
    ) {
      continue;
    }
    const model = (entry.message as { model?: unknown }).model;
    if (typeof model === "string" && model.trim().length > 0 && !/^<[^>]+>$/.test(model.trim())) {
      return model.trim();
    }
  }
  return undefined;
}

/** Read the resume model from the local transcript without starting a Claude
 * control request. This is intentionally on the load critical path. */
export async function readResumedSession(
  sessionId: string,
  logger?: ResumeLogger,
): Promise<ResumedSessionSnapshot> {
  const timing = new SessionTiming(logger, "models", sessionId);
  try {
    // Deliberately search all project directories, matching replaySessionHistory.
    // A client may reopen a session from a worktree or normalized path that is
    // different from the directory under which Claude persisted the transcript.
    const messages = await getSessionMessages(sessionId);
    const model = resumedModelFromTranscript(messages);
    timing.phase("read-transcript", ` messages=${messages.length} model=${model ?? "unknown"}`);
    return { messages, model };
  } catch (error) {
    timing.phase("read-transcript", " outcome=error");
    logger?.error(`Failed to read transcript for resumed session ${sessionId}:`, error);
    return {};
  }
}

/**
 * The permission mode a resumed session was last in, read from the end of its
 * local transcript (ported from upstream #1218's `readResumedTail`, mode half).
 *
 * Claude Code records the mode on each prompt record of type `user`. The CLI's
 * `permission-mode` metadata records are not used: they can disagree with the
 * prompts, and the SDK does not write them. The SDK writes no mode when it
 * leaves plan mode through ExitPlanMode, only a `plan_mode_exit` attachment, so
 * a `plan` before a later plan exit is not the current mode and gives none.
 * The search stops at the first mode or at the last human prompt: every human
 * prompt of a current Claude Code carries one, so a prompt without it means the
 * transcript does not record modes. A compaction does not stop it.
 *
 * `configDir` is the configuration home the resumed query runs with -- an
 * account overlay keeps its transcripts under its own home, not the adapter's.
 * Best-effort: any failure returns `undefined` and the caller keeps its default.
 */
export async function readResumedPermissionMode(
  sessionId: string,
  configDir: string,
  logger?: ResumeLogger,
): Promise<string | undefined> {
  const timing = new SessionTiming(logger, "permission-mode", sessionId);
  try {
    const filePath = await findTranscript(sessionId, configDir);
    if (!filePath) {
      timing.phase("read-transcript-tail", " outcome=no-transcript");
      return undefined;
    }
    const mode = await lastPermissionMode(filePath);
    timing.phase("read-transcript-tail", ` permissionMode=${mode ?? "unknown"}`);
    return mode;
  } catch (error) {
    timing.phase("read-transcript-tail", " outcome=error");
    logger?.error(`Failed to read the permission mode of resumed session ${sessionId}:`, error);
    return undefined;
  }
}

/** The local transcript of a session in any project directory of `configDir`. */
async function findTranscript(sessionId: string, configDir: string): Promise<string | undefined> {
  const projects = path.join(configDir, "projects");
  let directories: string[];
  try {
    directories = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    const candidate = path.join(projects, directory, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not in this project directory.
    }
  }
  return undefined;
}

async function lastPermissionMode(filePath: string): Promise<string | undefined> {
  const handle = await open(filePath, "r");
  const scan = new PermissionModeScan();
  try {
    let end = (await handle.stat()).size;
    // The bytes of the line whose start is not read yet, in file order.
    let pending: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      let chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (scan.visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return scan.mode;
        pending = [];
        chunk = chunk.subarray(0, at);
      }
      pending.unshift(chunk);
      end = start;
    }
    scan.visit(Buffer.concat(pending));
    return scan.mode;
  } finally {
    await handle.close();
  }
}

type TranscriptRecord = {
  type?: unknown;
  isSidechain?: unknown;
  permissionMode?: unknown;
  origin?: { kind?: unknown };
  attachment?: { type?: unknown };
};

/** Visits transcript lines from the end; see {@link readResumedPermissionMode}. */
class PermissionModeScan {
  mode: string | undefined;
  private planExited = false;

  /** Visit the previous line. Return true when the search is over. */
  visit(line: Buffer): boolean {
    let parsed: TranscriptRecord | null | undefined;
    // Most lines carry no marker of interest; the check skips their JSON parse.
    const record = (marker: string): TranscriptRecord | undefined => {
      if (line.indexOf(marker) < 0) return undefined;
      if (parsed === undefined) parsed = parseMainThreadRecord(line);
      return parsed ?? undefined;
    };
    const modeEntry = record('"permissionMode"');
    if (
      modeEntry?.type === "user" &&
      typeof modeEntry.permissionMode === "string" &&
      modeEntry.permissionMode.trim() !== ""
    ) {
      const mode = modeEntry.permissionMode.trim();
      if (!(this.planExited && mode === "plan")) this.mode = mode;
      return true;
    }
    if (record('"plan_mode_exit"')?.attachment?.type === "plan_mode_exit") {
      this.planExited = true;
      return false;
    }
    const human = record('"human"');
    return human?.type === "user" && human.origin?.kind === "human";
  }
}

/** The parsed record of one line, or null for a subagent record or a bad line. */
function parseMainThreadRecord(line: Buffer): TranscriptRecord | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as TranscriptRecord;
  return record.isSidechain === true ? null : record;
}
