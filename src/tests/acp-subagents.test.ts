// Story 065, Task 1.1 (R1.1, R1.2): which client gets subagents in the RFD form.
//
// The RFD form is a new wire contract: Zed drops `subagent_update` and
// `session_message` from a client that did not advertise
// `clientCapabilities.subagents` (design.md, Implementation Gotchas), so the
// detection must say yes to exactly the declarations the schema defines —
// `SubagentCapabilities` is an object, `{}` included — and no to everything
// else. The hostile cases come first: shapes that are NOT a declaration but
// look like one, then declarations that do not look like the bare `{}`.

import { describe, expect, it } from "vitest";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { clientSupportsSubagents, subagentForm } from "../acp-subagents.js";

const caps = (value: Record<string, unknown>) => value as unknown as ClientCapabilities;

describe("subagentForm — a client that did not ask gets no RFD form (R1.2)", () => {
  it.each([
    ["`subagents: true`", caps({ subagents: true })],
    ["`subagents: []`", caps({ subagents: [] })],
    ["`subagents: null`", caps({ subagents: null })],
    ['`subagents: "yes"`', caps({ subagents: "yes" })],
    ["`subagents: 1`", caps({ subagents: 1 })],
  ])("treats %s as no declaration", (_label, capabilities) => {
    expect(subagentForm(capabilities)).toBeUndefined();
    expect(clientSupportsSubagents(capabilities)).toBe(false);
  });

  it("does not read the fork's subagent-transcript extension as the RFD", () => {
    // A client that opted into nested subagent transcripts (`_meta`
    // "subagent-transcript") renders nested tool calls, not child sessions.
    const capabilities = caps({ _meta: { "subagent-transcript": true } });
    expect(subagentForm(capabilities)).toBeUndefined();
    expect(clientSupportsSubagents(capabilities)).toBe(false);
  });

  it("does not read a `subagents` key under `_meta` as the declaration", () => {
    const capabilities = caps({ _meta: { subagents: {} } });
    expect(subagentForm(capabilities)).toBeUndefined();
    expect(clientSupportsSubagents(capabilities)).toBe(false);
  });

  it("does not read a sibling capability object as the declaration", () => {
    // Every other capability of a full-featured client, and no `subagents`.
    const capabilities = caps({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      elicitation: { form: {} },
      session: { notices: {} },
      _meta: { terminal_output: true, "terminal-auth": true },
    });
    expect(subagentForm(capabilities)).toBeUndefined();
    expect(clientSupportsSubagents(capabilities)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["no capabilities", caps({})],
  ])("gets no form with %s", (_label, capabilities) => {
    expect(subagentForm(capabilities as ClientCapabilities | null | undefined)).toBeUndefined();
    expect(clientSupportsSubagents(capabilities as ClientCapabilities | null | undefined)).toBe(
      false,
    );
  });
});

describe("subagentForm — a client that asked gets the RFD form (R1.1)", () => {
  it("reads a declaration carrying `_meta` as a declaration", () => {
    // The schema's `SubagentCapabilities` is `{ _meta? }`: a declaration need
    // not be the bare `{}`.
    const capabilities = caps({ subagents: { _meta: { vendor: "zeo" } } });
    expect(subagentForm(capabilities)).toBe("rfd");
    expect(clientSupportsSubagents(capabilities)).toBe(true);
  });

  it("reads the declaration beside every other capability", () => {
    const capabilities = caps({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      _meta: { "subagent-transcript": true, terminal_output: true },
      subagents: {},
    });
    expect(subagentForm(capabilities)).toBe("rfd");
    expect(clientSupportsSubagents(capabilities)).toBe(true);
  });

  it("reads `subagents: {}` as the RFD form", () => {
    const capabilities = caps({ subagents: {} });
    expect(subagentForm(capabilities)).toBe("rfd");
    expect(clientSupportsSubagents(capabilities)).toBe(true);
  });
});
