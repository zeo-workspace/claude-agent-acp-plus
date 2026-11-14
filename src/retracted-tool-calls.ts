import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** The most assistant messages whose tool uses are kept; the oldest are
 *  dropped. Upstream #1616's bound: a retraction names the response just sent,
 *  so a long session needs only the recent ones. */
const MAX_MESSAGES = 1000;

/** The text of a tool call that Claude Code stopped when it took back the
 *  response that made it — upstream #1616's wording, kept so plus and
 *  upstream read the same. */
export const RETRACTED_TOOL_CALL_TEXT =
  "Claude Code replaced the response that made this tool call, and stopped the call. If it had started, some of its effects may have happened.";

/** A tool call of a message that Claude Code took back, with the Agent call
 *  of the subagent that made it (null for the main conversation). */
export type RetractedToolCall = { toolCallId: string; parentToolUseId: string | null };

/**
 * The tool uses of the assistant messages that Claude Code sent, by message
 * `uuid`, to find the tool calls of a message that Claude Code takes back.
 * Ported from upstream claude-agent-acp #1616.
 *
 * Claude Code takes back the response of a model that refuses, and retries on
 * the fallback model. It stops the tool calls of that response that have no
 * result yet, and sends no result for them, so without this they spin in the
 * client forever. It names the messages it took back, by the `uuid` they were
 * sent with (read from the code of CLI 2.1.323 upstream; a refusal fallback
 * cannot be produced on demand, so it was not observed live):
 * - in `retracted_message_uuids` of the `model_refusal_fallback` notice;
 * - in `supersedes` of the first assistant message of the retry.
 *
 * Both name the same messages, so a tool call is given once. Since Claude
 * Code 2.1.323 `supersedes` also names a response whose tool call could not
 * be parsed; such a response holds no tool use, so it gives nothing.
 */
export class RetractedToolCalls {
  private readonly toolUses = new Map<string, RetractedToolCall[]>();

  /** Records the tool uses of a complete assistant message. */
  sent(message: SDKMessage): void {
    if (message.type !== "assistant" || typeof message.uuid !== "string") return;
    const ids = toolUseIds(message);
    if (ids.length === 0) return;
    const parentToolUseId = message.parent_tool_use_id ?? null;
    this.toolUses.delete(message.uuid);
    this.toolUses.set(
      message.uuid,
      ids.map((toolCallId) => ({ toolCallId, parentToolUseId })),
    );
    if (this.toolUses.size > MAX_MESSAGES) {
      this.toolUses.delete(this.toolUses.keys().next().value!);
    }
  }

  /**
   * The tool calls of the messages that `message` takes back, each given
   * once. A tool call that `message` makes itself is not among them: the
   * message that replaces another can hold the same tool use.
   */
  retractedBy(message: SDKMessage): RetractedToolCall[] {
    const own = new Set(toolUseIds(message));
    const retracted: RetractedToolCall[] = [];
    for (const uuid of retractedMessageUuids(message)) {
      for (const call of this.toolUses.get(uuid) ?? []) {
        if (!own.has(call.toolCallId)) retracted.push(call);
      }
      this.toolUses.delete(uuid);
    }
    return retracted;
  }
}

/** The `uuid`s of the messages that `message` says Claude Code took back. */
function retractedMessageUuids(message: SDKMessage): readonly string[] {
  if (message.type === "assistant") return message.supersedes ?? [];
  if (message.type === "system" && message.subtype === "model_refusal_fallback") {
    return message.retracted_message_uuids ?? [];
  }
  return [];
}

/** The ids of the tool uses of an assistant message. */
function toolUseIds(message: SDKMessage): string[] {
  if (message.type !== "assistant" || !Array.isArray(message.message.content)) return [];
  return message.message.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
}
