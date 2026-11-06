/**
 * Story 065 — one ACP connection to a real `ClaudeAcpAgent` over the mocked
 * SDK (see child-sessions-harness.ts). Imported by the suites themselves,
 * never by a `vi.mock` factory: it imports the agent, which imports the SDK.
 */

import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import { idle, result, running } from "./task-feed-harness.js";
import { lastCaptured, recordingClient, recordingLogger } from "./child-sessions-harness.js";

/** The capability a Zed `a5c4ca8b` client sends, and one that does not ask. */
export const RFD_CAPABILITIES = { subagents: {} };
export const NESTED_CAPABILITIES = {};

const agents: ClaudeAcpAgent[] = [];

/** Disposes every agent a test connected; call from `afterEach`. */
export async function disconnectAll() {
  for (const agent of agents.splice(0)) {
    await agent.dispose().catch(() => {});
  }
}

export async function connect(clientCapabilities: Record<string, unknown>) {
  const { client, updates, permissions } = recordingClient();
  const { lines, logger } = recordingLogger();
  const agent = new ClaudeAcpAgent(client as unknown as AcpClient, logger);
  agents.push(agent);
  const init: InitializeResponse = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: clientCapabilities as any,
  });

  /** Wraps a session the agent already holds (new, loaded or resumed). */
  function session(sessionId: string) {
    const query = lastCaptured();
    const push = (...messages: unknown[]) => {
      for (const message of messages) query.script.out.push(message);
    };
    /** Starts a turn; the caller pushes its stream, then `endTurn()`. */
    const prompt = (text = "go") => {
      const response = agent.prompt({ sessionId, prompt: [{ type: "text", text }] });
      push(running(sessionId));
      return response;
    };
    const endTurn = () => push(result(sessionId), idle(sessionId));
    return { sessionId, query, push, prompt, endTurn };
  }

  async function open(cwd = process.cwd()) {
    const { sessionId } = await agent.newSession({ cwd, mcpServers: [] });
    return session(sessionId);
  }

  return { agent, init, updates, permissions, lines, open, session };
}
