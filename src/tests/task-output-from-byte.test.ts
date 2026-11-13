// Zeo next proposal §6.1 / §6.27: a client following a running task's log asks only for what it
// has not read yet. `_claude/tasks/output` takes an optional `fromByte` and answers `startByte`,
// the file offset its `content` begins at. A client that does not send `fromByte` gets the end of
// the file as before; one that gets no `startByte` back is talking to an older adapter.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOutput } from "../task-output.js";
import { parseTasksOutputRequest } from "../acp-agent.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "task-output-from-byte-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(content: string | Buffer): Promise<string> {
  const path = join(dir, "task.output");
  await writeFile(path, content);
  return path;
}
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("readOutput — startByte on the end of the file", () => {
  it("says where a whole file's content begins: 0", async () => {
    const path = await file("a\nb\n");
    const out = await readOutput(path, 100);
    expect(out).toMatchObject({ content: "a\nb\n", startByte: 0, totalBytes: 4 });
  });

  it("says where a cut window begins, so a client can follow on from its end", async () => {
    const path = await file("one\ntwo\nthree\n");
    const out = await readOutput(path, 8);
    expect(out.truncated).toBe(true);
    expect(out.startByte + bytes(out.content)).toBe(out.totalBytes);
  });
});

describe("readOutput — fromByte, reading on from an offset", () => {
  it("returns only what follows the offset, and the pieces rebuild the file", async () => {
    const path = await file("first\n");
    const a = await readOutput(path, 100, 0);
    expect(a).toMatchObject({ content: "first\n", startByte: 0, truncated: false });
    await appendFile(path, "second\nthird\n");
    const b = await readOutput(path, 100, a.startByte + bytes(a.content));
    expect(b).toMatchObject({ content: "second\nthird\n", startByte: 6 });
    expect(a.content + b.content).toBe("first\nsecond\nthird\n");
  });

  it("answers nothing new at the end of the file", async () => {
    const path = await file("done\n");
    expect(await readOutput(path, 100, 5)).toMatchObject({ content: "", startByte: 5 });
  });

  it("serves at most maxBytes on from the offset, cut after a whole line, and says more remains", async () => {
    const path = await file("aaaa\nbbbb\ncccc\n");
    const out = await readOutput(path, 12, 0);
    expect(out).toMatchObject({ content: "aaaa\nbbbb\n", startByte: 0, truncated: true });
    const rest = await readOutput(path, 12, 10);
    expect(rest).toMatchObject({ content: "cccc\n", startByte: 10, truncated: false });
  });

  // Hostile: the writer may be mid-character when the read lands. Decoding half a sequence
  // would paint a replacement character the next read cannot take back.
  it("leaves a trailing partial UTF-8 sequence for the next read", async () => {
    const e = Buffer.from("é", "utf8"); // C3 A9
    const path = await file(Buffer.concat([Buffer.from("caf"), e.subarray(0, 1)]));
    const a = await readOutput(path, 100, 0);
    expect(a).toMatchObject({ content: "caf", startByte: 0 });
    await appendFile(path, e.subarray(1));
    const b = await readOutput(path, 100, a.startByte + bytes(a.content));
    expect(b.content).toBe("é");
  });

  // Hostile: a log that was truncated or replaced is shorter than the client's offset. Reading
  // from past the end would answer nothing forever; the end of the new file is what to show.
  it("falls back to the end of the file when the offset is past it", async () => {
    const path = await file("old old old old\n");
    await truncate(path, 0);
    await appendFile(path, "new\n");
    const out = await readOutput(path, 100, 16);
    expect(out).toMatchObject({ content: "new\n", startByte: 0, totalBytes: 4 });
  });
});

describe("parseTasksOutputRequest — fromByte", () => {
  it("is optional", () => {
    expect(parseTasksOutputRequest({ sessionId: "s", taskId: "t", maxBytes: 10 })).toEqual({
      sessionId: "s",
      taskId: "t",
      maxBytes: 10,
    });
  });

  it("is passed through when it is a non-negative integer", () => {
    expect(
      parseTasksOutputRequest({ sessionId: "s", taskId: "t", maxBytes: 10, fromByte: 0 }).fromByte,
    ).toBe(0);
    expect(
      parseTasksOutputRequest({ sessionId: "s", taskId: "t", maxBytes: 10, fromByte: 42 }).fromByte,
    ).toBe(42);
  });

  it("refuses a negative, fractional, string or unsafe fromByte, naming fromByte", () => {
    for (const fromByte of [-1, 1.5, "3", Number.NaN, 2 ** 53]) {
      expect(
        () => parseTasksOutputRequest({ sessionId: "s", taskId: "t", maxBytes: 10, fromByte }),
        String(fromByte),
      ).toThrow(/fromByte/);
    }
  });
});
