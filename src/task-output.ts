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

import { constants, open, type FileHandle } from "node:fs/promises";
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

type Window = { bytes: Buffer; totalBytes: number; truncated: boolean; startByte: number };

/**
 * Reads `file` and hands the open handle and its size to `read`. O_NONBLOCK: opening a FIFO for
 * reading would otherwise wait for a writer forever; with it the open returns, and the
 * `isFile()` check refuses the FIFO. O_NOFOLLOW refuses a symlink at the path.
 */
async function withRegularFile<T>(
  file: string,
  read: (handle: FileHandle, totalBytes: number) => Promise<T>,
): Promise<T> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw unavailable(error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new OutputUnavailable("not_regular");
    return await read(handle, stats.size);
  } catch (error) {
    throw unavailable(error);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Up to `length` bytes at `start`; fewer when the file shrank between fstat and read. */
async function readRange(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

/**
 * The last `maxBytes` of the file, cut on a line boundary. When the file is longer, one byte
 * before the window is read too: everything up to and including the first `\n` is dropped, so a
 * window that already starts on a line keeps that line. A window holding no `\n` is kept whole.
 */
async function readTailWindow(
  handle: FileHandle,
  totalBytes: number,
  maxBytes: number,
): Promise<Window> {
  const truncated = totalBytes > maxBytes;
  const start = truncated ? totalBytes - maxBytes - 1 : 0;
  let bytes = await readRange(handle, start, totalBytes - start);
  let startByte = start;
  if (truncated) {
    const newline = bytes.indexOf(0x0a);
    const cut = newline === -1 ? 1 : newline + 1;
    bytes = bytes.subarray(cut);
    startByte = start + cut;
  }
  return { bytes, totalBytes, truncated, startByte };
}

/**
 * How many leading bytes of `bytes` end on a whole UTF-8 character. A writer can be in the
 * middle of a multi-byte character when the read lands; those trailing bytes are left for the
 * next read rather than decoded into a replacement character it could not take back.
 */
function completeUtf8Length(bytes: Buffer): number {
  // A sequence is at most 4 bytes, so only the last 3 can start an unfinished one.
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: keep looking for the lead
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/**
 * What follows `fromByte`, at most `maxBytes`. When the cap stops the read before the end, the
 * piece ends after its last whole line (or, with no newline in it, after its last whole
 * character), and `truncated` says more remains. An offset past the end means the file was
 * truncated or replaced: the end of the new file is served instead, and its `startByte` tells
 * the client to start over.
 */
async function readFromWindow(
  handle: FileHandle,
  totalBytes: number,
  maxBytes: number,
  fromByte: number,
): Promise<Window> {
  if (fromByte > totalBytes) return readTailWindow(handle, totalBytes, maxBytes);
  const capped = totalBytes - fromByte > maxBytes;
  let bytes = await readRange(handle, fromByte, Math.min(totalBytes - fromByte, maxBytes));
  if (capped) {
    const newline = bytes.lastIndexOf(0x0a);
    if (newline !== -1) bytes = bytes.subarray(0, newline + 1);
  }
  bytes = bytes.subarray(0, completeUtf8Length(bytes));
  const truncated = fromByte + bytes.length < totalBytes && capped;
  return { bytes, totalBytes, truncated, startByte: fromByte };
}

const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/**
 * A task's output, at most `min(maxBytes, OUTPUT_MAX_BYTES)` bytes (R2.1, R2.3). Without
 * `fromByte`, the end of the file; with it, what follows that offset (Zeo next §6.1, §6.27).
 * `startByte` is the offset `content` begins at either way, so a client following a running
 * task asks next from `startByte + byteLength(content)`.
 */
export async function readOutput(
  file: string,
  maxBytes: number,
  fromByte?: number,
): Promise<{ content: string; totalBytes: number; truncated: boolean; startByte: number }> {
  const cap = Math.min(maxBytes, OUTPUT_MAX_BYTES);
  const { bytes, totalBytes, truncated, startByte } = await withRegularFile(file, (handle, size) =>
    fromByte === undefined
      ? readTailWindow(handle, size, cap)
      : readFromWindow(handle, size, cap, fromByte),
  );
  return { content: decode(bytes), totalBytes, truncated, startByte };
}

/** The last `TAIL_MAX_LINES` lines of `file`, sanitized (R1.2, R1.3). */
export async function readTail(file: string): Promise<string[]> {
  const { bytes } = await withRegularFile(file, (handle, size) =>
    readTailWindow(handle, size, TAIL_READ_BYTES),
  );
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
