import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";

/**
 * Story 062, Task 1.3 (R1.6, Q9). The built adapter over ACP stdio -- the
 * same wire `zed-patches/scripts/acp-probe.mjs` drives, without Zed -- against
 * the real CLI on Opus 5.5, two sessions in one adapter process:
 *
 *   1. `plan_updates` left at its default (on): a turn that keeps a todo list
 *      must emit a `plan` session update.
 *   2. `plan_updates` turned off through `session/set_config_option` before
 *      the first prompt: the same turn is the control and emits none.
 *
 * Why: the CLI enables its todo tools only on legacy models unless
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set (upstream #1380), so Zed's plan view
 * stays empty on Opus 5.x. TWO REAL MODEL TURNS on the account the adapter
 * runs as, hence the RUN_INTEGRATION_TESTS gate.
 *
 * Set PLAN_UPDATES_PROOF_DIR to keep both captures (`on.json`, `off.json`) --
 * the story saves them under `.draft/proofs/1.3/`. PLAN_UPDATES_MODEL pins the
 * model id when the picker's Opus 5.5 entry is spelled differently.
 */
const OPTION_ID = "plan_updates";
const MODEL_PATTERN = /opus[-\s.]?5[-.]5/i;

const PROMPT =
  "Keep a todo list for this request with your todo-list tool: record exactly three items " +
  "(alpha, beta, gamma), then mark all three completed, one at a time. Do not use any other " +
  "tool and do not touch any file. Then reply with the single word: done.";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-updates-e2e-"));
  roots.push(root);
  return root;
}

function modelValue(options: SessionConfigOption[] | null | undefined): string | undefined {
  if (process.env.PLAN_UPDATES_MODEL) return process.env.PLAN_UPDATES_MODEL;
  const model = options?.find((o) => o.id === "model");
  if (!model || model.type !== "select") return undefined;
  const flat = model.options.flatMap((o) => ("options" in o ? o.options : [o]));
  return flat.find((o) => MODEL_PATTERN.test(o.value) || MODEL_PATTERN.test(o.name))?.value;
}

function saveProof(name: string, capture: unknown) {
  const dir = process.env.PLAN_UPDATES_PROOF_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(capture, null, 2) + "\n");
}

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "Plan updates reach the wire on Opus 5.5 (real CLI)",
  () => {
    const children: ReturnType<typeof spawn>[] = [];

    beforeAll(() => {
      if (spawnSync("tsc", { stdio: "inherit" }).status) throw new Error("failed to compile");
    });

    afterAll(() => {
      for (const child of children) child.kill();
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    });

    it("emits a plan update with plan_updates on, and none with it off", async () => {
      const cwd = workspace();
      const child = spawn("node", ["dist/index.js"], {
        stdio: ["pipe", "pipe", "inherit"],
        env: process.env,
      });
      children.push(child);

      const updates: SessionNotification[] = [];
      const stream = ndJsonStream(
        nodeToWebWritable(child.stdin!),
        nodeToWebReadable(child.stdout!),
      );
      const { agent: ctx } = acpClient({ name: "plan-updates-e2e" })
        .onNotification(methods.client.session.update, (c) => void updates.push(c.params))
        // A todo list needs no permission; anything else is not this test's.
        .onRequest(methods.client.session.requestPermission, async () => ({
          outcome: { outcome: "cancelled" as const },
        }))
        .connect(stream);

      await ctx.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
      });

      const open = async () => {
        const session = await ctx.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
          _meta: { claudeCode: { options: { settingSources: [] } } },
        });
        const model = modelValue(session.configOptions);
        expect(model, "an Opus 5.5 entry in the model picker").toBeDefined();
        await ctx.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: "model",
          value: model!,
        });
        return session;
      };
      const turn = async (sessionId: string) => {
        const result = await ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: PROMPT }],
        });
        const mine = updates.filter((u) => u.sessionId === sessionId).map((u) => u.update);
        return { stopReason: result.stopReason, updates: mine };
      };

      // 1. Default on: the option is offered (Q9) and the todo list reaches Zed.
      const on = await open();
      const offered = on.configOptions?.find((o) => o.id === OPTION_ID);
      expect(offered, "plan_updates offered on session/new").toBeDefined();
      expect(offered?.currentValue).toBe(true);
      const onCapture = await turn(on.sessionId);
      saveProof("on", onCapture);
      expect(onCapture.stopReason).toBe("end_turn");
      const plans = onCapture.updates.filter((u) => u.sessionUpdate === "plan");
      expect(plans.length, "plan updates with plan_updates on").toBeGreaterThan(0);
      expect(
        (plans.at(-1) as { entries?: unknown[] }).entries?.length,
        "the last plan carries the three items",
      ).toBe(3);

      // 2. Control: the same turn with the option off emits no plan.
      const off = await open();
      const ack = await ctx.request(methods.agent.session.setConfigOption, {
        sessionId: off.sessionId,
        configId: OPTION_ID,
        type: "boolean",
        value: false,
      });
      expect(ack.configOptions.find((o) => o.id === OPTION_ID)?.currentValue).toBe(false);
      const offCapture = await turn(off.sessionId);
      saveProof("off", offCapture);
      expect(offCapture.stopReason).toBe("end_turn");
      expect(offCapture.updates.filter((u) => u.sessionUpdate === "plan")).toEqual([]);
    }, 600_000);
  },
);
