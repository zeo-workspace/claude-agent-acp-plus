/**
 * Ultracode as an independent boolean session option (PARITY-REPORT §21.2,
 * item 84), driven through the agent's public ACP surface.
 *
 * The wire contract these tests pin (SDK `applyFlagSettings`, unchanged
 * 0.3.285..0.3.299):
 * - `ultracode: true|false` toggles it and leaves effort alone;
 * - an `effortLevel` change sent WITHOUT the key turns it off;
 * - `null` resets it to off.
 * So the toggle sends `{ultracode:true}` / `{ultracode:null}`, and every effort
 * change re-sends `ultracode:true` while the intent is on — and never `null`.
 *
 * The numbering follows the design's test list (1–10; 11 is the mutation
 * check run against these tests, 12 the stdio probe).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import { SettingsManager } from "../settings.js";

const XHIGH_MODEL = "claude-opus-x";
const PLAIN_MODEL = "claude-sonnet-p";

const MODELS = [
  {
    value: XHIGH_MODEL,
    displayName: "Opus X",
    description: "Has xhigh",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
  },
  {
    value: PLAIN_MODEL,
    displayName: "Sonnet P",
    description: "No xhigh",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsFastMode: true,
  },
];

/** What the next query's `getSettings()` answers. `"reject"` makes it fail,
 *  `"absent"` removes the method (an SDK without the untyped runtime call). */
let nextGetSettings: unknown | "reject" | "absent";

const mockQuery = vi.hoisted(() => vi.fn((): Record<string, unknown> => ({})));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

function makeQuery() {
  const answer = nextGetSettings;
  const q: Record<string, unknown> = {
    initializationResult: vi.fn().mockResolvedValue({ models: MODELS }),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    getContextUsage: vi.fn().mockResolvedValue({ totalTokens: 0, rawMaxTokens: 200000 }),
    [Symbol.asyncIterator]: async function* () {},
  };
  if (answer === "reject") {
    q.getSettings = vi.fn().mockRejectedValue(new Error("get_settings unsupported"));
  } else if (answer !== "absent") {
    q.getSettings = vi.fn().mockResolvedValue(answer);
  }
  return q;
}

/** Settings the session resolves; layered over the real ones so every other
 *  key a session reads keeps its normal shape. */
let settingsOverlay: Partial<Settings> & Record<string, unknown>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function startSession(opts: { boolean?: boolean } = {}) {
  const updates: SessionNotification[] = [];
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (n: SessionNotification) => {
        updates.push(n);
      },
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
  );
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities:
      opts.boolean === false ? {} : { session: { configOptions: { boolean: {} } } },
  });
  const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const sessionId = response.sessionId;
  const session = (agent as any).sessions[sessionId];
  const query = session.query as { applyFlagSettings: ReturnType<typeof vi.fn> };
  // Let the background readback land before the test drives the session.
  await flush();
  const initialCalls = [...query.applyFlagSettings.mock.calls];
  query.applyFlagSettings.mockClear();
  return { agent, sessionId, session, query, response, updates, initialCalls };
}

const option = (options: SessionConfigOption[], id: string) => options.find((o) => o.id === id);

const optionValues = (o: SessionConfigOption | undefined): string[] =>
  o && o.type === "select"
    ? o.options.flatMap((x) => ("value" in x ? [x.value] : x.options.map((y) => y.value)))
    : [];

