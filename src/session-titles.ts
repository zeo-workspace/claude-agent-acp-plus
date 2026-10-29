/**
 * AI-generated session titles.
 *
 * Claude Code titles a new SDK session itself: when it reads the first prompt,
 * it asks a small model for a title and stores it in the transcript as an
 * `ai-title` entry, a few seconds in, and sends no message when it does
 * (upstream #1406 corrected the older claim that it never does). This module
 * asks for the title with the `generate_session_title` control request, which
 * returns the stored title or waits for the one being generated, and publishes
 * it over ACP as a `session_info_update`. Where the CLI does not title the
 * session itself (a resumed session, or nonessential traffic disabled), the
 * same request generates it.
 *
 * {@link SessionTitles} holds the per-session state and is owned by `Session`.
 * `acp-agent.ts` drives it from five places: {@link SessionTitles.onPrompt} and
 * {@link SessionTitles.onAssistantText} to collect text,
 * {@link SessionTitles.onPromptQueued} once a prompt is sent to the CLI,
 * {@link SessionTitles.onTurnEnd} at `session_state_changed: idle`, and
 * {@link SessionTitles.reset} on `conversation_reset`.
 */

import type { ContentBlock, PromptRequest } from "@agentclientprotocol/sdk";
import { getSessionInfo, type Query, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent, Session } from "./acp-agent.js";

const MAX_TITLE_LENGTH = 256;

/** How much session text the title is generated from. The CLI caps its own
 *  title input at the same 1000 trailing characters. */
const MAX_TITLE_CONTEXT_LENGTH = 1000;

/** Below this the generator returns null without calling the model, so there is
 *  nothing to gain by asking yet. */
const MIN_TITLE_CONTEXT_LENGTH = 10;

/** `generateSessionTitle` is present on the SDK's runtime `Query` class but is
 *  not declared in `sdk.d.ts` (0.3.220), so it is reached through this optional
 *  shape rather than the published interface. */
type TitleCapableQuery = Query & {
  generateSessionTitle?: (
    description: string,
    options?: { persist?: boolean },
  ) => Promise<string | null>;
};

/** A title already stored for the session, published when generation is
 *  unavailable or yields nothing. */
type TitleFallback = { title: string; lastModified: number };

