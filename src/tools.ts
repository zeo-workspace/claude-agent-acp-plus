import {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentInput,
  AgentOutput,
  AskUserQuestionInput,
  BashInput,
  BashOutput,
  FileEditInput,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  ReportFindingsInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
  WebSearchOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  WebSearchResultBlock,
  WebSearchToolResultBlockParam,
  WebSearchToolResultError,
} from "@anthropic-ai/sdk/resources";
import {
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultBlockParam,
  BetaBashCodeExecutionToolResultError,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultBlockParam,
  BetaCodeExecutionToolResultError,
  BetaImageBlockParam,
  BetaRequestMCPToolResultBlockParam,
  BetaTextEditorCodeExecutionCreateResultBlock,
  BetaTextEditorCodeExecutionStrReplaceResultBlock,
  BetaTextEditorCodeExecutionToolResultBlockParam,
  BetaTextEditorCodeExecutionToolResultError,
  BetaTextEditorCodeExecutionViewResultBlock,
  BetaToolReferenceBlock,
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaToolSearchToolResultError,
  BetaToolSearchToolSearchResultBlock,
  BetaWebFetchBlock,
  BetaWebFetchToolResultBlockParam,
  BetaWebFetchToolResultErrorBlock,
  BetaWebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import path from "node:path";

/**
 * Union of all possible content types that can appear in tool results from the Anthropic SDK.
 * These are transformed to valid ACP ContentBlock types by toValidAcpContent().
 */
type ToolResultContent =
  | TextBlockParam
  | ImageBlockParam
  | BetaImageBlockParam
  | BetaToolReferenceBlock
  | BetaToolSearchToolSearchResultBlock
  | BetaToolSearchToolResultError
  | WebSearchResultBlock
  | WebSearchToolResultError
  | BetaWebFetchBlock
  | BetaWebFetchToolResultErrorBlock
  | BetaCodeExecutionResultBlock
  | BetaCodeExecutionToolResultError
  | BetaBashCodeExecutionResultBlock
  | BetaBashCodeExecutionToolResultError
  | BetaTextEditorCodeExecutionViewResultBlock
  | BetaTextEditorCodeExecutionCreateResultBlock
  | BetaTextEditorCodeExecutionStrReplaceResultBlock
  | BetaTextEditorCodeExecutionToolResultError;

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  _meta?: {
    terminal_info?: {
      terminal_id: string;
    };
    terminal_output?: {
      terminal_id: string;
      data: string;
    };
    terminal_exit?: {
      terminal_id: string;
      /** Null when the code is not known (as in `TerminalExitStatus`). */
      exit_code: number | null;
      signal: string | null;
    };
  };
}

/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/** Read a Write tool_use input the way the CLI validates it. Since 2.1.280 the
 *  CLI accepts `path` for `file_path` and `file_text`/`file_content` for
 *  `content` when a model sends those spellings, but the streamed tool_use
 *  block still carries them raw — without this the call renders as
 *  "Preparing file…" with no diff while the write goes through. */
function normalizeWriteInput(input: unknown): FileWriteInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const filePath = raw.file_path ?? (typeof raw.path === "string" ? raw.path : undefined);
  const content = raw.content ?? raw.file_text ?? raw.file_content;
  return { ...raw, file_path: filePath, content } as FileWriteInput;
}

