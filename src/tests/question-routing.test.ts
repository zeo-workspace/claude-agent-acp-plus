import { describe, it, expect } from "vitest";
import {
  ASK_QUESTIONS_IN_CARDS_META_KEY,
  QUESTION_ROUTING_PROMPT,
  questionRoutingEnabled,
  questionRoutingResumeHook,
  withQuestionRouting,
  type QuestionRoutingInput,
} from "../question-routing.js";

const enabled: QuestionRoutingInput = {
  formElicitation: true,
  meta: undefined,
  userTools: undefined,
  userDisallowedTools: undefined,
};
const preset = { type: "preset", preset: "claude_code" } as const;

describe("questionRoutingEnabled", () => {
  it("is on when the client renders forms and said nothing else", () => {
    expect(questionRoutingEnabled(enabled)).toBe(true);
  });

  it("is off without form elicitation: the tool is disabled then", () => {
    expect(questionRoutingEnabled({ ...enabled, formElicitation: false })).toBe(false);
  });

  it("is off only for an explicit false in _meta", () => {
    const off = { [ASK_QUESTIONS_IN_CARDS_META_KEY]: false };
    expect(questionRoutingEnabled({ ...enabled, meta: off })).toBe(false);
    const truthy = { [ASK_QUESTIONS_IN_CARDS_META_KEY]: "false" };
    expect(questionRoutingEnabled({ ...enabled, meta: truthy })).toBe(true);
    expect(questionRoutingEnabled({ ...enabled, meta: null })).toBe(true);
  });

  it("is off when the client disallowed the tool", () => {
    expect(
      questionRoutingEnabled({ ...enabled, userDisallowedTools: ["WebFetch", "AskUserQuestion"] }),
    ).toBe(false);
  });

  it("follows an explicit tool list", () => {
    expect(questionRoutingEnabled({ ...enabled, userTools: ["Read", "Edit"] })).toBe(false);
    expect(questionRoutingEnabled({ ...enabled, userTools: ["Read", "AskUserQuestion"] })).toBe(
      true,
    );
    expect(
      questionRoutingEnabled({ ...enabled, userTools: { type: "preset", preset: "claude_code" } }),
    ).toBe(true);
  });
});

describe("withQuestionRouting", () => {
  it("sets append on a bare preset", () => {
    expect(withQuestionRouting(preset, enabled)).toEqual({
      ...preset,
      append: QUESTION_ROUTING_PROMPT,
    });
  });

  it("keeps the client's append first and its other preset options", () => {
    const result = withQuestionRouting(
      { ...preset, append: "client text\n", excludeDynamicSections: true },
      enabled,
    );
    expect(result).toEqual({
      ...preset,
      append: `client text\n\n${QUESTION_ROUTING_PROMPT}`,
      excludeDynamicSections: true,
    });
  });

  it("leaves every full replacement of the preset untouched", () => {
    expect(withQuestionRouting("custom", enabled)).toBe("custom");
    expect(withQuestionRouting(["a", "b"], enabled)).toEqual(["a", "b"]);
    const custom = { type: "custom", prompt: "x" } as const;
    expect(withQuestionRouting(custom, enabled)).toBe(custom);
    expect(withQuestionRouting(undefined, enabled)).toBeUndefined();
  });

  it("returns the preset unchanged when disabled", () => {
    expect(withQuestionRouting(preset, { ...enabled, formElicitation: false })).toBe(preset);
  });

  it("states the limits the rule relies on", () => {
    // The tool's input schema caps a call at four questions, and subagents
    // cannot call it at all; the rule is wrong if it stops saying either.
    expect(QUESTION_ROUTING_PROMPT).toMatch(/one to four questions/);
    expect(QUESTION_ROUTING_PROMPT).toMatch(/Subagents cannot ask the user/);
  });
});

describe("questionRoutingResumeHook", () => {
  // The CLI keeps a conversation's first system prompt (systemPromptSnapshot),
  // so a resumed or forked session never sees a rule added to the preset later.
  const signal = new AbortController().signal;
  const prompt = { hook_event_name: "UserPromptSubmit", prompt: "hi" } as never;

  it("carries the rule in on the first prompt only", async () => {
    const hook = questionRoutingResumeHook();
    expect(await hook(prompt, undefined, { signal })).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: QUESTION_ROUTING_PROMPT,
      },
    });
    expect(await hook(prompt, undefined, { signal })).toEqual({ continue: true });
    expect(await hook(prompt, undefined, { signal })).toEqual({ continue: true });
  });

  it("keeps one delivery per hook, so each resumed session gets its own", async () => {
    const first = questionRoutingResumeHook();
    await first(prompt, undefined, { signal });
    const second = questionRoutingResumeHook();
    expect(await second(prompt, undefined, { signal })).toMatchObject({
      hookSpecificOutput: { additionalContext: QUESTION_ROUTING_PROMPT },
    });
  });
});
