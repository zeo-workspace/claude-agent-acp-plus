import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guard for `ModelInfo.supportsThinkingOff`, the runtime field the Thinking option reads
 * (thinking-option.ts, `modelCanDisableThinking`). The SDK's sdk.d.ts does not declare it and
 * the CLI marks it internal, so a CLI that stops sending it degrades SILENTLY: every model reads
 * as able to turn thinking off, "Off" reappears on models that always think, and the CLI quietly
 * runs those turns adaptive anyway. No type error, no failing unit test -- the unit tests feed
 * hand-built rows. This test reads the CLI the SDK actually bundles, so an SDK bump that drops
 * the field fails here instead (follow-up of story 071, 2026-11-09).
 *
 * It looks for the field name in the bundled binary: a hypothesis check, not proof the field is
 * populated, which only a live `supportedModels()` call shows. When the platform package is not
 * installed (another OS or libc), there is nothing to read and the test skips.
 */

const require = createRequire(import.meta.url);

function bundledCliPath(): string | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`,
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl/claude${ext}`,
  ];
  for (const candidate of candidates) {
    try {
      const path = require.resolve(candidate);
      if (existsSync(path)) return path;
    } catch {
      // Not installed for this platform; try the next candidate.
    }
  }
  return undefined;
}

const cliPath = bundledCliPath();

describe("bundled CLI still sends ModelInfo.supportsThinkingOff", () => {
  it.skipIf(cliPath === undefined)("names the field the Thinking option reads", () => {
    const binary = readFileSync(cliPath as string);
    expect(binary.indexOf("supportsThinkingOff")).toBeGreaterThanOrEqual(0);
  });
});