export function toolInfoFromToolUse(
  toolUse: any,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
): ToolInfo {
  const name = toolUse.name;

  switch (name) {
    case "Agent":
    case "Task": {
      const input = toolUse.input as AgentInput | BashInput | undefined;
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && "prompt" in input
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "Bash":
    case "PowerShell": {
      const input = toolUse.input as BashInput | undefined;
      return {
        title: input?.command ? input.command : "Terminal",
        kind: "execute",
        content: supportsTerminalOutput
          ? [{ type: "terminal" as const, terminalId: toolUse.id }]
          : input && input.description
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.description },
                },
              ]
            : [],
      };
    }

    case "Read": {
      const input = toolUse.input as FileReadInput | undefined;
      let limit = "";
      if (input?.limit && input.limit > 0) {
        limit = " (" + (input.offset ?? 1) + " - " + ((input.offset ?? 1) + input.limit - 1) + ")";
      } else if (input?.offset) {
        limit = " (from line " + input.offset + ")";
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : "File";
      return {
        title: "Read " + displayPath + limit,
        kind: "read",
        locations: input?.file_path
          ? [
              {
                path: input.file_path,
                line: input.offset ?? 1,
              },
            ]
          : [],
        content: [],
      };
    }

    case "Write": {
      const input = normalizeWriteInput(toolUse.input);
      let content: ToolCallContent[] = [];
      if (input && input.file_path) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Write ${displayPath}` : "Preparing file…",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Edit": {
      const input = toolUse.input as FileEditInput | undefined;
      let content: ToolCallContent[] = [];
      if (input && input.file_path && (input.old_string || input.new_string)) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: input.old_string || null,
            newText: input.new_string ?? "",
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Edit ${displayPath}` : "Edit",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Glob": {
      const input = toolUse.input as GlobInput | undefined;
      let label = "Find";
      if (input?.path) {
        label += ` \`${input.path}\``;
      }
      if (input?.pattern) {
        label += ` \`${input.pattern}\``;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: input?.path ? [{ path: input.path }] : [],
      };
    }

    case "Grep": {
      const input = toolUse.input as GrepInput | undefined;
      let label = "grep";

      if (input?.["-i"]) {
        label += " -i";
      }
      if (input?.["-n"]) {
        label += " -n";
      }

      if (input?.["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input?.["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input?.["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }

      if (input?.output_mode) {
        switch (input.output_mode) {
          case "files_with_matches":
            label += " -l";
            break;
          case "count":
            label += " -c";
            break;
          case "content":
          default:
            break;
        }
      }

      if (input?.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      if (input?.glob) {
        label += ` --include="${input.glob}"`;
      }

      if (input?.type) {
        label += ` --type=${input.type}`;
      }

      if (input?.multiline) {
        label += " -P";
      }

      if (input?.pattern) {
        label += ` "${input.pattern}"`;
      }

      if (input?.path) {
        label += ` ${input.path}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch": {
      const input = toolUse.input as WebFetchInput;
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "WebSearch": {
      const input = toolUse.input as WebSearchInput | undefined;

      return {
        title: input?.query ? `Search "${input.query}"` : "Web search",
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite": {
      const input = toolUse.input as TodoWriteInput | undefined;
      return {
        title: Array.isArray(input?.todos)
          ? `Update TODOs: ${input.todos.map((todo: any) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };
    }

    case "ReportFindings": {
      const input = toolUse.input as ReportFindingsInput | undefined;
      const findings = input?.findings ?? [];
      return {
        title:
          findings.length === 0
            ? "Report findings: none found"
            : `Report ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
        kind: "think",
        content: findings.map((finding) => ({
          type: "content" as const,
          content: {
            type: "text" as const,
            text: `**${finding.file}${finding.line ? `:${finding.line}` : ""}** — ${finding.summary}`,
          },
        })),
      };
    }

    case "TaskCreate": {
      const input = toolUse.input as TaskCreateInput | undefined;
      return {
        title: input?.subject ? `Create task: ${input.subject}` : "Create task",
        kind: "think",
        content: [],
      };
    }

    case "TaskUpdate": {
      const input = toolUse.input as TaskUpdateInput | undefined;
      return {
        title: input?.subject ? `Update task: ${input.subject}` : "Update task",
        kind: "think",
        content: [],
      };
    }

    case "TaskList": {
      return {
        title: "List tasks",
        kind: "think",
        content: [],
      };
    }

    case "TaskGet": {
      return {
        title: "Get task",
        kind: "think",
        content: [],
      };
    }

    case "ExitPlanMode": {
      const planInput = toolUse.input as { plan?: string } | undefined;
      return {
        title: "Approve Plan",
        kind: "switch_mode",
        content: planInput?.plan
          ? [{ type: "content" as const, content: { type: "text" as const, text: planInput.plan } }]
          : [],
      };
    }

    case "Skill": {
      const input = toolUse.input as { skill?: string; args?: string } | undefined;
      const skillName = input?.skill;
      return {
        title: skillName ? `Load skill: ${skillName}` : "Load skill",
        kind: "other",
        content: [],
      };
    }

    case "AskUserQuestion": {
      const input = toolUse.input as Partial<AskUserQuestionInput> | undefined;
      const questions = Array.isArray(input?.questions) ? input.questions : [];
      return {
        title:
          questions.length === 1 && questions[0]?.question
            ? questions[0].question
            : "Asking for your input",
        kind: "other",
        content: questions
          .filter((q) => typeof q?.question === "string")
          .map((q) => ({
            type: "content" as const,
            content: { type: "text" as const, text: q.question },
          })),
      };
    }

    case "Other": {
      const input = toolUse.input;
      let output;
      try {
        output = JSON.stringify(input, null, 2);
      } catch {
        output = typeof input === "string" ? input : "{}";
      }
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${output}\`\`\``,
            },
          },
        ],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

/**
 * Narrow the untyped message-level `tool_use_result` toward a per-tool Output
 * shape: rejects everything but a plain non-null object (arrays pass a bare
 * `typeof === "object"` check, so they're excluded here). The returned value
 * is only *nominally* typed — it arrives over the wire from arbitrary CLI
 * versions, so each caller must still guard the specific fields it reads
 * before trusting them.
 */
function structuredResult<T extends object>(toolUseResult: unknown): T | undefined {
  return toolUseResult !== null &&
    typeof toolUseResult === "object" &&
    !Array.isArray(toolUseResult)
    ? (toolUseResult as T)
    : undefined;
}

/**
 * Strip the model-directed trailer from a raw Agent/Task tool_result text:
 * a `<usage>…</usage>` totals block and/or an
 * `agentId: <id> (use SendMessage …)` continuation line at the end of the
 * text. Both patterns are tail-anchored and independent (older CLIs emit
 * variants with only one of them), so a format change makes them stop
 * matching rather than mangle the report.
 */
function stripAgentTrailer(text: string): string {
  return stripAgentIdLine(stripUsageBlock(text));
}

const USAGE_OPEN = "<usage>";
const USAGE_CLOSE = "</usage>";

/** Remove a trailing `<usage>…</usage>` block, plus trailing whitespace and
 *  one preceding newline. Matches from the *last* `<usage>` so a report that
 *  merely mentions the marker earlier isn't truncated at the mention. */
function stripUsageBlock(text: string): string {
  const body = text.trimEnd();
  if (!body.endsWith(USAGE_CLOSE)) {
    return text;
  }
  const open = body.lastIndexOf(USAGE_OPEN, body.length - USAGE_CLOSE.length - USAGE_OPEN.length);
  if (open === -1) {
    return text;
  }
  return body.slice(0, open > 0 && body[open - 1] === "\n" ? open - 1 : open);
}

/** The continuation line, anchored to a whole line so the regex has a single
 *  start position and no ambiguous repetition (`[\w-]+` can't consume the
 *  following space, `[^)]*` can't consume the closing paren) — it runs in
 *  linear time on any input. */
const AGENT_ID_LINE = /^agentId: [\w-]+ \([^)]*\)$/;

/** Remove a final `agentId: <id> (…)` line, plus trailing whitespace and the
 *  newline that preceded the line. */
function stripAgentIdLine(text: string): string {
  const body = text.trimEnd();
  const lineStart = body.lastIndexOf("\n") + 1;
  if (!AGENT_ID_LINE.test(body.slice(lineStart))) {
    return text;
  }
  return body.slice(0, Math.max(lineStart - 1, 0));
}

/** Apply {@link stripAgentTrailer} across a raw tool_result `content` (plain
 *  string or block array), leaving non-text blocks untouched. */
function stripAgentTrailerFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripAgentTrailer(content);
  }
  if (Array.isArray(content)) {
    return content.map((block) =>
      block !== null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
        ? { ...block, text: stripAgentTrailer(block.text) }
        : block,
    );
  }
  return content;
}

export function toolUpdateFromToolResult(
  toolResult:
    | ToolResultBlockParam
    | BetaToolResultBlockParam
    | BetaWebSearchToolResultBlockParam
    | BetaWebFetchToolResultBlockParam
    | WebSearchToolResultBlockParam
    | BetaCodeExecutionToolResultBlockParam
    | BetaBashCodeExecutionToolResultBlockParam
    | BetaTextEditorCodeExecutionToolResultBlockParam
    | BetaRequestMCPToolResultBlockParam
    | BetaToolSearchToolResultBlockParam,
  toolUse: any | undefined,
  supportsTerminalOutput: boolean = false,
  toolUseResult?: unknown,
): ToolUpdate {
  if (
    "is_error" in toolResult &&
    toolResult.is_error &&
    toolResult.content &&
    toolResult.content.length > 0 &&
    !((toolUse?.name === "Bash" || toolUse?.name === "PowerShell") && supportsTerminalOutput)
  ) {
    // Only return errors
    return toAcpContentUpdate(toolResult.content, true);
  }

  // Shared raw-text fallback: renders the tool_result content the model saw.
  // The structured cases below fall back to this when `tool_use_result` is
  // absent or fails its shape guard (older CLIs, replayed sessions).
  const rawContentUpdate = () =>
    toAcpContentUpdate(toolResult.content, "is_error" in toolResult ? toolResult.is_error : false);

  switch (toolUse?.name) {
    case "Read": {
      // The raw tool_result text is the model-facing view: line-numbered
      // content plus any appended <system-reminder> blocks (malicious-code
      // checks, memory staleness notes, …) that clients shouldn't see. The
      // structured FileReadOutput carries the clean content — rebuild the
      // line-numbered view from it. Non-text variants (image/notebook/pdf)
      // fall back to the raw content blocks, which already render fine.
      const structuredRead = structuredResult<FileReadOutput>(toolUseResult);
      if (
        structuredRead?.type === "text" &&
        typeof structuredRead.file?.content === "string" &&
        // An empty file has nothing to line-number; keep the raw view (the
        // model-facing "file is empty" note) rather than a phantom blank line.
        structuredRead.file.content.length > 0
      ) {
        // startLine is typed non-optional but defended anyway; a Read's
        // `offset` input is the same 1-based starting line, so it beats a
        // blind 1 when an emitter omits the field.
        const startLine =
          structuredRead.file.startLine ??
          (toolUse.input as FileReadInput | undefined)?.offset ??
          1;
        // A trailing newline is a line terminator, not an extra line — don't
        // number a phantom empty line after it.
        let numbered = structuredRead.file.content
          .replace(/\n$/, "")
          .split("\n")
          .map((line, i) => `${startLine + i}\t${line}`)
          .join("\n");
        // The model-facing truncation banner doesn't survive reconstruction
        // from file.content (the SDK flag exists for exactly this case) —
        // re-establish it so a partial first page doesn't read as the whole
        // file.
        if (structuredRead.file.truncatedByTokenCap) {
          const { numLines, totalLines } = structuredRead.file;
          const detail =
            typeof numLines === "number" && typeof totalLines === "number"
              ? `: showing ${numLines} of ${totalLines} lines`
              : "";
          numbered += `\n[File truncated${detail}]`;
        }
        return {
          content: [
            {
              type: "content",
              content: { type: "text", text: markdownEscape(numbered) },
            },
          ],
        };
      }
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content:
              content.type === "text"
                ? {
                    type: "text",
                    text: markdownEscape(content.text),
                  }
                : toAcpContentBlock(content, false),
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content),
              },
            },
          ],
        };
      }
      return {};
    }

    case "Bash":
    case "PowerShell": {
      const result = toolResult.content;
      // The terminal was announced under the tool_use's own id (see
      // `toolInfoFromToolUse`), so key the output/exit metas off that: it is the
      // id the client actually created a terminal for. `toolResult.tool_use_id`
      // is the same value whenever present — the caller looks the tool_use up by
      // it — so preferring `toolUse.id` only adds a source for the case where the
      // result block carries no id at all. Anything that isn't a non-empty
      // string is no id at all: `""` matches no terminal, and stringifying a
      // present-but-undefined field would invent the literal `"undefined"`.
      const terminalIdOf = (id: unknown): string | undefined =>
        typeof id === "string" && id.length > 0 ? id : undefined;
      const terminalId: string | undefined =
        terminalIdOf(toolUse?.id) ??
        terminalIdOf("tool_use_id" in toolResult ? toolResult.tool_use_id : undefined);
      const isError = "is_error" in toolResult && toolResult.is_error;

      // Extract output and exit code from either format:
      // 1. The structured BashOutput (message-level tool_use_result): its
      //    stdout/stderr exclude the model-directed suffixes the raw text
      //    carries (stale-read hints, gh rate-limit hints, the
      //    persisted-output wrapper for too-large outputs — the interruption
      //    and truncation facts those carried are re-established from the
      //    structured flags below). Skipped for image output (the raw content
      //    array carries the actual image blocks) and backgrounded commands
      //    (the raw text carries the background-task notice; structured
      //    stdout may be empty).
      // 2. BetaBashCodeExecutionResultBlock: { type: "bash_code_execution_result", stdout, stderr, return_code }
      // 3. Plain string content from a regular tool_result
      // 4. Array content (e.g. [{ type: "text", text: "..." }] for stdout,
      //    or [{ type: "image", source: {...} }] when the local Bash tool
      //    produces an image, e.g. piping a base64 data URI)
      let output = "";
      // Parity item 92 (upstream #1252): the code is the one the result names.
      // `null` means "not known" — `TerminalExitStatus` allows it — and is used
      // only where the command did NOT fail: a client such as Zeo marks a
      // command failed only on a non-null, non-zero code, so a known failure
      // keeps a number (the `Exit code N` the text names, else 1).
      let exitCode: number | null = isError ? 1 : 0;
      let codeFromResult = false;

      const structuredBash = structuredResult<BashOutput>(toolUseResult);
      if (
        structuredBash &&
        typeof structuredBash.stdout === "string" &&
        typeof structuredBash.stderr === "string" &&
        !structuredBash.isImage &&
        structuredBash.backgroundTaskId === undefined
      ) {
        output = [structuredBash.stdout, structuredBash.stderr].filter(Boolean).join("\n");
        // Two raw-text notices don't survive the structured stdout/stderr —
        // re-establish them so the client isn't shown a clean-looking result:
        // the CLI appends its abort marker only to the model-facing text, and
        // an aborted command isn't a success, so synthesize a failing exit
        // code when the result wasn't already an error.
        if (structuredBash.interrupted) {
          output = [output, "[Command was aborted before completion]"].filter(Boolean).join("\n");
          exitCode = 1;
        } else if (structuredBash.returnCodeInterpretation !== undefined && !isError) {
          // Claude Code accepted a non-zero code as a success (grep's "No
          // matches found"); the result does not carry which code it was.
          exitCode = null;
        }
        // Structured stdout is clipped (~30k chars) when the full output was
        // persisted to disk; without this note the clip is silent and the
        // path to the full output is lost.
        if (typeof structuredBash.persistedOutputPath === "string") {
          const size =
            typeof structuredBash.persistedOutputSize === "number"
              ? ` (${structuredBash.persistedOutputSize} bytes total)`
              : "";
          output = [
            output,
            `[Output truncated${size}: full output saved to ${structuredBash.persistedOutputPath}]`,
          ]
            .filter(Boolean)
            .join("\n");
        }
      } else if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        result.type === "bash_code_execution_result"
      ) {
        const bashResult = result as BetaBashCodeExecutionResultBlock;
        output = [bashResult.stdout, bashResult.stderr].filter(Boolean).join("\n");
        exitCode = bashResult.return_code;
        codeFromResult = true;
      } else if (typeof result === "string") {
        output = result;
      } else if (Array.isArray(result) && result.length > 0) {
        const textOnly = result.every(
          (c: any) => c && typeof c === "object" && typeof c.text === "string",
        );
        if (textOnly) {
          output = result.map((c: any) => c.text).join("\n");
        } else {
          // Image (or mixed non-text) content. Binary payloads can't be
          // streamed through the terminal-output _meta channel, so bypass
          // it and surface the blocks as ACP content. This handles the
          // local Bash tool's image output, which previously failed the
          // text-only guard and was silently dropped.
          return toAcpContentUpdate(result, isError);
        }
      }

      if (isError && !codeFromResult) exitCode = failureExitCode(output) ?? 1;
      // A command sent to the background is still running: the result only
      // announces it. The consumer withholds this exit while the task is live
      // and sends the real one when the task ends (`backgroundTerminals`).
      if (structuredBash?.backgroundTaskId !== undefined) exitCode = null;

      // Without a terminal id there is nothing the client can reconcile these
      // metas against, and emitting them anyway strands the output: a client that
      // buffers output/exit for terminals it has not been told about (Zed keeps
      // them in `pending_terminal_output`/`pending_terminal_exit`, drained only on
      // a matching create) would hold them forever behind an id that never
      // arrives, showing an empty terminal. Fall through to the code-block
      // rendering below instead.
      if (supportsTerminalOutput && terminalId !== undefined) {
        return {
          content: [{ type: "terminal" as const, terminalId }],
          _meta: {
            terminal_info: {
              terminal_id: terminalId,
            },
            terminal_output: {
              terminal_id: terminalId,
              data: output,
            },
            terminal_exit: {
              terminal_id: terminalId,
              exit_code: exitCode,
              signal: null,
            },
          },
        };
      }
      // Fallback: format output as a code block without terminal _meta
      if (output.trim()) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        };
      }
      return {};
    }

    case "Agent":
    case "Task": {
      // The raw tool_result text ends with a model-directed trailer (an
      // `agentId: … (use SendMessage …)` line plus a `<usage>` totals block)
      // that ACP clients shouldn't see. The message-level `tool_use_result`
      // carries the structured AgentOutput whose `content` is the subagent's
      // report without the trailer — render from it when present (per the SDK
      // 0.3.207 guidance) and fall back to the raw text otherwise (older CLIs,
      // replayed sessions).
      // Narrowed to the full union, not the completed variant — the status
      // check below is what discriminates it, and pre-narrowing would let
      // future field reads typecheck against a variant the runtime value may
      // not be.
      const structured = structuredResult<AgentOutput>(toolUseResult);
      if (
        structured?.status === "completed" &&
        Array.isArray(structured.content) &&
        // A completed subagent can end with zero text blocks; an empty
        // structured render would beat the raw fallback for no benefit.
        structured.content.length > 0
      ) {
        return toAcpContentUpdate(
          structured.content,
          "is_error" in toolResult ? toolResult.is_error : false,
        );
      }
      // No structured report to render from (replayed sessions —
      // getSessionMessages doesn't expose the transcript's toolUseResult —
      // and older CLIs). The SDK advises rendering from tool_use_result
      // instead of parsing the text, but with no structured value the
      // tail-anchored strip is the only cleanup available; if the trailer
      // format changes it simply stops matching and the full raw text
      // renders, no worse than before.
      return toAcpContentUpdate(
        stripAgentTrailerFromContent(toolResult.content),
        "is_error" in toolResult ? toolResult.is_error : false,
      );
    }

    case "Skill": {
      return {};
    }

    case "Edit": // Edit is handled in hooks
    case "Write": {
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    case "WebSearch": {
      // The raw tool_result text is a model-directed dump ("Web search
      // results for query: …\n\nLinks: [{…json…}]"). The structured
      // WebSearchOutput carries the hits — render them the way server-side
      // web_search_result blocks render ("Title (url)").
      const structuredSearch = structuredResult<WebSearchOutput>(toolUseResult);
      if (structuredSearch && Array.isArray(structuredSearch.results)) {
        const lines = structuredSearch.results.flatMap((entry) =>
          typeof entry === "string"
            ? [entry]
            : Array.isArray(entry?.content)
              ? // tool_use_result arrives untyped across CLI version skew —
                // skip off-spec hits rather than rendering
                // "undefined (undefined)" lines.
                entry.content.flatMap((hit) =>
                  typeof hit?.title === "string" && typeof hit?.url === "string"
                    ? [formatWebSearchHit(hit)]
                    : [],
                )
              : [],
        );
        if (lines.length > 0) {
          return {
            content: [
              {
                type: "content",
                content: { type: "text", text: lines.join("\n") },
              },
            ],
          };
        }
      }
      return rawContentUpdate();
    }

    default: {
      return rawContentUpdate();
    }
  }
}

