import { describe, expect, it, vi } from "vitest";
import {
  askSideQuestion,
  BTW_MAX_QUESTION_CHARS,
  formatSideAnswer,
  parseBtwInvocation,
  parseSideQuestionRequest,
} from "../side-question.js";

describe("parseBtwInvocation", () => {
  it("takes the question after /btw", () => {
    expect(parseBtwInvocation("/btw what does foo do?")).toEqual({
      kind: "ask",
      question: "what does foo do?",
    });
  });

  it("keeps a multi-line question and trims only its ends", () => {
    expect(parseBtwInvocation("/btw  first line\n second line \n")).toEqual({
      kind: "ask",
      question: "first line\n second line",
    });
  });

  it("answers usage for /btw with no question", () => {
    expect(parseBtwInvocation("/btw")).toEqual({ kind: "usage" });
    expect(parseBtwInvocation("/btw   \n")).toEqual({ kind: "usage" });
  });

  it("is not /btw for other text", () => {
    expect(parseBtwInvocation("/btwx hi")).toBeNull();
    expect(parseBtwInvocation("btw hi")).toBeNull();
    expect(parseBtwInvocation(" /btw hi")).toBeNull();
    expect(parseBtwInvocation("/rewind")).toBeNull();
  });
});

describe("parseSideQuestionRequest", () => {
  it("accepts a session id and a question", () => {
    expect(parseSideQuestionRequest({ sessionId: "s1", question: " why? " })).toEqual({
      sessionId: "s1",
      question: "why?",
    });
  });

  it.each([
    [{ question: "why?" }],
    [{ sessionId: "", question: "why?" }],
    [{ sessionId: "s1" }],
    [{ sessionId: "s1", question: "   " }],
    [{ sessionId: "s1", question: 42 }],
    [null],
  ])("refuses %j", (params) => {
    expect(() => parseSideQuestionRequest(params)).toThrow(/_claude\/btw/);
  });

  it("refuses a question over the limit", () => {
    const question = "x".repeat(BTW_MAX_QUESTION_CHARS + 1);
    expect(() => parseSideQuestionRequest({ sessionId: "s1", question })).toThrow(/at most/);
  });
});

describe("askSideQuestion", () => {
  it("answers through the query's askSideQuestion", async () => {
    const ask = vi.fn().mockResolvedValue({ response: "It parses.", synthetic: false });
    const result = await askSideQuestion({ askSideQuestion: ask }, "what?");
    expect(result).toEqual({ status: "answered", answer: "It parses.", synthetic: false });
    expect(ask).toHaveBeenCalledWith("what?", { signal: undefined });
  });

  it("passes the abort signal through", async () => {
    const ask = vi.fn().mockResolvedValue({ response: "ok", synthetic: true });
    const controller = new AbortController();
    await askSideQuestion({ askSideQuestion: ask }, "q", controller.signal);
    expect(ask).toHaveBeenCalledWith("q", { signal: controller.signal });
  });

  it("names the fallback model when the answer came from one", async () => {
    const ask = vi.fn().mockResolvedValue({
      response: "ok",
      synthetic: false,
      refusalFallback: { originalModel: "a", fallbackModel: "b", content: [] },
    });
    expect(await askSideQuestion({ askSideQuestion: ask }, "q")).toEqual({
      status: "answered",
      answer: "ok",
      synthetic: false,
      fallbackModel: "b",
    });
  });

  it("reports no answer when the CLI returns null", async () => {
    const ask = vi.fn().mockResolvedValue(null);
    expect(await askSideQuestion({ askSideQuestion: ask }, "q")).toEqual({ status: "no_answer" });
  });

  it("reports unsupported when the query has no askSideQuestion", async () => {
    expect(await askSideQuestion({}, "q")).toEqual({ status: "unsupported" });
  });

  it("reports a failure with its message, never throwing", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("control request timed out"));
    expect(await askSideQuestion({ askSideQuestion: ask }, "q")).toEqual({
      status: "failed",
      message: "control request timed out",
    });
  });
});

describe("formatSideAnswer", () => {
  it("frames an answer as an aside", () => {
    expect(formatSideAnswer({ status: "answered", answer: "It parses.", synthetic: false })).toBe(
      "**By the way** (not added to the conversation)\n\nIt parses.",
    );
  });

  it("explains every other outcome", () => {
    expect(formatSideAnswer({ status: "no_answer" })).toMatch(/no answer/i);
    expect(formatSideAnswer({ status: "unsupported" })).toMatch(/Claude Code/);
    expect(formatSideAnswer({ status: "failed", message: "boom" })).toMatch(/boom/);
  });
});
