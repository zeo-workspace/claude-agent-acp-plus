import { describe, expect, it } from "vitest";
import { subagentLabels } from "../acp-agent.js";

// Upstream #1479: the title tells siblings apart; the description carries the role.
describe("subagentLabels", () => {
  it("titles unnamed siblings of one type by their tasks, not their shared role", () => {
    expect(subagentLabels(undefined, "Search the parser", "Explore")).toEqual({
      title: "Search the parser",
      description: "Explore",
    });
    expect(subagentLabels(undefined, "Search the lexer", "Explore").title).toBe("Search the lexer");
  });

  it("prefers the agent's name over its task", () => {
    expect(subagentLabels("parser-finder", "Search the parser", "Explore")).toEqual({
      title: "parser-finder",
      description: "Explore",
    });
  });

  it("falls back to the role, and then omits a description equal to the title", () => {
    expect(subagentLabels(undefined, "  ", "Explore")).toEqual({ title: "Explore" });
  });

  it("never returns an empty title", () => {
    expect(subagentLabels(undefined, undefined, undefined)).toEqual({ title: "Subagent" });
  });
});