/** One display format for a web-search hit, shared by the structured
 *  WebSearchOutput render and the server-side `web_search_result` block so
 *  the two paths can't drift. */
function formatWebSearchHit(hit: { title: string; url: string }): string {
  return `${hit.title} (${hit.url})`;
}

function toAcpContentUpdate(
  content: any,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: any) => ({
        type: "content" as const,
        content: toAcpContentBlock(c, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null && "type" in content) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

function toAcpContentBlock(content: ToolResultContent, isError: boolean): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  switch (content.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${content.text}\n\`\`\`` : content.text,
      };
    case "image":
      if (content.source.type === "base64") {
        return {
          type: "image" as const,
          data: content.source.data,
          mimeType: content.source.media_type,
        };
      }
      // URL and file-based images can't be converted to ACP format (requires data)
      return wrapText(
        content.source.type === "url"
          ? `[image: ${content.source.url}]`
          : "[image: file reference]",
      );

    case "tool_reference":
      return wrapText(`Tool: ${content.tool_name}`);
    case "tool_search_tool_search_result":
      return wrapText(
        `Tools found: ${content.tool_references.map((r) => r.tool_name).join(", ") || "none"}`,
      );
    case "tool_search_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );
    case "web_search_result":
      return wrapText(formatWebSearchHit(content));
    case "web_search_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "web_fetch_result":
      return wrapText(`Fetched: ${content.url}`);
    case "web_fetch_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "bash_code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "code_execution_tool_result_error":
    case "bash_code_execution_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "text_editor_code_execution_view_result":
      return wrapText(content.content);
    case "text_editor_code_execution_create_result":
      return wrapText(content.is_file_update ? "File updated" : "File created");
    case "text_editor_code_execution_str_replace_result":
      return wrapText(content.lines?.join("\n") || "");
    case "text_editor_code_execution_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );

    default:
      return wrapText(JSON.stringify(content));
  }
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

/**
 * The exit code the text of a failed command names. Claude Code starts the text
 * of a command that exited with a failing code with `Exit code N`; other
 * failures, such as a denial or a command that could not start, name none.
 */
export function failureExitCode(text: string): number | undefined {
  const match = /^Exit code (\d+)(?:\n|$)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

export function planEntries(input: { todos: ClaudePlanEntry[] } | undefined): PlanEntry[] {
  return (input?.todos ?? []).map((todo) => ({
    content: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content,
    status: todo.status,
    priority: "medium",
  }));
}

/**
 * Per-session task list accumulated from Task* tool calls (TaskCreate /
 * TaskUpdate). The headless/SDK session emits these as incremental tool
 * calls keyed by task ID, replacing the snapshot-style TodoWrite tool.
 * Iteration order is insertion order (Map semantics), matching the order
 * tasks are created.
 */
export type TaskEntry = {
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  description?: string;
};
export type TaskState = Map<string, TaskEntry>;

/**
 * Best-effort parse of a structured Task* tool_result. The SDK delivers tool
 * outputs either as a string or as an array of TextBlockParam-like blocks
 * containing JSON text; try both.
 */
function parseJsonToolOutput<T>(
  content: unknown,
  isExpectedOutput: (value: unknown) => value is T,
): T | undefined {
  const tryParse = (text: string): T | undefined => {
    try {
      const parsed: unknown = JSON.parse(text);
      return isExpectedOutput(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  if (typeof content === "string") {
    return tryParse(content);
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return isExpectedOutput(content) ? content : undefined;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") {
          const parsed = tryParse(text);
          if (parsed) return parsed;
        }
      }
    }
  }
  return undefined;
}

function toolOutputTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
      ? [block.text]
      : [],
  );
}

