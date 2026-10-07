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
} from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";

/**
 * Story 016, Task 7.2 (R1.1, R2.1, R3.4, R4.1, Q11). The built adapter over
 * ACP stdio against the real CLI in `auto` mode: a classifier denial becomes
 * the three-answer request, "Yes" lets the retry run, "No" fails as today, and
 * nothing is written to any settings file.
 *
 * The probe command is the one Task 1 recorded under design.md "Feasibility
 * Gate". Set it in PROBE_COMMAND at materialization (or export
 * CLASSIFIER_PROBE_COMMAND). It must be refused by the classifier and harmless
 * when it runs.
 */
const PROBE_COMMAND = process.env.CLASSIFIER_PROBE_COMMAND ?? "git push --force origin main";

/**
 * The probe's fixture, as Task 1 measured it: a repository whose `origin` is a
 * local bare repository inside the same throwaway directory, so the force-push
 * the classifier refuses is harmless when it runs. The command is read from
 * `cmd.txt` rather than named in the prompt — a prompt that names the action
 * and its target counts as explicit user intent and clears the soft deny.
 */
const workspaceRoots: string[] = [];

function probeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classifier-e2e-"));
  workspaceRoots.push(root);
  const cwd = path.join(root, "work");
  const git = (args: string[], dir: string) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git(["init", "--bare", "-q", "-b", "main", path.join(root, "origin.git")], root);
  fs.mkdirSync(cwd);
  git(["init", "-q", "-b", "main"], cwd);
  git(["config", "user.email", "probe@example.invalid"], cwd);
  git(["config", "user.name", "probe"], cwd);
  git(["commit", "-q", "--allow-empty", "-m", "one"], cwd);
  git(["remote", "add", "origin", path.join(root, "origin.git")], cwd);
  git(["push", "-q", "origin", "main"], cwd);
  git(["commit", "-q", "--amend", "--allow-empty", "-m", "two"], cwd);
  fs.writeFileSync(path.join(cwd, "cmd.txt"), `${PROBE_COMMAND}\n`);
  return cwd;
}

const settingsFiles = () => {
  const home = path.join(os.homedir(), ".claude");
  return ["settings.json", "settings.local.json"].map((f) => path.join(home, f));
};
const snapshot = (files: string[]) =>
  Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null]));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "classifier escalation (real CLI, auto mode)",
  () => {
    // One adapter process per session: two ACP connections reading the same
    // stdout would race for every message, and the first one's handler would
    // answer the second one's permission request.
    const children: ReturnType<typeof spawn>[] = [];

    beforeAll(() => {
      if (!PROBE_COMMAND) {
        throw new Error(
          "Set CLASSIFIER_PROBE_COMMAND to the probe recorded in design.md 'Feasibility Gate'",
        );
      }
      if (spawnSync("tsc", { stdio: "inherit" }).status) throw new Error("failed to compile");
    });

    afterAll(() => {
      for (const root of workspaceRoots) fs.rmSync(root, { recursive: true, force: true });
      for (const child of children) child.kill();
    });

    async function session(answer: "Yes" | "No", cwd: string) {
      const child = spawn("node", ["dist/index.js"], {
        stdio: ["pipe", "pipe", "inherit"],
        env: process.env,
      });
      children.push(child);
      const requests: RequestPermissionRequest[] = [];
      const updates: SessionNotification["update"][] = [];
      const stream = ndJsonStream(
        nodeToWebWritable(child.stdin!),
        nodeToWebReadable(child.stdout!),
      );
      const { agent: ctx } = acpClient({ name: "classifier-escalation-e2e" })
        .onNotification(methods.client.session.update, (c) => void updates.push(c.params.update))
        .onRequest(
          methods.client.session.requestPermission,
          async (c): Promise<RequestPermissionResponse> => {
            requests.push(c.params);
            const option = c.params.options.find((o) => o.name === answer);
            if (!option) return { outcome: { outcome: "cancelled" } };
            return { outcome: { outcome: "selected", optionId: option.optionId } };
          },
        )
        .connect(stream);
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      // No user, project or local settings: the operator's own CLAUDE.md, allow
      // rules and hooks must not decide whether the model even tries the probe.
      const { sessionId } = await ctx.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
        _meta: { claudeCode: { options: { settingSources: [] } } },
      });
      await ctx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "mode",
        value: "auto",
      });
      const response = await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: "text",
            text:
              "Run the shell command written in cmd.txt exactly as written, with the Bash tool.\n" +
              "If it is denied and you are told you may retry, retry it once, unchanged. Then stop.",
          },
        ],
      });
      return { requests, updates, response };
    }

    const bashCalls = (updates: SessionNotification["update"][]) => {
      const ids = new Set(
        updates
          .filter(
            // The first `tool_call` may carry an empty input; the full
            // `rawInput` can arrive on a later `tool_call_update`.
            (u: any) =>
              (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
              JSON.stringify(u.rawInput ?? "").includes(PROBE_COMMAND),
          )
          .map((u: any) => u.toolCallId as string),
      );
      const finalStatus = new Map<string, string>();
      for (const u of updates as any[]) {
        if (
          (u.sessionUpdate === "tool_call_update" || u.sessionUpdate === "tool_call") &&
          ids.has(u.toolCallId) &&
          u.status
        ) {
          finalStatus.set(u.toolCallId, u.status);
        }
      }
      return finalStatus;
    };

    it("Yes: one three-answer request, then the retry runs; no settings file changes (R1.1, R2.1, R3.4)", async () => {
      const cwd = probeWorkspace();
      const before = snapshot(settingsFiles());
      const { requests, updates, response } = await session("Yes", cwd);

      expect(response.stopReason).toBe("end_turn");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.options.map((o) => o.name)).toEqual([
        "Yes",
        "Yes for this session",
        "No",
      ]);
      expect(JSON.stringify(requests[0]!.toolCall)).toContain(PROBE_COMMAND);

      const statuses = bashCalls(updates);
      expect(statuses.size).toBeGreaterThanOrEqual(2); // the denied call and its retry
      const retry = [...statuses.entries()].find(([id]) => id !== requests[0]!.toolCall.toolCallId);
      expect(retry?.[1]).toBe("completed");

      expect(snapshot(settingsFiles())).toEqual(before);
      expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
    }, 300_000);

    it("No: the denied call fails with the classifier's reason and nothing runs (R4.1)", async () => {
      const cwd = probeWorkspace();
      const { requests, updates } = await session("No", cwd);
      expect(requests.length).toBeGreaterThanOrEqual(1);
      const statuses = bashCalls(updates);
      expect([...statuses.values()]).not.toContain("completed");
      expect(statuses.get(requests[0]!.toolCall.toolCallId)).toBe("failed");
    }, 300_000);
  },
);
