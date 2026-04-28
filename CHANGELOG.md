# Changelog

All notable changes to this project will be documented in this file.

## [0.9.2] - 2026-04-28

### Features
- Inherit main-session model more reliably for subagents (single/parallel/background), including ad-hoc provider model IDs not yet present in registry
- Add `/fast-subagent:debug-model` command to inspect cached/inferred main model state

### Bug Fixes
- Fix expanded verbose output formatting by coalescing streamed `text_delta` chunks before wrapping (prevents one-token-per-line rendering)

### Other
- Add unit tests for `resolveModelObject()` fallback behavior
- Update bundled `scout` agent default model to `openai-codex/gpt-5.4-mini`

## [0.9.1] - 2026-04-24

### Bug Fixes
- Stream subagent prompt/tool-call preview while the parent LLM is still writing delegated task arguments
- Keep subagent call row compact after execution starts to avoid duplicate prompt rendering

## [0.9.0] - 2026-04-24

### Features
- Chronological execution events in expanded subagent view: tool calls and subagent text now interleave in the order they actually ran (press Ctrl+O)
- Collapsed view shows subagent response followed by only the tool calls that ran after the last text block, rendered as an indented tree (`├─`/`└─`)
- Agent-name label (e.g. `scout:`) shown before response text in both collapsed and expanded views
- Configurable preview sizes via `settings.json`: `fastSubagent.previewLines` (response) and `fastSubagent.promptPreviewLines` (prompt), both default 12

### Other
- Split `index.ts` into focused modules and add a test suite
- Extract `findTrailingTools()` as a pure helper with 6 unit tests
- Remove duplicate agent name from the footer status line (now shown as a label)
- Footer hint simplified to `verbose` for the expand shortcut

## [0.8.0] - 2026-04-24

### Features
- Disable nested subagent spawning by default; agents can opt in with `maxDepth` frontmatter

### Other
- Add `.gitignore` for local development artifacts

## [0.7.0] - 2026-04-24

### Features
- Cache and warm extension-capable resource loaders to remove UI freeze before all-tools subagents start streaming
- Add explicit `tools: builtins` mode for lean agents while preserving omitted `tools` as all-tools default

### Bug Fixes
- Give pi's TUI a real paint window before cold extension loading so subagent prompt/header appears immediately
- Preserve per-agent system prompts while reusing warmed loader resources

### Other
- Document omitted `tools`, `tools: builtins`, `tools: all`, and YAML frontmatter comments in README and bundled agents

## [0.6.1] - 2026-04-24

### Bug Fixes
- Prompt preview now shows up to 8 visual lines in collapsed view (was cut to a single truncated line). Hidden prompt lines are counted in the `expand` hint alongside response lines.

## [0.6.0] - 2026-04-24

### Features
- Agent frontmatter `tools:` field supports `all` / `none` / comma-separated allowlist
- Subagents now inherit parent extensions (web_search, fetch_content, mcp, playwright, …) by default
- Auto-load extensions when frontmatter allowlist references non-builtin tool names
- Export `BUILTIN_TOOL_NAMES` constant from `agents.ts`

### Breaking Changes
- Default subagent now loads parent extensions (previously always lean builtins-only). Agents that want the old behavior must list builtins explicitly: `tools: read, bash, edit, write, grep, find, ls`
- Bundled `scout` agent updated to the explicit builtins allowlist to preserve lean behavior

### Other
- README: document `tools:` frontmatter field with examples

## [0.5.1] - 2026-04-23

### Other
- Improve README: background agents lifecycle, all slash commands, keyboard shortcuts, tool reference section

## [0.5.0] - 2026-04-23

### Features
- Namespace all slash commands under `fast-subagent:` prefix (`/fast-subagent:agent`, `/fast-subagent:bg`, `/fast-subagent:bg-status`, `/fast-subagent:bg-cancel`)

### Other
- Add roadmap to docs
- Clarify chain mode removal reason

## [0.4.0] - 2026-04-23

### Features
- Background job support: `subagent({ agent, task, background: true })` returns job ID immediately
- `status` action: list all background jobs
- `poll` action: check result/progress of a specific job by `jobId`
- `cancel` action: abort a running background job
- Improve keywords for npm discoverability
- Include `background-job-manager.ts` and `background-types.ts` in published package
- Remove chain mode (LLM/agent can chain calls natively)

## [0.3.0] - 2026-04-22

### Features
- Add `/agent` slash command to list available agents and show per-agent details

## [0.2.0] - 2026-04-22

### Features
- Collapse subagent output to 8 lines with Ctrl+O expand hint

### Bug Fixes
- Collapse subagent output during streaming unless expanded
- Move expand hint inline with status/usage line at bottom

### Other
- Improve tool summarization and imports

## [0.1.2] - 2026-04-22

### Bug Fixes
- Truncate output to terminal width using graphemeWidth