export function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined {
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskCreateOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "task" in parsed &&
      parsed.task &&
      typeof parsed.task === "object" &&
      "id" in parsed.task &&
      typeof parsed.task.id === "string",
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const match = /^Task #(\S+) created successfully: (.+)$/.exec(text.trim());
    if (match) return { task: { id: match[1], subject: match[2] } };
  }
  return undefined;
}

// A task line is `#id [status] subject`, optionally followed by ` (owner)` and then by
// ` [blocked by #a, #b]`. Two things about that shape cost superlinear time if the
// parse is left to a regex engine, and only one of them is obvious.
//
// The ambiguity. `[^,\]]` also matches `#`, so a list written `#a#a#a` splits 2^(k-1)
// ways, and one regex covering all four parts retried every split whenever the line
// failed to close with `]`. An 87-byte line took 3.1 s; each further pair of characters
// quadrupled it. Fixed by giving each list element a forced boundary: `[^,\]]` cannot
// match `,`, so `, ` is the only place an element can end and no alternative split
// exists to backtrack into.
//
// The start position. That alone is not enough. A suffix pattern anchored only at `$`
// lets the engine retry from every ` [blocked by #` in the line, each retry scanning to
// the end — quadratic, which is what CodeQL flagged next: 224 KB took 1.2 s. So the
// opener is located once with lastIndexOf and the shape is anchored at both ends,
// leaving exactly one start to try. 3.5 MB now parses in 1.5 ms.
//
// Taking the LAST opener rather than the leftmost match is the one behavioural change,
// and it needs a subject that itself contains ` [blocked by #` to show: `a [blocked by
// #x [blocked by #1]` used to yield the single blocking id `x [blocked by #1`, and now
// yields `1` with the rest left in the subject. Differential run over 8400 lines: those
// 15 and nothing else. An id carrying brackets and spaces was never a real id.
const TASK_LINE_RE = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/;
const TASK_OWNER_SUFFIX_RE = /^ \(([^()]*)\)$/;
const TASK_BLOCKED_SUFFIX_RE = /^ \[blocked by (#[^,\]]+(?:, #[^,\]]+)*(?:, )?)\]$/;

function splitTaskSuffix(
  subject: string,
  opener: string,
  closer: string,
  shape: RegExp,
): { subject: string; captured: string } | undefined {
  if (!subject.endsWith(closer)) return undefined;
  const at = subject.lastIndexOf(opener);
  // `at > 0` keeps the subject non-empty, which the `(.+?)` this replaces required.
  if (at <= 0) return undefined;
  const match = shape.exec(subject.slice(at));
  return match ? { subject: subject.slice(0, at), captured: match[1] } : undefined;
}

export function parseTaskListOutput(content: unknown): TaskListOutput | undefined {
  const validStatuses = new Set(["pending", "in_progress", "completed"]);
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskListOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "tasks" in parsed &&
      Array.isArray(parsed.tasks) &&
      parsed.tasks.every(
        (task) =>
          task &&
          typeof task === "object" &&
          typeof task.id === "string" &&
          typeof task.subject === "string" &&
          typeof task.status === "string" &&
          validStatuses.has(task.status),
      ),
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    if (text.trim() === "No tasks found") return { tasks: [] };

    const tasks: TaskListOutput["tasks"] = [];
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const head = TASK_LINE_RE.exec(line);
      if (!head) {
        tasks.length = 0;
        break;
      }
      // Strip from the right, blocked-by before owner: that is the order the parts
      // appear in, so each strip exposes the next one's closer.
      let subject = head[3];
      let blockedBy: TaskListOutput["tasks"][number]["blockedBy"] = [];
      const blocked = splitTaskSuffix(subject, " [blocked by #", "]", TASK_BLOCKED_SUFFIX_RE);
      if (blocked) {
        blockedBy = blocked.captured.split(", ").map((id) => id.slice(1));
        subject = blocked.subject;
      }
      let owner: string | undefined;
      const ownerSuffix = splitTaskSuffix(subject, " (", ")", TASK_OWNER_SUFFIX_RE);
      if (ownerSuffix) {
        owner = ownerSuffix.captured;
        subject = ownerSuffix.subject;
      }
      tasks.push({
        id: head[1],
        subject,
        status: head[2] as TaskListOutput["tasks"][number]["status"],
        ...(owner ? { owner } : {}),
        blockedBy,
      });
    }
    if (tasks.length > 0) return { tasks };
  }
  return undefined;
}