beforeEach(() => {
  nextGetSettings = "absent";
  settingsOverlay = { model: XHIGH_MODEL };
  mockQuery.mockImplementation(makeQuery);
  const real = SettingsManager.prototype.getSettings;
  vi.spyOn(SettingsManager.prototype, "getSettings").mockImplementation(function (
    this: SettingsManager,
  ) {
    const base = real.call(this) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...base, ...settingsOverlay };
    // Pin the keys this suite reasons about, whatever the developer's own
    // settings file says.
    for (const key of ["ultracode", "effortLevel", "disableWorkflows", "accounts"]) {
      if (!(key in settingsOverlay)) delete merged[key];
    }
    return merged as Settings;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mockQuery.mockReset();
});

describe("1. the effort select", () => {
  it("carries no Ultracode entry on an xhigh model", async () => {
    const { response } = await startSession();
    const effort = option(response.configOptions!, "effort");
    expect(optionValues(effort)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("2. the Ultracode option", () => {
  it("is a boolean after effort and before fast when available", async () => {
    const { response } = await startSession();
    const ids = response.configOptions!.map((o) => o.id);
    expect(ids.indexOf("ultracode")).toBe(ids.indexOf("effort") + 1);
    expect(ids.indexOf("fast")).toBe(ids.indexOf("ultracode") + 1);
    expect(option(response.configOptions!, "ultracode")).toEqual({
      id: "ultracode",
      name: "Ultracode",
      description: "Run dynamic workflows on every task",
      category: "model_config",
      type: "boolean",
      currentValue: false,
    });
  });

  it("is absent on a model without xhigh", async () => {
    settingsOverlay = { model: PLAIN_MODEL };
    const { response } = await startSession();
    expect(option(response.configOptions!, "ultracode")).toBeUndefined();
  });

  it("is absent when workflows are disabled", async () => {
    settingsOverlay = { model: XHIGH_MODEL, disableWorkflows: true };
    const { response } = await startSession();
    expect(option(response.configOptions!, "ultracode")).toBeUndefined();
  });

  it("falls back to an on/off select without the boolean capability", async () => {
    const { response } = await startSession({ boolean: false });
    const ultracode = option(response.configOptions!, "ultracode");
    expect(ultracode).toMatchObject({ type: "select", currentValue: "off" });
    expect(optionValues(ultracode)).toEqual(["on", "off"]);
  });
});

describe("3. toggling", () => {
  it("sends exactly {ultracode:true} on and {ultracode:null} off", async () => {
    const { agent, sessionId, query, session } = await startSession();

    const on = await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      type: "boolean",
      value: true,
    });
    expect(query.applyFlagSettings.mock.calls).toEqual([[{ ultracode: true }]]);
    expect(option(on.configOptions, "ultracode")?.currentValue).toBe(true);
    // Effort is left alone.
    expect(option(on.configOptions, "effort")?.currentValue).toBe("default");
    expect(session.ultracodeRequested).toBe(true);

    const off = await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      type: "boolean",
      value: false,
    });
    expect(query.applyFlagSettings.mock.calls.at(-1)).toEqual([{ ultracode: null }]);
    // `null`, not `undefined`: JSON drops an undefined key and the SDK only
    // clears a flag on an explicit null.
    expect(JSON.parse(JSON.stringify(query.applyFlagSettings.mock.calls.at(-1)![0]))).toEqual({
      ultracode: null,
    });
    expect(option(off.configOptions, "ultracode")?.currentValue).toBe(false);
    expect(session.ultracodeRequested).toBe(false);
  });

  it("accepts the on/off select fallback", async () => {
    const { agent, sessionId, query } = await startSession({ boolean: false });
    const on = await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      value: "on",
    });
    expect(query.applyFlagSettings).toHaveBeenCalledWith({ ultracode: true });
    expect(option(on.configOptions, "ultracode")?.currentValue).toBe("on");
  });
});

describe("4–5. an effort change carries the intent", () => {
  it("4a. sends {high, ultracode:true} with the intent on", async () => {
    const { agent, sessionId, query } = await startSession();
    await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      type: "boolean",
      value: true,
    });
    query.applyFlagSettings.mockClear();

    const res = await agent.setSessionConfigOption({
      sessionId,
      configId: "effort",
      value: "high",
    });
    expect(query.applyFlagSettings.mock.calls).toEqual([
      [{ effortLevel: "high", ultracode: true }],
    ]);
    expect(option(res.configOptions, "ultracode")?.currentValue).toBe(true);
  });

  it("4b. sends {high} with NO ultracode key when the intent is off", async () => {
    const { agent, sessionId, query } = await startSession();
    await agent.setSessionConfigOption({ sessionId, configId: "effort", value: "high" });
    expect(query.applyFlagSettings.mock.calls).toEqual([[{ effortLevel: "high" }]]);
    expect(query.applyFlagSettings.mock.calls[0][0]).not.toHaveProperty("ultracode");
  });

  it("5. Default with the intent on sends {effortLevel:null, ultracode:true}", async () => {
    const { agent, sessionId, query } = await startSession();
    await agent.setSessionConfigOption({ sessionId, configId: "effort", value: "high" });
    await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      type: "boolean",
      value: true,
    });
    query.applyFlagSettings.mockClear();

    await agent.setSessionConfigOption({ sessionId, configId: "effort", value: "default" });
    expect(query.applyFlagSettings.mock.calls).toEqual([[{ effortLevel: null, ultracode: true }]]);
  });
});

describe("6. a model switch keeps the intent", () => {
  it("hides the option without availability, re-sends the intent, and shows it again", async () => {
    const { agent, sessionId, query, session } = await startSession();
    await agent.setSessionConfigOption({ sessionId, configId: "effort", value: "xhigh" });
    await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      type: "boolean",
      value: true,
    });
    query.applyFlagSettings.mockClear();

    const away = await agent.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: PLAIN_MODEL,
    });
    expect(option(away.configOptions, "ultracode")).toBeUndefined();
    // xhigh is not offered here, so effort falls back to Default — an effort
    // change, which must carry the intent or the CLI drops it.
    expect(option(away.configOptions, "effort")?.currentValue).toBe("default");
    expect(query.applyFlagSettings.mock.calls).toEqual([[{ effortLevel: null, ultracode: true }]]);
    expect(session.ultracodeRequested).toBe(true);

    const back = await agent.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: XHIGH_MODEL,
    });
    expect(option(back.configOptions, "ultracode")?.currentValue).toBe(true);
    for (const [payload] of query.applyFlagSettings.mock.calls) {
      expect(payload).not.toHaveProperty("ultracode", null);
    }
  });

  it("re-reads availability after the switch, in the background", async () => {
    nextGetSettings = { applied: { ultracodeRequested: false, ultracodeAvailable: true } };
    const { agent, sessionId, session, updates } = await startSession();
    await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      type: "boolean",
      value: true,
    });
    // The CLI now says this model cannot run it (e.g. an org policy).
    session.query.getSettings = vi
      .fn()
      .mockResolvedValue({ applied: { ultracodeRequested: true, ultracodeAvailable: false } });
    await agent.setSessionConfigOption({ sessionId, configId: "model", value: PLAIN_MODEL });
    await agent.setSessionConfigOption({ sessionId, configId: "model", value: XHIGH_MODEL });
    updates.length = 0;
    await flush();

    expect(session.query.getSettings).toHaveBeenCalled();
    expect(option(session.configOptions, "ultracode")).toBeUndefined();
    expect(session.ultracodeRequested).toBe(true);
    expect(updates.map((u) => u.update.sessionUpdate)).toContain("config_option_update");
  });
});

