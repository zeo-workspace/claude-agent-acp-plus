/**
 * `/btw` — a side question answered without entering the conversation (Zeo
 * proposal §6.8, ask 29).
 *
 * The CLI answers a side question through the `side_question` control request,
 * which the SDK exposes as `Query.askSideQuestion(question, { signal })`. It is
 * on the runtime object but absent from the SDK's published types (0.3.325), so
 * it is feature-detected here and a missing method answers `unsupported`
 * instead of throwing. The answer never enters the session's transcript: the
 * model's history is unchanged, and a reloaded session does not replay it.
 *
 * Two ways in, one implementation: the `_claude/btw` ext method, which Zeo
 * sends at once while a turn runs and renders as a dismissable card, and the
 * `/btw <question>` command typed into any client's composer, answered as an
 * agent message chunk.
 */
import { RequestError } from "@agentclientprotocol/sdk";

export const BTW_METHOD = "_claude/btw";
/** Advertised under `agentCapabilities._meta`; bump on a breaking wire change. */
export const BTW_CAPABILITY_KEY = "_claude/btw";
export const BTW_CAPABILITY_VERSION = 1;
/** Generous for a typed or dictated question; refuses a pasted file. */
export const BTW_MAX_QUESTION_CHARS = 8000;

export type BtwInvocation = { kind: "ask"; question: string } | { kind: "usage" };

const BTW_COMMAND = /^\/btw(?=\s|$)/;

/** `/btw <question>` → the question; bare `/btw` → usage; anything else → null.
 *  The command token must be the whole first word, at the very start. */
export function parseBtwInvocation(text: string): BtwInvocation | null {
  const match = text.match(BTW_COMMAND);
  if (!match) return null;
  const question = text.slice(match[0].length).trim();
  return question ? { kind: "ask", question } : { kind: "usage" };
}

export type SideQuestionRequest = { sessionId: string; question: string };

export type SideQuestionResult =
  | { status: "answered"; answer: string; synthetic: boolean; fallbackModel?: string }
  | { status: "no_answer" }
  | { status: "unsupported" }
  | { status: "failed"; message: string };

/** Validate raw JSON-RPC params for `_claude/btw`. */
export function parseSideQuestionRequest(params: unknown): SideQuestionRequest {
  const record =
    params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
  const sessionId = record?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      `${BTW_METHOD} params require a non-empty sessionId`,
    );
  }
  const raw = record?.question;
  const question = typeof raw === "string" ? raw.trim() : "";
  if (!question) {
    throw RequestError.invalidParams(
      undefined,
      `${BTW_METHOD} params require a non-empty question`,
    );
  }
  if (question.length > BTW_MAX_QUESTION_CHARS) {
    throw RequestError.invalidParams(
      undefined,
      `${BTW_METHOD} question must be at most ${BTW_MAX_QUESTION_CHARS} characters`,
    );
  }
  return { sessionId, question };
}

/** The runtime shape of the SDK's answer (`sdk.mjs`, 0.3.325). */
type SdkSideAnswer = {
  response: string;
  synthetic?: boolean;
  refusalFallback?: { originalModel?: string; fallbackModel?: string };
};

/** The part of the SDK `Query` this module reads, method optional. */
export type SideQuestionQuery = {
  askSideQuestion?: (
    question: string,
    options?: { signal?: AbortSignal },
  ) => Promise<SdkSideAnswer | null>;
};

/** Ask one side question. Never throws: every outcome is a result. */
export async function askSideQuestion(
  query: SideQuestionQuery,
  question: string,
  signal?: AbortSignal,
): Promise<SideQuestionResult> {
  if (typeof query.askSideQuestion !== "function") {
    return { status: "unsupported" };
  }
  try {
    const answer = await query.askSideQuestion(question, { signal });
    if (answer === null || typeof answer?.response !== "string") {
      return { status: "no_answer" };
    }
    const fallbackModel = answer.refusalFallback?.fallbackModel;
    return {
      status: "answered",
      answer: answer.response,
      synthetic: answer.synthetic ?? false,
      ...(fallbackModel ? { fallbackModel } : {}),
    };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export const BTW_USAGE_TEXT =
  "Usage: `/btw <question>` — ask something on the side. The answer is not added to the conversation.";

/** Markdown for the `/btw` command typed into a composer. */
export function formatSideAnswer(result: SideQuestionResult): string {
  switch (result.status) {
    case "answered":
      return `**By the way** (not added to the conversation)\n\n${result.answer}`;
    case "no_answer":
      return "The side question got no answer.";
    case "unsupported":
      return "This Claude Code version cannot answer side questions (`/btw`).";
    case "failed":
      return `The side question failed: ${result.message}`;
    default: {
      // Exhaustive: a new status fails to compile here.
      const unknownStatus: never = result;
      return `The side question ended unexpectedly (${String(unknownStatus)}).`;
    }
  }
}