export function parseTaskUpdateOutput(
  content: unknown,
  expectedTaskId?: string,
): TaskUpdateOutput | undefined {
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskUpdateOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "success" in parsed &&
      typeof parsed.success === "boolean" &&
      "taskId" in parsed &&
      typeof parsed.taskId === "string" &&
      "updatedFields" in parsed &&
      Array.isArray(parsed.updatedFields) &&
      parsed.updatedFields.every((field) => typeof field === "string"),
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const notFound = /^Task #(\S+) not found$/.exec(text.trim());
    const taskId = notFound?.[1] ?? expectedTaskId;
    if (taskId && (notFound || text.trim() === "Failed to delete task")) {
      return { success: false, taskId, updatedFields: [], error: text.trim() };
    }
  }
  return undefined;
}

export function applyTaskCreate(
  state: TaskState,
  input: TaskCreateInput | undefined,
  output: TaskCreateOutput | undefined,
): void {
  const taskId = output?.task?.id;
  if (!taskId || !input) return;
  state.set(taskId, {
    subject: input.subject,
    status: "pending",
    activeForm: input.activeForm,
    description: input.description,
  });
}

export function applyTaskUpdate(state: TaskState, input: TaskUpdateInput | undefined): void {
  if (!input?.taskId) return;
  if (input.status === "deleted") {
    state.delete(input.taskId);
    return;
  }
  const existing = state.get(input.taskId);
  // Without a subject from either the existing entry or the update payload,
  // we'd produce a plan entry with empty `content` — drop the update.
  const subject = input.subject ?? existing?.subject;
  if (!subject) return;
  state.set(input.taskId, {
    subject,
    status: input.status ?? existing?.status ?? "pending",
    activeForm: input.activeForm ?? existing?.activeForm,
    description: input.description ?? existing?.description,
  });
}

