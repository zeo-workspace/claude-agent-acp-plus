import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientCapabilities,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

/**
 * Story 062, Task 1 (R1.1-R1.5): the "Plan updates" session option.
 *
 * Why it exists: the CLI enables its todo tools only on legacy models unless
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set (upstream #1380), so Zed's plan view
 * stays empty on Opus 5.x. The option drives that variable into the query env.
 *
 * Behaviour-level on purpose (Standard story, no design.md): everything is
 * observed through the ACP surface (`newSession`, `setSessionConfigOption`,
 * `prompt`) and the options the SDK's `query()` is called with -- never
 * through an internal helper name, which the implementer is free to choose.
 */

const OPTION_ID = "plan_updates";
const TODO_ENV = "CLAUDE_CODE_ENABLE_TODO_TOOLS";

type QueryCall = { options: Options };
const queryCalls: QueryCall[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  const { randomUUID } = await import("node:crypto");
  return {
    ...actual,
    query: (args: { prompt: AsyncIterable<any>; options: Options }) => {
      queryCalls.push({ options: args.options });
      const publicId = args.options.sessionId ?? args.options.resume ?? "unknown";
      // One scripted turn per pushed prompt: echo it, succeed, go idle -- the
      // minimum the agent needs to resolve `prompt()` with end_turn. A real
      // generator, because the agent drives the query with `next()`.
      async function* turns() {
        for await (const user of args.prompt) {
          yield {
            type: "user",
            message: user.message,
            parent_tool_use_id: null,
            uuid: user.uuid,
            session_id: publicId,
            isReplay: true,
          };
          yield {
            type: "result",
            subtype: "success",
            stop_reason: "end_turn",
            is_error: false,
            result: "",
            errors: [],
            duration_ms: 0,
            duration_api_ms: 0,
            num_turns: 1,
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: randomUUID(),
            session_id: publicId,
          };
          yield { type: "system", subtype: "session_state_changed", state: "idle" };
        }
      }
      const surface: Record<PropertyKey, unknown> = makeMockQuery({
        initializationResult: async () => ({
          models: [
            {
              value: "claude-opus-4-8",
              displayName: "Claude Opus",
              description: "Most capable",
              supportsAutoMode: true,
            },
          ],
        }),
        applyFlagSettings: async () => {},
      });
      // The generator's own iterator drives the turn, not the base stub's.
      delete surface[Symbol.asyncIterator];
      return Object.assign(turns(), surface);
    },
  };
});

const BOOLEAN_CLIENT: ClientCapabilities = { session: { configOptions: { boolean: {} } } };
const SELECT_CLIENT: ClientCapabilities = {};

function planOption(options: SessionConfigOption[] | null | undefined) {
  return options?.find((o) => o.id === OPTION_ID);
}

/** The query calls that belong to one public session id: a fresh query runs
 *  under `sessionId`, a resumed one under `resume`. */
function callsFor(sessionId: string): QueryCall[] {
  return queryCalls.filter(
    (c) => c.options.sessionId === sessionId || c.options.resume === sessionId,
  );
}

function lastCallFor(sessionId: string): QueryCall {
  const calls = callsFor(sessionId);
  expect(calls.length, `a query was spawned for ${sessionId}`).toBeGreaterThan(0);
  return calls.at(-1)!;
}

/** What the query would run with for the variable: the spawn env, and the
 *  programmatic settings tier the CLI applies after it. */
function todoEnvValues(call: QueryCall): Array<string | undefined> {
  const settings = call.options.settings;
  const settingsEnv =
    settings && typeof settings === "object"
      ? (settings as { env?: Record<string, string> }).env
      : undefined;
  return [call.options.env?.[TODO_ENV], settingsEnv?.[TODO_ENV]];
}

let configDir: string;
let projectDir: string;
let savedConfigDir: string | undefined;
let savedTodoEnv: string | undefined;
let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

beforeAll(async () => {
  // Cold import of acp-agent.js under a loaded machine can exceed the default
  // per-test budget (see acp-agent-settings.test.ts); pay it once here.
  await import("../acp-agent.js");
}, 30_000);

beforeEach(async () => {
  queryCalls.length = 0;
  configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "plan-updates-"));
  projectDir = path.join(configDir, "project");
  await fs.promises.mkdir(projectDir, { recursive: true });
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  savedTodoEnv = process.env[TODO_ENV];
  // The adapter's own settings and the session transcripts live here; the
  // ambient variable must not leak in from the developer's shell.
  process.env.CLAUDE_CONFIG_DIR = configDir;
  delete process.env[TODO_ENV];
  vi.resetModules();
  ({ ClaudeAcpAgent } = await import("../acp-agent.js"));
});

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  if (savedTodoEnv === undefined) delete process.env[TODO_ENV];
  else process.env[TODO_ENV] = savedTodoEnv;
  await fs.promises.rm(configDir, { recursive: true, force: true });
});

