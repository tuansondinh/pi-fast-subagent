# pi-fast-subagent

In-process subagent delegation for [pi](https://github.com/badlogic/pi-mono).

Runs subagents with `createAgentSession()` in same process instead of spawning `pi` subprocesses. This removes subprocess cold-start and reuses pi auth/model registry.

## Features

- Single mode: `{ agent, task }`
- Parallel mode: `{ tasks: [...] }`
- Chain mode: `{ chain: [...] }`
- Per-call or per-step model override
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

## Usage

### List agents

```js
subagent({ action: "list" })
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
  concurrency: 2
})
```

### Chain

```js
subagent({
  chain: [
    { agent: "scout", task: "Explore app structure" },
    { agent: "scout", task: "Based on this: {previous}\n\nExtract only auth flow." }
  ]
})
```

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
