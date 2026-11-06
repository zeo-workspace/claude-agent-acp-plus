// Story 065, Task 3.1 tech review: the cancel races the cancel suite does not
// reach — an ask raised after its child was cancelled, a question (not a
// permission) open on a cancelled child, and a cancel after the parent closed.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentStarted,
  agentToolUse,
  assistant,
  lastCaptured,
  type Launch,
  statesOf,
  tick,
  waitFor,
} from "./child-sessions-harness.js";
import { connect, disconnectAll, RFD_CAPABILITIES } from "./child-sessions-connection.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { capturingQuery } = await import("./child-sessions-harness.js");
  return { ...actual, query: vi.fn(capturingQuery) };
});

afterEach(disconnectAll);

const PARSER: Launch = {
  toolUseId: "toolu_01ParserLaunch",
  agentId: "a3f9c1d2e4b5a6c7",
  name: "parser-finder",
  subagentType: "Explore",
  description: "Find the parser",
  prompt: "Find where the config parser lives.",
};

async function oneChild(capabilities: Record<string, unknown> = RFD_CAPABILITIES) {
  const c = await connect(capabilities);
  const s = await c.open();
  const response = s.prompt();
  s.push(assistant(s.sessionId, [agentToolUse(PARSER)]));
  s.push(agentStarted(s.sessionId, PARSER));
  await waitFor(() => statesOf(c.updates, PARSER.agentId).length > 0, "the child's announcement");
  return { c, s, response };
}

const childAsk = (toolName: string, input: Record<string, unknown>, toolUseID: string) =>
  lastCaptured().options.canUseTool(toolName, input, {
    signal: new AbortController().signal,
    toolUseID,
    agentID: PARSER.agentId,
  });

describe("child sessions — cancel races", () => {
  it("denies a permission request a cancelled child raises afterwards, without asking the client", async () => {
    const { c } = await oneChild();
    await c.agent.cancel({ sessionId: PARSER.agentId });

    const result = await childAsk("Bash", { command: "ls" }, "toolu_01LateBash");

    expect(result.behavior).toBe("deny");
    expect(c.permissions).toEqual([]);
  });

  it("answers a question open on a child when that child is cancelled", async () => {
    const { c } = await oneChild({ ...RFD_CAPABILITIES, elicitation: { form: {} } });
    const asked: unknown[] = [];
    (c.agent.client as any).unstable_createElicitation = (request: unknown) => {
      asked.push(request);
      return new Promise(() => {});
    };
    const question = childAsk(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Which parser?",
            header: "Parser",
            multiSelect: false,
            options: [
              { label: "toml", description: "TOML" },
              { label: "yaml", description: "YAML" },
            ],
          },
        ],
      },
      "toolu_01ChildQuestion",
    );
    await waitFor(() => asked.length === 1, "the child's question");
    expect((asked[0] as { sessionId?: string }).sessionId).toBe(PARSER.agentId);

    await c.agent.cancel({ sessionId: PARSER.agentId });
    await tick(50);

    await expect(question).resolves.toMatchObject({ behavior: "deny" });
  });

  it("settles a child cancelled after its parent closed, and logs both ids", async () => {
    const { c, s } = await oneChild();
    await c.agent.closeSession({ sessionId: s.sessionId });

    await c.agent.cancel({ sessionId: PARSER.agentId });

    expect(statesOf(c.updates, PARSER.agentId).at(-1)).toMatchObject({
      state: "idle",
      stopReason: "cancelled",
    });
    expect(
      c.lines.some(
        (line) =>
          line.includes("outcome=parent_gone") &&
          line.includes(PARSER.agentId) &&
          line.includes(s.sessionId),
      ),
    ).toBe(true);
  });
});
