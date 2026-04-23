# Changelog

All notable changes to this project will be documented in this file.

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
