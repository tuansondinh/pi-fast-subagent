/**
 * fast-subagent — In-process subagent delegation.
 *
 * Uses createAgentSession() to run subagents in the same process as pi —
 * no subprocess spawn, no cold-start overhead.
 *
 * Supports: single, parallel.
 * Agent .md files are compatible with pi-subagents frontmatter format.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { BackgroundJobManager } from "./background-job-manager.js";
import type { BackgroundHandleLike, BackgroundJobResult } from "./background-types.js";
import { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { truncateToVisualLines, keyHint } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";

// ─── Tool arg summarizer (compact one-liner per tool call) ─────────────────────

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const cwd = process.cwd();
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p.replace(/^\/Users\/[^/]+\/[^/]+\//, "");
}

function summarizeToolArgs(toolName: unknown, toolInput: unknown): string {
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

// ─── Shared auth (created once, reused across calls) ─────────────────────────

let _authStorage: ReturnType<typeof AuthStorage.create> | null = null;
let _modelRegistry: ReturnType<typeof ModelRegistry.create> | null = null;
let _bgManager: BackgroundJobManager | null = null;

function getAuth() {
  if (!_authStorage) _authStorage = AuthStorage.create();
  if (!_modelRegistry) _modelRegistry = ModelRegistry.create(_authStorage);
  return { authStorage: _authStorage, modelRegistry: _modelRegistry };
}

function getBgManager(): BackgroundJobManager {
  if (!_bgManager) _bgManager = new BackgroundJobManager();
  return _bgManager;
}

// ─── In-process runner ───────────────────────────────────────────────────────

const MAX_DEPTH = 2;
const DEPTH_ENV = "PI_FAST_SUBAGENT_DEPTH";

interface ToolCallEntry {
  id: string;
  name: string;
  argSummary: string;
  result?: string;
  isError?: boolean;
  durMs?: number;
}

interface RunResult {
  output: string;
  exitCode: number;
  error?: string;
  model?: string;
  toolCalls: ToolCallEntry[];
  usage: { input: number; output: number; cost: number; turns: number };
}

interface AgentRowStatus {
  name: string;
  taskSummary: string;
  status: "pending" | "running" | "done" | "error";
  durMs?: number;
  toolCalls?: ToolCallEntry[];
  responseText?: string;
}

interface SubagentDetails {
  mode?: "single" | "parallel";
  task?: string;
  // parallel
  parallelAgents?: AgentRowStatus[];
  usage: RunResult["usage"];
  running: boolean;
  elapsedMs?: number;
  model?: string;
  toolCalls: ToolCallEntry[];
}

type OnUpdate = (partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void;

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

// Module-level depth counter — avoids process.env race conditions in parallel mode
let _currentDepth = 0;

async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  modelOverride: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  parentDepth?: number,
): Promise<RunResult> {
  const depth = parentDepth ?? _currentDepth;
  if (depth >= MAX_DEPTH) {
    return {
      output: "",
      exitCode: 1,
      error: `Max subagent depth (${MAX_DEPTH}) exceeded. Increase PI_FAST_SUBAGENT_DEPTH env to allow deeper nesting.`,
      toolCalls: [],
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
  }

  const { authStorage, modelRegistry } = getAuth();
  const agentDir = getAgentDir();

  // Build resource loader — no extensions/context files to keep subagent lean
  const loaderOptions: DefaultResourceLoaderOptions = {
    cwd,
    agentDir,
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
  };
  if (agent.systemPrompt) {
    // Replace pi's base system prompt with the agent's own prompt
    loaderOptions.systemPromptOverride = () => agent.systemPrompt;
  }

  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
  });

  // Resolve and apply model
  const modelStr = modelOverride ?? agent.model;
  if (modelStr) {
    const [provider, ...rest] = modelStr.split("/");
    const modelId = rest.join("/");
    if (provider && modelId) {
      const model = modelRegistry.find(provider, modelId);
      if (model) await session.setModel(model);
    }
  }

  // Restrict tools if agent specifies them
  if (agent.tools && agent.tools.length > 0) {
    session.setActiveToolsByName(agent.tools);
  }

  // Track output and usage
  const usage = { input: 0, output: 0, cost: 0, turns: 0 };
  let lastOutput = "";
  let currentDelta = "";
  let detectedModel: string | undefined;
  const startedAt = Date.now();
  const configuredModel = modelOverride ?? agent.model;
  const toolCalls: ToolCallEntry[] = [];
  const toolStartTimes = new Map<string, number>();

  let done = false;

  function emitUpdate(): void {
    if (done) return;
    onUpdate?.({
      content: [{ type: "text", text: currentDelta || lastOutput || "" }],
      details: {
        task,
        usage,
        running: true,
        elapsedMs: Date.now() - startedAt,
        model: detectedModel ?? configuredModel,
        toolCalls: [...toolCalls],
      } satisfies SubagentDetails,
    });
  }

  emitUpdate();

  const heartbeat = setInterval(emitUpdate, 1000);

  const unsubscribe = session.subscribe((event: any) => {
    // Stream tool execution events
    if (event.type === "tool_execution_start") {
      toolStartTimes.set(event.toolCallId, Date.now());
      toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        argSummary: summarizeToolArgs(event.toolName, event.args),
      });
      emitUpdate();
      return;
    }

    if (event.type === "tool_execution_end") {
      const startedAtTool = toolStartTimes.get(event.toolCallId);
      toolStartTimes.delete(event.toolCallId);
      const resultText: string = (event.result?.content ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text as string)
        .join("\n");
      let entry: ToolCallEntry | undefined;
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        if (toolCalls[i]!.id === event.toolCallId) { entry = toolCalls[i]; break; }
      }
      if (!entry) {
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          if (toolCalls[i]!.name === event.toolName && toolCalls[i]!.result === undefined) { entry = toolCalls[i]; break; }
        }
      }
      if (entry) {
        entry.result = resultText;
        entry.isError = event.isError;
        entry.durMs = startedAtTool != null ? Date.now() - startedAtTool : undefined;
      }
      emitUpdate();
      return;
    }

    // Stream text deltas live to the UI
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (e?.type === "text_delta" && e.delta) {
        currentDelta += e.delta;
        emitUpdate();
      }
      return;
    }

    if (event.type !== "message_end" || !event.message) return;
    const msg = event.message;
    if (msg.role !== "assistant") return; // usage/model only tracked for assistant turns

    usage.turns++;
    const u = msg.usage;
    if (u) {
      usage.input += u.input ?? 0;
      usage.output += u.output ?? 0;
      usage.cost += u.cost?.total ?? 0;
    }
    if (msg.model) detectedModel = msg.model;

    // Extract last text content
    for (const part of msg.content ?? []) {
      if (part.type === "text") {
        lastOutput = part.text;
        break;
      }
    }
    // Reset delta accumulator for next turn
    currentDelta = "";

    onUpdate?.({
      content: [{ type: "text", text: lastOutput || "(running...)" }],
      details: {
        agent: agent.name,
        usage,
        running: true,
        elapsedMs: Date.now() - startedAt,
        model: detectedModel ?? configuredModel,
      },
    });
  });

  // Propagate depth to nested calls — use module counter (safe for parallel) + env for subprocess compat
  const prevEnvDepth = process.env[DEPTH_ENV];
  process.env[DEPTH_ENV] = String(depth + 1);
  _currentDepth = depth + 1;

  let exitCode = 0;
  let error: string | undefined;

  try {
    if (signal?.aborted) throw new Error("Aborted");

    const onAbort = () => void session.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(task);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } catch (e) {
    exitCode = 1;
    error = signal?.aborted ? "Aborted" : e instanceof Error ? e.message : String(e);
  } finally {
    done = true;
    clearInterval(heartbeat);
    unsubscribe();
    session.dispose();
    if (prevEnvDepth === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = prevEnvDepth;
    _currentDepth = depth;
  }

  return { output: lastOutput, exitCode, error, model: detectedModel, toolCalls, usage };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, i: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function formatUsage(usage: RunResult["usage"], model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function getFinalText(r: RunResult): string {
  if (r.exitCode !== 0) return `Error: ${r.error ?? r.output ?? "(no output)"}`;
  return r.output || "(no output)";
}

// ─── Tool schemas ─────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  model: Type.Optional(Type.String({ description: "Model override (provider/model)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  count: Type.Optional(Type.Number({ description: "Repeat this task N times" })),
});

const SubagentParams = Type.Object({
  // Single mode
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task (single mode)" })),
  model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),

  // Parallel mode
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: "Array of {agent, task} for parallel execution. Use count to repeat one task.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({ description: "Max parallel concurrency (default: 4)", default: 4 }),
  ),

  // Background
  background: Type.Optional(Type.Boolean({ description: "Run in background, returns job ID immediately" })),
  jobId: Type.Optional(Type.String({ description: "Job ID for poll/cancel" })),

  // Management
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("get"),
        Type.Literal("status"),
        Type.Literal("poll"),
        Type.Literal("cancel"),
      ],
      { description: "'list'/'get' for agents, 'status' for bg jobs, 'poll'/'cancel' for a specific job" },
    ),
  ),
  agentScope: Type.Optional(
    Type.Union(
      [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
      { description: "Agent scope filter", default: "both" },
    ),
  ),
});

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ─── /agent slash command ─────────────────────────────────────────────────
  pi.registerCommand("agent", {
    description: "List available subagents. Usage: /agent [name] — show details for a specific agent.",
    getArgumentCompletions(prefix: string) {
      const agents = discoverAgents(process.cwd());
      return agents
        .filter((a) => a.name.startsWith(prefix))
        .map((a) => ({ value: a.name, label: a.name, description: a.description }));
    },
    async handler(args: string, ctx) {
      const agents = discoverAgents(ctx.cwd);
      const name = args.trim();

      if (name) {
        const agent = agents.find((a) => a.name === name);
        if (!agent) {
          const list = agents.map((a) => a.name).join(", ") || "none";
          ctx.ui.notify(`Unknown agent "${name}". Available: ${list}`, "warning");
          return;
        }
        const lines = [
          `## ${agent.name} [${agent.source}]`,
          `File: ${agent.filePath}`,
          `Description: ${agent.description}`,
          agent.model ? `Model: ${agent.model}` : "",
          agent.tools ? `Tools: ${agent.tools.join(", ")}` : "",
          agent.systemPrompt ? `\nSystem prompt:\n${agent.systemPrompt}` : "",
        ].filter(Boolean).join("\n");
        ctx.ui.notify(lines, "info");
        return;
      }

      if (agents.length === 0) {
        ctx.ui.notify(
          "No agents found.\n" +
          "Add .md files to:\n" +
          "  ~/.pi/agent/agents/   (user-level)\n" +
          "  .pi/agents/           (project-level)\n" +
          "\nFrontmatter required: name, description. Optional: model, tools.",
          "info"
        );
        return;
      }

      const userAgents = agents.filter((a) => a.source === "user");
      const projectAgents = agents.filter((a) => a.source === "project");

      const lines: string[] = [`Agents (${agents.length}):`];
      if (projectAgents.length) {
        lines.push("\nProject (.pi/agents/):");
        for (const a of projectAgents) {
          lines.push(`  ${a.name}${a.model ? ` [${a.model}]` : ""} — ${a.description}`);
        }
      }
      if (userAgents.length) {
        lines.push("\nUser (~/.pi/agent/agents/):");
        for (const a of userAgents) {
          lines.push(`  ${a.name}${a.model ? ` [${a.model}]` : ""} — ${a.description}`);
        }
      }
      lines.push("");
      lines.push("Tip: /agent <name> for details · Add .md files to .pi/agents/ to create new agents");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents. Runs IN-PROCESS — no subprocess cold-start overhead.",
      "Modes: single ({ agent, task }), parallel ({ tasks: [...] }).",
      "Agents defined as .md files in ~/.pi/agent/agents/ (user) or .pi/agents/ (project).",
      "Use { action: 'list' } to discover available agents.",
    ].join(" "),
    parameters: SubagentParams,

    renderResult(result: AgentToolResult<unknown>, { isPartial, expanded }: ToolRenderResultOptions, theme: Theme) {
      const agentText = result.content?.[0]?.type === "text" ? (result.content[0] as any).text as string : "";
      const details = (result.details ?? {}) as SubagentDetails;
      const toolCalls = details.toolCalls ?? [];

      // ── Parallel / Chain mode renders ────────────────────────────────
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
              const mark = a.status === "pending" ? theme.fg("dim", "⋅") : a.status === "running" ? theme.fg("dim", "→") : a.status === "done" ? `✓${dur}` : `✗${dur}`;

              if (expanded) {
                // Full solo-style block per agent
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
                // Collapsed: compact one-liner
                const row = `  [${a.name}] ${mark}  ${a.taskSummary}`;
                out.push(truncateToWidth(row, width, "..."));
                // Show tool call rows compactly
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
            return out;
          },
        };
      }

      function statusLine(): string {
        if (details.running) {
          const parts: string[] = ["running"];
          if (details.usage?.turns) parts.push(`${details.usage.turns} turn${details.usage.turns > 1 ? "s" : ""}`);
          if (details.elapsedMs != null) parts.push(formatDuration(details.elapsedMs));
          if (details.model) parts.push(details.model);
          return parts.join(" · ");
        }
        return formatUsage(details.usage ?? { input: 0, output: 0, cost: 0, turns: 0 }, details.model);
      }

      // Name(arg) ✓ 0.3s  or  Name(arg)  (dim, still running)
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

      const cache: { width?: number; responseLines?: string[]; skipped?: number } = {};

      return {
        invalidate() { cache.width = undefined; },
        render(width: number): string[] {
          const out: string[] = [];
          const indent = "  ";

          // ── Prompt ────────────────────────────────────────────────────
          if (details.task) {
            out.push("Prompt:");
            const taskLines = details.task.split("\n");
            if (expanded) {
              for (const line of taskLines) {
                for (const w of wrapLine(indent + line, width)) out.push(w);
              }
            } else {
              // Single truncated line in collapsed
              const oneLiner = taskLines[0] ?? "";
              out.push(truncateToWidth(indent + oneLiner, width, "..."));
            }
          }

          // ── Tool calls ─────────────────────────────────────────────
          for (const t of toolCalls) {
            out.push(truncateToWidth(toolRow(t), width, "..."));
            if (expanded && t.result !== undefined) {
              for (const line of t.result.split("\n")) {
                for (const w of wrapLine(theme.fg("dim", indent + line), width)) out.push(w);
              }
            }
          }

          // ── Response ────────────────────────────────────────────
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
              out.push(...(cache.responseLines ?? []));
            }
          }

          // ── Status ───────────────────────────────────────────────
          const status = statusLine();
          const expandHint = !expanded && (cache.skipped ?? 0) > 0
            ? keyHint("app.tools.expand", `expand · ${cache.skipped} lines hidden`)
            : !expanded && toolCalls.some((t) => t.result !== undefined)
              ? keyHint("app.tools.expand", "expand for tool outputs")
              : "";
          const statusWithHint = [status, expandHint].filter(Boolean).join("  ");
          if (statusWithHint) out.push(truncateToWidth(statusWithHint, width, "..."));

          return out;
        },
      };
    },

    async execute(_id: string, params: Record<string, any>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<unknown> | undefined, ctx: ExtensionContext): Promise<any> {
      const cwd = params.cwd ?? ctx.cwd;
      const agents = discoverAgents(cwd);

      const findAgent = (name: string): { agent?: AgentConfig; error?: string } => {
        const found = agents.find((a) => a.name === name);
        if (!found) {
          const list = agents.map((a) => `"${a.name}"`).join(", ") || "none";
          return { error: `Unknown agent: "${name}". Available: ${list}` };
        }
        return { agent: found };
      };

      // ── Management: list ──────────────────────────────────────────────────────
      if (params.action === "list" || (!params.action && !params.agent && !params.tasks)) {
        if (agents.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No agents found. Add .md files to ~/.pi/agent/agents/ or .pi/agents/.",
            }],
          };
        }
        const lines = agents.map(
          (a) => `${a.name} [${a.source}]${a.model ? ` · ${a.model}` : ""}: ${a.description}`,
        );
        return { content: [{ type: "text", text: `Agents (${agents.length}):\n${lines.join("\n")}` }] };
      }

      // ── Management: get ───────────────────────────────────────────────────────
      if (params.action === "get" && params.agent) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };
        const info = [
          `## ${agent.name} [${agent.source}]`,
          `**Description:** ${agent.description}`,
          agent.model ? `**Model:** ${agent.model}` : null,
          agent.tools ? `**Tools:** ${agent.tools.join(", ")}` : null,
          agent.systemPrompt ? `\n**System prompt:**\n${agent.systemPrompt}` : null,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: info }] };
      }

      // ── Background status ───────────────────────────────────────────────────
      if (params.action === "status") {
        const jobs = getBgManager().getAllJobs();
        if (jobs.length === 0) return { content: [{ type: "text", text: "No background jobs." }] };
        const lines = jobs.map((j) => {
          const dur = j.completedAt ? formatDuration(j.completedAt - j.startedAt) : formatDuration(Date.now() - j.startedAt);
          return `${j.id} [${j.status}] ${j.agentName} · ${dur} · ${j.task.length > 50 ? j.task.slice(0, 47) + "..." : j.task}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── Background poll ────────────────────────────────────────────────────────
      if (params.action === "poll") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId to poll." }] };
        const job = getBgManager().getJob(params.jobId);
        if (!job) return { content: [{ type: "text", text: `Job ${params.jobId} not found (completed and evicted, or invalid).` }] };
        const dur = job.completedAt ? formatDuration(job.completedAt - job.startedAt) : formatDuration(Date.now() - job.startedAt);
        const parts = [`${job.id} [${job.status}] ${job.agentName} · ${dur}`, `Task: ${job.task}`];
        if (job.status === "completed") parts.push(`\nResult:\n${job.resultSummary ?? "(no output)"}`);
        if (job.status === "failed") parts.push(`\nError: ${job.error ?? "(unknown)"}`);
        if (job.status === "running") parts.push("Still running — poll again later.");
        return { content: [{ type: "text", text: parts.join("\n") }] };
      }

      // ── Background cancel ──────────────────────────────────────────────────────
      if (params.action === "cancel") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId to cancel." }] };
        const result = getBgManager().cancel(params.jobId);
        const msg = result === "cancelled" ? `Job ${params.jobId} cancelled.`
          : result === "already_done" ? `Job ${params.jobId} already completed.`
          : `Job ${params.jobId} not found.`;
        return { content: [{ type: "text", text: msg }] };
      }

      // ── Single mode ───────────────────────────────────────────────────────────
      if (params.agent && params.task) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };

        // Background dispatch — fire and forget
        if (params.background) {
          const bgAbort = new AbortController();
          const handle: BackgroundHandleLike = { abort: () => bgAbort.abort() };
          const resultPromise: Promise<BackgroundJobResult> = runAgent(
            agent, params.task, cwd, params.model, bgAbort.signal, undefined
          ).then((r) => ({ summary: r.output, exitCode: r.exitCode, error: r.error, model: r.model }));
          const jobId = getBgManager().adoptHandle(agent.name, params.task, cwd, handle, resultPromise);
          return { content: [{ type: "text", text: `Background job started: ${jobId}\nCheck progress: subagent({ action: "poll", jobId: "${jobId}" })` }] };
        }

        const result = await runAgent(
          agent,
          params.task,
          cwd,
          params.model,
          signal,
          onUpdate,
        );

        return {
          content: [{ type: "text", text: getFinalText(result) }],
          details: {
            task: params.task,
            usage: result.usage,
            running: false,
            elapsedMs: undefined,
            model: result.model,
            toolCalls: result.toolCalls,
          } satisfies SubagentDetails,
          isError: result.exitCode !== 0,
        };
      }

      // ── Parallel mode ─────────────────────────────────────────────
      if (params.tasks && params.tasks.length > 0) {
        const expanded: Array<{ agent: string; task: string; model?: string; cwd?: string }> = [];
        for (const t of params.tasks) {
          const n = t.count ?? 1;
          for (let i = 0; i < n; i++) expanded.push({ agent: t.agent, task: t.task, model: t.model, cwd: t.cwd });
        }

        const concurrency = params.concurrency ?? 4;
        const emptyUsage = { input: 0, output: 0, cost: 0, turns: 0 };
        const parallelAgents: AgentRowStatus[] = expanded.map((t) => ({
          name: t.agent,
          taskSummary: t.task.length > 60 ? t.task.slice(0, 57) + "..." : t.task,
          status: "pending" as const,
        }));
        let runningUsage = { ...emptyUsage };

        const emitParallel = (running: boolean) => onUpdate?.({
          content: [{ type: "text", text: "" }],
          details: { mode: "parallel", parallelAgents: [...parallelAgents], usage: { ...runningUsage }, running, toolCalls: [] } satisfies SubagentDetails,
        });

        emitParallel(true);

        const parentDepth = _currentDepth;
        const allResults = await mapConcurrent(expanded, concurrency, async (t, i) => {
          parallelAgents[i]!.status = "running";
          emitParallel(true);
          const { agent, error } = findAgent(t.agent);
          if (error || !agent) {
            parallelAgents[i]!.status = "error";
            emitParallel(true);
            return { agentName: t.agent, output: "", exitCode: 1, error, model: undefined, toolCalls: [] as ToolCallEntry[], usage: emptyUsage };
          }
          const agentStart = Date.now();
          const agentOnUpdate: OnUpdate = (partial) => {
            const d = partial.details as SubagentDetails | undefined;
            parallelAgents[i]!.toolCalls = d?.toolCalls ? [...d.toolCalls] : parallelAgents[i]!.toolCalls;
            parallelAgents[i]!.responseText = (partial.content?.[0] as any)?.text || parallelAgents[i]!.responseText;
            emitParallel(true);
          };
          const result = await runAgent(agent, t.task, t.cwd ?? cwd, t.model, signal, agentOnUpdate, parentDepth);
          parallelAgents[i]!.status = result.exitCode === 0 ? "done" : "error";
          parallelAgents[i]!.durMs = Date.now() - agentStart;
          parallelAgents[i]!.toolCalls = result.toolCalls;
          parallelAgents[i]!.responseText = result.output;
          runningUsage = { input: runningUsage.input + result.usage.input, output: runningUsage.output + result.usage.output, cost: runningUsage.cost + result.usage.cost, turns: runningUsage.turns + result.usage.turns };
          emitParallel(true);
          return { ...result, agentName: t.agent, toolCalls: result.toolCalls ?? [] };
        });

        const totalUsage = allResults.reduce(
          (acc, r) => ({ input: acc.input + r.usage.input, output: acc.output + r.usage.output, cost: acc.cost + r.usage.cost, turns: acc.turns + r.usage.turns }),
          emptyUsage,
        );
        const outputs = allResults.map((r) => `[${r.agentName}] ${r.exitCode === 0 ? "✓" : "✗"}\n${getFinalText(r)}`).join("\n\n");

        return {
          content: [{ type: "text", text: outputs }],
          details: { mode: "parallel", parallelAgents, usage: totalUsage, running: false, toolCalls: [] } satisfies SubagentDetails,
        };
      }

      // ── Chain mode ────────────────────────────────────────────
      // Shouldn't reach here
      return { content: [{ type: "text", text: "Provide agent+task or tasks array." }] };
    },
  });
}
