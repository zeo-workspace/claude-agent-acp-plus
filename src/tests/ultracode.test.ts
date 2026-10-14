/**
 * Ultracode as a boolean option — the module's pure parts. The session-level
 * behaviour (toggle, effort, model switch, recreate, readback) is driven
 * through the agent in `ultracode-session.test.ts`.
 *
 * The assertions that matter are the two payload rules the old notch got
 * wrong: an effort change carries `ultracode:true` while the intent is on, and
 * never carries `null`.
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  createUltracodeConfigOption,
  effortFlagSettings,
  isLegacyUltracodeEffort,
  isUltracodeAvailable,
  placeUltracodeOption,
  readUltracodeState,
  resolveUltracodeRequested,
  ULTRACODE_CONFIG_ID,
  ultracodeTogglePayload,
} from "../ultracode.js";
import { buildConfigOptions } from "../acp-agent.js";
import { EFFORT_CONFIG_ID } from "../session-config-ids.js";

const MODES = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default", description: "Standard behavior" }],
};

const MODELS = {
  currentModelId: "m1",
  availableModels: [{ modelId: "m1", name: "M1", description: "A model" }],
};

const modelInfo = (levels: EffortLevel[]): ModelInfo[] => [
  {
    value: "m1",
    displayName: "M1",
    description: "A model",
    supportsEffort: levels.length > 0,
    supportedEffortLevels: levels,
  },
];

const ids = (options: SessionConfigOption[]) => options.map((o) => o.id);

describe("ultracode: availability heuristic", () => {
  it("needs xhigh on the model", () => {
    expect(isUltracodeAvailable(["low", "medium", "high"], {})).toBe(false);
    expect(isUltracodeAvailable(["low", "high", "xhigh"], {})).toBe(true);
  });

  it("is withheld when workflows are disabled", () => {
    expect(isUltracodeAvailable(["xhigh"], { disableWorkflows: true })).toBe(false);
    expect(isUltracodeAvailable(["xhigh"], { disableWorkflows: false })).toBe(true);
  });

  it("treats an ABSENT disableWorkflows as not-disabled", () => {
    expect(isUltracodeAvailable(["xhigh"], undefined)).toBe(true);
    expect(isUltracodeAvailable(["xhigh"], {})).toBe(true);
  });
});

describe("ultracode: payloads", () => {
  it("toggles with true and an explicit null", () => {
    expect(ultracodeTogglePayload(true)).toEqual({ ultracode: true });
    const off = JSON.parse(JSON.stringify(ultracodeTogglePayload(false)));
    expect(off).toEqual({ ultracode: null });
  });

  it("carries the intent on every effort change, and never null", () => {
    expect(effortFlagSettings("high", true)).toEqual({ effortLevel: "high", ultracode: true });
    expect(effortFlagSettings("default", true)).toEqual({ effortLevel: null, ultracode: true });
    expect(effortFlagSettings(undefined, true)).toEqual({ effortLevel: null, ultracode: true });
    for (const v of ["low", "high", "xhigh", "max", "default", undefined]) {
      expect(effortFlagSettings(v, false)).not.toHaveProperty("ultracode");
    }
  });

  it("never raises effort to xhigh on its own", () => {
    expect(effortFlagSettings("high", true).effortLevel).toBe("high");
  });
});

describe("ultracode: the option", () => {
  it("is a boolean for clients that opted in", () => {
    expect(createUltracodeConfigOption(true, true)).toEqual({
      id: ULTRACODE_CONFIG_ID,
      name: "Ultracode",
      description: "Run dynamic workflows on every task",
      category: "model_config",
      type: "boolean",
      currentValue: true,
    });
  });

  it("is an on/off select otherwise", () => {
    expect(createUltracodeConfigOption(false, false)).toMatchObject({
      type: "select",
      currentValue: "off",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    });
  });

  it("resolves both value shapes and rejects anything else", () => {
    const base = { sessionId: "s", configId: ULTRACODE_CONFIG_ID };
    expect(resolveUltracodeRequested({ ...base, type: "boolean", value: true })).toBe(true);
    expect(resolveUltracodeRequested({ ...base, value: "off" })).toBe(false);
    expect(() => resolveUltracodeRequested({ ...base, value: "xhigh" })).toThrow(/Invalid value/);
  });

  it("recognises only the retired notch as the legacy alias", () => {
    expect(isLegacyUltracodeEffort("ultracode")).toBe(true);
    expect(isLegacyUltracodeEffort("xhigh")).toBe(false);
    expect(isLegacyUltracodeEffort(true)).toBe(false);
  });

  it("is placed after effort, or after model when there is no effort", () => {
    const opt = createUltracodeConfigOption(true, true);
    const withEffort = [{ id: "mode" }, { id: "model" }, { id: "effort" }, { id: "fast" }];
    expect(ids(placeUltracodeOption(withEffort as SessionConfigOption[], opt))).toEqual([
      "mode",
      "model",
      "effort",
      ULTRACODE_CONFIG_ID,
      "fast",
    ]);
    const noEffort = [{ id: "mode" }, { id: "model" }, { id: "fast" }];
    expect(ids(placeUltracodeOption(noEffort as SessionConfigOption[], opt))).toEqual([
      "mode",
      "model",
      ULTRACODE_CONFIG_ID,
      "fast",
    ]);
    const present = placeUltracodeOption(withEffort as SessionConfigOption[], opt);
    expect(ids(placeUltracodeOption(present, undefined))).not.toContain(ULTRACODE_CONFIG_ID);
  });
});

describe("ultracode: buildConfigOptions", () => {
  it("1. the effort select carries no Ultracode entry", () => {
    const options = buildConfigOptions(MODES, MODELS, modelInfo(["low", "high", "xhigh"]));
    const effort = options.find((o) => o.id === EFFORT_CONFIG_ID);
    expect(
      effort?.type === "select" && effort.options.map((o) => ("value" in o ? o.value : "")),
    ).toEqual(["default", "low", "high", "xhigh"]);
  });

  it("shows the option only while available, with the intent as its value", () => {
    const build = (available: boolean) =>
      buildConfigOptions(
        MODES,
        MODELS,
        modelInfo(["xhigh"]),
        "xhigh",
        [],
        "default",
        undefined,
        undefined,
        { available, requested: true, useBooleanOption: true },
      );
    expect(build(true).find((o) => o.id === ULTRACODE_CONFIG_ID)?.currentValue).toBe(true);
    expect(build(false).find((o) => o.id === ULTRACODE_CONFIG_ID)).toBeUndefined();
    // The effort value is the level, whatever the intent.
    expect(build(true).find((o) => o.id === EFFORT_CONFIG_ID)?.currentValue).toBe("xhigh");
  });
});

describe("ultracode: readUltracodeState", () => {
  it("reads applied.{ultracodeRequested, ultracodeAvailable}", async () => {
    const query = {
      getSettings: vi.fn().mockResolvedValue({
        applied: { ultracode: false, ultracodeRequested: true, ultracodeAvailable: false },
      }),
    };
    expect(await readUltracodeState(query)).toEqual({ requested: true, available: false });
  });

  it("is undefined without the method, on a rejection, or with no applied fields", async () => {
    const onError = vi.fn();
    expect(await readUltracodeState({})).toBeUndefined();
    expect(await readUltracodeState(null)).toBeUndefined();
    expect(
      await readUltracodeState({ getSettings: vi.fn().mockRejectedValue(new Error("x")) }, onError),
    ).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(
      await readUltracodeState({ getSettings: vi.fn().mockResolvedValue({}) }),
    ).toBeUndefined();
    expect(
      await readUltracodeState({ getSettings: vi.fn().mockResolvedValue({ applied: {} }) }),
    ).toBeUndefined();
    expect(
      await readUltracodeState({
        getSettings: vi.fn().mockResolvedValue({ applied: { ultracodeAvailable: "yes" } }),
      }),
    ).toBeUndefined();
  });

  it("calls getSettings with the query as `this`", async () => {
    const query = {
      answer: { applied: { ultracodeAvailable: true } },
      async getSettings(this: { answer: unknown }) {
        return this.answer;
      },
    };
    expect(await readUltracodeState(query)).toEqual({ available: true });
  });
});
