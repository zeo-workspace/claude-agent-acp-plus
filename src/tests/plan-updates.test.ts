import { describe, expect, it } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  applyPlanUpdatesToOptions,
  readTodoToolsEnv,
  resolvePlanUpdatesAtSpawn,
  TODO_TOOLS_ENV,
} from "../plan-updates.js";

// Story 062 tech review (M1, L1): the precedence and spelling the CLI uses.
describe("plan-updates env resolution", () => {
  it("reads the CLI's truthy spellings as on and anything else as off", () => {
    for (const v of ["1", "true", "YES", " on "]) expect(readTodoToolsEnv(v)).toBe(true);
    for (const v of ["0", "false", "no", ""]) expect(readTodoToolsEnv(v)).toBe(false);
    expect(readTodoToolsEnv(undefined)).toBeUndefined();
  });

  it("lets the command-line settings outrank the settings files and the spawn env", () => {
    expect(
      resolvePlanUpdatesAtSpawn(
        { [TODO_TOOLS_ENV]: "1" },
        { [TODO_TOOLS_ENV]: "1" },
        { [TODO_TOOLS_ENV]: "0" },
      ),
    ).toEqual({ enabled: false, inject: false, settingsValue: false });
  });

  it("injects only when no tier sets the variable", () => {
    expect(resolvePlanUpdatesAtSpawn({}, undefined, undefined)).toEqual({
      enabled: true,
      inject: true,
    });
  });

  it("overrides a settings pin in the command-line tier, both ways", () => {
    const options: Options = { settings: { env: { [TODO_TOOLS_ENV]: "0" } } };
    expect(applyPlanUpdatesToOptions(options, true, false)).toBe(true);
    expect((options.settings as { env: Record<string, string> }).env[TODO_TOOLS_ENV]).toBe("1");
    expect(options.env?.[TODO_TOOLS_ENV]).toBe("1");
    expect(applyPlanUpdatesToOptions(options, false, false)).toBe(true);
    expect((options.settings as { env: Record<string, string> }).env[TODO_TOOLS_ENV]).toBe("0");
  });

  it("reports a settings file path it cannot override", () => {
    const options: Options = { settings: "/etc/claude/settings.json" };
    expect(applyPlanUpdatesToOptions(options, true, false)).toBe(false);
    expect(options.env?.[TODO_TOOLS_ENV]).toBe("1");
  });
});
