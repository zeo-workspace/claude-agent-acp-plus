import { describe, expect, it, vi } from "vitest";
import {
  parseRewindRequest,
  planFork,
  REWIND_METHOD,
  rewindSession,
  type RewindDepsV2,
} from "../session-rewind.js";
import type { TranscriptRow } from "../turn-cut.js";

function row(type: "user" | "assistant", uuid: string, text: string): TranscriptRow {
  return {
    type,
    uuid,
    parent_tool_use_id: null,
    message: { role: type, content: [{ type: "text", text }] },
  } as TranscriptRow;
}

const transcript = [
  row("user", "p1", "first"),
  row("assistant", "a1", "one"),
  row("user", "p2", "second"),
  row("assistant", "a2", "two"),
];

function deps(overrides: Partial<RewindDepsV2> = {}): RewindDepsV2 {
  return {
    readTranscript: vi.fn(async () => transcript),
    messageIdToUuid: new Map(),
    rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged: ["a.ts"] })),
    forkTranscript: vi.fn(async () => "forked-session"),
    ...overrides,
  };
}

describe("rewindSession", () => {
  it("restores files to the next prompt, then forks the transcript at the cut", async () => {
    const d = deps();
    const result = await rewindSession(d, { at: { turn: 1 }, restoreFiles: true });
    expect(result).toEqual({
      status: "rewound",
      sessionId: "forked-session",
      droppedTurns: 1,
      filesRestored: true,
    });
    expect(d.rewindFiles).toHaveBeenCalledWith("p2");
    expect(d.forkTranscript).toHaveBeenCalledWith("a1");
  });

  it("leaves files alone when not asked", async () => {
    const d = deps();
    const result = await rewindSession(d, { at: { turn: 1 }, restoreFiles: false });
    expect(result).toMatchObject({ status: "rewound", filesRestored: false });
    expect(d.rewindFiles).not.toHaveBeenCalled();
  });

  it("touches nothing when the files cannot be restored", async () => {
    const d = deps({
      rewindFiles: vi.fn(async () => ({ canRewind: false, error: "no checkpoint" })),
    });
    const result = await rewindSession(d, { at: { turn: 1 }, restoreFiles: true });
    expect(result).toEqual({ status: "failed", stage: "files", message: "no checkpoint" });
    expect(d.forkTranscript).not.toHaveBeenCalled();
  });

  it("reports a fork failure after the files were restored", async () => {
    const d = deps({ forkTranscript: vi.fn(async () => Promise.reject(new Error("disk full"))) });
    const result = await rewindSession(d, { at: { turn: 1 }, restoreFiles: true });
    expect(result).toEqual({
      status: "failed",
      stage: "conversation",
      message: "disk full",
      filesRestored: true,
    });
  });

  it("has nothing to rewind at the last turn", async () => {
    const d = deps();
    expect(await rewindSession(d, { at: { turn: 2 }, restoreFiles: true })).toEqual({
      status: "nothing_to_rewind",
    });
    expect(d.rewindFiles).not.toHaveBeenCalled();
    expect(d.forkTranscript).not.toHaveBeenCalled();
  });

  it("reports an unknown message id as not found", async () => {
    expect(
      await rewindSession(deps(), { at: { messageId: "msg_x" }, restoreFiles: false }),
    ).toEqual({ status: "not_found" });
  });
});

describe("parseRewindRequest", () => {
  it("accepts a session, a cut point and the files flag", () => {
    expect(parseRewindRequest({ sessionId: "s", at: { turn: 2 }, restoreFiles: true })).toEqual({
      sessionId: "s",
      at: { turn: 2 },
      restoreFiles: true,
    });
  });

  it("defaults restoreFiles to false", () => {
    expect(parseRewindRequest({ sessionId: "s", at: { messageId: "m" } })).toEqual({
      sessionId: "s",
      at: { messageId: "m" },
      restoreFiles: false,
    });
  });

  it.each([
    [{ at: { turn: 1 } }],
    [{ sessionId: "s" }],
    [{ sessionId: "s", at: { turn: 1 }, restoreFiles: "yes" }],
  ])("refuses %j", (params) => {
    expect(() => parseRewindRequest(params)).toThrow(new RegExp(REWIND_METHOD.replace("/", "\\/")));
  });
});

describe("planFork", () => {
  it("copies the whole session when no cut point is given", async () => {
    const d = deps();
    expect(await planFork(d, "parent", undefined)).toEqual({ resume: "parent", forkSession: true });
    expect(d.forkTranscript).not.toHaveBeenCalled();
  });

  it("resumes a transcript copied up to the cut", async () => {
    const d = deps();
    expect(await planFork(d, "parent", { turn: 1 })).toEqual({
      resume: "forked-session",
      forkSession: false,
    });
    expect(d.forkTranscript).toHaveBeenCalledWith("a1");
  });

  it("copies the whole session when the cut is at the last turn", async () => {
    const d = deps();
    expect(await planFork(d, "parent", { turn: 2 })).toEqual({
      resume: "parent",
      forkSession: true,
    });
    expect(d.forkTranscript).not.toHaveBeenCalled();
  });

  it("refuses a message id it cannot find", async () => {
    await expect(planFork(deps(), "parent", { messageId: "msg_x" })).rejects.toThrow(/not found/);
  });
});
