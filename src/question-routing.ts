/**
 * Open questions go through AskUserQuestion (Zeo proposal §6.43, ask 67).
 *
 * Whether the model asks in prose or calls `AskUserQuestion` is the model's
 * choice; the client only renders the card. A client that advertises form
 * elicitation already gets the tool as an interactive form
 * (`handleAskUserQuestion`), so this module appends a short rule to the
 * `claude_code` preset steering the model towards it. It costs nothing at
 * runtime and cannot block a turn — a `Stop` hook that enforces it would cost
 * a model turn each time, and is deferred until a week of counts says the
 * rule alone is not enough.
 *
 * Subagents cannot ask: Claude Code removes `AskUserQuestion` from every
 * subagent, even when listed in its `tools`
 * (code.claude.com/docs/en/sub-agents, checked 2026-11-16). They can only
 * return questions in their result, so the rule tells the main agent to relay
 * those. One call takes one to four questions (the tool's input schema).
 *
 * Kept free of `acp-agent.ts` imports for the same reason as
 * `thinking-option.ts`: that file changes upstream almost daily, and every
 * coupling to it is paid again at each sync.
 */

import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

/** Session `_meta` key; `false` turns the rule off (Zeo's
 *  `agent.ask_questions_in_cards`). Absent or any other value leaves it on. */
export const ASK_QUESTIONS_IN_CARDS_META_KEY = "askQuestionsInCards";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/** Appended to the preset. Worded as guidance, not a hard rule: a question the
 *  model answers itself, or a rhetorical one, must stay in prose. */
export const QUESTION_ROUTING_PROMPT = `# Questions for the user

This client shows the ${ASK_USER_QUESTION_TOOL} tool as an interactive card. When you need the user's decision or information to continue (a choice between approaches, a missing requirement, a confirmation), ask it with ${ASK_USER_QUESTION_TOOL} instead of writing the question in your reply.

- Before you end a turn, gather every question that is still open into a single ${ASK_USER_QUESTION_TOOL} call rather than listing them in your final message. One call takes one to four questions; make another call only for more than four.
- Subagents cannot ask the user. When a subagent's result contains questions for the user, put them to the user through ${ASK_USER_QUESTION_TOOL} instead of repeating them in prose.
- Keep rhetorical questions, and questions you answer yourself, in prose.`;

export type QuestionRoutingInput = {
  /** The client advertised `elicitation.form`; without it the tool is disabled. */
  formElicitation: boolean;
  /** The session request's `_meta`, as received. */
  meta: Record<string, unknown> | null | undefined;
  /** `_meta.claudeCode.options.tools`, when the client pinned the tool set. */
  userTools: Options["tools"] | undefined;
  /** `_meta.claudeCode.options.disallowedTools`. */
  userDisallowedTools: string[] | undefined;
};

/** Whether the rule applies. Every reason it does not is one where the model
 *  could not call the tool, or the client asked for it to be off. */
export function questionRoutingEnabled(input: QuestionRoutingInput): boolean {
  if (!input.formElicitation) return false;
  if (input.meta?.[ASK_QUESTIONS_IN_CARDS_META_KEY] === false) return false;
  if (input.userDisallowedTools?.includes(ASK_USER_QUESTION_TOOL)) return false;
  // An explicit tool list replaces the preset; only follow it when it names the tool.
  if (Array.isArray(input.userTools) && !input.userTools.includes(ASK_USER_QUESTION_TOOL)) {
    return false;
  }
  return true;
}

/** The preset with the rule merged into its `append`. Any other shape (a
 *  string, an array, a `custom` prompt) is a client's full replacement of the
 *  preset and is returned untouched. The CLI records the prompt once per
 *  conversation (`systemPromptSnapshot`), so a resumed session keeps whatever
 *  it started with until the next compaction. */
export function withQuestionRouting(
  systemPrompt: Options["systemPrompt"],
  input: QuestionRoutingInput,
): Options["systemPrompt"] {
  if (
    typeof systemPrompt !== "object" ||
    Array.isArray(systemPrompt) ||
    systemPrompt.type !== "preset" ||
    !questionRoutingEnabled(input)
  ) {
    return systemPrompt;
  }
  const existing = systemPrompt.append?.trim();
  return {
    ...systemPrompt,
    append: existing ? `${existing}\n\n${QUESTION_ROUTING_PROMPT}` : QUESTION_ROUTING_PROMPT,
  };
}

/** A `UserPromptSubmit` hook for a resumed, loaded or forked session: it
 *  carries the rule in as additional context on the session's first prompt,
 *  then stays silent. Such a session keeps the system prompt recorded when the
 *  conversation began, so `withQuestionRouting` cannot reach it. `SessionStart`
 *  would be the natural event, but the CLI fires it before the SDK's callback
 *  hooks are registered: measured 2026-11-19 over ACP stdio, a `SessionStart`
 *  callback was registered and never called on `session/load`. Register this
 *  only where `withQuestionRouting` applied the rule. A session that already
 *  began with the rule gets it once more; the adapter cannot read the recorded
 *  prompt to tell. */
export function questionRoutingResumeHook(): HookCallback {
  let delivered = false;
  return async () => {
    if (delivered) return { continue: true };
    delivered = true;
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: QUESTION_ROUTING_PROMPT,
      },
    };
  };
}
