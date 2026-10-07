# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40lucascouts%2Fclaude-agent-acp-plus)](https://www.npmjs.com/package/@lucascouts/claude-agent-acp-plus)

> A **fork** of [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) that ports features from the Claude Code VS Code extension to ACP clients (like Zed), for a friendlier experience. Tracks upstream through v0.70.0. Requires Node.js >= 24.

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Nested subagent transcripts
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers
- Session-scoped long-running goals through the provider-neutral [goal extension](docs/goal-extension.md)
- Structured errors, recovery, and warnings through the opt-in [session failure extension](docs/session-failure-extension.md)
- Tool permission presentation, editable choices, and durable effects through the [permission extension](docs/permission-extension.md)

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## What this fork adds

On top of upstream, aimed at parity with the Claude Code VS Code extension:

- **Multi-select questions** — `AskUserQuestion` with `multiSelect` renders as checkboxes, and a typed custom answer keeps the boxes already ticked
- **Refusal consent dialog** — when the model refuses, the CLI's fallback prompt is shown as a dialog instead of a bare error
- **Live quota windows** — every usage window from the account's usage report, refreshed while the session is idle and shared between adapter processes
- **Background tasks** — the live set of background tasks is published to the client
- **Task feed** — every task the agent runs, with status, usage and timing, plus stop and send-to-background actions (see [Task feed](#task-feed))
- **Session notices** — live advisories sent as ACP session notices, and context compaction reported rather than inferred
- **Ultracode** in the effort picker, and a model picker that offers only the newest model of each family
- **Per-session account selection**, and an agent name taken from the installed package
- Permission prompts that honour the CLI's `defaultToNo` and `suppressAlwaysAllowRule`
- **Classifier denials ask instead of failing** — in `auto` mode, a call the classifier blocks becomes a permission prompt (see [Classifier denials](#classifier-denials))

### Nested subagent transcripts

ACP 1.2 has no standard subagent tool kind or nested-message relationship. Clients that can render
nested transcripts can opt in with `clientCapabilities._meta["subagent-transcript"] = true`.
The agent then forwards subagent text, thinking, and tool calls, relating nested updates to the
launching Agent/Task call through `_meta.claudeCode.parentToolUseId`. Agent/Task calls are marked
with `_meta.claudeCode.subagent = true`.

Clients that do not advertise the capability retain the legacy flattened behavior. In both modes,
the normal Agent/Task tool result is preserved as the protocol-compatible fallback.

### Classifier denials

In `auto` permission mode the CLI's classifier decides alone whether a tool call may run. When it
refuses one, the agent asks the client instead of failing the call: one permission request for
that call, showing the command (or an input summary) and the classifier's reason, with three
answers:

- **Yes** — the model is told it may retry, and its next identical call in this turn runs without
  the classifier, once
- **Yes for this session** — every later identical call in this session skips the classifier
- **No** — the call fails with the classifier's reason, exactly as before

"Identical" means the same tool and the same input, except a Bash call's `description`, which the
model rewrites on retry. Neither answer is permanent: grants live in the agent's memory only, are
never written to a settings or project file, and end with the session (an unused "Yes" ends with
its turn). Cancelling the turn withdraws the request. Denials from deny rules, `dontAsk` mode,
hooks or other modes are reported as before, with no prompt.

A grant applies only while the session is in `auto` mode. In any other mode it is held, not
lost: that mode's own permission checks decide, and the grant applies again once the session is
back in `auto`. A deny rule always wins over a grant.

### Task feed

The agent's background shells, subagents, monitors and workflows are published as one table per
session, under `session_info_update._meta["_claude/tasks"]`. The `initialize` response advertises
it as `agentCapabilities._meta["_claude/tasks"] = { "version": 1 }`; clients should gate on that
capability, never on the agent's name.

Each update is a **snapshot, not a delta**: `{ "tasks": [...] }` carries every live task, so a
client replaces its list instead of merging. Each entry has `id`, `toolCallId`, `type`
(`shell` · `subagent` · …), `description`, `background`, `depth`, `status`
(`running` · `completed` · `failed` · `stopped` · `interrupted`), `startedAt` and `endedAt`
(epoch milliseconds, `endedAt` null while running), `usage` (`{ tokens, toolUses, durationMs }`
or null), `lastTool` and `summary`. An ended task appears in exactly one snapshot with its final
status, then drops out. Progress is published at most once per second; an ending is published at
once. When the agent's stream ends, running tasks are published once as `interrupted`.
Command lines are never copied into an entry.

Two JSON-RPC methods act on a task:

- `_claude/tasks/stop` — params `{ sessionId, taskId }`, result `{}`
- `_claude/tasks/background` — params `{ sessionId, toolCallId }`, result `{ backgrounded }`;
  moves a foreground tool call's task to the background

An unknown session or a task that is not running is an invalid-params error (`-32602`); a session
whose stream already ended is an internal error (`-32603`).

Subagent entries can carry a short model-written progress `summary`. It is off by default, because
each summary is a model call billed to the user; set `CLAUDE_ACP_PROGRESS_SUMMARIES=1` (or `true`)
in the agent's environment to turn it on.

## Install

```bash
npm install -g @lucascouts/claude-agent-acp-plus
```

This puts `claude-agent-acp-plus` on your `PATH`. Point your ACP client at it — in Zed, an
`agent_servers` entry of `"type": "custom"` whose `command` is `claude-agent-acp-plus`.

## Test

```bash
npm ci
npm run ci:local   # format check, lint, build, and the full test suite
```

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