describe("7. query recreate", () => {
  async function recreate(effort: string) {
    const started = await startSession();
    const { agent, sessionId, session } = started;
    if (effort !== "default") {
      await agent.setSessionConfigOption({ sessionId, configId: "effort", value: effort });
    }
    await agent.setSessionConfigOption({
      sessionId,
      configId: "ultracode",
      type: "boolean",
      value: true,
    });
    await (agent as any).recreateSessionQuery(sessionId, session);
    return (session.query as { applyFlagSettings: ReturnType<typeof vi.fn> }).applyFlagSettings.mock
      .calls;
  }

  it("re-applies the intent when effort is Default", async () => {
    expect(await recreate("default")).toContainEqual([{ ultracode: true }]);
  });

  it("re-applies it with the level otherwise", async () => {
    expect(await recreate("high")).toContainEqual([{ effortLevel: "high", ultracode: true }]);
  });
});

describe("8. seeding at session start", () => {
  it("seeds from getSettings().applied and announces the change", async () => {
    nextGetSettings = { applied: { ultracodeRequested: true, ultracodeAvailable: true } };
    const { session, updates } = await startSession();
    expect(session.ultracodeRequested).toBe(true);
    expect(option(session.configOptions, "ultracode")?.currentValue).toBe(true);
    const update = updates.find((u) => u.update.sessionUpdate === "config_option_update");
    expect(update).toBeDefined();
  });

  it("ultracodeAvailable:false hides the option even on an xhigh model", async () => {
    nextGetSettings = { applied: { ultracodeRequested: false, ultracodeAvailable: false } };
    const { session } = await startSession();
    expect(option(session.configOptions, "ultracode")).toBeUndefined();
  });

  it("a rejected read falls back to the heuristic plus settings.ultracode", async () => {
    nextGetSettings = "reject";
    settingsOverlay = { model: XHIGH_MODEL, ultracode: true };
    const { session } = await startSession();
    expect(option(session.configOptions, "ultracode")?.currentValue).toBe(true);
  });

  it("an empty read falls back to the heuristic", async () => {
    nextGetSettings = {};
    const { session } = await startSession();
    expect(option(session.configOptions, "ultracode")?.currentValue).toBe(false);
  });

  it("settings ultracode:true with effort high keeps high and sends the key with it", async () => {
    settingsOverlay = { model: XHIGH_MODEL, ultracode: true, effortLevel: "high" };
    const { response, initialCalls } = await startSession();
    expect(option(response.configOptions!, "effort")?.currentValue).toBe("high");
    expect(option(response.configOptions!, "ultracode")?.currentValue).toBe(true);
    expect(initialCalls).toEqual([[{ effortLevel: "high", ultracode: true }]]);
  });
});

describe("9. the legacy effort alias", () => {
  it("accepts effort='ultracode' as {xhigh, ultracode:true}", async () => {
    const { agent, sessionId, query, session } = await startSession();
    const res = await agent.setSessionConfigOption({
      sessionId,
      configId: "effort",
      value: "ultracode",
    });
    expect(query.applyFlagSettings.mock.calls).toEqual([
      [{ effortLevel: "xhigh", ultracode: true }],
    ]);
    expect(option(res.configOptions, "effort")?.currentValue).toBe("xhigh");
    expect(option(res.configOptions, "ultracode")?.currentValue).toBe(true);
    expect(session.ultracodeRequested).toBe(true);
  });
});

describe("10. a rejected apply", () => {
  it("changes nothing", async () => {
    const { agent, sessionId, query, session } = await startSession();
    const before = structuredClone(session.configOptions);
    query.applyFlagSettings.mockRejectedValueOnce(new Error("nope"));
    await expect(
      agent.setSessionConfigOption({
        sessionId,
        configId: "ultracode",
        type: "boolean",
        value: true,
      }),
    ).rejects.toThrow("nope");
    expect(session.ultracodeRequested).toBe(false);
    expect(session.configOptions).toEqual(before);
  });
});