async function startAgent(capabilities: ClientCapabilities) {
  const updates: SessionNotification[] = [];
  const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(
    {
      sessionUpdate: async (n: SessionNotification) => {
        updates.push(n);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
  );
  await agent.initialize({ protocolVersion: 1, clientCapabilities: capabilities });
  return { agent, updates };
}

async function newSession(agent: ClaudeAcpAgentType, env?: Record<string, string>) {
  return agent.newSession({
    cwd: projectDir,
    mcpServers: [],
    ...(env ? { _meta: { claudeCode: { options: { env } } } } : {}),
  });
}

/** A transcript on disk, so a re-created query has history to resume. */
async function writeTranscript(sessionId: string) {
  const dir = path.join(configDir, "projects", "-plan-updates-project");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

describe("Plan updates option offer and env (1.1)", () => {
  it("is offered as a boolean named Plan updates, on by default (R1.1)", async () => {
    const { agent } = await startAgent(BOOLEAN_CLIENT);
    const response = await newSession(agent);

    const option = planOption(response.configOptions);
    expect(option, "plan_updates offered on a new session").toBeDefined();
    expect(option).toMatchObject({ id: OPTION_ID, name: "Plan updates", type: "boolean" });
    expect(option?.currentValue).toBe(true);
  });

  it("falls back to an on/off select for a client without boolean options (R1.5)", async () => {
    const { agent } = await startAgent(SELECT_CLIENT);
    const response = await newSession(agent);

    const option = planOption(response.configOptions);
    expect(option, "plan_updates offered on a new session").toBeDefined();
    // The same spelling the existing boolean options use for their fallback.
    expect(option).toMatchObject({
      id: OPTION_ID,
      name: "Plan updates",
      type: "select",
      currentValue: "on",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    });
    // The ACP boolean-config-option RFD: a client that did not opt in never
    // receives the boolean shape.
    expect(option?.type).not.toBe("boolean");
  });

  it("starts the CLI with the todo tools enabled while on (R1.2)", async () => {
    const { agent } = await startAgent(BOOLEAN_CLIENT);
    const { sessionId } = await newSession(agent);

    expect(lastCallFor(sessionId).options.env?.[TODO_ENV]).toBe("1");
  });

  // Hostile half of R1.3: a value the client already chose must not be
  // overwritten by the default -- the case that makes the rule fire wrongly.
  it("keeps a client env that disables the todo tools, and reports the option off (R1.3)", async () => {
    const { agent } = await startAgent(BOOLEAN_CLIENT);
    const response = await newSession(agent, { [TODO_ENV]: "0" });

    const option = planOption(response.configOptions);
    expect(option, "plan_updates offered on a new session").toBeDefined();
    expect(option?.currentValue).toBe(false);
    const call = lastCallFor(response.sessionId);
    expect(call.options.env?.[TODO_ENV]).toBe("0");
    expect(todoEnvValues(call)).not.toContain("1");
  });

  it("keeps a settings env that disables the todo tools, and reports the option off (R1.3)", async () => {
    await fs.promises.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({ env: { [TODO_ENV]: "0" } }),
    );
    const { agent } = await startAgent(BOOLEAN_CLIENT);
    const response = await newSession(agent);

    const option = planOption(response.configOptions);
    expect(option, "plan_updates offered on a new session").toBeDefined();
    expect(option?.currentValue).toBe(false);
    // The CLI applies settings env after the spawn env; the adapter must not
    // write a conflicting "1" in either tier.
    expect(todoEnvValues(lastCallFor(response.sessionId))).not.toContain("1");
  });

  it("keeps a client env that enables the todo tools, and reports the option on (R1.3)", async () => {
    const { agent } = await startAgent(SELECT_CLIENT);
    const response = await newSession(agent, { [TODO_ENV]: "1" });

    const option = planOption(response.configOptions);
    expect(option, "plan_updates offered on a new session").toBeDefined();
    expect(option?.currentValue).toBe("on");
    expect(lastCallFor(response.sessionId).options.env?.[TODO_ENV]).toBe("1");
  });
});

describe("Plan updates live toggle (1.2)", () => {
  it("toggle off applies from the next turn and resumes the same session (R1.4)", async () => {
    const { agent, updates } = await startAgent(BOOLEAN_CLIENT);
    const response = await newSession(agent);
    const { sessionId } = response;
    expect(planOption(response.configOptions), "plan_updates offered").toBeDefined();
    await writeTranscript(sessionId);

    const ack = await agent.setSessionConfigOption({
      sessionId,
      configId: OPTION_ID,
      type: "boolean",
      value: false,
    });
    expect(planOption(ack.configOptions)?.currentValue).toBe(false);

    const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "next" }] });
    expect(result.stopReason).toBe("end_turn");

    const serving = lastCallFor(sessionId);
    // History kept: the replacement resumes THIS conversation, never a fork.
    expect(serving.options.resume).toBe(sessionId);
    expect(serving.options.forkSession).toBeFalsy();
    expect(todoEnvValues(serving)).not.toContain("1");
    // The public id is unchanged: every update of the turn reaches it.
    expect(updates.filter((u) => u.sessionId !== sessionId)).toEqual([]);
  });

  it("toggle back on restores the todo tools on the following turn (R1.4)", async () => {
    const { agent } = await startAgent(BOOLEAN_CLIENT);
    const response = await newSession(agent);
    const { sessionId } = response;
    expect(planOption(response.configOptions), "plan_updates offered").toBeDefined();
    await writeTranscript(sessionId);

    await agent.setSessionConfigOption({
      sessionId,
      configId: OPTION_ID,
      type: "boolean",
      value: false,
    });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    expect(todoEnvValues(lastCallFor(sessionId))).not.toContain("1");

    const ack = await agent.setSessionConfigOption({
      sessionId,
      configId: OPTION_ID,
      type: "boolean",
      value: true,
    });
    expect(planOption(ack.configOptions)?.currentValue).toBe(true);
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] });

    const serving = lastCallFor(sessionId);
    expect(serving.options.resume).toBe(sessionId);
    expect(serving.options.env?.[TODO_ENV]).toBe("1");
  });

  it("toggle through the on/off select fallback (R1.4, R1.5)", async () => {
    const { agent } = await startAgent(SELECT_CLIENT);
    const response = await newSession(agent);
    const { sessionId } = response;
    expect(planOption(response.configOptions), "plan_updates offered").toBeDefined();
    await writeTranscript(sessionId);

    const ack = await agent.setSessionConfigOption({
      sessionId,
      configId: OPTION_ID,
      value: "off",
    });
    expect(planOption(ack.configOptions)?.currentValue).toBe("off");

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "next" }] });
    const serving = lastCallFor(sessionId);
    expect(serving.options.resume).toBe(sessionId);
    expect(todoEnvValues(serving)).not.toContain("1");
  });

  // Hostile half of "session-scoped" (R1.1): one session's toggle must not
  // reach another session's query.
  it("toggle in one session leaves another session's todo tools on (R1.1, R1.4)", async () => {
    const { agent } = await startAgent(BOOLEAN_CLIENT);
    const a = await newSession(agent);
    const b = await newSession(agent);
    expect(planOption(a.configOptions), "plan_updates offered").toBeDefined();
    await writeTranscript(a.sessionId);
    await writeTranscript(b.sessionId);

    await agent.setSessionConfigOption({
      sessionId: a.sessionId,
      configId: OPTION_ID,
      type: "boolean",
      value: false,
    });
    await agent.prompt({ sessionId: a.sessionId, prompt: [{ type: "text", text: "a" }] });
    await agent.prompt({ sessionId: b.sessionId, prompt: [{ type: "text", text: "b" }] });

    expect(todoEnvValues(lastCallFor(a.sessionId))).not.toContain("1");
    expect(lastCallFor(b.sessionId).options.env?.[TODO_ENV]).toBe("1");
    const bOptions = (
      agent as unknown as { sessions: Record<string, { configOptions: SessionConfigOption[] }> }
    ).sessions[b.sessionId].configOptions;
    expect(planOption(bOptions)?.currentValue).toBe(true);
  });

  it("rejects a toggle value that is neither boolean nor on/off (R1.4)", async () => {
    const { agent } = await startAgent(SELECT_CLIENT);
    const response = await newSession(agent);
    expect(planOption(response.configOptions), "plan_updates offered").toBeDefined();

    await expect(
      agent.setSessionConfigOption({
        sessionId: response.sessionId,
        configId: OPTION_ID,
        value: "maybe",
      }),
    ).rejects.toThrow();
    const after = (
      agent as unknown as { sessions: Record<string, { configOptions: SessionConfigOption[] }> }
    ).sessions[response.sessionId].configOptions;
    expect(planOption(after)?.currentValue).toBe("on");
  });
});
