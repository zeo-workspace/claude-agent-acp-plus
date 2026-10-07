import { describe, expect, it, vi } from "vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { GrantStore, createGrantPreToolUseHook, fingerprint } from "../classifier-escalation.js";

/**
 * Story 016, Task 6.1 (R2.1, R2.2, R3.1, R6.2, R6.3). The PreToolUse hook is
 * the only thing that lets a granted call skip the classifier, so it must
 * answer `allow` for exactly the approved call and nothing else.
 */
const SECRET_COMMAND = "psql postgres://admin:hunter2@db.internal/prod -c 'DROP TABLE x'";
const ALLOW = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "approved by the operator after a classifier denial",
  },
};

function setup() {
  const store = new GrantStore();
  const session = { sessionId: "sess-1", classifierGrants: store };
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push(
        `${level} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`,
      );
  const logger = {
    log: vi.fn(record("log")),
    error: vi.fn(record("error")),
    warn: vi.fn(record("warn")),
    info: vi.fn(record("info")),
    debug: vi.fn(record("debug")),
  };
  const hook: HookCallback = createGrantPreToolUseHook(session as any, logger as any);
  return { hook, store, lines };
}

function call(toolUseId: string, input: unknown, toolName = "Bash") {
  return {
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/work",
    tool_name: toolName,
    tool_input: input,
    tool_use_id: toolUseId,
  } as Parameters<HookCallback>[0];
}
const opts = () => ({ signal: new AbortController().signal });

describe("createGrantPreToolUseHook — must not allow what was not approved", () => {
  it("returns {} with no grant at all", async () => {
    const { hook } = setup();
    expect(await hook(call("toolu_1", { command: "ls" }), "toolu_1", opts())).toEqual({});
  });

  it("returns {} for a different command, and leaves the grant unconsumed", async () => {
    const { hook, store } = setup();
    store.grantOnce(fingerprint("Bash", { command: "npm test" })!);
    expect(
      await hook(call("toolu_2", { command: "npm test; rm -rf ~" }), "toolu_2", opts()),
    ).toEqual({});
    expect(await hook(call("toolu_3", { command: "npm test" }), "toolu_3", opts())).toEqual(ALLOW);
  });

  it("returns {} for the same command under another tool name", async () => {
    const { hook, store } = setup();
    store.grantSession(fingerprint("Bash", { command: "Remove-Item x" })!);
    expect(
      await hook(call("toolu_2", { command: "Remove-Item x" }, "PowerShell"), "toolu_2", opts()),
    ).toEqual({});
  });

  it("returns {} when a non-cosmetic field changed on retry (R2.3)", async () => {
    const { hook, store } = setup();
    store.grantSession(fingerprint("Bash", { command: "npm test" })!);
    expect(
      await hook(
        call("toolu_2", { command: "npm test", run_in_background: true }),
        "toolu_2",
        opts(),
      ),
    ).toEqual({});
  });

  it("returns {} without throwing for an input that cannot be fingerprinted", async () => {
    const { hook } = setup();
    const cyclic: Record<string, unknown> = { command: "x" };
    cyclic.self = cyclic;
    await expect(hook(call("toolu_c", cyclic), "toolu_c", opts())).resolves.toEqual({});
  });
});

describe("createGrantPreToolUseHook — allows the approved call", () => {
  it("allows the retry under a new tool_use_id even with a rewritten description (R2.1)", async () => {
    const { hook, store } = setup();
    store.grantOnce(fingerprint("Bash", { command: "npm test", description: "Run tests" })!);
    expect(
      await hook(
        call("toolu_retry", { command: "npm test", description: "Retry the tests" }),
        "toolu_retry",
        opts(),
      ),
    ).toEqual(ALLOW);
  });

  it("a once grant lets exactly one call through; the next identical call goes to the classifier (R2.2)", async () => {
    const { hook, store } = setup();
    store.grantOnce(fingerprint("Bash", { command: "npm test" })!);
    expect(await hook(call("toolu_a", { command: "npm test" }), "toolu_a", opts())).toEqual(ALLOW);
    expect(await hook(call("toolu_b", { command: "npm test" }), "toolu_b", opts())).toEqual({});
  });

  it("a session grant lets every later identical call through (R3.1)", async () => {
    const { hook, store } = setup();
    store.grantSession(fingerprint("Bash", { command: "npm test" })!);
    for (const id of ["toolu_a", "toolu_b", "toolu_c"]) {
      expect(await hook(call(id, { command: "npm test" }), id, opts())).toEqual(ALLOW);
    }
  });
});

describe("createGrantPreToolUseHook — observable without leaking input (R6.2, R6.3)", () => {
  it("logs one line per consumed grant with session id, new tool_use_id, tool name and kind", async () => {
    const { hook, store, lines } = setup();
    store.grantOnce(fingerprint("Bash", { command: SECRET_COMMAND })!);
    await hook(call("toolu_once", { command: SECRET_COMMAND }), "toolu_once", opts());
    const onceLines = lines.filter((l) => l.includes("toolu_once"));
    expect(onceLines).toHaveLength(1);
    expect(onceLines[0]).toContain("sess-1");
    expect(onceLines[0]).toContain("Bash");
    expect(onceLines[0]).toMatch(/\bonce\b/);

    store.grantSession(fingerprint("Bash", { command: SECRET_COMMAND })!);
    await hook(call("toolu_sess", { command: SECRET_COMMAND }), "toolu_sess", opts());
    const sessionLines = lines.filter((l) => l.includes("toolu_sess"));
    expect(sessionLines).toHaveLength(1);
    expect(sessionLines[0]).toContain("sess-1");
    // The two kinds are distinguishable in the log.
    expect(sessionLines[0]!.replace("toolu_sess", "toolu_once")).not.toBe(onceLines[0]);
  });

  it("never logs the command or any input field", async () => {
    const { hook, store, lines } = setup();
    store.grantSession(fingerprint("Bash", { command: SECRET_COMMAND, description: "Drop it" })!);
    await hook(
      call("toolu_1", { command: SECRET_COMMAND, description: "Drop it" }),
      "toolu_1",
      opts(),
    );
    await hook(call("toolu_2", { command: "other secret-ish thing" }), "toolu_2", opts());
    const all = lines.join("\n");
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("db.internal");
    expect(all).not.toContain("Drop it");
    expect(all).not.toContain("secret-ish");
  });
});
