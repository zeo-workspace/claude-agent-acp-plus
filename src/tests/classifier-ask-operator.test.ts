import { describe, expect, it, vi } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createAskOperator } from "../classifier-escalation.js";

/**
 * Story 016, R1.2, as rendered by the client. Zed draws a tool call that
 * carries terminal content as the terminal alone and drops every other block,
 * so a classifier-escalation card built with the terminal hid the classifier's
 * reason (seen live in Zeo, 2026-10-07). The denied call never runs — the retry
 * is a new tool_use — so its card carries no terminal at all.
 */
const COMMAND = "git push --force origin main";

function setup(terminalOutput: boolean) {
  const requests: Array<Parameters<typeof requestPermissionFromClient>[0]> = [];
  const requestPermissionFromClient = vi.fn(
    async (request: Omit<RequestPermissionRequest, "options"> & RequestPermissionRequest) => {
      requests.push(request);
      return { outcome: { outcome: "selected" as const, optionId: "classifier-allow-once" } };
    },
  );
  const agent = {
    sessions: { s1: { cwd: "/work", liveBackgroundTasks: new Map() } },
    clientCapabilities: terminalOutput ? { _meta: { terminal_output: true } } : {},
    logger: { log: vi.fn(), error: vi.fn() },
    requestPermissionFromClient,
  };
  const ask = createAskOperator(agent as never, "s1");
  return { ask, requests };
}

const ask = (run: ReturnType<typeof setup>["ask"]) =>
  run(
    {
      toolUseId: "toolu_denied",
      toolName: "Bash",
      input: { command: COMMAND, description: "Force-push main" },
      reason: "[Git Destructive]",
    },
    new AbortController().signal,
  );

describe("createAskOperator — the card shows the reason in a terminal-capable client", () => {
  it("carries no terminal content, even when the client renders terminals", async () => {
    const { ask: run, requests } = setup(true);
    await ask(run);
    expect(requests).toHaveLength(1);
    const content = requests[0]!.toolCall.content ?? [];
    expect(content.some((c) => c.type === "terminal")).toBe(false);
  });

  it("shows the classifier's reason as text, beside the command in the title", async () => {
    for (const terminalOutput of [true, false]) {
      const { ask: run, requests } = setup(terminalOutput);
      await ask(run);
      const toolCall = requests[0]!.toolCall;
      expect(toolCall.title).toBe(COMMAND);
      const texts = (toolCall.content ?? []).flatMap((c) =>
        c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
      );
      expect(texts.some((t) => t.includes("Reason: [Git Destructive]"))).toBe(true);
    }
  });
});
