import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";

/**
 * Story 065, Task 7.1 (R1.1, R2.1, R2.2, R2.3, R3.1, R6.1; Q9). The built
 * adapter over ACP stdio against the real CLI, with a client that declares
 * `clientCapabilities.subagents: {}` — the wire half of the proof; the Zeo
 * half (one row and one card per subagent) is the `xvfb-proof.sh` capture.
 *
 * One real turn launches two foreground subagents in parallel. The first child
 * to show traffic is cancelled on its own session; the other must finish and
 * the parent's turn must end normally. SPENDS MODEL TURNS: run with
 * RUN_INTEGRATION_TESTS=true and, for an isolated account, CLAUDE_CONFIG_DIR
 * pointing at a throwaway config directory that holds a login. A model that
 * refuses or answers without the Agent tool fails the first assertion; Task
 * 7.1 retries once and records it.
 */

const workspaceRoots: string[] = [];

function probeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfd-subagents-e2e-"));
  workspaceRoots.push(root);
  return root;
}

type Recorded = SessionNotification & { at: number };

const kind = (n: SessionNotification) => (n.update as any).sessionUpdate as string;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("subagents RFD over stdio (real CLI)", () => {
  const children: ReturnType<typeof spawn>[] = [];

  beforeAll(() => {
    if (spawnSync("tsc", { stdio: "inherit" }).status) throw new Error("failed to compile");
  });

  afterAll(() => {
    for (const root of workspaceRoots) fs.rmSync(root, { recursive: true, force: true });
    for (const child of children) child.kill();
  });

  it("announces each child before its traffic, routes it to the child, and cancels one child alone", async () => {
    const cwd = probeWorkspace();
    const child = spawn("node", ["dist/index.js"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    children.push(child);

    const updates: Recorded[] = [];
    const requests: RequestPermissionRequest[] = [];
    let cancelledChild: string | undefined;
    let onUpdate: (n: SessionNotification) => void = () => {};

    const stream = ndJsonStream(nodeToWebWritable(child.stdin!), nodeToWebReadable(child.stdout!));
    const { agent: ctx } = acpClient({ name: "subagents-rfd-e2e" })
      .onNotification(methods.client.session.update, (c) => {
        updates.push({ ...c.params, at: Date.now() });
        onUpdate(c.params);
      })
      .onRequest(
        methods.client.session.requestPermission,
        async (c): Promise<RequestPermissionResponse> => {
          requests.push(c.params);
          const allow = c.params.options.find((o) => o.kind.startsWith("allow"));
          if (!allow) return { outcome: { outcome: "cancelled" } };
          return { outcome: { outcome: "selected", optionId: allow.optionId } };
        },
      )
      .connect(stream);

    const init = await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { subagents: {} },
    });
    expect((init.agentCapabilities?._meta as any)?.["_claude/tasks"]).toEqual({ version: 3 });

    // No user, project or local settings: the operator's CLAUDE.md, allow
    // rules and hooks must not shape the turn.
    const { sessionId: parent } = await ctx.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
      _meta: { claudeCode: { options: { settingSources: [] } } },
    });

    const announced = new Set<string>();
    onUpdate = (n) => {
      if (n.sessionId === parent && kind(n) === "subagent_update") {
        announced.add((n.update as any).sessionId);
      }
      // Cancel the first child that shows traffic of its own, on its own session.
      if (!cancelledChild && announced.has(n.sessionId) && kind(n) === "tool_call") {
        cancelledChild = n.sessionId;
        void ctx.notify(methods.agent.session.cancel, { sessionId: n.sessionId });
      }
    };

    const response = await ctx.request(methods.agent.session.prompt, {
      sessionId: parent,
      prompt: [
        {
          type: "text",
          text:
            "Launch exactly two subagents in parallel, in one message, with the Agent tool, " +
            "both in the foreground. Give each the description 'Wait and report'. Each must " +
            "run exactly `sleep 20` with the Bash tool and then reply with the single word: " +
            "done. Do not run anything yourself. When both have returned, reply with the " +
            "single word: finished.",
        },
      ],
    });

    // R2.1 — two children, announced on the parent.
    const childIds = [...announced];
    expect(childIds).toHaveLength(2);
    expect(cancelledChild).toBeDefined();
    const sibling = childIds.find((id) => id !== cancelledChild)!;

    for (const id of childIds) {
      const announce = updates.findIndex(
        (n) =>
          n.sessionId === parent &&
          kind(n) === "subagent_update" &&
          (n.update as any).sessionId === id,
      );
      const prompt = updates.findIndex(
        (n) => kind(n) === "session_message" && (n.update as any).recipientSessionId === id,
      );
      const traffic = updates.findIndex((n) => n.sessionId === id && kind(n) !== "session_message");
      // R2.1/R2.2 order: subagent_update, then the prompt, then the child's own traffic.
      expect(announce).toBeGreaterThanOrEqual(0);
      expect(prompt).toBeGreaterThan(announce);
      expect(traffic).toBeGreaterThan(prompt);
    }

    // R2.3 — the children's Bash calls and their permission requests are on child sessions.
    // The parent's own Agent calls carry "sleep 20" in their prompt and stay on the
    // parent (R2.5), so they are not the children's calls.
    const sleepCalls = updates.filter(
      (n) =>
        (kind(n) === "tool_call" || kind(n) === "tool_call_update") &&
        (n.update as any)._meta?.claudeCode?.toolName !== "Agent" &&
        JSON.stringify((n.update as any).rawInput ?? "").includes("sleep 20"),
    );
    expect(sleepCalls.length).toBeGreaterThan(0);
    for (const n of sleepCalls) expect(childIds).toContain(n.sessionId);
    for (const r of requests) {
      if (JSON.stringify(r.toolCall).includes("sleep 20")) expect(childIds).toContain(r.sessionId);
    }

    // R3.1 — the cancelled child ends cancelled; the sibling and the parent do not.
    const statesOf = (id: string) =>
      updates
        .filter(
          (n) =>
            n.sessionId === parent &&
            kind(n) === "subagent_update" &&
            (n.update as any).sessionId === id &&
            (n.update as any).state,
        )
        .map((n) => (n.update as any).state);
    expect(statesOf(cancelledChild!).at(-1)).toMatchObject({
      state: "idle",
      stopReason: "cancelled",
    });
    expect(statesOf(sibling).map((s: any) => s.stopReason)).not.toContain("cancelled");
    expect(statesOf(sibling).at(-1)).toMatchObject({ state: "idle", stopReason: "end_turn" });
    expect(response.stopReason).toBe("end_turn");

    // R6.1 — one subagent row per child, each naming its child.
    const rows = new Map<string, string>();
    for (const n of updates) {
      const tasks = (n.update._meta as any)?.["_claude/tasks"]?.tasks ?? [];
      for (const t of tasks) if (t.type === "subagent") rows.set(t.id, t.childSessionId);
    }
    expect([...rows.values()].sort()).toEqual([...childIds].sort());
  }, 300_000);
});
