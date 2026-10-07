import { describe, expect, it, vi } from "vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { GrantStore, createGrantPreToolUseHook, fingerprint } from "../classifier-escalation.js";

/**
 * Story 029, Task 2.1 (R1.1-R1.5, R3.1, R3.4). A classifier-escalation grant
 * is an answer to the auto-mode classifier, so it may only stand in for that
 * classifier: outside `auto` the grant hook must give no decision, consume
 * nothing, and let the mode's own checks run. The mode is the one the CLI puts
 * on the hook input (`permission_mode`) — absent means "not auto".
 *
 * Hostile halves first: the mode values that would make the gate open wrongly
 * (near-"auto" strings, values that only coerce to "auto", a stale session
 * mode), then the gate closing wrongly (a grant lost or a call blocked in
 * auto), then the plain cases.
 */
const SECRET_COMMAND = "psql postgres://admin:hunter2@db.internal/prod -c 'DROP TABLE x'";
const ALLOW = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "approved by the operator after a classifier denial",
  },
};

function setup(sessionExtras: Record<string, unknown> = {}) {
  const store = new GrantStore();
  const session = { sessionId: "sess-1", classifierGrants: store, ...sessionExtras };
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

const ABSENT = Symbol("absent");

/** A PreToolUse input; `mode === ABSENT` leaves `permission_mode` off entirely. */
function call(toolUseId: string, input: unknown, mode: unknown, toolName = "Bash") {
  return {
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/work",
    ...(mode === ABSENT ? {} : { permission_mode: mode }),
    tool_name: toolName,
    tool_input: input,
    tool_use_id: toolUseId,
  } as unknown as Parameters<HookCallback>[0];
}
const opts = () => ({ signal: new AbortController().signal });

const CMD = { command: "git push --force origin main" };
const fpCmd = () => fingerprint("Bash", CMD)!;

/** Every real mode the CLI knows besides `auto` (sdk.d.ts `PermissionMode`). */
const OTHER_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const;

/**
 * Values that are not the string "auto" but look, compare loosely, or coerce
 * like it. Each one must keep the gate shut.
 */
const NEAR_AUTO: [string, unknown][] = [
  ["autoX", "autoX"],
  ["AUTO", "AUTO"],
  ["Auto", "Auto"],
  ["' auto' (leading space)", " auto"],
  ["'auto ' (trailing space)", "auto "],
  ["'auto\\n'", "auto\n"],
  ["'xauto'", "xauto"],
  ["'auto-mode'", "auto-mode"],
  ["empty string", ""],
  ["['auto'] (== 'auto' under loose equality)", ["auto"]],
  ["an object whose toString() is 'auto'", { toString: () => "auto" }],
  ["a String object wrapping 'auto'", new String("auto")],
  ["null", null],
  ["true", true],
];

describe("grant hook outside auto — the gate must not open wrongly (R1.1, R1.2, R1.3)", () => {
  for (const [label, mode] of NEAR_AUTO) {
    it(`a near-auto mode value ${label} gives no decision and consumes nothing`, async () => {
      const { hook, store } = setup();
      store.grantOnce(fpCmd());
      expect(await hook(call("toolu_near", CMD, mode), "toolu_near", opts())).toEqual({});
      // The once grant is still there for the auto-mode retry it was given for.
      expect(store.consume(fpCmd())).toBe("once");
    });
  }

  for (const mode of OTHER_MODES) {
    it(`mode ${mode}: a once grant gives no decision and stays unconsumed`, async () => {
      const { hook, store } = setup();
      store.grantOnce(fpCmd());
      expect(await hook(call("toolu_1", CMD, mode), "toolu_1", opts())).toEqual({});
      expect(await hook(call("toolu_2", CMD, mode), "toolu_2", opts())).toEqual({});
      expect(store.consume(fpCmd())).toBe("once");
    });

    it(`mode ${mode}: a session grant gives no decision, call after call`, async () => {
      const { hook, store } = setup();
      store.grantSession(fpCmd());
      for (const id of ["toolu_a", "toolu_b", "toolu_c"]) {
        expect(await hook(call(id, CMD, mode), id, opts())).toEqual({});
      }
      expect(store.consume(fpCmd())).toBe("session");
    });
  }

  it("no permission_mode on the input at all: no decision, nothing consumed (R1.3)", async () => {
    const { hook, store } = setup();
    store.grantOnce(fpCmd());
    expect(await hook(call("toolu_none", CMD, ABSENT), "toolu_none", opts())).toEqual({});
    expect(store.consume(fpCmd())).toBe("once");
  });

  it("permission_mode explicitly undefined: no decision, nothing consumed (R1.3)", async () => {
    const { hook, store } = setup();
    store.grantSession(fpCmd());
    expect(await hook(call("toolu_undef", CMD, undefined), "toolu_undef", opts())).toEqual({});
  });

  // The mode comes from the hook input, never from the adapter's own session
  // state, which can lag a switch (story Constraints).
  it("a session object claiming auto does not open the gate when the input says default", async () => {
    const { hook, store } = setup({
      permissionMode: "auto",
      currentModeId: "auto",
      modes: { currentModeId: "auto" },
    });
    store.grantOnce(fpCmd());
    expect(await hook(call("toolu_stale", CMD, "default"), "toolu_stale", opts())).toEqual({});
    expect(store.consume(fpCmd())).toBe("once");
  });
});

describe("grant hook in auto — the gate must not close wrongly (R1.4, R3.1)", () => {
  it("a session object claiming default does not shut the gate when the input says auto", async () => {
    const { hook, store } = setup({
      permissionMode: "default",
      currentModeId: "default",
      modes: { currentModeId: "default" },
    });
    store.grantSession(fpCmd());
    expect(await hook(call("toolu_fresh", CMD, "auto"), "toolu_fresh", opts())).toEqual(ALLOW);
  });

  it("a once grant held back outside auto is consumed by the first auto-mode call, and only once", async () => {
    const { hook, store } = setup();
    store.grantOnce(fpCmd());
    for (const [i, mode] of [...OTHER_MODES, ABSENT, "AUTO"].entries()) {
      const id = `toolu_held_${i}`;
      expect(await hook(call(id, CMD, mode), id, opts())).toEqual({});
    }
    expect(await hook(call("toolu_auto_1", CMD, "auto"), "toolu_auto_1", opts())).toEqual(ALLOW);
    expect(await hook(call("toolu_auto_2", CMD, "auto"), "toolu_auto_2", opts())).toEqual({});
  });

  it("a session grant is dormant outside auto and honoured, unchanged, each time auto returns", async () => {
    const { hook, store } = setup();
    store.grantSession(fpCmd());
    const sequence: [unknown, unknown][] = [
      ["auto", ALLOW],
      ["default", {}],
      ["auto", ALLOW],
      ["plan", {}],
      ["acceptEdits", {}],
      ["auto", ALLOW],
      ["auto", ALLOW],
    ];
    for (const [i, [mode, expected]] of sequence.entries()) {
      const id = `toolu_seq_${i}`;
      expect(await hook(call(id, CMD, mode), id, opts())).toEqual(expected);
    }
  });

  it("in auto, a once grant still lets exactly one call through (R3.1)", async () => {
    const { hook, store } = setup();
    store.grantOnce(fpCmd());
    expect(await hook(call("toolu_a", CMD, "auto"), "toolu_a", opts())).toEqual(ALLOW);
    expect(await hook(call("toolu_b", CMD, "auto"), "toolu_b", opts())).toEqual({});
  });
});

describe("grant hook with no matching grant — no decision in every mode (R3.4)", () => {
  for (const mode of ["auto", ...OTHER_MODES, ABSENT] as unknown[]) {
    it(`mode ${String(mode === ABSENT ? "absent" : mode)}: no grant, no decision`, async () => {
      const { hook, store } = setup();
      store.grantSession(fingerprint("Bash", { command: "npm test" })!);
      expect(await hook(call("toolu_x", CMD, mode), "toolu_x", opts())).toEqual({});
    });
  }
});

describe("grant hook — a held-back grant is observable without leaking input (R1.5)", () => {
  it("logs exactly one line per held-back grant with session id, tool_use_id, tool name and mode", async () => {
    const { hook, store, lines } = setup();
    store.grantSession(fingerprint("Bash", { command: SECRET_COMMAND })!);
    await hook(
      call("toolu_held_d", { command: SECRET_COMMAND }, "default"),
      "toolu_held_d",
      opts(),
    );
    await hook(call("toolu_held_p", { command: SECRET_COMMAND }, "plan"), "toolu_held_p", opts());

    const d = lines.filter((l) => l.includes("toolu_held_d"));
    expect(d).toHaveLength(1);
    expect(d[0]).toContain("sess-1");
    expect(d[0]).toContain("Bash");
    expect(d[0]).toMatch(/\bdefault\b/);

    const p = lines.filter((l) => l.includes("toolu_held_p"));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("sess-1");
    expect(p[0]).toMatch(/\bplan\b/);
    // The two lines tell the modes apart.
    expect(p[0]!.replace("toolu_held_p", "toolu_held_d")).not.toBe(d[0]);
  });

  it("logs one line for a held-back grant when the input carries no mode", async () => {
    const { hook, store, lines } = setup();
    store.grantOnce(fpCmd());
    await hook(call("toolu_nomode", CMD, ABSENT), "toolu_nomode", opts());
    expect(lines.filter((l) => l.includes("toolu_nomode"))).toHaveLength(1);
  });

  it("a held-back line is distinguishable from an auto-mode consumed line", async () => {
    const { hook, store, lines } = setup();
    store.grantSession(fpCmd());
    await hook(call("toolu_same", CMD, "default"), "toolu_same", opts());
    await hook(call("toolu_same", CMD, "auto"), "toolu_same", opts());
    const same = lines.filter((l) => l.includes("toolu_same"));
    expect(same).toHaveLength(2);
    expect(same[0]).not.toBe(same[1]);
  });

  it("logs nothing outside auto when no grant matches the call — nothing was held back", async () => {
    const { hook, store, lines } = setup();
    store.grantSession(fingerprint("Bash", { command: "npm test" })!);
    await hook(call("toolu_nomatch", CMD, "default"), "toolu_nomatch", opts());
    expect(lines.filter((l) => l.includes("toolu_nomatch"))).toHaveLength(0);
  });

  it("never logs the command or any input field when holding a grant back", async () => {
    const { hook, store, lines } = setup();
    const input = { command: SECRET_COMMAND, description: "Drop it" };
    store.grantOnce(fingerprint("Bash", input)!);
    store.grantSession(fingerprint("Bash", input)!);
    for (const mode of [...OTHER_MODES, ABSENT]) {
      await hook(call("toolu_leak", input, mode), "toolu_leak", opts());
    }
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("db.internal");
    expect(all).not.toContain("DROP TABLE");
    expect(all).not.toContain("Drop it");
  });
});
