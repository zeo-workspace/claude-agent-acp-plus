// Story 071, task 6.1 — the RELEASED plus, as installed, still advertises what the 1.x line did
// (R1.3, R5.1; Q9). E2E: the installed adapter (the overlay's `/usr/bin/claude-agent-acp-plus`, or
// any other path to the published package) is driven by `zed-patches/scripts/acp-probe.mjs init`,
// the workspace's own wire probe, and its answer is compared field for field with the `acp-probe`
// shape of `fixtures/initialize-baseline.json` — the baseline task 1.1 recorded before the move.
//
// It also pins WHICH binary answered: `agentInfo.version` must be the version just released, so a
// run against the old install cannot pass by answering exactly as the old install did.
//
//   ACP_RELEASED_ADAPTER=/usr/bin/claude-agent-acp-plus ACP_RELEASED_VERSION=<new version> \
//     npx vitest run src/tests/initialize-released.e2e.test.ts
//
// Skipped, with the reason printed, unless both are set. `ACP_PROBE` overrides the probe's path.
// No model turn, no network, no credentials.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "src", "tests", "fixtures", "initialize-baseline.json");
const PROBE =
  process.env.ACP_PROBE ?? path.resolve(ROOT, "../../zed-patches/scripts/acp-probe.mjs");
const ADAPTER = process.env.ACP_RELEASED_ADAPTER;
const VERSION = process.env.ACP_RELEASED_VERSION;
// The published package's name, which the fork's own package.json does not carry.
const PUBLISHED_NAME = "@lucascouts/claude-agent-acp-plus";

const RUN = !!ADAPTER && !!VERSION;
if (!RUN) {
  console.log(
    "initialize-released.e2e.test.ts skipped: set ACP_RELEASED_ADAPTER and ACP_RELEASED_VERSION",
  );
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The probe's answer with the install-specific values replaced, each only when it has the shape
 *  the adapter must send: an absolute node path, and exactly one argv entry — the package's
 *  `dist/index.js` — ahead of `--cli`. Anything else is left as it is and so differs. */
function normalizeReleased(response: Json): Json {
  const copy: Json = JSON.parse(JSON.stringify(response));
  if (!isObject(copy)) return copy;
  const info = copy.agentInfo;
  if (isObject(info)) {
    if (info.name === PUBLISHED_NAME) info.name = "<package.name>";
    if (info.version === VERSION) info.version = "<package.version>";
  }
  for (const method of Array.isArray(copy.authMethods) ? copy.authMethods : []) {
    const meta = isObject(method) ? method._meta : undefined;
    const auth = isObject(meta) ? meta["terminal-auth"] : undefined;
    if (!isObject(auth)) continue;
    if (typeof auth.command === "string" && path.isAbsolute(auth.command)) auth.command = "<node>";
    const argv = Array.isArray(auth.args) ? auth.args : [];
    const cli = argv.indexOf("--cli");
    const entry = argv[0];
    if (
      cli === 1 &&
      typeof entry === "string" &&
      entry.endsWith(`${path.sep}dist${path.sep}index.js`)
    ) {
      auth.args = ["<adapter-argv>", ...argv.slice(1)];
    }
  }
  return copy;
}

function wireDiff(actual: Json | undefined, expected: Json | undefined, at = "$"): string[] {
  if (isObject(actual) && isObject(expected)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].sort().flatMap((key) => {
      const where = `${at}.${key}`;
      if (!(key in actual)) return [`dropped ${where}`];
      if (!(key in expected)) return [`added ${where}`];
      return wireDiff(actual[key], expected[key], where);
    });
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const length = Math.max(actual.length, expected.length);
    return Array.from({ length }, (_, i) => {
      if (i >= actual.length) return [`dropped ${at}[${i}]`];
      if (i >= expected.length) return [`added ${at}[${i}]`];
      return wireDiff(actual[i], expected[i], `${at}[${i}]`);
    }).flat();
  }
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [`changed ${at}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`];
}

async function probeInit(adapter: string): Promise<{ raw: Json; normalized: Json }> {
  // A sanitised environment: a stray SSH_* or CLAUDE_CODE_REMOTE would flip the auth methods.
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "initialize-released-"));
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [PROBE, "init", adapter, "--cwd", cwd], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`acp-probe exited ${code}:\n${stderr}`)),
      );
    });
    const raw = JSON.parse(out) as Json;
    return { raw, normalized: normalizeReleased(raw) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe.skipIf(!RUN)(
  "released plus answers initialize as the 1.x line did (R1.3, R5.1, Q9)",
  () => {
    it("is the version just released, and answers field for field as before the move", async () => {
      const baseline = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).variants["acp-probe"];
      const { raw, normalized } = await probeInit(ADAPTER!);
      expect((raw as any).agentInfo).toMatchObject({ name: PUBLISHED_NAME, version: VERSION });
      expect(wireDiff(normalized, baseline)).toEqual([]);
    }, 60_000);
  },
);
