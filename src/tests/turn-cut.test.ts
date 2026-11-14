import { describe, expect, it } from "vitest";
import { parseCutAt, resolveTurnCut, type TranscriptRow } from "../turn-cut.js";

function prompt(uuid: string, text: string): TranscriptRow {
  return {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] },
  } as TranscriptRow;
}

function toolResult(uuid: string): TranscriptRow {
  return {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
    },
  } as TranscriptRow;
}

function reply(uuid: string): TranscriptRow {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  } as TranscriptRow;
}

// Three turns; the second used a tool, so its last entry is the reply after
// the tool result.
const transcript: TranscriptRow[] = [
  prompt("p1", "first"),
  reply("a1"),
  prompt("p2", "second"),
  reply("a2-tool"),
  toolResult("r2"),
  reply("a2"),
  prompt("p3", "third"),
  reply("a3"),
];

describe("resolveTurnCut by turn number", () => {
  it("cuts after the kept turn's last entry, before the next prompt", () => {
    expect(resolveTurnCut(transcript, { turn: 2 }, new Map())).toEqual({
      kind: "cut",
      cutUuid: "a2",
      nextPromptUuid: "p3",
      droppedTurns: 1,
    });
    expect(resolveTurnCut(transcript, { turn: 1 }, new Map())).toEqual({
      kind: "cut",
      cutUuid: "a1",
      nextPromptUuid: "p2",
      droppedTurns: 2,
    });
  });

  it("has nothing to cut at or past the last turn", () => {
    expect(resolveTurnCut(transcript, { turn: 3 }, new Map())).toEqual({ kind: "nothing_to_cut" });
    expect(resolveTurnCut(transcript, { turn: 9 }, new Map())).toEqual({ kind: "nothing_to_cut" });
  });

  it("does not count a tool result as a prompt", () => {
    expect(
      resolveTurnCut([prompt("p1", "x"), toolResult("r"), reply("a")], { turn: 1 }, new Map()),
    ).toEqual({ kind: "nothing_to_cut" });
  });
});

describe("resolveTurnCut by message id", () => {
  it("translates the ACP message id and extends the cut to the turn's end", () => {
    // The client names the turn's first reply (a2-tool); the cut still keeps
    // the tool result and the final reply of that turn.
    const ids = new Map([["msg_2", "a2-tool"]]);
    expect(resolveTurnCut(transcript, { messageId: "msg_2" }, ids)).toEqual({
      kind: "cut",
      cutUuid: "a2",
      nextPromptUuid: "p3",
      droppedTurns: 1,
    });
  });

  it("has nothing to cut for the last turn's message", () => {
    const ids = new Map([["msg_3", "a3"]]);
    expect(resolveTurnCut(transcript, { messageId: "msg_3" }, ids)).toEqual({
      kind: "nothing_to_cut",
    });
  });

  it("reports an unknown id, or one missing from the transcript", () => {
    expect(resolveTurnCut(transcript, { messageId: "msg_x" }, new Map())).toEqual({
      kind: "not_found",
    });
    const stale = new Map([["msg_old", "gone"]]);
    expect(resolveTurnCut(transcript, { messageId: "msg_old" }, stale)).toEqual({
      kind: "not_found",
    });
  });
});

describe("parseCutAt", () => {
  it("accepts a message id or a positive integer turn", () => {
    expect(parseCutAt({ messageId: "msg_1" }, "m")).toEqual({ messageId: "msg_1" });
    expect(parseCutAt({ turn: 2 }, "m")).toEqual({ turn: 2 });
  });

  it.each([[{}], [{ turn: 0 }], [{ turn: 1.5 }], [{ messageId: "" }], [null], ["2"]])(
    "refuses %j",
    (value) => {
      expect(() => parseCutAt(value, "my/method")).toThrow(/my\/method/);
    },
  );
});
