/**
 * Render function for the `subagent` tool's result panel.
 */

import { Theme, truncateToVisualLines, keyHint } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

import { formatDuration, formatUsage } from "./format.js";
import type { SubagentDetails, ToolCallEntry } from "./types.js";

export function renderSubagentResult(
  result: AgentToolResult<unknown>,
  { isPartial, expanded }: ToolRenderResultOptions,
  theme: Theme,
) {
  const agentText = result.content?.[0]?.type === "text" ? (result.content[0] as any).text as string : "";
  const details = (result.details ?? {}) as SubagentDetails;
  const toolCalls = details.toolCalls ?? [];

  // ── Parallel mode render ──────────────────────────────────────
  if (details.mode === "parallel" && details.parallelAgents) {
    const agents = details.parallelAgents;
    const doneCount = agents.filter((a) => a.status === "done" || a.status === "error").length;

    function agentToolRow(t: ToolCallEntry): string {
      const arg = t.argSummary || "";
      const call = `${t.name}(${arg})`;
      if (t.result === undefined) return theme.fg("dim", call);
      const dur = t.durMs != null ? (t.durMs < 1000 ? ` ${t.durMs}ms` : ` ${(t.durMs / 1000).toFixed(1)}s`) : "";
      return `${call}${t.isError ? " ✗" : ` ✓${dur}`}`;
    }

    function wrapL(text: string, w: number): string[] {
      try { return wrapTextWithAnsi(text, w); } catch { return [truncateToWidth(text, w, "...")]; }
    }

    const cache: { width?: number } = {};
    return {
      invalidate() { cache.width = undefined; },
      render(width: number): string[] {
        const out: string[] = [];
        const header = details.running
          ? `Parallel (${doneCount}/${agents.length} done)`
          : `Parallel: ${agents.filter((a) => a.status === "done").length}/${agents.length} succeeded`;
        out.push(truncateToWidth(header, width, "..."));

        for (const a of agents) {
          const dur = a.durMs != null ? (a.durMs < 1000 ? ` ${a.durMs}ms` : ` ${(a.durMs / 1000).toFixed(1)}s`) : "";
          const mark = a.status === "pending" ? theme.fg("dim", "⋅")
            : a.status === "running" ? theme.fg("dim", "→")
            : a.status === "done" ? `✓${dur}` : `✗${dur}`;

          if (expanded) {
            out.push("");
            out.push(truncateToWidth(`[${a.name}] ${mark}`, width, "..."));
            out.push(truncateToWidth(`Prompt:`, width, "..."));
            out.push(truncateToWidth(`  ${a.taskSummary}`, width, "..."));
            for (const t of a.toolCalls ?? []) {
              out.push(truncateToWidth(agentToolRow(t), width, "..."));
            }
            if (a.responseText) {
              out.push("Response:");
              const preview = truncateToVisualLines(a.responseText, 6, width - 2);
              for (const l of preview.visualLines) out.push(truncateToWidth("  " + l, width, "..."));
              if (preview.skippedCount > 0) out.push(truncateToWidth(theme.fg("dim", `  … ${preview.skippedCount} more lines`), width, "..."));
            } else if (a.status === "running") {
              out.push(theme.fg("dim", "  running..."));
            }
          } else {
            const row = `  [${a.name}] ${mark}  ${a.taskSummary}`;
            out.push(truncateToWidth(row, width, "..."));
            for (const t of a.toolCalls ?? []) {
              out.push(truncateToWidth(`    ${agentToolRow(t)}`, width, "..."));
            }
            if (a.responseText && (a.status === "done" || a.status === "error")) {
              const preview = truncateToVisualLines(a.responseText, 2, width - 4);
              for (const l of preview.visualLines) out.push(truncateToWidth("    " + l, width, "..."));
            }
          }
        }

        out.push("");
        const status = details.running
          ? ["running", details.usage?.turns ? `${details.usage.turns} turn${details.usage.turns > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")
          : formatUsage(details.usage ?? { input: 0, output: 0, cost: 0, turns: 0 }, details.model);
        const expandHint = !expanded ? keyHint("app.tools.expand", "expand for full output") : "";
        out.push(truncateToWidth([status, expandHint].filter(Boolean).join("  "), width, "..."));
        // Suppress unused warning
        void wrapL;
        return out;
      },
    };
  }

  // ── Single mode render ────────────────────────────────────────

  function statusLine(): string {
    if (details.backgroundJobId) return `moved to background · ${details.backgroundJobId}`;
    const prefix = details.agentName ? `${theme.fg("toolTitle", details.agentName)} · ` : "";
    if (details.running) {
      const parts: string[] = ["running"];
      if (details.usage?.turns) parts.push(`${details.usage.turns} turn${details.usage.turns > 1 ? "s" : ""}`);
      if (details.elapsedMs != null) parts.push(formatDuration(details.elapsedMs));
      if (details.model) parts.push(details.model);
      return prefix + parts.join(" · ");
    }
    return prefix + formatUsage(details.usage ?? { input: 0, output: 0, cost: 0, turns: 0 }, details.model);
  }

  function toolRow(t: ToolCallEntry): string {
    const arg = t.argSummary ? t.argSummary : "";
    const call = `${t.name}(${arg})`;
    if (t.result === undefined) return theme.fg("dim", call);
    const dur = t.durMs != null
      ? t.durMs < 1000 ? ` ${t.durMs}ms` : ` ${(t.durMs / 1000).toFixed(1)}s`
      : "";
    return `${call}${t.isError ? " ✗" : ` ✓${dur}`}`;
  }

  function wrapLine(text: string, w: number): string[] {
    try { return wrapTextWithAnsi(text, w); } catch { return [truncateToWidth(text, w, "...")]; }
  }

  const cache: {
    width?: number;
    promptLines?: string[];
    promptSkipped?: number;
    responseLines?: string[];
    skipped?: number;
  } = {};

  return {
    invalidate() { cache.width = undefined; },
    render(width: number): string[] {
      const out: string[] = [];
      const indent = "  ";
      const ellipsisLine = (count: number) =>
        theme.fg("muted", `${indent}… (${count} more line${count === 1 ? "" : "s"})`);

      if (details.task) {
        out.push("Prompt:");
        if (expanded) {
          for (const line of details.task.split("\n")) {
            for (const w of wrapLine(indent + line, width)) out.push(w);
          }
        } else {
          const PROMPT_PREVIEW_LINES = 8;
          if (cache.width !== width || cache.promptLines === undefined) {
            const innerWidth = Math.max(1, width - indent.length);
            const allVisual: string[] = [];
            for (const raw of details.task.split("\n")) {
              for (const w of wrapLine(raw, innerWidth)) allVisual.push(w);
            }
            const head = allVisual.slice(0, PROMPT_PREVIEW_LINES);
            cache.promptLines = head.map((l) => truncateToWidth(indent + l, width, "..."));
            cache.promptSkipped = Math.max(0, allVisual.length - head.length);
          }
          out.push(...cache.promptLines);
          if ((cache.promptSkipped ?? 0) > 0) {
            out.push(truncateToWidth(ellipsisLine(cache.promptSkipped!), width, "..."));
          }
        }
      }

      for (const t of toolCalls) {
        out.push(truncateToWidth(toolRow(t), width, "..."));
        if (expanded && t.result !== undefined) {
          for (const line of t.result.split("\n")) {
            for (const w of wrapLine(theme.fg("dim", indent + line), width)) out.push(w);
          }
        }
      }

      const responseText = agentText || (isPartial ? "" : "");
      if (responseText || isPartial) {
        out.push("Response:");
        if (expanded) {
          for (const line of responseText.split("\n")) {
            for (const w of wrapLine(indent + line, width)) out.push(w);
          }
        } else {
          const PREVIEW_LINES = 6;
          if (cache.width !== width) {
            const preview = truncateToVisualLines(responseText, PREVIEW_LINES, width - indent.length);
            cache.responseLines = preview.visualLines.map((l) => truncateToWidth(indent + l, width, "..."));
            cache.skipped = preview.skippedCount;
            cache.width = width;
          }
          if ((cache.skipped ?? 0) > 0) {
            out.push(truncateToWidth(ellipsisLine(cache.skipped!), width, "..."));
          }
          out.push(...(cache.responseLines ?? []));
        }
      }

      const status = statusLine();
      const totalSkipped = (cache.skipped ?? 0) + (cache.promptSkipped ?? 0);
      const expandHint = !expanded && totalSkipped > 0
        ? keyHint("app.tools.expand", `expand · ${totalSkipped} lines hidden`)
        : !expanded && toolCalls.some((t) => t.result !== undefined)
          ? keyHint("app.tools.expand", "expand for tool outputs")
          : "";
      const statusWithHint = [status, expandHint].filter(Boolean).join("  ");
      if (statusWithHint) out.push(truncateToWidth(statusWithHint, width, "..."));
      if (details.running && !details.backgroundJobId)
        out.push(truncateToWidth(theme.fg("dim", "Ctrl+Shift+B: move to background"), width, "..."));

      return out;
    },
  };
}
