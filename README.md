# pi-fast-subagent

In-process subagent delegation for [pi](https://github.com/badlogic/pi-mono).

Runs subagents with `createAgentSession()` in same process instead of spawning `pi` subprocesses. This removes subprocess cold-start and reuses pi auth/model registry.

## Features

- Single mode: `{ agent, task }`
- Parallel mode: `{ tasks: [...] }`
- Background mode: `{ agent, task, background: true }` — fire-and-forget with poll/cancel
- Slash commands for background job status + cancellation via selector UI
- Per-call model override
- User + project agent discovery
- Project agents override user agents
- Max nesting depth guard

## Install

```bash
pi install /absolute/path/to/pi-fast-subagent
```

Or from npm after publish:

```bash
pi install npm:pi-fast-subagent
```

## Package contents

This package exposes one pi extension:

- `./index.ts` — registers `subagent` tool

## Included agents

This package bundles default agents:

- `scout` — code exploration specialist
- `general` — general-purpose helper

Discovery priority:

1. bundled package agents
2. `~/.pi/agent/agents/`
3. nearest `.pi/agents/`
4. nearest legacy `.agents/`

User and project agents override bundled agents with same name.

Example override agent file:

```md
---
name: scout
description: Explore codebases and summarize findings
model: anthropic/claude-haiku-4-5
---

You are code exploration specialist. Read relevant files, trace data flow, summarize findings clearly.
```

## Background Agents

Every foreground subagent can be moved to background at any time. Background jobs run concurrently while you continue chatting. When a job finishes, pi automatically posts the result as a follow-up message.

### Status bar

While a foreground subagent is running, the pi status bar shows:
```
{agent-name} running · Ctrl+Shift+B to move to background
```

While background jobs are running:
```
⧗ N bg agents
```

### Moving to background

**Keyboard shortcut (while subagent is running):**
```
Ctrl+Shift+B
```

**Slash command:**
```
/fast-subagent:bg fg_ab12cd34
```

**Via tool call:**
```js
subagent({ action: "detach", jobId: "fg_ab12cd34" })
```

### Auto-completion announcement

When a background job finishes, pi injects a follow-up message automatically:
```
Background subagent ✓: sa_ab12cd34 (scout, 4.2s)
> Explore src and summarize architecture

<result output>
```

Failed jobs are announced the same way with ✗ and the error message.

## Slash Commands

### `/fast-subagent:agent`

List all available agents:

```
/fast-subagent:agent
```

Show details for a specific agent (description, file path, model, tools, system prompt):

```
/fast-subagent:agent scout
```

Tab-completion is supported for agent names.

### `/fast-subagent:bg`

Detach a running foreground subagent to background. Each foreground job has a `fg_` prefixed ID shown in the status bar.

```
/fast-subagent:bg fg_ab12cd34
```

Omit ID to list all active foreground jobs:

```
/fast-subagent:bg
```

### `/fast-subagent:bg-status`

Open selector UI showing all active background jobs. Arrow keys to navigate, Enter to view full details.

```
/fast-subagent:bg-status
```

Skip the selector — show details for a specific job directly:

```
/fast-subagent:bg-status sa_ab12cd34
```

### `/fast-subagent:bg-cancel`

Open selector UI to choose a running job to cancel:

```
/fast-subagent:bg-cancel
```

Cancel a specific job directly:

```
/fast-subagent:bg-cancel sa_ab12cd34
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+B` | Move active foreground subagent to background |

## Roadmap

Goal: keep this extension **small and focused** — aligned with pi's philosophy of minimal, composable tooling. No feature creep. Every addition must earn its place.

- **UI/UX polish** — improve visibility of running subagents: clearer status lines, better progress feedback, agent name + task always visible during execution
- ~~**Background subagents**~~ ✔ shipped in v0.4.0 — fire-and-forget with `background: true`, poll/cancel/detach support

## Notes

- Async/background isolation not supported in-process
- Git worktree isolation not supported
- Nested subagent depth limited to 2 by default

## Tool Reference

> These are `subagent` tool call examples used by the LLM internally. Not typically invoked directly by users.

### List / discover agents

```js
// List all agents
subagent({ action: "list" })

// Get details for a specific agent
subagent({ action: "get", agent: "scout" })

// Scope filter: "user" | "project" | "both" (default)
subagent({ action: "list", agentScope: "project" })
```

### Single

```js
subagent({ agent: "scout", task: "Explore src and summarize architecture" })
```

### Parallel

```js
subagent({
  tasks: [
    { agent: "scout", task: "Map auth flow" },
    { agent: "scout", task: "Map navigation" }
  ],
  concurrency: 2  // default: 4
})

// Repeat one task N times
subagent({ tasks: [{ agent: "scout", task: "Explore src", count: 3 }] })
```

### Background

```js
// Fire-and-forget — returns job ID immediately
subagent({ agent: "scout", task: "Explore src", background: true })
// → { jobId: "sa_ab12cd34", status: "running" }

subagent({ action: "poll",   jobId: "sa_ab12cd34" })  // check progress
subagent({ action: "cancel", jobId: "sa_ab12cd34" })  // abort
subagent({ action: "status" })                        // list all bg jobs
subagent({ action: "detach", jobId: "fg_ab12cd34" })  // move fg → bg
```

### Options

```js
subagent({ agent: "scout", task: "...", model: "anthropic/claude-haiku-4-5" })
subagent({ agent: "scout", task: "...", cwd: "/path/to/project" })
```

## Publish

```bash
cd ~/.pi/agent/extensions/fast-subagent
npm publish
```

If package name is taken, rename `name` in `package.json` first, usually with your npm scope:

```json
{
  "name": "@your-scope/pi-fast-subagent"
}
```
