// Story 041, task 1.2 — the task output reader (R1.2, R1.3, R1.6, R2.1, R2.3, R2.5; Q4, Q15).
//
// `src/task-output.ts` reads the end of a shell task's output file and turns its last lines into
// a sanitized `tail`. These tests drive it with real files in a private temp directory and assert
// only what it returns or throws (design.md §Components `task-output.ts`).
//
// Hostile halves first: a cut that lands inside a line or a UTF-8 sequence must not leak half of
// either; a file of exactly `maxBytes` must not read as truncated, one byte more must; a symlink
// at the recorded path must be refused while the real file is read; a path naming another task's
// file — `b12.output` for task `b1`, `b1.output` for task `b12` — must be refused while the exact
// one is accepted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OUTPUT_MAX_BYTES,
  OutputUnavailable,
  TAIL_MAX_CHARS,
  TAIL_MAX_LINES,
  outputPathFromBashResult,
  readOutput,
  readTail,
  sanitizeLine,
} from "../task-output.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "task-output-test-"));
});

afterEach(async () => {
  await chmod(join(dir, "locked.output"), 0o600).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string | Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

describe("caps", () => {
  it("are the story's numbers", () => {
    expect(OUTPUT_MAX_BYTES).toBe(1_048_576);
    expect(TAIL_MAX_LINES).toBe(10);
    expect(TAIL_MAX_CHARS).toBe(240);
  });
});

describe("readOutput — the end of the file (R2.1)", () => {
  it("returns the whole of a small file, untruncated", async () => {
    const text = lines(3);
    const path = await file("t1.output", text);

    await expect(readOutput(path, 1_048_576)).resolves.toEqual({
      content: text,
      totalBytes: bytes(text),
      truncated: false,
    });
  });

  // Hostile: the cut point falls in the middle of a line made of two-byte characters. The
  // content must start at a line boundary and carry no replacement character.
  it("cuts a large file at a line boundary, never inside a line or a UTF-8 sequence", async () => {
    const text =
      Array.from({ length: 400 }, (_, i) => `é${"é".repeat(i % 37)} ${i}`).join("\n") + "\n";
    const path = await file("t1.output", text);
    const maxBytes = 1_001; // odd on purpose: lands inside a two-byte "é" for many offsets

    const out = await readOutput(path, maxBytes);

    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBe(bytes(text));
    expect(bytes(out.content)).toBeLessThanOrEqual(maxBytes);
    expect(out.content.length).toBeGreaterThan(0);
    expect(out.content).not.toContain("�");
    expect(text.endsWith(out.content)).toBe(true);
    // A line boundary: the byte just before the served content is a newline.
    const before = text.slice(0, text.length - out.content.length);
    expect(before.endsWith("\n")).toBe(true);
  });

  // Hostile off-by-one, both directions.
  it("treats a file of exactly maxBytes as whole, and one byte more as truncated", async () => {
    const exact = "a".repeat(99) + "\n"; // 100 bytes
    const exactPath = await file("exact.output", exact);
    await expect(readOutput(exactPath, 100)).resolves.toEqual({
      content: exact,
      totalBytes: 100,
      truncated: false,
    });

    const over = "x\n" + exact; // 102 bytes: the first line must go
    const overPath = await file("over.output", over);
    const out = await readOutput(overPath, 101);
    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBe(102);
    expect(out.content).toBe(exact);
  });

  it("decodes invalid UTF-8 with replacement instead of throwing", async () => {
    const path = await file(
      "bad.output",
      Buffer.concat([Buffer.from("ok "), Buffer.from([0xff, 0xfe]), Buffer.from(" done\n")]),
    );
    const out = await readOutput(path, 1_048_576);
    expect(out.content).toContain("�");
    expect(out.content).toContain("ok ");
    expect(out.content).toContain(" done");
  });

  it("does not throw on a window with no newline at all", async () => {
    const path = await file("one-line.output", "z".repeat(5_000));
    const out = await readOutput(path, 1_000);
    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBe(5_000);
    expect(bytes(out.content)).toBeLessThanOrEqual(1_000);
  });

  it("serves at most OUTPUT_MAX_BYTES whatever maxBytes asks for (R2.3)", async () => {
    const text = lines(150_000); // ~1.6 MiB
    expect(bytes(text)).toBeGreaterThan(OUTPUT_MAX_BYTES);
    const path = await file("big.output", text);

    const out = await readOutput(path, 5_000_000);

    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBe(bytes(text));
    expect(bytes(out.content)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect(text.endsWith(out.content)).toBe(true);
    expect(out.content.startsWith("line ")).toBe(true);
  });
});

describe("readOutput — what it refuses (R2.5, Q4, Q15)", () => {
  // Hostile first: a symlink planted at the recorded path, pointing at a readable file. Then the
  // converse: the real file at a path of its own is read.
  it("refuses a symlink at the path, and reads the regular file it points to", async () => {
    const target = await file("secret.txt", "TOP-SECRET-CONTENT\n");
    const link = join(dir, "t1.output");
    await symlink(target, link);

    const error = await readOutput(link, 1_048_576).catch((e) => e);
    expect(error).toBeInstanceOf(OutputUnavailable);
    expect(String(error?.message)).not.toContain("TOP-SECRET-CONTENT");

    await expect(readOutput(target, 1_048_576)).resolves.toMatchObject({
      content: "TOP-SECRET-CONTENT\n",
    });
  });

  it("refuses a directory with code not_regular", async () => {
    const path = join(dir, "t1.output");
    await mkdir(path);
    const error = await readOutput(path, 100).catch((e) => e);
    expect(error).toBeInstanceOf(OutputUnavailable);
    expect(error.code).toBe("not_regular");
  });

  it("wraps a missing file as OutputUnavailable with code ENOENT", async () => {
    const error = await readOutput(join(dir, "gone.output"), 100).catch((e) => e);
    expect(error).toBeInstanceOf(OutputUnavailable);
    expect(error.code).toBe("ENOENT");
  });

  it("wraps an unreadable file with its code and never puts file content in the error", async () => {
    if (process.getuid?.() === 0) return; // root reads mode-000 files
    const path = await file("locked.output", "TOP-SECRET-CONTENT\n");
    await chmod(path, 0o000);

    const error = await readOutput(path, 100).catch((e) => e);
    expect(error).toBeInstanceOf(OutputUnavailable);
    expect(error.code).toBe("EACCES");
    expect(`${error.message} ${String(error.stack)}`).not.toContain("TOP-SECRET-CONTENT");
  });
});

describe("readTail — the last lines (R1.2)", () => {
  it("keeps the last 10 lines and drops the trailing empty line", async () => {
    const path = await file("t1.output", lines(30));
    await expect(readTail(path)).resolves.toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${i + 21}`),
    );
  });

  it("keeps a last line that has no newline yet", async () => {
    const path = await file("t1.output", "line 1\nline 2\nhalf a li");
    await expect(readTail(path)).resolves.toEqual(["line 1", "line 2", "half a li"]);
  });

  it("returns no lines for an empty file", async () => {
    const path = await file("t1.output", "");
    await expect(readTail(path)).resolves.toEqual([]);
  });

  it("reads the end of a large file", async () => {
    const path = await file("t1.output", lines(200_000));
    const tail = await readTail(path);
    expect(tail).toHaveLength(10);
    expect(tail.at(-1)).toBe("line 200000");
    expect(tail[0]).toBe("line 199991");
  });

  // Hostile: a line of exactly 240 characters is not cut; one of 241 is, to 240 at most.
  it("cuts a line to 240 characters with an ellipsis, and leaves one of exactly 240 alone", async () => {
    const exact = "e".repeat(240);
    const long = "l".repeat(241);
    const path = await file("t1.output", `${exact}\n${long}\n`);

    const [first, second] = await readTail(path);
    expect(first).toBe(exact);
    expect([...second].length).toBeLessThanOrEqual(240);
    expect(second.endsWith("…")).toBe(true);
    expect(second.startsWith("l".repeat(200))).toBe(true);
  });

  it("counts characters, not UTF-16 units: a line of emoji is cut on a whole character", async () => {
    const path = await file("t1.output", "😀".repeat(300) + "\n");
    const [line] = await readTail(path);
    const chars = [...line];
    expect(chars.length).toBeLessThanOrEqual(240);
    for (const ch of chars.slice(0, -1)) expect(ch).toBe("😀");
  });

  it("sanitizes every line it returns", async () => {
    const path = await file("t1.output", "\x1b[32mok\x1b[0m\n10%\r55%\r100%\n");
    await expect(readTail(path)).resolves.toEqual(["ok", "100%"]);
  });

  it("refuses a symlink like readOutput", async () => {
    const target = await file("real.txt", "x\n");
    const link = join(dir, "t1.output");
    await symlink(target, link);
    await expect(readTail(link)).rejects.toBeInstanceOf(OutputUnavailable);
  });
});

describe("sanitizeLine (R1.3)", () => {
  it("keeps only the text after the last carriage return", () => {
    expect(sanitizeLine("10%\r20%\r30%")).toBe("30%");
    expect(sanitizeLine("old\x1b[2K\rnew")).toBe("new");
  });

  it("strips CSI, OSC (BEL- and ST-terminated) and other escape sequences", () => {
    expect(sanitizeLine("\x1b[1;31mred\x1b[0m text")).toBe("red text");
    expect(sanitizeLine("\x1b]0;window title\x07after")).toBe("after");
    expect(sanitizeLine("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(sanitizeLine("\x1bMx")).toBe("x");
  });

  it("removes control characters but keeps tab", () => {
    expect(sanitizeLine("a\x00b\x07c\x7fd")).toBe("abcd");
    expect(sanitizeLine("col1\tcol2")).toBe("col1\tcol2");
  });

  // Hostile converse: text that merely looks like an escape sequence, with no ESC, is content.
  it("leaves bracketed text without an ESC alone", () => {
    expect(sanitizeLine("[31m not a colour ]0; nor a title")).toBe(
      "[31m not a colour ]0; nor a title",
    );
  });
});

describe("outputPathFromBashResult (R1.6)", () => {
  const notice = (path: string, id = "b1") =>
    `Command running in background with ID: ${id}. Output is being written to: ${path}`;

  // Hostile (wrong collapse): names that differ from `<task id>.output` by a prefix, a suffix or
  // one character are another task's file.
  it("refuses a path whose file name is not exactly <task id>.output", () => {
    for (const path of [
      "/tmp/claude-1000/p/tasks/b12.output",
      "/tmp/claude-1000/p/tasks/xb1.output",
      "/tmp/claude-1000/p/tasks/b1.output.bak",
      "/tmp/claude-1000/p/tasks/b1.log",
      "/tmp/claude-1000/p/tasks/b1.output/../passwd",
    ]) {
      expect(outputPathFromBashResult(notice(path), "b1"), path).toBeNull();
    }
    expect(outputPathFromBashResult(notice("/tmp/x/b1.output", "b12"), "b12")).toBeNull();
  });

  it("refuses a relative path", () => {
    expect(outputPathFromBashResult(notice("tasks/b1.output"), "b1")).toBeNull();
    expect(outputPathFromBashResult(notice("../b1.output"), "b1")).toBeNull();
  });

  it("returns null when the text names no output file", () => {
    expect(outputPathFromBashResult("Command completed with exit code 0", "b1")).toBeNull();
    expect(outputPathFromBashResult("", "b1")).toBeNull();
  });

  // Converse (wrong split): the same notice wrapped in other lines is still the same path.
  it("accepts the absolute path named <task id>.output, wherever the notice sits in the text", () => {
    const path = "/tmp/claude-1000/-home-u-p/tasks/b1.output";
    expect(outputPathFromBashResult(notice(path), "b1")).toBe(path);
    expect(
      outputPathFromBashResult(`stdout before\n${notice(path)}\nUse BashOutput to read it.`, "b1"),
    ).toBe(path);
  });
});
