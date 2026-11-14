import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_USAGE_METHOD,
  fetchContextReport,
  parseContextUsageRequest,
  shapeContextUsage,
} from "../context-usage.js";

const raw = {
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 1759, color: "gray", kind: "used" },
    { id: "system_tools", name: "System tools", tokens: 4466, color: "purple", kind: "used" },
    { id: "messages", name: "Messages", tokens: 855, color: "red", kind: "used" },
    { id: "free_space", name: "Free space", tokens: 200000, color: "dim", kind: "free" },
    { id: "autocompact_buffer", name: "Buffer", tokens: 13000, color: "dim", kind: "buffer" },
    { name: "Future row", tokens: 7, color: "x", kind: "something_new" },
  ],
  totalTokens: 31400,
  maxTokens: 256000,
  rawMaxTokens: 256000,
  percentage: 12.3,
  gridRows: [[{ color: "x", isFilled: true, categoryName: "a", tokens: 1, percentage: 1 }]],
  model: "claude-sonnet-5",
  memoryFiles: [{ path: "/p/CLAUDE.md", type: "Project", tokens: 13600 }],
  mcpTools: [
    { name: "query", serverName: "db", tokens: 900 },
    { name: "search", serverName: "web", tokens: 2200 },
  ],
  agents: [{ agentType: "reviewer", source: "user", tokens: 1900 }],
  skills: {
    totalSkills: 3,
    includedSkills: 2,
    tokens: 5600,
    skillFrontmatter: [
      { name: "zeo-bump", source: "project", tokens: 3000, path: "/p/.claude/skills/x" },
      { name: "epico", source: "plugin", tokens: 2600 },
    ],
  },
  isAutoCompactEnabled: true,
  autoCompactThreshold: 230000,
  messageBreakdown: {
    toolCallTokens: 300,
    toolResultTokens: 9000,
    attachmentTokens: 0,
    assistantMessageTokens: 400,
    userMessageTokens: 155,
    redirectedContextTokens: 0,
    unattributedTokens: 0,
    toolCallsByType: [
      { name: "Read", callTokens: 100, resultTokens: 6000 },
      { name: "Bash", callTokens: 150, resultTokens: 3000 },
      { name: "Grep", callTokens: 50, resultTokens: 0 },
    ],
    attachmentsByType: [],
  },
  apiUsage: null,
};

describe("shapeContextUsage", () => {
  it("keeps what the card and the report show, and drops the grid", () => {
    const report = shapeContextUsage(raw as any, "full");
    expect(report).toEqual({
      status: "ok",
      detail: "full",
      model: "claude-sonnet-5",
      totalTokens: 31400,
      maxTokens: 256000,
      percentage: 12.3,
      autoCompact: { enabled: true, threshold: 230000 },
      categories: [
        { id: "system_tools", name: "System tools", tokens: 4466, color: "purple" },
        { id: "system_prompt", name: "System prompt", tokens: 1759, color: "gray" },
        { id: "messages", name: "Messages", tokens: 855, color: "red" },
      ],
      tools: [
        { name: "Read", callTokens: 100, resultTokens: 6000 },
        { name: "Bash", callTokens: 150, resultTokens: 3000 },
        { name: "Grep", callTokens: 50, resultTokens: 0 },
      ],
      mcpTools: [
        { name: "search", serverName: "web", tokens: 2200 },
        { name: "query", serverName: "db", tokens: 900 },
      ],
      memoryFiles: [{ path: "/p/CLAUDE.md", type: "Project", tokens: 13600 }],
      skills: [
        { name: "zeo-bump", source: "project", tokens: 3000 },
        { name: "epico", source: "plugin", tokens: 2600 },
      ],
      agents: [{ agentType: "reviewer", source: "user", tokens: 1900 }],
    });
    expect(JSON.stringify(report)).not.toContain("gridRows");
  });

  it("tolerates a CLI that sends none of the optional sections", () => {
    const minimal = {
      categories: [{ name: "Messages", tokens: 10, color: "red", kind: "used" }],
      totalTokens: 10,
      maxTokens: 200000,
      percentage: 0,
      model: "m",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: false,
    };
    expect(shapeContextUsage(minimal as any, "summary")).toMatchObject({
      status: "ok",
      detail: "summary",
      categories: [{ name: "Messages", tokens: 10, color: "red" }],
      tools: [],
      skills: [],
      autoCompact: { enabled: false },
    });
  });
});

describe("fetchContextReport", () => {
  it("asks the query for the requested detail", async () => {
    const getContextUsage = vi.fn(async () => raw);
    const report = await fetchContextReport({ getContextUsage } as any, "summary");
    expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    expect(report.status).toBe("ok");
  });

  it("answers unavailable instead of throwing", async () => {
    const getContextUsage = vi.fn(async () => Promise.reject(new Error("timed out")));
    expect(await fetchContextReport({ getContextUsage } as any, "full")).toEqual({
      status: "unavailable",
      message: "timed out",
    });
  });
});

describe("parseContextUsageRequest", () => {
  it("needs a session id", () => {
    expect(parseContextUsageRequest({ sessionId: "s" })).toEqual({ sessionId: "s" });
    expect(() => parseContextUsageRequest({})).toThrow(new RegExp(CONTEXT_USAGE_METHOD));
  });
});
