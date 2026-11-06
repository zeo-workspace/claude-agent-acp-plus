import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { findTranscript } from "./transcript-path.js";

/**
 * Story 065, Task 4.1 — which Agent call launched which subagent, read back
 * from a session's transcripts so a replayed or restored child keeps the id it
 * had live (R4.1, R4.3).
 *
 * The bundled CLI writes, beside each subagent transcript
 * `<session>/subagents/agent-<agentId>.jsonl`, a metadata file
 * `agent-<agentId>.meta.json` whose `toolUseId` names the launching call
 * (the same layout upstream's `subagent-history.ts` reads). The child id is
 * the `<agentId>` of the file name — never generated: a launch without
 * metadata has no known id and is left nested, as before.
 */
export type SubagentLaunchRecord = {
  agentId: string;
  name?: string;
  agentType?: string;
  description?: string;
  /** `parentAgentId`: the subagent whose agent launched this one (a nested
   *  subagent, whose launch is in that agent's transcript, not the parent's). */
  launcherAgentId?: string;
  /** `spawnDepth`: 1 for a launch by the main thread. */
  depth: number;
};

const META_FILE = /^agent-(.+)\.meta\.json$/;

/** The subagents of `sessionId`, keyed by the tool use id that launched each. */
export async function readSubagentLaunches(
  configDir: string,
  sessionId: string,
): Promise<Map<string, SubagentLaunchRecord>> {
  const launches = new Map<string, SubagentLaunchRecord>();
  const transcript = await findTranscript(configDir, sessionId);
  if (!transcript) return launches;
  const directory = path.join(path.dirname(transcript), sessionId, "subagents");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return launches;
  }
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  await Promise.all(
    names.map(async (name) => {
      const agentId = name.match(META_FILE)?.[1];
      if (!agentId) return;
      try {
        const meta = JSON.parse(await readFile(path.join(directory, name), "utf8")) as Record<
          string,
          unknown
        > | null;
        if (typeof meta?.toolUseId !== "string") return;
        launches.set(meta.toolUseId, {
          agentId,
          name: text(meta.name),
          agentType: text(meta.agentType),
          description: text(meta.description),
          launcherAgentId: text(meta.parentAgentId),
          depth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : 1,
        });
      } catch {
        // A damaged metadata file leaves its subagent nested, as without the RFD.
      }
    }),
  );
  return launches;
}
