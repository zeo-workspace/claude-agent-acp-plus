/**
 * A resumed or loaded session continues in the permission mode of its
 * transcript's last prompt (upstream #1218's resume rider), read backwards
 * from the end of the local transcript in the query's configuration home.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readResumedPermissionMode } from "../resumed-session.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
let configDir: string;

const user = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, ...fields });
const assistant = () =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-x" } });

function writeTranscript(lines: string[], project = "-tmp-project") {
  const dir = path.join(configDir, "projects", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.join("\n") + "\n");
}

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "resumed-mode-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("readResumedPermissionMode", () => {
  it("returns the mode of the last prompt, not an earlier one", async () => {
    writeTranscript([
      user({ origin: { kind: "human" }, permissionMode: "default" }),
      assistant(),
      user({ origin: { kind: "human" }, permissionMode: "acceptEdits" }),
      assistant(),
    ]);
    expect(await readResumedPermissionMode(SESSION, configDir)).toBe("acceptEdits");
  });

  it("gives no mode for a plan the session has since left through ExitPlanMode", async () => {
    writeTranscript([
      user({ origin: { kind: "human" }, permissionMode: "plan" }),
      assistant(),
      JSON.stringify({ type: "attachment", attachment: { type: "plan_mode_exit" } }),
      assistant(),
    ]);
    expect(await readResumedPermissionMode(SESSION, configDir)).toBeUndefined();
  });

  it("stops at a human prompt that records no mode", async () => {
    writeTranscript([
      user({ origin: { kind: "human" }, permissionMode: "auto" }),
      assistant(),
      user({ origin: { kind: "human" } }),
      assistant(),
    ]);
    expect(await readResumedPermissionMode(SESSION, configDir)).toBeUndefined();
  });

  it("ignores a subagent's records", async () => {
    writeTranscript([
      user({ origin: { kind: "human" }, permissionMode: "default" }),
      user({ isSidechain: true, permissionMode: "bypassPermissions" }),
      assistant(),
    ]);
    expect(await readResumedPermissionMode(SESSION, configDir)).toBe("default");
  });

  it("finds the transcript in any project directory, and gives none without one", async () => {
    writeTranscript([user({ origin: { kind: "human" }, permissionMode: "dontAsk" })], "-other");
    expect(await readResumedPermissionMode(SESSION, configDir)).toBe("dontAsk");
    expect(
      await readResumedPermissionMode("99999999-0000-0000-0000-000000000000", configDir),
    ).toBeUndefined();
  });

  it("reads a transcript longer than one backward chunk", async () => {
    const filler = Array.from({ length: 3000 }, () => assistant());
    writeTranscript([user({ origin: { kind: "human" }, permissionMode: "auto" }), ...filler]);
    expect(await readResumedPermissionMode(SESSION, configDir)).toBe("auto");
  });
});
