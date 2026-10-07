import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { DurablePermissionChangeSet } from "./normalization.js";
import { applyClaudePermissionSelection, parseClaudePermissionSelection } from "./effects.js";
import { PERMISSION_OPTION_ID } from "./options/shared.js";

export interface ClaudePermissionDecision {
  permissionResult: PermissionResult;
  contextResetMode?: PermissionMode;
}

/** Decode, validate, and interpret an ACP response exactly once. */
export function decodeClaudePermissionResponse(
  response: RequestPermissionResponse,
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  offeredOptions: readonly PermissionOption[],
  durableChangeSet?: DurablePermissionChangeSet,
): ClaudePermissionDecision {
  const selection = parseClaudePermissionSelection(response, toolName);
  const offeredOption = offeredOptions.find((option) => option.optionId === selection.optionId);
  if (!offeredOption) {
    throw new Error(`Permission option was not offered: ${selection.optionId}`);
  }
  const permissionResult = applyClaudePermissionSelection(selection, {
    toolName,
    input,
    toolUseID,
    durableChangeSet,
  });
  return {
    permissionResult,
    ...(selection.contextResetMode ? { contextResetMode: selection.contextResetMode } : {}),
  };
}

export type ClassifierEscalationAnswer = "once" | "session" | "reject" | "cancelled";

/**
 * Map the answer to a classifier-denial request. Only the three ids that
 * request offers are accepted; anything else is an error, never an approval.
 */
export function decodeClassifierEscalationResponse(
  response: RequestPermissionResponse,
): ClassifierEscalationAnswer {
  if (response.outcome.outcome === "cancelled") return "cancelled";
  switch (response.outcome.optionId) {
    case PERMISSION_OPTION_ID.classifierAllowOnce:
      return "once";
    case PERMISSION_OPTION_ID.classifierAllowSession:
      return "session";
    case PERMISSION_OPTION_ID.reject:
      return "reject";
    default:
      throw new Error(`Classifier escalation option was not offered: ${response.outcome.optionId}`);
  }
}