export function applyTaskList(state: TaskState, output: TaskListOutput): void {
  const previous = new Map(state);
  state.clear();
  for (const task of output.tasks) {
    const existing = previous.get(task.id);
    state.set(task.id, {
      subject: task.subject,
      status: task.status,
      activeForm: existing?.activeForm,
      description: existing?.description,
    });
  }
}

export function taskStateToPlanEntries(state: TaskState): PlanEntry[] {
  return Array.from(state.values()).map((task) => ({
    content: task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject,
    status: task.status,
    priority: "medium",
  }));
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

interface DiffToolResponseHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: DiffToolResponseHunk[];
}

/**
 * Builds diff ToolUpdate content from the structured toolResponse provided by
 * the PostToolUse hook for diff-producing tools (Edit, Write). Unlike parsing
 * the plain unified diff string, this uses the pre-parsed structuredPatch
 * which supports multiple replacement sites (replaceAll) and always includes
 * context lines for better readability.
 */
export function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  if (!response.filePath || !Array.isArray(response.structuredPatch)) return {};

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];

  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else if (line === "\\ No newline at end of file") {
        // A unified-diff EOF marker, not a line of the file. Falling through to
        // the context branch below strips its leading backslash and pushes
        // " No newline at end of file" into BOTH sides, so the client renders
        // the marker as file content in the diff view. Upstream #1122 skips it;
        // its other half publishes `_meta.jetbrains.air.diffStats`, which no
        // client this adapter serves reads, and is deliberately not taken.
        continue;
      } else {
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
      });
    }
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) result.content = content;
  if (locations.length > 0) result.locations = locations;
  return result;
}

