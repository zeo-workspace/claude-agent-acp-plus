import { describe, expect, it } from "vitest";
import { withDistinctModelNames } from "../acp-agent.js";

// Upstream #1286 (issue #1246): aliases and pinned ids can inherit one SDK label.
describe("withDistinctModelNames", () => {
  it("appends the model id to names that occur more than once", () => {
    const rows = withDistinctModelNames([
      { modelId: "opus", name: "Opus 5.5" },
      { modelId: "opus[1m]", name: "Opus 5.5" },
      { modelId: "sonnet", name: "Sonnet 5.5" },
    ]);
    expect(rows.map((row) => row.name)).toEqual([
      "Opus 5.5 (opus)",
      "Opus 5.5 (opus[1m])",
      "Sonnet 5.5",
    ]);
  });

  it("keeps every row, its id and its other fields", () => {
    const rows = withDistinctModelNames([
      { modelId: "a", name: "Same", description: "first" },
      { modelId: "b", name: "Same", description: "second" },
    ]);
    expect(rows).toEqual([
      { modelId: "a", name: "Same (a)", description: "first" },
      { modelId: "b", name: "Same (b)", description: "second" },
    ]);
  });
});
