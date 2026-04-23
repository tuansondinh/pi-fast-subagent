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

Detach running foreground subagent to background:

```
/fast-subagent:bg fg_ab12cd34
```

Omit job id to list active foreground jobs:

```
/fast-subagent:bg
```

### `/fast-subagent:bg-status`

Show active background subagents in selector UI. Arrow keys move selection. Enter shows full details for selected job.

```
/fast-subagent:bg-status
```

Show details for specific background job:

```
/fast-subagent:bg-status sa_ab12cd34
```

### `/fast-subagent:bg-cancel`

Cancel running background subagent. Omit job id to open selector UI, then choose job with arrow keys.

```
/fast-subagent:bg-cancel
```

Cancel specific background job directly:

```
/fast-subagent:bg-cancel sa_ab12cd34
```

## Usage

### List agents

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
subagent({
  agent: "scout",
  task: "Explore src and summarize architecture"
})
```

### General-purpose built-in agent

```js
subagent({
  agent: "general",
  task: "Summarize open TODOs and propose next step"
})
```

### Override model

```js
subagent({
  agent: "scout",
  task: "Explore src and summarize architecture",
  model: "anthropic/claude-haiku-4-5"
})
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

// Repeat one task N times in parallel
subagent({
  tasks: [{ agent: "scout", task: "Explore src", count: 3 }]
})
```

### Background (fire-and-forget)

```js
// Dispatch — returns job ID immediately
subagent({ agent: "scout", task: "Explore src", background: true })
// → { jobId: "sa_ab12cd34", status: "running" }

// Poll — check result / progress
subagent({ action: "poll", jobId: "sa_ab12cd34" })

// Cancel
subagent({ action: "cancel", jobId: "sa_ab12cd34" })

// List all background jobs
subagent({ action: "status" })

// Detach a running foreground job to background
subagent({ action: "detach", jobId: "fg_ab12cd34" })
```

### Working directory override

```js
subagent({ agent: "scout", task: "Explore", cwd: "/path/to/project" })
```

## Roadmap

Goal: keep this extension **small and focused** — aligned with pi's philosophy of minimal, composable tooling. No feature creep. Every addition must earn its place.

- **UI/UX polish** — improve visibility of running subagents: clearer status lines, better progress feedback, agent name + task always visible during execution
- ~~**Background subagents**~~ ✔ shipped in v0.4.0 — fire-and-forget with `background: true`, poll/cancel/detach support

## Notes

- Async/background isolation not supported in-process
- Git worktree isolation not supported
- Nested subagent depth limited to 2 by default

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
