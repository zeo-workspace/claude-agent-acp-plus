// Story 041, task 3.1 — `_claude/tasks` version 2 against the real CLI, over ACP stdio (R1.1, R1.2,
// R1.4, R2.1; Q11).
//
// The built adapter runs as a subprocess (`npm run dev`, as adapter-parity-round-2 does — spawn
// with a fixed argument list, no shell) and this file is its ACP client. The model is asked to
// start one background shell that prints eight numbered lines a second apart. The suite then reads
// only the wire:
//   - snapshots under `session_info_update._meta["_claude/tasks"]` show that shell with
//     `hasOutput: true` and a `tail` that GROWS (a later snapshot holds a higher line number);
//   - the Bash tool_result's background notice names `<task id>.output` for the SAME task id the
//     snapshot carries (the story's assumption on the output path; if the ids differ, the suite
//     fails here and the assumption must be raised, not worked around);
//   - after the ending, `_claude/tasks/output` returns all eight lines.
//
// Run mode records here, before the first green run, the CLI version and the exact notice line
// the probe produced:
//   CLI version: 2.1.285 (Claude Code) — the CLI bundled with @anthropic-ai/claude-agent-sdk
//                0.3.285, which is what the adapter spawns (recorded 2026-10-11)
//   Notice line: Output is being written to: /tmp/claude-1000/-tmp-task-output-it-zYE5Iu/dff6db10-ece6-4220-842a-66bc6f365642/tasks/b0dtugkyb.output.
//                (captured from this suite's first real run rather than a separate probe turn; the
//                trailing period is the CLI's, and the first run failed on it — see task-output.ts)
//
// Skipped, with the reason printed, unless RUN_INTEGRATION_TESTS is set. It costs one short model
// turn on the operator's account.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";

const RUN = !!process.env.RUN_INTEGRATION_TESTS;
if (!RUN) {
  console.log(
    "task-output.integration.test.ts skipped: set RUN_INTEGRATION_TESTS=true to drive the real CLI",
  );
}

const COMMAND = "for i in $(seq 1 8); do echo line $i; sleep 1; done";
// The CLI ends the sentence with a period, which is not part of the path (see task-output.ts).
const NOTICE = /Output is being written to: ([^\s"\\]+?)\.?(?=[\s"\\]|$)/;

type Snapshot = { at: number; tasks: any[] };

describe.skipIf(!RUN)("_claude/tasks v2 against the real CLI", () => {
  let child: ReturnType<typeof spawn>;
  let cwd = "";

  beforeAll(() => {
    const built = spawnSync("tsc", { stdio: "inherit" });
    if (built.status) throw new Error("failed to compile");
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-output-it-"));
    child = spawn("npm", ["run", "--silent", "dev"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
  });

  afterAll(() => {
    child?.kill();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("publishes a growing tail and serves the whole output after the end", async () => {
    const snapshots: Snapshot[] = [];
    const notices: string[] = [];
    const onUpdate = (n: SessionNotification) => {
      const update: any = n.update;
      const tasks = update._meta?.["_claude/tasks"];
      if (update.sessionUpdate === "session_info_update" && tasks) {
        snapshots.push({ at: Date.now(), tasks: tasks.tasks });
      }
      const match = JSON.stringify(update.content ?? update.rawOutput ?? "").match(NOTICE);
      if (match) notices.push(match[1]);
    };
    const allow = async (p: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({
      outcome: {
        outcome: "selected",
        optionId: p.options.find((o) => o.kind.startsWith("allow"))!.optionId,
      },
    });

    const stream = ndJsonStream(nodeToWebWritable(child.stdin!), nodeToWebReadable(child.stdout!));
    const { agent } = acpClient({ name: "task-output-integration" })
      .onNotification(methods.client.session.update, (c) => onUpdate(c.params))
      .onRequest(methods.client.session.requestPermission, (c) => allow(c.params))
      .connect(stream);

    const init: any = await agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(init?.agentCapabilities?._meta?.["_claude/tasks"]).toEqual({ version: 2 });

    const { sessionId } = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
    await agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        {
          type: "text",
          text:
            "Use the Bash tool with run_in_background set to true to run exactly this command, " +
            `then reply "started" and nothing else: ${COMMAND}`,
        },
      ],
    });

    const shell = () =>
      snapshots
        .flatMap((s) => s.tasks.map((t) => ({ at: s.at, t })))
        .filter(({ t }) => t.type === "shell");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !shell().some(({ t }) => t.status !== "running")) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const entries = shell();
    expect(entries.length).toBeGreaterThan(0);
    const taskId = entries[0].t.id;

    // The notice names this task's file: the story's assumption, confirmed or refuted here.
    expect(notices.length).toBeGreaterThan(0);
    expect(path.basename(notices[0])).toBe(`${taskId}.output`);

    // A growing tail while it ran.
    const lineNumber = (tail: string[] | null) =>
      Math.max(0, ...(tail ?? []).map((l) => Number(/line (\d+)/.exec(l)?.[1] ?? 0)));
    const runningTails = entries.filter(
      ({ t }) => t.id === taskId && t.status === "running" && t.tail,
    );
    expect(runningTails.length).toBeGreaterThanOrEqual(2);
    for (const { t } of runningTails) {
      expect(t.hasOutput).toBe(true);
      expect(t.tail.length).toBeLessThanOrEqual(10);
    }
    expect(lineNumber(runningTails.at(-1)!.t.tail)).toBeGreaterThan(
      lineNumber(runningTails[0].t.tail),
    );

    // The ending, with output, and the whole output on request.
    const ending = entries.find(({ t }) => t.id === taskId && t.status !== "running");
    expect(ending?.t).toMatchObject({ hasOutput: true, tail: null });
    const out: any = await agent.request("_claude/tasks/output", {
      sessionId,
      taskId,
      maxBytes: 1_048_576,
    });
    expect(out.truncated).toBe(false);
    for (let i = 1; i <= 8; i++) expect(out.content).toContain(`line ${i}`);
    expect(out.totalBytes).toBe(Buffer.byteLength(out.content));
  }, 90_000);
});