export function sanitizeTitle(text: string): string {
  // Replace newlines and collapse whitespace
  const sanitized = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

/** Rolling text a title is generated from: `previous` plus `text`, keeping only
 *  the trailing {@link MAX_TITLE_CONTEXT_LENGTH} characters. */
export function appendTitleContext(previous: string | undefined, text: string): string {
  const next = (previous ?? "") + text;
  return next.length > MAX_TITLE_CONTEXT_LENGTH ? next.slice(-MAX_TITLE_CONTEXT_LENGTH) : next;
}

/** The text chunks of a prompt, one per line. */
function promptText(prompt: PromptRequest["prompt"]): string {
  return prompt.flatMap((chunk) => (chunk.type === "text" ? [chunk.text] : [])).join("\n");
}

/** Whether this SDK still offers on-demand title generation. */
function supportsTitleGeneration(query: Query): boolean {
  return typeof (query as TitleCapableQuery).generateSessionTitle === "function";
}

/** One session's title: the text a generated title is derived from, whether a
 *  title has been settled on, and the last one published. Created with the
 *  session and reachable as `session.titles`. */
export class SessionTitles {
  /** Last title pushed to the client via `session_info_update`, so an unchanged
   *  title is never re-notified. Undefined until the first push. */
  private lastTitle?: string;

  /** Rolling tail of this session's own user + assistant text, capped at
   *  {@link MAX_TITLE_CONTEXT_LENGTH}. Dropped once a title exists. */
  private context?: string;

  /** Set once this session has a title or has asked for one. A title is
   *  generated at most once per session: the SDK reports a generated title in
   *  the same field as a user `/rename`, so re-titling could silently overwrite
   *  one. Released by {@link reset}, and when generation yields nothing. */
  private settled = false;

  /** Whether {@link onPromptQueued} asked for a title from the latest prompt
   *  and did not fail. A turn end then does not ask again: like the CLI, a
   *  prompt that yields no title gets one try, and the next prompt tries
   *  again. A request that throws clears it, so the turn end asks as before
   *  (story 062, R4.2). */
  private askedAtPrompt = false;

  /** Set once a real title — stored or generated — has been published, so a
   *  generation still in flight never replaces it with a late result. */
  private titled = false;

  constructor(
    private readonly agent: ClaudeAcpAgent,
    private readonly sessionId: string,
  ) {}

  /** Collect a prompt's own text for the title, skipping openers not worth
   *  titling after. No-op once the title is settled. */
  onPrompt(prompt: PromptRequest["prompt"]): void {
    if (this.settled) {
      return;
    }
    this.context = appendTitleContext(this.context, `\n${promptText(prompt)}\n`);
  }

  /** Ask for the title as soon as a prompt is sent to the CLI, instead of
   *  waiting for `idle`, which comes only after the whole turn and its
   *  background tasks. The CLI answers `generate_session_title` while the turn
   *  runs, with the title it stored or is generating, so this makes no second
   *  model call. The prompt alone is the description, because the CLI titles
   *  from the prompt alone. */
  onPromptQueued(session: Session, prompt: PromptRequest["prompt"]): void {
    this.askedAtPrompt = false;
    // `session.cancelled` is not checked: after a cancelled turn it stays set
    // until the next turn starts, which is after this prompt is queued.
    if (this.settled || session.queryClosed || !supportsTitleGeneration(session.query)) {
      return;
    }
    const description = promptText(prompt).trim();
    if (description.length < MIN_TITLE_CONTEXT_LENGTH) {
      return;
    }
    this.askedAtPrompt = true;
    this.startGeneration(() => this.titleFromPrompt(session, description));
  }

  /** Collect the assistant's own answer for the title. Chunks are appended
   *  verbatim so streamed text reassembles. No-op once the title is settled. */
  onAssistantText(content: ContentBlock): void {
    if (this.settled || content.type !== "text") {
      return;
    }
    this.context = appendTitleContext(this.context, content.text);
  }

  /** Drop the title state so the next turn re-evaluates. Used on
   *  `conversation_reset`, which mounts a fresh transcript. */
  reset(): void {
    this.settled = false;
    this.askedAtPrompt = false;
    this.titled = false;
    this.context = undefined;
    this.lastTitle = undefined;
  }

  /** Turn-end title handling. `idle` is the SDK's turn-over signal, so it is
   *  when a title may have landed or become generatable.
   *
   *  `info.customTitle` is non-empty only once the session file holds a real
   *  title — a user `/rename` or one generated earlier; the SDK folds both into
   *  that one field. Adopt it and latch, so neither is ever titled over.
   *
   *  With no title yet, ask the SDK to generate one in the background: it is a
   *  ~2s small-model call and turn-end must not wait on it. Only when that is
   *  not possible do we fall back to `summary`, which for an SDK-driven session
   *  is just the raw first prompt. */
  async onTurnEnd(session: Session): Promise<void> {
    const info = await this.readSessionInfo(session);

    if (info?.customTitle) {
      this.settled = true;
      this.titled = true;
      this.context = undefined;
      await this.publish(info.customTitle, info.lastModified);
      return;
    }

    const fallback = info?.summary
      ? { title: info.summary, lastModified: info.lastModified }
      : undefined;

    if (!this.askedAtPrompt && this.canRequest(session)) {
      const description = this.context?.trim() ?? "";
      this.startGeneration(() => this.requestGenerateTitle(session, description, fallback));
      return;
    }
    // Only while this session has no title of its own: `summary` degrades to the
    // raw first prompt, which must never overwrite a generated title if the
    // persisted one is slow to show up in `info`.
    if (fallback && !this.settled) {
      await this.publish(fallback.title, fallback.lastModified);
    }
  }

  /** Read the SDK's stored info for this session. A missing session file or read
   *  error is non-fatal: the title is best-effort and another turn will retry. */
  private async readSessionInfo(session: Session): Promise<SDKSessionInfo | undefined> {
    try {
      return await getSessionInfo(this.sessionId, { dir: session.cwd });
    } catch (error) {
      this.agent.logger.error(`Session ${this.sessionId}: failed to read session info: ${error}`);
      return undefined;
    }
  }

  /** Notify the client of a title, unless it is the one we last sent. */
  private async publish(rawTitle: string, lastModified: number): Promise<void> {
    const title = sanitizeTitle(rawTitle);
    if (title === this.lastTitle) {
      return;
    }
    this.lastTitle = title;
    await this.agent.client.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date(lastModified).toISOString(),
      },
    });
  }

  /** Whether to ask the SDK for a generated title now: once per session, on a
   *  live query, with enough collected text for the generator to work with. */
  private canRequest(session: Session): boolean {
    if (this.settled || session.queryClosed || session.cancelled) {
      return false;
    }
    if (!supportsTitleGeneration(session.query)) {
      return false;
    }
    return (this.context?.trim().length ?? 0) >= MIN_TITLE_CONTEXT_LENGTH;
  }

  /** Latch the title and run `generation` in the background, so neither the
   *  prompt nor turn-end waits on a model call. */
  private startGeneration(generation: () => Promise<void>): void {
    this.settled = true;
    void generation().catch((error) => {
      this.agent.logger.error(`Session ${this.sessionId}: session title update failed: ${error}`);
    });
  }

  /** The prompt-time title: the one the session file already holds (a resumed
   *  session's title, or a `/rename`), else one generated from `description`.
   *  The file is read first because the CLI checks only the titles it holds in
   *  memory before generating one. */
  private async titleFromPrompt(session: Session, description: string): Promise<void> {
    const info = await this.readSessionInfo(session);
    if (this.agent.sessions[this.sessionId] !== session || this.titled) {
      return;
    }
    if (info?.customTitle) {
      this.titled = true;
      this.context = undefined;
      await this.publish(info.customTitle, info.lastModified);
      return;
    }
    const fallback = info?.summary
      ? { title: info.summary, lastModified: info.lastModified }
      : undefined;
    await this.requestGenerateTitle(session, description, fallback, true);
  }

  /** Generate a title from `description` and publish it. `persist` writes it
   *  to the session file, which is what carries it into `session/list` and
   *  `session/load`. A null or failed generation releases the latch so a later
   *  prompt or turn end retries, and publishes `fallback` (the stored summary)
   *  so a backend that can't generate titles is no worse off than before. A
   *  prompt-time request that throws publishes nothing and lets the turn end
   *  ask again. */
  private async requestGenerateTitle(
    session: Session,
    description: string,
    fallback: TitleFallback | undefined,
    atPrompt = false,
  ): Promise<void> {
    let title: string | null = null;

    try {
      title =
        (await (session.query as TitleCapableQuery).generateSessionTitle?.(description, {
          persist: true,
        })) ?? null;
    } catch (error) {
      this.agent.logger.error(
        `Session ${this.sessionId}: failed to generate a session title: ${error}`,
      );
      if (atPrompt) {
        // The turn end titles it instead, from the prompt and the reply; the
        // raw-prompt summary is not published in between.
        this.askedAtPrompt = false;
        this.settled = false;
        return;
      }
    }

    // A session torn down or replaced while the title was in flight must not
    // adopt it, and neither may one that got its title meanwhile.
    if (this.agent.sessions[this.sessionId] !== session || this.titled) {
      return;
    }

    if (!title) {
      this.settled = false;

      if (fallback) {
        await this.publish(fallback.title, fallback.lastModified);
      }
      return;
    }

    this.titled = true;
    this.context = undefined;
    await this.publish(title, Date.now());
  }
}
