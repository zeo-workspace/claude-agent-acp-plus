import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";

// Story 071 (R2.1, R2.2) through the agent: the Thinking option follows the selected model's
// `supportsThinkingOff`, a set "off" is kept as intent where it cannot hold, and switching models
// re-renders the option and rebuilds the query when what "Off" sends changes.
const mockQuery = vi.hoisted(() =>
  vi.fn(() => ({
    initializationResult: vi.fn().mockResolvedValue({
      models: [
        {
          value: "capable",
          displayName: "Capable",
          description: "can turn thinking off",
          supportsThinkingOff: true,
        },
        {
          value: "always",
          displayName: "Always",
          description: "always thinks",
          supportsThinkingOff: false,
        },
      ],
    }),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    getContextUsage: vi.fn().mockResolvedValue({ totalTokens: 0, rawMaxTokens: 200000 }),
    [Symbol.asyncIterator]: async function* () {},
  })),
);

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

const lastThinking = () =>
  (mockQuery.mock.calls.at(-1) as unknown as [{ options: { thinking?: unknown } }])[0].options
    .thinking;

async function sessionOn(model: string) {
  const agent = new ClaudeAcpAgent({ sessionUpdate: async () => {} } as unknown as AcpClient, {
    log: () => {},
    error: () => {},
  });
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId, configId: "model", value: model });
  const session = (agent as any).sessions[sessionId];
  const thinkingOption = () =>
    session.configOptions.find((o: { id: string }) => o.id === "thinking") as {
      currentValue: string;
      description?: string;
      options: { value: string }[];
    };
  return { agent, sessionId, session, thinkingOption };
}

describe("Thinking Off follows the model's capability (story 071)", () => {
  afterEach(() => vi.clearAllMocks());

  it("on a capable model, Off is offered and the rebuilt query runs with thinking disabled", async () => {
    const { agent, sessionId, session, thinkingOption } = await sessionOn("capable");
    expect(thinkingOption().options.map((o) => o.value)).toEqual(["on", "off"]);

    await agent.setSessionConfigOption({ sessionId, configId: "thinking", value: "off" });
    expect(thinkingOption().currentValue).toBe("off");
    await (agent as any).recreateSessionQuery(sessionId, session);
    expect(lastThinking()).toEqual({ type: "disabled" });
  });

  it("on a model that always thinks, Off is not offered and the option says why", async () => {
    const { thinkingOption } = await sessionOn("always");
    expect(thinkingOption().options.map((o) => o.value)).toEqual(["on"]);
    expect(thinkingOption().description).toMatch(/always thinks/i);
  });

  // A set "off" on a model that always thinks — from a client still holding the option list it
  // had before a model switch — must not fail: it is kept as the user's intent, shown as On, and
  // the query runs adaptive — what the model really does — never a silent `disabled`.
  it("a set off there is kept as intent, reads On, and the query runs adaptive", async () => {
    const { agent, sessionId, session, thinkingOption } = await sessionOn("always");
    await agent.setSessionConfigOption({ sessionId, configId: "thinking", value: "off" });
    expect(session.thinkingEnabled).toBe(false);
    expect(thinkingOption().currentValue).toBe("on");
    await (agent as any).recreateSessionQuery(sessionId, session);
    expect(lastThinking()).toEqual({ type: "adaptive" });
  });

  it("switching to a model that always thinks shows On and rebuilds the query without a silent disabled", async () => {
    const { agent, sessionId, session, thinkingOption } = await sessionOn("capable");
    await agent.setSessionConfigOption({ sessionId, configId: "thinking", value: "off" });
    session.pendingQueryRecreate = false;

    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "always" });
    expect(thinkingOption().currentValue).toBe("on");
    expect(session.pendingQueryRecreate).toBe(true);
    await (agent as any).recreateSessionQuery(sessionId, session);
    expect(lastThinking()).toEqual({ type: "adaptive" });
  });

  it("switching back to a capable model restores the retained Off", async () => {
    const { agent, sessionId, session, thinkingOption } = await sessionOn("capable");
    await agent.setSessionConfigOption({ sessionId, configId: "thinking", value: "off" });
    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "always" });
    session.pendingQueryRecreate = false;

    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "capable" });
    expect(thinkingOption().currentValue).toBe("off");
    expect(thinkingOption().options.map((o) => o.value)).toEqual(["on", "off"]);
    expect(session.pendingQueryRecreate).toBe(true);
    await (agent as any).recreateSessionQuery(sessionId, session);
    expect(lastThinking()).toEqual({ type: "disabled" });
  });

  it("a switch that keeps what a retained Off sends does not rebuild the query", async () => {
    const { agent, sessionId, session } = await sessionOn("capable");
    await agent.setSessionConfigOption({ sessionId, configId: "thinking", value: "off" });
    session.pendingQueryRecreate = false;
    session.modelInfos = [
      ...session.modelInfos,
      {
        value: "capable-too",
        displayName: "Capable too",
        description: "",
        supportsThinkingOff: true,
      },
    ];
    session.models = {
      ...session.models,
      availableModels: [
        ...session.models.availableModels,
        { modelId: "capable-too", name: "Capable too" },
      ],
    };
    session.configOptions = session.configOptions.map((o: any) =>
      o.id === "model"
        ? { ...o, options: [...o.options, { value: "capable-too", name: "Capable too" }] }
        : o,
    );

    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "capable-too" });
    expect(session.pendingQueryRecreate).toBe(false);
  });

  it("a switch with Thinking On or untouched does not rebuild the query", async () => {
    for (const intent of [true, undefined]) {
      const { agent, sessionId, session } = await sessionOn("capable");
      if (intent) {
        await agent.setSessionConfigOption({ sessionId, configId: "thinking", value: "on" });
      }
      session.pendingQueryRecreate = false;

      await agent.setSessionConfigOption({ sessionId, configId: "model", value: "always" });
      expect(session.pendingQueryRecreate).toBe(false);
    }
  });
});
