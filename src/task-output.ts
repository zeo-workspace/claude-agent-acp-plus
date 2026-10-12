// Reading a shell task's output file — story 041.
//
// The CLI writes a background shell's output to `<task id>.output` and names that path in the
// Bash result. This module reads the end of such a file safely, for two consumers: the tail the
// task feed publishes while the task runs, and `_claude/tasks/output` after it ends.
//
// Safety rules, each one a test in `tests/task-output.test.ts`:
// - only a regular file is read, opened with `O_NOFOLLOW` so a symlink planted at the recorded
//   path is refused (Node's flag covers only the last component, hence the `isFile()` check on
//   the handle as well);
// - a cut lands on a line boundary, never inside a line or a UTF-8 sequence;
// - an error carries the fs code and never the file's content.

import { constants, open } from "node:fs/promises";
import path from "node:path";

/** The most `_claude/tasks/output` ever serves, whatever the client asks for (R2.3). */
export const OUTPUT_MAX_BYTES = 1_048_576;
/** Lines kept in a running task's `tail` (R1.2). */
export const TAIL_MAX_LINES = 10;
/** Code points kept per tail line; a longer line ends in `…` (R1.3). */
export const TAIL_MAX_CHARS = 240;
/** Bytes read from the end of the file to build a tail. */
export const TAIL_READ_BYTES = 16_384;

/** A file that could not be read. `code` is the fs code, or `not_regular`. */
export class OutputUnavailable extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`task output unavailable (${code})`);
    this.name = "OutputUnavailable";
    this.code = code;
  }
}

function unavailable(error: unknown): OutputUnavailable {
  if (error instanceof OutputUnavailable) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
  return new OutputUnavailable(code);
}

type Window = { bytes: Buffer; totalBytes: number; truncated: boolean };

/**
 * Reads the last `maxBytes` of `file`, cut on a line boundary. When the file is longer, one byte
 * before the window is read too: everything up to and including the first `\n` is dropped, so a
 * window that already starts on a line keeps that line. A window holding no `\n` is kept whole.
 */
async function readWindow(file: string, maxBytes: number): Promise<Window> {
  let handle;
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer
    // forever; with it the open returns, and `isFile()` below refuses the FIFO.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw unavailable(error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new OutputUnavailable("not_regular");
    const totalBytes = stats.size;
    const truncated = totalBytes > maxBytes;
    const start = truncated ? totalBytes - maxBytes - 1 : 0;
    const length = totalBytes - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (bytesRead === 0) break; // the file shrank between fstat and read
      read += bytesRead;
    }
    let bytes = buffer.subarray(0, read);
    if (truncated) {
      const newline = bytes.indexOf(0x0a);
      bytes = newline === -1 ? bytes.subarray(1) : bytes.subarray(newline + 1);
    }
    return { bytes, totalBytes, truncated };
  } catch (error) {
    throw unavailable(error);
  } finally {
    await handle.close().catch(() => {});
  }
}

const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/** The end of `file`, at most `min(maxBytes, OUTPUT_MAX_BYTES)` bytes (R2.1, R2.3). */
export async function readOutput(
  file: string,
  maxBytes: number,
): Promise<{ content: string; totalBytes: number; truncated: boolean }> {
  const { bytes, totalBytes, truncated } = await readWindow(
    file,
    Math.min(maxBytes, OUTPUT_MAX_BYTES),
  );
  return { content: decode(bytes), totalBytes, truncated };
}

/** The last `TAIL_MAX_LINES` lines of `file`, sanitized (R1.2, R1.3). */
export async function readTail(file: string): Promise<string[]> {
  const { bytes } = await readWindow(file, TAIL_READ_BYTES);
  const lines = decode(bytes).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-TAIL_MAX_LINES).map(sanitizeLine);
}

/* eslint-disable no-control-regex -- these patterns exist to match terminal control bytes */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESCAPE = /\x1b[\s\S]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** One tail line as a terminal would leave it, without escapes or controls (R1.3). */
export function sanitizeLine(line: string): string {
  const redrawn = line.slice(line.lastIndexOf("\r") + 1);
  const clean = redrawn
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(OTHER_ESCAPE, "")
    .replace(CONTROL, "");
  const chars = [...clean];
  if (chars.length <= TAIL_MAX_CHARS) return clean;
  return chars.slice(0, TAIL_MAX_CHARS - 1).join("") + "…";
}

// The CLI ends the sentence with a period (2.1.285: "…/tasks/<id>.output."), so
// one trailing punctuation mark is not part of the path.
const OUTPUT_NOTICE = /Output is being written to: (\S+?)[.,;:]?(?:\s|$)/;

/**
 * The output path a Bash result names for `taskId`, or null. Only an absolute, normalized path
 * whose file name is exactly `<taskId>.output` is accepted (R1.6): anything else could be
 * another task's file, or no task's.
 */
export function outputPathFromBashResult(text: string, taskId: string): string | null {
  const candidate = text.match(OUTPUT_NOTICE)?.[1];
  return candidate !== undefined && isOutputPathFor(candidate, taskId) ? candidate : null;
}

/** True for an absolute, normalized path whose file name is exactly `<taskId>.output`. */
export function isOutputPathFor(candidate: string, taskId: string): boolean {
  return (
    path.isAbsolute(candidate) &&
    path.normalize(candidate) === candidate &&
    path.basename(candidate) === `${taskId}.output`
  );
}
