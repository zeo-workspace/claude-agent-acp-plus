/**
 * Where to cut a conversation "at the end of a turn" — the shared core of
 * fork-from-here and rewind-to-here (Zeo proposal §6.33, asks 55 and 61).
 *
 * A client names the turn to keep either by the ACP `messageId` of one of its
 * agent messages, translated through `Session.messageIdToUuid`, or by its
 * 1-based position among the user's prompts. Either way the cut is the LAST
 * transcript entry before the next prompt, never the named message itself:
 * the SDK's guidance for a fork point is the kept turn's last chain entry
 * (`resumeDropsTurn` in the SDK types), so a tool result or a final reply after
 * the named message stays with its turn.
 *
 * What counts as a prompt is `/rewind`'s rule (`listCheckpoints`): a top-level
 * user row that is not a tool result or a local-command marker and has text. A
 * prompt holding only an image therefore does not start a turn here.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { listCheckpoints } from "./rewind-command.js";

/** A transcript row as `getSessionMessages` returns it, read structurally. */
export type TranscriptRow = SDKMessage;

export type CutAt = { messageId: string } | { turn: number };

export type TurnCut =
  | { kind: "cut"; cutUuid: string; nextPromptUuid: string; droppedTurns: number }
  | { kind: "nothing_to_cut" }
  | { kind: "not_found" };

/** Validate a `CutAt` from client params; `method` names the caller in errors. */
export function parseCutAt(value: unknown, method: string): CutAt {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (record && typeof record.messageId === "string" && record.messageId.length > 0) {
    return { messageId: record.messageId };
  }
  if (record && Number.isInteger(record.turn) && (record.turn as number) >= 1) {
    return { turn: record.turn as number };
  }
  throw RequestError.invalidParams(
    undefined,
    `${method} needs a cut point: {messageId} or {turn}, a positive integer`,
  );
}

function rowUuid(row: TranscriptRow): string | undefined {
  const uuid = (row as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : undefined;
}

/** Resolve a cut point against a session's transcript. */
export function resolveTurnCut(
  transcript: TranscriptRow[],
  at: CutAt,
  messageIdToUuid: ReadonlyMap<string, string>,
): TurnCut {
  // listCheckpoints answers most recent first; turns are counted forwards.
  const promptUuids = listCheckpoints(transcript)
    .map((checkpoint) => checkpoint.uuid)
    .reverse();
  const promptIndexes = promptUuids.map((uuid) => transcript.findIndex((r) => rowUuid(r) === uuid));

  // The index of the first prompt that starts a dropped turn.
  let firstDropped: number;
  if ("turn" in at) {
    firstDropped = at.turn;
  } else {
    const uuid = messageIdToUuid.get(at.messageId);
    const atIndex = uuid === undefined ? -1 : transcript.findIndex((r) => rowUuid(r) === uuid);
    if (atIndex < 0) return { kind: "not_found" };
    firstDropped = promptIndexes.findIndex((index) => index > atIndex);
    if (firstDropped < 0) return { kind: "nothing_to_cut" };
  }
  if (firstDropped >= promptIndexes.length) return { kind: "nothing_to_cut" };

  const nextPromptIndex = promptIndexes[firstDropped];
  const cutUuid = nextPromptIndex > 0 ? rowUuid(transcript[nextPromptIndex - 1]) : undefined;
  if (cutUuid === undefined) return { kind: "nothing_to_cut" };
  return {
    kind: "cut",
    cutUuid,
    nextPromptUuid: promptUuids[firstDropped],
    droppedTurns: promptIndexes.length - firstDropped,
  };
}
