import { describe, expect, it, vi } from "vitest";
import {
  EscalationRegistry,
  GrantStore,
  createGrantPreToolUseHook,
  fingerprint,
} from "../classifier-escalation.js";

/**
 * Story 016, R6.3 hygiene left by its audit: no log line this story adds may
 * carry text a client or the model chose. An emit failure's message can echo
 * the update (and with it the command), and a tool name is model-steerable for
 * MCP tools, so both are reduced before they reach a line.
 */
const SECRET = "psql postgres://admin:hunter2@db/prod";

function capture() {
  const lines: string[] = [];
  const logger = {
    log: vi.fn((line: string) => lines.push(line)),
    error: vi.fn((line: string) => lines.push(line)),
  };
  return { lines, logger };
}

describe("classifier escalation logs", () => {
  it("a failed final update logs the error's kind, never its message", async () => {
    const { lines, logger } = capture();
    const registry = new EscalationRegistry({
      sessionId: "s1",
      emit: () => {
        throw new TypeError(`client refused update for ${SECRET}`);
      },
      logger: logger as never,
    });
    registry.noteFrame({
      toolUseId: "toolu_1",
      reasonType: "classifier",
      reason: "[Git Destructive]",
    });
    registry.claim("toolu_1");
    registry.resolve("toolu_1", "rejected");
    await Promise.resolve();
    const all = lines.join("\n");
    expect(all).toContain("toolUseId=toolu_1");
    expect(all).toContain("TypeError");
    expect(all).not.toContain("hunter2");
  });

  it("a rejected emit promise is logged the same way", async () => {
    const { lines, logger } = capture();
    const registry = new EscalationRegistry({
      sessionId: "s1",
      emit: () => Promise.reject(new Error(`echo ${SECRET}`)),
      logger: logger as never,
    });
    registry.noteFrame({ toolUseId: "toolu_2", reasonType: "classifier", reason: "r" });
    registry.claim("toolu_2");
    registry.resolve("toolu_2", "rejected");
    await new Promise((r) => setTimeout(r, 0));
    expect(lines.join("\n")).not.toContain("hunter2");
    expect(lines.join("\n")).toContain("toolUseId=toolu_2");
  });

  it("a grant line carries the tool name reduced to a safe token", async () => {
    const { lines, logger } = capture();
    const store = new GrantStore();
    const toolName = "mcp__x__run level=error injected=1\nforged line";
    store.grantSession(fingerprint(toolName, { q: 1 })!);
    const hook = createGrantPreToolUseHook(
      { sessionId: "s1", classifierGrants: store },
      logger as never,
    );
    await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        transcript_path: "/t",
        cwd: "/w",
        permission_mode: "auto",
        tool_name: toolName,
        tool_input: { q: 1 },
        tool_use_id: "toolu_3",
      } as never,
      "toolu_3",
      { signal: new AbortController().signal },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).not.toContain(" injected=1");
    expect(lines[0]).toContain("toolName=mcp__x__run");
  });
});
