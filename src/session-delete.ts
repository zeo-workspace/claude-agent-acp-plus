/**
 * `session/delete` without a transcript succeeds (upstream fadbe18, #1351).
 *
 * ACP: "Deleting an already-deleted session, or a session that never existed,
 * SHOULD succeed silently." The SDK delete instead throws for an id that is
 * not a UUID ("Invalid sessionId") and for a session with nothing on disk —
 * which includes a live session never prompted, since Claude Code writes the
 * transcript at the first prompt. Every other SDK failure still fails.
 */

import { deleteSession as sdkDeleteSession } from "@anthropic-ai/claude-agent-sdk";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a Claude session id (a UUID): only such ids name a
 *  transcript. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** The SDK's own "nothing on disk" error, matched on its message as upstream
 *  does — the SDK throws a plain `Error` with no code. */
export function isSdkSessionNotFound(error: unknown): boolean {
  return error instanceof Error && /^Session \S+ not found in /.test(error.message);
}

export async function deleteSessionIfStored(
  sessionId: string,
  deleteSession: (sessionId: string) => Promise<void> = sdkDeleteSession,
): Promise<void> {
  if (!isSessionId(sessionId)) return;
  try {
    await deleteSession(sessionId);
  } catch (error) {
    if (isSdkSessionNotFound(error)) return;
    throw error;
  }
}
