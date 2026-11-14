/**
 * `_claude/rewind` — take a session back to the end of an earlier turn, the
 * conversation and optionally the files (Zeo proposal §6.33, ask 61; zed
 * discussion #50192).
 *
 * The conversation is not truncated in place. A truncating resume
 * (`resumeSessionAt`) leaves the discarded entries in the same transcript, and
 * whether a later load follows the old tail until a new message is appended is
 * not something this adapter can prove offline. Instead the kept part is
 * copied into a NEW transcript with the SDK's documented `forkSession(id,
 * { upToMessageId })`, and the new session id goes back to the client, which
 * replaces the thread's session with it. The original transcript is left as
 * it was, so nothing is lost if the client fails to switch.
 *
 * Order matters: files first, through the live query's `rewindFiles` at the
 * first dropped prompt (its checkpoint is the files' state at the end of the
 * kept turn). If that fails nothing else is touched. A fork failure after a
 * file restore is reported with `filesRestored: true`, so the client can say
 * so. A forked transcript starts without file checkpoints (SDK docs), so a
 * later file rewind reaches only edits made after this one.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import type { RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import { type CutAt, parseCutAt, resolveTurnCut, type TranscriptRow } from "./turn-cut.js";

export const REWIND_METHOD = "_claude/rewind";
export const REWIND_CAPABILITY_KEY = "_claude/rewind";
export const REWIND_CAPABILITY_VERSION = 1;

export type RewindRequest = { sessionId: string; at: CutAt; restoreFiles: boolean };

export type RewindResult =
  | { status: "rewound"; sessionId: string; droppedTurns: number; filesRestored: boolean }
  | { status: "nothing_to_rewind" }
  | { status: "not_found" }
  | { status: "busy" }
  | { status: "failed"; stage: "files"; message: string }
  | { status: "failed"; stage: "conversation"; message: string; filesRestored: boolean };

/** What `rewindSession` needs from the adapter and the SDK. */
export type RewindDepsV2 = {
  readTranscript: () => Promise<TranscriptRow[]>;
  messageIdToUuid: ReadonlyMap<string, string>;
  /** The live query's `rewindFiles`, at a user-message uuid. */
  rewindFiles: (userMessageUuid: string) => Promise<RewindFilesResult>;
  /** Copy the transcript up to and including `upToUuid`; resolves the new id. */
  forkTranscript: (upToUuid: string) => Promise<string>;
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate raw JSON-RPC params for `_claude/rewind`. */
export function parseRewindRequest(params: unknown): RewindRequest {
  const record =
    params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
  const sessionId = record?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      `${REWIND_METHOD} params require a non-empty sessionId`,
    );
  }
  const restoreFiles = record?.restoreFiles ?? false;
  if (typeof restoreFiles !== "boolean") {
    throw RequestError.invalidParams(undefined, `${REWIND_METHOD} restoreFiles must be a boolean`);
  }
  return { sessionId, at: parseCutAt(record?.at, REWIND_METHOD), restoreFiles };
}

/** Rewind one session; the caller has already checked it is idle. */
export async function rewindSession(
  deps: RewindDepsV2,
  request: Pick<RewindRequest, "at" | "restoreFiles">,
): Promise<RewindResult> {
  const cut = resolveTurnCut(await deps.readTranscript(), request.at, deps.messageIdToUuid);
  if (cut.kind === "nothing_to_cut") return { status: "nothing_to_rewind" };
  if (cut.kind === "not_found") return { status: "not_found" };

  let filesRestored = false;
  if (request.restoreFiles) {
    try {
      const result = await deps.rewindFiles(cut.nextPromptUuid);
      if (!result.canRewind) {
        return {
          status: "failed",
          stage: "files",
          message: result.error ?? "the files could not be restored",
        };
      }
      filesRestored = true;
    } catch (error) {
      return { status: "failed", stage: "files", message: reason(error) };
    }
  }

  try {
    const sessionId = await deps.forkTranscript(cut.cutUuid);
    return { status: "rewound", sessionId, droppedTurns: cut.droppedTurns, filesRestored };
  } catch (error) {
    return { status: "failed", stage: "conversation", message: reason(error), filesRestored };
  }
}

/** The `_meta` key a `session/fork` request names its cut point under. */
export const FORK_AT_META_KEY = "_claude/forkAt";

/** How `unstable_forkSession` starts the forked query. */
export type ForkPlan = { resume: string; forkSession: boolean };

/**
 * Fork from a turn (§6.33). Without a cut point, or with one at the last turn,
 * the fork is the full copy it has always been: resume the parent with
 * `forkSession`. With an earlier cut, the kept part is copied into a new
 * transcript first and the fork resumes that copy as it is.
 */
export async function planFork(
  deps: Pick<RewindDepsV2, "readTranscript" | "messageIdToUuid" | "forkTranscript">,
  parentSessionId: string,
  at: CutAt | undefined,
): Promise<ForkPlan> {
  const fullCopy = { resume: parentSessionId, forkSession: true };
  if (at === undefined) return fullCopy;
  const cut = resolveTurnCut(await deps.readTranscript(), at, deps.messageIdToUuid);
  if (cut.kind === "nothing_to_cut") return fullCopy;
  if (cut.kind === "not_found") {
    throw RequestError.invalidParams(
      undefined,
      "the fork's cut point was not found in the session",
    );
  }
  return { resume: await deps.forkTranscript(cut.cutUuid), forkSession: false };
}
