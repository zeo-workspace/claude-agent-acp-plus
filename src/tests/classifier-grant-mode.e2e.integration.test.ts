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
 * Story 029, Task 3.1 (R1.1, R1.2, R1.4, R3.1, Q11). The built adapter over
 * ACP stdio against the real CLI, one session, three turns:
 *
 *   1. `auto`: the classifier refuses the probe; the operator answers
 *      "Yes for this session"; the retry runs.
 *   2. switch to `default`: the same probe is asked through the normal
 *      permission path (not the three classifier answers) and, rejected, does
 *      not run — the session grant does not stand in for default mode's check.
 *   3. switch back to `auto`: the same probe runs with no request at all — the
 *      dormant grant is honoured again.
 *
 * Same harness as story 016's `classifier-escalation.e2e.integration.test.ts`:
 * a throwaway repository whose `origin` is a local bare repository (so the
 * force-push is harmless), the command read from `cmd.txt`, one adapter
 * process per session, and no operator settings (`settingSources: []`).
 * Exposed to the model refusing the probe on its own: read a red from the CLI
 * transcript first.
 */
const PROBE_COMMAND = process.env.CLASSIFIER_PROBE_COMMAND ?? "git push --force origin main";

const CLASSIFIER_OPTION_IDS = ["classifier-allow-once", "classifier-allow-session"];

const workspaceRoots: string[] = [];

function probeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classifier-mode-e2e-"));
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

type Phase = "auto" | "default" | "auto-again";
type Recorded = { phase: Phase; params: RequestPermissionRequest };

const mentionsProbe = (r: RequestPermissionRequest) =>
  JSON.stringify(r.toolCall).includes(PROBE_COMMAND);
const isClassifierRequest = (r: RequestPermissionRequest) =>
  r.options.some((o) => CLASSIFIER_OPTION_IDS.includes(o.optionId));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "classifier grant held back outside auto (real CLI)",
  () => {
    const children: ReturnType<typeof spawn>[] = [];

    beforeAll(() => {
      if (spawnSync("tsc", { stdio: "inherit" }).status) throw new Error("failed to compile");
    });

    afterAll(() => {
      for (const root of workspaceRoots) fs.rmSync(root, { recursive: true, force: true });
      for (const child of children) child.kill();
    });

    /** Bash probe calls among `updates`, mapped to their last reported status. */
    const probeCalls = (updates: SessionNotification["update"][]) => {
      const ids = new Set(
        updates
          .filter(
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

    it("a session grant made in auto is asked again in default, rejected there, and honoured back in auto", async () => {
      const cwd = probeWorkspace();
      const child = spawn("node", ["dist/index.js"], {
        stdio: ["pipe", "pipe", "inherit"],
        env: process.env,
      });
      children.push(child);

      let phase: Phase = "auto";
      const requests: Recorded[] = [];
      const updates: SessionNotification["update"][] = [];
      const stream = ndJsonStream(
        nodeToWebWritable(child.stdin!),
        nodeToWebReadable(child.stdout!),
      );
      const { agent: ctx } = acpClient({ name: "classifier-grant-mode-e2e" })
        .onNotification(methods.client.session.update, (c) => void updates.push(c.params.update))
        .onRequest(
          methods.client.session.requestPermission,
          async (c): Promise<RequestPermissionResponse> => {
            requests.push({ phase, params: c.params });
            const pick = (predicate: (o: (typeof c.params.options)[number]) => boolean) => {
              const option = c.params.options.find(predicate);
              return option
                ? ({ outcome: { outcome: "selected", optionId: option.optionId } } as const)
                : ({ outcome: { outcome: "cancelled" } } as const);
            };
            if (phase === "auto" && isClassifierRequest(c.params)) {
              return pick((o) => o.optionId === "classifier-allow-session");
            }
            if (phase === "default" && mentionsProbe(c.params)) {
              return pick((o) => o.kind === "reject_once");
            }
            // Anything else is not this test's to approve: fail closed.
            return { outcome: { outcome: "cancelled" } };
          },
        )
        .connect(stream);

      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await ctx.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
        _meta: { claudeCode: { options: { settingSources: [] } } },
      });
      const setMode = (value: "auto" | "default") =>
        ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value });
      const prompt = (text: string) =>
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
      const inPhase = (p: Phase) => requests.filter((r) => r.phase === p).map((r) => r.params);

      // 1. auto: the classifier refuses, "Yes for this session", the retry runs.
      await setMode("auto");
      const start1 = updates.length;
      const r1 = await prompt(
        "Run the shell command written in cmd.txt exactly as written, with the Bash tool.\n" +
          "If it is denied and you are told you may retry, retry it once, unchanged. Then stop.",
      );
      expect(r1.stopReason).toBe("end_turn");
      const asked1 = inPhase("auto").filter(isClassifierRequest);
      // Precondition: without a classifier denial there is no grant to test.
      expect(asked1).toHaveLength(1);
      expect([...probeCalls(updates.slice(start1)).values()]).toContain("completed");

      // 2. default: the grant must not stand in for default mode's own check.
      await setMode("default");
      phase = "default";
      const start2 = updates.length;
      const r2 = await prompt(
        "Run the shell command written in cmd.txt again, exactly as written, with the Bash tool.\n" +
          "If it is rejected, do not retry and do not try anything else. Then stop.",
      );
      expect(r2.stopReason).toBe("end_turn");
      const asked2 = inPhase("default").filter(mentionsProbe);
      expect(asked2.length).toBeGreaterThanOrEqual(1);
      for (const r of asked2) expect(isClassifierRequest(r)).toBe(false);
      expect(asked2[0]!.options.map((o) => o.name)).not.toEqual([
        "Yes",
        "Yes for this session",
        "No",
      ]);
      expect([...probeCalls(updates.slice(start2)).values()]).not.toContain("completed");

      // 3. back to auto: the dormant session grant is honoured, unasked.
      await setMode("auto");
      phase = "auto-again";
      const start3 = updates.length;
      const r3 = await prompt(
        "Run the shell command written in cmd.txt once more, exactly as written, with the Bash tool. Then stop.",
      );
      expect(r3.stopReason).toBe("end_turn");
      expect(inPhase("auto-again").filter(mentionsProbe)).toHaveLength(0);
      expect([...probeCalls(updates.slice(start3)).values()]).toContain("completed");
    }, 600_000);
  },
);
