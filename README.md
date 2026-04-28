# pi-fast-subagent

In-process subagent delegation for [pi](https://github.com/badlogic/pi-mono) with max visibility.

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
- Streamed prompt preview while the parent LLM is writing the subagent task
- Chronological expanded view (Ctrl+O): subagent tool calls and response text interleaved in execution order
- Collapsed view shows response + trailing tool calls as an indented tree

## Settings

Configure preview sizes in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "fastSubagent": {
    "previewLines": 12,
    "promptPreviewLines": 12
  }
}
```

- `previewLines` — response text preview lines in collapsed view (default 12)
- `promptPreviewLines` — task/prompt preview lines in collapsed view (default 12)

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

### Agent frontmatter

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique agent identifier used in `subagent({ agent: "..." })` |
| `description` | yes | One-line description shown in `/fast-subagent:agent` |
| `model` | no | Model override, format `provider/model-id` (e.g. `anthropic/claude-haiku-4-5`) |
| `tools` | no | Tool allowlist (see below) |
| `maxDepth` | no | Nested subagent depth this agent may spawn. Default `0` means this agent cannot call `subagent`. |

### `tools:` field

Controls which tools the subagent has access to. The default is **all tools** — builtins plus parent extensions (web_search, fetch_content, mcp, playwright, …). Agents opt into lean mode with `tools: builtins` or an explicit built-in allowlist.

| Value | Behavior |
|-------|----------|
| *(omitted)* | Builtins + every parent extension (**default**) |
| `all` | Same as omitted — explicit "everything" |
| `builtins` | Builtins only — `read, bash, edit, write, grep, find, ls` |
| `none` | No tools at all — pure reasoning agent |
| comma list | Allowlist; extensions auto-load only if any listed tool is non-builtin |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

Examples:

```md
---
name: writer
description: Pure-reasoning writing assistant
tools: none
---
```

```md
---
name: scout
description: Read-only code explorer
# drop `edit` and `write` so the agent cannot mutate the codebase
tools: read, bash, grep, find, ls
---
```

```md
---
name: researcher
description: Web research agent
# listing `web_search` triggers extension loading; `read` + `write` keep the rest local
tools: read, write, web_search, fetch_content
---
```

```md
---
name: general
description: Do-anything helper
# `tools` omitted means all tools; `tools: all` is equivalent
tools: all
---
```

> **Performance note:** omitted `tools` / `tools: all` loads every installed pi extension into the subagent session. That adds startup cost (extension init, possibly MCP server spawn, playwright runtime, …) and token cost (bigger system prompt). Use `tools: builtins` or list specific tools for tight, focused agents.

**YAML comments** (`# …`) are allowed inside the frontmatter — handy for documenting *why* a particular tool set was chosen. See `agents/general.md` and `agents/scout.md` for examples.

### `maxDepth:` field

Subagents cannot spawn other subagents by default, even when `tools` exposes the `subagent` tool.

```md
---
name: planner
description: Can delegate one level deeper
maxDepth: 1
---
```

Depth counts nested generations from that agent:

| Value | Behavior |
|-------|----------|
| *(omitted)* / `0` | This agent cannot spawn subagents |
| `1` | This agent may spawn subagents, but those children cannot spawn again unless their own `maxDepth` allows it |
| `2` | Allows two nested generations, subject to each child agent's own `maxDepth` |

Aliases accepted: `max_depth`, `depth`, `subagentDepth`.

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
- Nested subagent spawning disabled by default (`maxDepth: 0`); opt in per agent via frontmatter

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
