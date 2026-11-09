// Upstream #1496: a child's working directory, from the `cwd` of its own hook, reaches the
// client only when it differs from the parent's.

import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { ChildSessionRouter, type ChildLaunch } from "../child-sessions.js";

const PARENT = "parent-session";
const PARENT_CWD = "/work/project";
const WORKTREE = "/work/project/.claude/worktrees/agent-a";

function router() {
  const sent: SessionNotification[] = [];
  const r = new ChildSessionRouter(
    async (n) => {
      sent.push(n);
    },
    () => {},
  );
  const subagentUpdates = () =>
    sent.flatMap((n) => (n.update.sessionUpdate === "subagent_update" ? [n.update] : []));
  return { r, subagentUpdates };
}

const launch: ChildLaunch = {
  parentSessionId: PARENT,
  toolUseId: "toolu_launch",
  agentId: "agent-a",
  title: "parser-finder",
  prompt: "Find it.",
  cancellable: true,
};

describe("child session cwd (upstream #1496)", () => {
  it("carries a cwd reported before the launch in the announcement", async () => {
    const { r, subagentUpdates } = router();
    await r.reportCwd("agent-a", WORKTREE, PARENT_CWD);
    await r.launch(launch);
    expect(subagentUpdates()).toHaveLength(1);
    expect(subagentUpdates()[0]).toMatchObject({ sessionId: "agent-a", cwd: WORKTREE });
  });

  it("sends a cwd reported after the launch as its own update, once", async () => {
    const { r, subagentUpdates } = router();
    await r.launch(launch);
    await r.reportCwd("agent-a", WORKTREE, PARENT_CWD);
    await r.reportCwd("agent-a", WORKTREE, PARENT_CWD);
    expect(subagentUpdates().map((u) => u.cwd)).toEqual([undefined, WORKTREE]);
  });

  it("sends nothing for a child in its parent's directory, and null when one returns to it", async () => {
    const { r, subagentUpdates } = router();
    await r.launch(launch);
    await r.reportCwd("agent-a", PARENT_CWD, PARENT_CWD);
    expect(subagentUpdates()).toHaveLength(1);
    await r.reportCwd("agent-a", WORKTREE, PARENT_CWD);
    await r.reportCwd("agent-a", `${PARENT_CWD}/`, PARENT_CWD);
    expect(subagentUpdates().map((u) => u.cwd)).toEqual([undefined, WORKTREE, null]);
  });

  it("ignores a relative cwd", async () => {
    const { r, subagentUpdates } = router();
    await r.launch(launch);
    await r.reportCwd("agent-a", "relative/dir", PARENT_CWD);
    expect(subagentUpdates()).toHaveLength(1);
  });
});
