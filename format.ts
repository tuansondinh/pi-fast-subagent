/**
 * Pure formatting helpers used by runner + render + command layers.
 */

import type { AgentConfig } from "./agents.js";
import type { BackgroundSubagentJob } from "./background-types.js";
import type { RunResult } from "./types.js";

export function formatTools(tools: AgentConfig["tools"]): string {
  if (tools === "all") return "all";
  if (tools === "builtins") return "builtins (default)";
  if (tools === "none") return "none";
  return tools.join(", ");
}

export function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const cwd = process.cwd();
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p.replace(/^\/Users\/[^/]+\/[^/]+\//, "");
}

export function summarizeToolArgs(toolName: unknown, toolInput: unknown): string {
  const name = String(toolName ?? "");
  const input =
    toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  const filePath = (): string => shortPath(input.path ?? input.file_path) || "";
  switch (name) {
    case "Read":
    case "read":
    case "Write":
    case "write":
    case "Edit":
    case "edit":
      return filePath();
    case "Bash":
    case "bash": {
      const cmd = String(input.command ?? "");
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    }
    case "Glob":
    case "glob":
      return String(input.pattern ?? "");
    case "find": {
      const pat = String(input.pattern ?? "");
      const p = shortPath(input.path);
      return p ? `${pat} in ${p}` : pat;
    }
    case "Grep":
    case "grep": {
      const pat = String(input.pattern ?? "");
      const g = input.glob ? ` ${input.glob}` : "";
      return `${pat}${g}`;
    }
    case "ls":
      return shortPath(input.path) || "";
    case "subagent": {
      const agent = String(input.agent ?? "");
      const t = String(input.task ?? "");
      const summary = t.length > 50 ? t.slice(0, 47) + "..." : t;
      return agent ? `${agent}: ${summary}` : summary;
    }
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0)
          return v.length > 60 ? v.slice(0, 57) + "..." : v;
      }
      return "";
    }
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

export function summarizeTask(task: string, max = 60): string {
  return task.length > max ? task.slice(0, max - 3) + "..." : task;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatUsage(usage: RunResult["usage"], model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalText(r: RunResult): string {
  if (r.exitCode !== 0) return `Error: ${r.error ?? r.output ?? "(no output)"}`;
  return r.output || "(no output)";
}

export function formatBgJobSummary(job: BackgroundSubagentJob, now = Date.now()): string {
  const dur = job.completedAt ? formatDuration(job.completedAt - job.startedAt) : formatDuration(now - job.startedAt);
  return `${job.id} [${job.status}] ${job.agentName} · ${dur} · ${summarizeTask(job.task)}`;
}

export function formatBgJobDetails(job: BackgroundSubagentJob, now = Date.now()): string {
  const dur = job.completedAt ? formatDuration(job.completedAt - job.startedAt) : formatDuration(now - job.startedAt);
  const lines = [`${job.id} [${job.status}] ${job.agentName} · ${dur}`, `Task: ${job.task}`];
  if (job.model) lines.push(`Model: ${job.model}`);
  if (job.status === "completed") lines.push(`\nResult:\n${job.resultSummary ?? "(no output)"}`);
  if (job.status === "failed") lines.push(`\nError: ${job.error ?? "(unknown)"}`);
  if (job.status === "cancelled") lines.push("\nCancelled.");
  if (job.status === "running") lines.push("\nStill running.");
  return lines.join("\n");
}
