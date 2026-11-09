/**
 * The session's task list as a keyed plan (Zeo next proposal §5.1, F1).
 *
 * A legacy `plan` update is pruned by Zed: when the next message is sent, it
 * drops the completed entries, so a fully completed plan vanished at the next
 * turn. A keyed `plan_update` (zed#66345) is never pruned, and Zed applies v1
 * `plan_update`/`plan_removed` as they arrive. It advertises the `plan` client
 * capability behind `acp-beta`, which Zeo's patch `0001` forces on.
 *
 * The gate and the id are upstream's, not new ones: `supportsPlanOperations`
 * (upstream `acp-agent.ts`, `clientCapabilities?.plan != null`) and
 * `SESSION_PLAN_ID` (upstream `src/v2/session-update.ts`).
 */

import type {
  ClientCapabilities,
  PlanEntry,
  SessionNotification,
} from "@agentclientprotocol/sdk/unstable";

/** The one plan id this adapter's task list lives under. */
export const SESSION_PLAN_ID = "plan";

/** True when the client applies keyed plan updates. */
export function supportsPlanOperations(caps: ClientCapabilities | null | undefined): boolean {
  return caps?.plan != null;
}

/** The task list as the update this client understands. */
export function planSessionUpdate(
  entries: PlanEntry[],
  keyed: boolean,
): SessionNotification["update"] {
  if (!keyed) return { sessionUpdate: "plan", entries };
  return {
    sessionUpdate: "plan_update",
    plan: { type: "items", planId: SESSION_PLAN_ID, entries },
  };
}

/** Removes the session plan from a client that applies keyed plans. */
export function planRemovedUpdate(): SessionNotification["update"] {
  return { sessionUpdate: "plan_removed", planId: SESSION_PLAN_ID };
}