/* A global variable to store callbacks that should be executed when receiving hooks from Claude Code */
const toolUseCallbacks: {
  [toolUseId: string]: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  };
} = {};

/* Setup callbacks that will be called when receiving hooks from Claude Code */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  },
) => {
  toolUseCallbacks[toolUseID] = {
    onPostToolUseHook,
  };
};

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (options?: { onEnterPlanMode?: () => Promise<void> }): HookCallback =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      // Handle EnterPlanMode tool - notify client of mode change after successful execution
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
        if (onPostToolUseHook) {
          await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
        }
        delete toolUseCallbacks[toolUseID]; // Cleanup after execution
      }
    }
    return { continue: true };
  };

/**
 * Hook callback for `TaskCreated` / `TaskCompleted` events. The SDK fires
 * these for both user-facing TaskCreate tool calls and subagent task
 * creation, giving us `task_id` + `task_subject` without having to parse
 * tool_result payloads.
 *
 * Populating `taskState` from the hook means a later `TaskUpdate` (which
 * typically only carries `taskId` + `status`) finds an existing entry with
 * a real subject, instead of synthesizing a placeholder with empty content.
 */
export const createTaskHook =
  (options: { taskState: TaskState; onChange?: () => Promise<void> }): HookCallback =>
  async (input): Promise<{ continue: boolean }> => {
    const taskId =
      "task_id" in input && typeof input.task_id === "string" ? input.task_id : undefined;
    if (!taskId) return { continue: true };

    if (input.hook_event_name === "TaskCreated") {
      if (!input.task_subject) return { continue: true };
      if (options.taskState.has(taskId)) return { continue: true };
      options.taskState.set(taskId, {
        subject: input.task_subject,
        status: "pending",
        description: input.task_description,
      });
      if (options.onChange) await options.onChange();
    } else if (input.hook_event_name === "TaskCompleted") {
      const existing = options.taskState.get(taskId);
      if (!existing || existing.status === "completed") return { continue: true };
      options.taskState.set(taskId, { ...existing, status: "completed" });
      if (options.onChange) await options.onChange();
    }
    return { continue: true };
  };
