import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  AvailableCommand,
  client as acpClient,
  methods,
  ndJsonStream,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeToWebWritable, nodeToWebReadable } from "../utils.js";
import { THINKING_CONFIG_ID, THINKING_ON, THINKING_OFF } from "../thinking-option.js";
import { isDeprecatedModel, filterDeprecatedModels } from "../model-deprecation.js";

/**
 * Story 006 cross-component integration (R1.2, R1.3, R3.1–R3.4, R3.6, R4.4):
 * real SDK subprocess, no mocks. Mirrors the "ACP subprocess integration"
 * setup in acp-agent.test.ts, but WITHOUT advertising fs capabilities so the
 * SDK writes workspace files directly to disk — the /rewind round-trip must
 * verify the on-disk file state, not just the response text.
 */

type ConfigOptionRow = {
  id: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string }>;
};
type SetConfigOptionResult = { configOptions?: ConfigOptionRow[] };

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("adapter parity round 2 (real SDK)", () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const valid = spawnSync("tsc", { stdio: "inherit" });
    if (valid.status) {
      throw new Error("failed to compile");
    }
    child = spawn("npm", ["run", "--silent", "dev"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    child.on("error", (error) => {
      console.error("Error starting subprocess:", error);
    });
  });

  afterAll(() => {
    child.kill();
  });

  class TestClient {
    receivedText: string = "";
    resolveAvailableCommands: (commands: AvailableCommand[]) => void;
    availableCommandsPromise: Promise<AvailableCommand[]>;

    constructor() {
      this.resolveAvailableCommands = () => {};
      this.availableCommandsPromise = new Promise((resolve) => {
        this.resolveAvailableCommands = resolve;
      });
    }

    takeReceivedText() {
      const text = this.receivedText;
      this.receivedText = "";
      return text;
    }

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const optionId = params.options.find((p) => p.kind === "allow_once")!.optionId;
      return { outcome: { outcome: "selected", optionId } };
    }

    async sessionUpdate(params: SessionNotification): Promise<void> {
      switch (params.update.sessionUpdate) {
        case "agent_message_chunk": {
          if (params.update.content.type === "text") {
            this.receivedText += params.update.content.text;
          }
          break;
        }
        case "available_commands_update":
          this.resolveAvailableCommands(params.update.availableCommands);
          break;
        default:
          break;
      }
    }
  }

  type TestConnection = {
    prompt(params: PromptRequest): Promise<PromptResponse>;
    setConfigOption(params: {
      sessionId: string;
      configId: string;
      value: unknown;
    }): Promise<SetConfigOptionResult>;
  };

  // No fs capability on purpose: the SDK's Write tool must touch the real
  // disk for file checkpointing (and /rewind) to be observable.
  async function setupTestSession(cwd: string): Promise<{
    client: TestClient;
    connection: TestConnection;
    newSessionResponse: NewSessionResponse;
  }> {
    const input = nodeToWebWritable(child.stdin!);
    const output = nodeToWebReadable(child.stdout!);
    const stream = ndJsonStream(input, output);

    const client = new TestClient();
    const { agent: ctx } = acpClient({ name: "parity-round-2-test-client" })
      .onNotification(methods.client.session.update, (c) => client.sessionUpdate(c.params))
      .onRequest(methods.client.session.requestPermission, (c) =>
        client.requestPermission(c.params),
      )
      .connect(stream);

    await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const newSessionResponse = await ctx.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });

    const connection: TestConnection = {
      prompt: (params) => ctx.request(methods.agent.session.prompt, params),
      setConfigOption: async (params) =>
        (await ctx.request(
          methods.agent.session.setConfigOption,
          params,
        )) as unknown as SetConfigOptionResult,
    };

    return { client, connection, newSessionResponse };
  }

  const textPrompt = (sessionId: string, text: string): PromptRequest => ({
    sessionId,
    prompt: [{ type: "text", text }],
  });

  const optionById = (result: SetConfigOptionResult, id: string) =>
    result.configOptions?.find((o) => o.id === id);

  it("thinking toggle: immediate ack, survives a model switch, next turn completes (R1.2, R1.3, R1.7)", async () => {
    const { client, connection, newSessionResponse } = await setupTestSession(process.cwd());
    const sessionId = newSessionResponse.sessionId;

    // R1.2 — the change is acknowledged immediately in the returned options.
    const offAck = await connection.setConfigOption({
      sessionId,
      configId: THINKING_CONFIG_ID,
      value: THINKING_OFF,
    });
    expect(optionById(offAck, THINKING_CONFIG_ID)?.currentValue).toBe(THINKING_OFF);

    // R1.3 — the next prompt (which recreates the query with resume) completes.
    const response = await connection.prompt(textPrompt(sessionId, "Reply with exactly: OK"));
    expect(response.stopReason).toBe("end_turn");
    expect(client.takeReceivedText()).not.toEqual("");

    // R1.7 — switching the model preserves the session's thinking intent.
    const modelOption = optionById(offAck, "model");
    expect(modelOption?.options?.length).toBeGreaterThan(1);
    const alternative = modelOption!.options!.find((o) => o.value !== modelOption!.currentValue)!;
    const switchAck = await connection.setConfigOption({
      sessionId,
      configId: "model",
      value: alternative.value,
    });
    expect(optionById(switchAck, THINKING_CONFIG_ID)?.currentValue).toBe(THINKING_OFF);

    // Toggle back on: acked the same way.
    const onAck = await connection.setConfigOption({
      sessionId,
      configId: THINKING_CONFIG_ID,
      value: THINKING_ON,
    });
    expect(optionById(onAck, THINKING_CONFIG_ID)?.currentValue).toBe(THINKING_ON);
  }, 120000);

  it("advertises the rewind command with an input hint (R3.1)", async () => {
    const { client } = await setupTestSession(process.cwd());

    const commands = await client.availableCommandsPromise;
    const rewind = commands.find((c) => c.name === "rewind");

    expect(rewind).toBeDefined();
    expect(rewind?.input?.hint).toBeTruthy();
    // Advertised exactly once (dedup against SDK-provided commands).
    expect(commands.filter((c) => c.name === "rewind")).toHaveLength(1);
  }, 60000);

  it("/rewind lists and restores file checkpoints, verified on disk (R3.2, R3.3, R3.4, R3.6)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-rewind-"));
    try {
      const { client, connection, newSessionResponse } = await setupTestSession(tmp);
      const sessionId = newSessionResponse.sessionId;
      const marker = path.join(tmp, "marker.txt");

      // R3.6 — brand-new session has nothing to rewind.
      await connection.prompt(textPrompt(sessionId, "/rewind"));
      expect(client.takeReceivedText()).toMatch(/nothing to rewind/i);

      // Set up a checkpointed change: the agent writes a real file.
      await connection.prompt(
        textPrompt(
          sessionId,
          "Create a file named marker.txt in the current directory containing exactly ROUND2, using the Write tool. Do nothing else.",
        ),
      );
      client.takeReceivedText();
      expect(fs.existsSync(marker)).toBe(true);

      // R3.2 — listing shows the checkpoint and touches nothing.
      await connection.prompt(textPrompt(sessionId, "/rewind"));
      const listText = client.takeReceivedText();
      expect(listText).toContain("1");
      expect(listText).toContain("marker.txt");
      expect(fs.existsSync(marker)).toBe(true);

      // R3.3 + R3.4 — restoring checkpoint 1 (the prompt that created the
      // file) rewinds the workspace: the file must be gone ON DISK, and the
      // outcome is reported naming the checkpoint.
      await connection.prompt(textPrompt(sessionId, "/rewind 1"));
      const restoreText = client.takeReceivedText();
      expect(restoreText).toContain("1");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 180000);

  // R4.4 — false-positive guard pinned to the LIVE catalog: the heuristic
  // must remove zero rows from today's supportedModels() output. If Anthropic
  // ships a catalog row the heuristic wrongly flags, this fails CI.
  it("deprecation heuristic removes zero rows from the live model catalog (R4.4)", async () => {
    const q = query({ prompt: "hi", options: { sessionId: randomUUID() } });
    try {
      const models = await q.supportedModels();
      expect(models.length).toBeGreaterThan(0);

      const flagged = models.filter((m) => isDeprecatedModel(m));
      expect(flagged).toEqual([]);
      expect(filterDeprecatedModels(models)).toHaveLength(models.length);
    } finally {
      q.return(undefined);
    }
  }, 30000);
});
