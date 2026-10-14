import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent SDK pin is a behaviour contract, not a dependency number.
 *
 * The SDK bundles the Claude Code CLI, and the CLI has two measured cadence
 * cliffs this adapter's turn accounting reasons from:
 *
 *   - CLI >=2.1.270 withholds `idle` while background agents run. The
 *     held-turn path in acp-agent.ts expects the opposite -- one idle per
 *     processing cycle, never a single "all drained" signal -- and spends an
 *     `owedTrailingIdles` debt on each. Upstream sweeps that counter at the
 *     `running` transition (d3205ab) precisely because the cadence changed;
 *     this adapter does not carry the sweep.
 *   - CLI >=2.1.274 answers queued background completions with placeholder
 *     results (`num_turns: 0`).
 *
 * Crossing either is a port, not a bump: it can hang a turn that spawned
 * background subagents. BOTH have since been crossed, each with its own
 * evidence, and this paragraph is kept because the cliffs are still the reason
 * a bump here is not routine:
 *
 *   - **2.1.270 — ported.** The fork now sweeps the counter at the `running`
 *     transition (`[turn/idle-debt] swept=... at=running-transition` in
 *     acp-agent.ts), which is precisely the upstream d3205ab behaviour the
 *     paragraph above says this adapter does not carry. It does now.
 *   - **2.1.274 — crossed 2026-09-23, measured not to hang.** Raising the pin
 *     0.3.273 -> 0.3.280 for CLI 2.1.280 (Claude Opus 5.5) went past it. Two
 *     independent live measurements on the bumped binary, both green:
 *     a turn driven through the built adapter over ACP stdio returned
 *     `stopReason: end_turn` in 9.9 s after spawning a `Task`; and the same
 *     prompt through `query()` returned `terminal_reason: "completed"`,
 *     `num_turns: 1`, with `subagent_stats.started_in_background: 2` and
 *     `completed: 2`. The placeholder-result shape this cliff predicts did not
 *     appear.
 *
 *   - **0.3.285 -> 0.3.296, 2026-10-15, by hand.** CLI 2.1.296 for Claude
 *     Haiku 5.5 and the `request_marker_lists_v1` capability, inside the
 *     7-day cooldown by operator decision, with upstream #1271/#1330's
 *     companions (the `run_id` late-run drop, the CLI input aliases). Neither
 *     cliff above moved in that range; the background-subagent probe was NOT
 *     re-run for it (the bump's live check stopped at session/new, no model
 *     turn).
 *
 * Neither measurement is a regression test, and that is the point of the
 * paragraph below: re-measure on the next crossing rather than trusting green.
 *
 * WHY THIS TEST EXISTS, when a sibling guard already lives in the fork.
 * The fork's src/tests/deps.test.ts asserts the same contract, but the two are
 * independent repositories with independent CI -- this repository never runs
 * that file. On 2026-09-22 Dependabot PR #106 raised the pin to 0.3.272, every
 * check here passed, and it was merged; the crossing surfaced only when the
 * fork's guard was run by hand. A guard in the other repository cannot fail a
 * build in this one.
 *
 * WHY THE REST OF THE SUITE CANNOT CATCH IT. The idle cadence under test comes
 * from the doubles in session-doubles.ts, which emit the pre-2.1.270 sequence.
 * Those 1200-odd tests stay green across a crossing by construction -- they
 * never speak to the bundled CLI. This file asserts the pin itself for that
 * reason, and is the only thing here that would go red.
 *
 * RAISING THE PIN. Change PINNED in the same commit that ports the accounting,
 * never before it, and move the fork first: the fork leads, the mirror follows
 * (the fork's guard enforces that order from its side). What the guards actually
 * constrain is the RESTING state -- equal pins, with the mirror never ahead -- so
 * what matters is that both trees land on the same value in the same change.
 *
 * And re-run the background-subagent probe by hand, because nothing here will:
 * the doubles in session-doubles.ts emit the pre-cliff cadence by construction,
 * so a crossing that hangs production leaves this suite entirely green. A live
 * turn that spawns background subagents is the only signal that means anything.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIRROR_ROOT = join(HERE, "..", "..");
const FORK_ROOT = join(MIRROR_ROOT, "..", "fork");

const SDK = "@anthropic-ai/claude-agent-sdk";
const PINNED = "0.3.296";

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function dependenciesOf(root: string): Record<string, string> {
  return (readJson(join(root, "package.json")).dependencies ?? {}) as Record<string, string>;
}

describe("agent SDK pin", () => {
  it(`pins the SDK at exactly ${PINNED}`, () => {
    expect(dependenciesOf(MIRROR_ROOT)[SDK]).toBe(PINNED);
  });

  it("carries no range operator, so a later publish cannot be taken silently", () => {
    // `^0.3.280` and `0.3.280` install the same thing TODAY and diverge at the
    // next publish. Equality alone would accept the range on the day it is
    // introduced, which is exactly when it is still invisible.
    const spec = dependenciesOf(MIRROR_ROOT)[SDK] ?? "";
    expect(spec).not.toMatch(/[\^~><*]|\s-\s|\|\|/);
  });

  it("resolves the installed copy to the version the spec names", () => {
    // A spec edited without an install is a pin nothing has exercised, and
    // `npm ci` is what makes the two agree.
    const installed = join(MIRROR_ROOT, "node_modules", SDK, "package.json");
    expect(existsSync(installed)).toBe(true);
    expect(readJson(installed).version).toBe(PINNED);
  });

  it("agrees with the fork where the fork is checked out", (ctx) => {
    // The two are independent repositories: an absent sibling is a skip, never
    // a red. In CI this repository is cloned alone, so only the clauses above
    // run -- which is the point, since those are the ones a bump trips.
    if (!existsSync(join(FORK_ROOT, "package.json"))) {
      ctx.skip(`skipped: no sibling checkout at ${FORK_ROOT}`);
      return;
    }
    expect(dependenciesOf(FORK_ROOT)[SDK]).toBe(PINNED);
  });
});
