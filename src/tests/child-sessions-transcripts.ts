/**
 * Story 065 — session transcripts on disk, in the layout the bundled CLI writes
 * and the real SDK readers (`getSessionMessages`, `listSubagents`,
 * `getSubagentMessages`) read:
 *
 *   <CLAUDE_CONFIG_DIR>/projects/<cwd, non-alphanumerics as "-">/<session>.jsonl
 *   <CLAUDE_CONFIG_DIR>/projects/<…>/<session>/subagents/agent-<agentId>.jsonl
 *   <CLAUDE_CONFIG_DIR>/projects/<…>/<session>/subagents/agent-<agentId>.meta.json
 *
 * The meta file names the Agent call that launched the subagent (`toolUseId`).
 * Nothing here is mocked: a replay test reads these files through whatever the
 * adapter uses, so the child ids it sends come from the transcript itself.
 *
 * Vitest-free, like helpers.ts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type TranscriptChild = {
  agentId: string;
  toolUseId: string;
  name: string;
  agentType: string;
  description: string;
  prompt: string;
  /** What the subagent said: its transcript's one assistant message. */
  said: string;
};

const projectDir = (configDir: string, cwd: string) =>
  path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

const line = (value: unknown) => JSON.stringify(value);

/** Writes a parent session whose one turn launched `children`, and each child's transcript. */
export async function writeSessionWithChildren(
  configDir: string,
  cwd: string,
  sessionId: string,
  children: TranscriptChild[],
) {
  const dir = projectDir(configDir, cwd);
  const subagents = path.join(dir, sessionId, "subagents");
  await mkdir(subagents, { recursive: true });
  const base = {
    sessionId,
    cwd,
    version: "2.1.300",
    userType: "external",
    isSidechain: false,
    timestamp: "2026-10-25T00:00:00.000Z",
  };
  const entries = [
    {
      ...base,
      type: "user",
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      parentUuid: null,
      message: { role: "user", content: "Find the parser, twice." },
    },
    {
      ...base,
      type: "assistant",
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000002`,
      parentUuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      message: {
        id: `msg_${sessionId.slice(0, 8)}_launch`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: children.map((child) => ({
          type: "tool_use",
          id: child.toolUseId,
          name: "Agent",
          input: {
            description: child.description,
            prompt: child.prompt,
            name: child.name,
            subagent_type: child.agentType,
          },
        })),
      },
    },
    {
      ...base,
      type: "user",
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000003`,
      parentUuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000002`,
      message: {
        role: "user",
        content: children.map((child) => ({
          type: "tool_result",
          tool_use_id: child.toolUseId,
          content: [{ type: "text", text: child.said }],
        })),
      },
    },
    {
      ...base,
      type: "assistant",
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000004`,
      parentUuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000003`,
      message: {
        id: `msg_${sessionId.slice(0, 8)}_answer`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "Both subagents answered." }],
      },
    },
  ];
  await writeFile(path.join(dir, `${sessionId}.jsonl`), entries.map(line).join("\n") + "\n");

  for (const child of children) {
    const sub = { ...base, isSidechain: true, agentId: child.agentId };
    const transcript = [
      {
        ...sub,
        type: "user",
        uuid: `${child.agentId.slice(0, 8)}-0000-4000-8000-00000000000a`,
        parentUuid: null,
        message: { role: "user", content: child.prompt },
      },
      {
        ...sub,
        type: "assistant",
        uuid: `${child.agentId.slice(0, 8)}-0000-4000-8000-00000000000b`,
        parentUuid: `${child.agentId.slice(0, 8)}-0000-4000-8000-00000000000a`,
        message: {
          id: `msg_${child.agentId}_said`,
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: child.said }],
        },
      },
    ];
    await writeFile(
      path.join(subagents, `agent-${child.agentId}.jsonl`),
      transcript.map(line).join("\n") + "\n",
    );
    await writeFile(
      path.join(subagents, `agent-${child.agentId}.meta.json`),
      line({
        toolUseId: child.toolUseId,
        agentType: child.agentType,
        description: child.description,
        name: child.name,
      }),
    );
  }
}
