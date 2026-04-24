/**
 * fast-subagent — In-process subagent delegation.
 *
 * Uses createAgentSession() to run subagents in the same process as pi —
 * no subprocess spawn, no cold-start overhead.
 *
 * Supports: single, parallel.
 * Agent .md files are compatible with pi-subagents frontmatter format.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { BackgroundJobManager } from "./background-job-manager.js";
import type { BackgroundHandleLike, BackgroundJobResult, BackgroundSubagentJob } from "./background-types.js";
import { Theme } from "@mariozechner/pi-coding-agent";
import { Key, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
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
import { type AgentConfig, agentNeedsExtensions, discoverAgents } from "./agents.js";

function formatTools(tools: AgentConfig["tools"]): string {
  if (tools === "all") return "all";
  if (tools === "none") return "none";
  return tools.join(", ");
}

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
let _onBgJobComplete: ((job: BackgroundSubagentJob) => void) | null = null;
let _setBgStatus: ((text: string | undefined) => void) | null = null;

function getAuth() {
  if (!_authStorage) _authStorage = AuthStorage.create();
  if (!_modelRegistry) _modelRegistry = ModelRegistry.create(_authStorage);
  return { authStorage: _authStorage, modelRegistry: _modelRegistry };
}

function getBgManager(): BackgroundJobManager {
  if (!_bgManager) _bgManager = new BackgroundJobManager({
    onJobComplete: (job) => _onBgJobComplete?.(job),
  });
  return _bgManager;
}

function refreshBgStatus(): void {
  const running = getBgManager().getRunningJobs();
  _setBgStatus?.(running.length > 0 ? `⧗ ${running.length} bg agent${running.length > 1 ? "s" : ""}` : undefined);
}

// ─── Foreground detach registry ───────────────────────────────────────────────

interface ForegroundDetachEntry {
  agentName: string;
  task: string;
  detach: () => string; // returns bg job id
}
const _fgJobs = new Map<string, ForegroundDetachEntry>();

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
  backgroundJobId?: string;
  toolCalls: ToolCallEntry[];
}

type OnUpdate = (partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void;

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function summarizeTask(task: string, max = 60): string {
  return task.length > max ? task.slice(0, max - 3) + "..." : task;
}

function formatBgJobSummary(job: BackgroundSubagentJob, now = Date.now()): string {
  const dur = job.completedAt ? formatDuration(job.completedAt - job.startedAt) : formatDuration(now - job.startedAt);
  return `${job.id} [${job.status}] ${job.agentName} · ${dur} · ${summarizeTask(job.task)}`;
}

function formatBgJobDetails(job: BackgroundSubagentJob, now = Date.now()): string {
  const dur = job.completedAt ? formatDuration(job.completedAt - job.startedAt) : formatDuration(now - job.startedAt);
  const lines = [`${job.id} [${job.status}] ${job.agentName} · ${dur}`, `Task: ${job.task}`];
  if (job.model) lines.push(`Model: ${job.model}`);
  if (job.status === "completed") lines.push(`\nResult:\n${job.resultSummary ?? "(no output)"}`);
  if (job.status === "failed") lines.push(`\nError: ${job.error ?? "(unknown)"}`);
  if (job.status === "cancelled") lines.push("\nCancelled.");
  if (job.status === "running") lines.push("\nStill running.");
  return lines.join("\n");
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

  // Build resource loader — no extensions/context files to keep subagent lean.
  // Agents can opt in to extensions via `extensions: true` in frontmatter, which
  // makes tools like web_search / fetch_content / mcp / etc. available to the
  // subagent (subject to the optional `tools:` allowlist below).
  const loaderOptions: DefaultResourceLoaderOptions = {
    cwd,
    agentDir,
    noExtensions: !agentNeedsExtensions(agent.tools),
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

  // Apply tools allowlist.
  //   "all"    → no restriction (everything registered stays active)
  //   "none"   → disable every tool
  //   string[] → explicit allowlist
  if (agent.tools === "none") {
    session.setActiveToolsByName([]);
  } else if (Array.isArray(agent.tools) && agent.tools.length > 0) {
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
        Type.Literal("detach"),
      ],
      { description: "'list'/'get' for agents, 'status' for bg jobs, 'poll'/'cancel' for a specific job, 'detach' to move a foreground job to background" },
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
  // ─── Status keys ────────────────────────────────────────────────────────────────────
  const BG_STATUS_KEY = "fast-subagent-bg";
  const FG_STATUS_KEY = "fast-subagent-fg";

  // ─── Background job lifecycle ─────────────────────────────────────────────────────
  _onBgJobComplete = (job) => {
    refreshBgStatus();
    const elapsed = job.completedAt ? ((job.completedAt - job.startedAt) / 1000).toFixed(1) : "?";
    const statusEmoji = job.status === "completed" ? "✓" : "✗";
    const taskPreview = job.task.length > 80 ? `${job.task.slice(0, 80)}…` : job.task;
    const output = job.status === "completed"
      ? (job.resultSummary ?? "(no output)")
      : `Error: ${job.error ?? "unknown"}`;
    const modelInfo = job.model ? ` · ${job.model}` : "";
    pi.sendUserMessage(
      [
        `**Background subagent ${statusEmoji}: ${job.id}** (${job.agentName}, ${elapsed}s${modelInfo})`,
        `> ${taskPreview}`,
        ``,
        output,
      ].join("\n"),
      { deliverAs: "followUp" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    _setBgStatus = (text) => ctx.ui.setStatus(BG_STATUS_KEY, text);
  });

  pi.on("session_shutdown", async () => {
    getBgManager().shutdown();
    _bgManager = null;
    _setBgStatus = null;
  });

  // ─── Ctrl+Shift+B — move foreground subagent to background ─────────────────────────
  pi.registerShortcut(Key.ctrlShift("b"), {
    description: "Move foreground subagent to background",
    handler: async (ctx) => {
      const entry = [..._fgJobs.values()][0];
      if (!entry) {
        ctx.ui.notify("No foreground subagent running.", "info");
        return;
      }
      try {
        const bgJobId = entry.detach();
        ctx.ui.notify(
          `Moved ${entry.agentName} to background as ${bgJobId}. Completion will be announced automatically.`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  // ─── /agent slash command ─────────────────────────────────────────────────
  pi.registerCommand("fast-subagent:agent", {
    description: "List available subagents. Usage: /fast-subagent:agent [name] — show details for a specific agent.",
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
          `Tools: ${formatTools(agent.tools)}`,
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
      lines.push("Tip: /fast-subagent:agent <name> for details · Add .md files to .pi/agents/ to create new agents");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── /bg slash command ────────────────────────────────────────────────────
  pi.registerCommand("fast-subagent:bg", {
    description: "Move a running foreground subagent to background. Shortcut: Ctrl+Shift+B. Usage: /fast-subagent:bg [fg-job-id] — omit ID to list active foreground jobs.",
    getArgumentCompletions(_prefix: string) {
      return [..._fgJobs.keys()].map((id) => ({ value: id, label: id }));
    },
    async handler(args: string, ctx) {
      const id = args.trim();
      if (!id) {
        if (_fgJobs.size === 0) {
          ctx.ui.notify("No active foreground subagent jobs.", "info");
          return;
        }
        const lines = ["Active foreground jobs (use /fast-subagent:bg <id> to detach):"];
        for (const [fgId, entry] of _fgJobs) {
          lines.push(`  ${fgId}  ${entry.agentName}: ${summarizeTask(entry.task)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const entry = _fgJobs.get(id);
      if (!entry) {
        ctx.ui.notify(`Foreground job "${id}" not found (already done or invalid).`, "warning");
        return;
      }
      const bgJobId = entry.detach();
      ctx.ui.notify(
        `Moved to background: ${bgJobId}\nTo check status, ask me to poll job ${bgJobId}.`,
        "info",
      );
    },
  });

  // ─── /bg-status slash command ─────────────────────────────────────────────
  pi.registerCommand("fast-subagent:bg-status", {
    description: "Show active background subagents. Usage: /fast-subagent:bg-status [sa-job-id] — omit ID to open selector.",
    getArgumentCompletions(prefix: string) {
      return getBgManager().getAllJobs()
        .filter((job) => job.id.startsWith(prefix))
        .map((job) => ({ value: job.id, label: formatBgJobSummary(job) }));
    },
    async handler(args: string, ctx) {
      const id = args.trim();
      if (id) {
        const job = getBgManager().getJob(id);
        if (!job) {
          ctx.ui.notify(`Background job "${id}" not found.`, "warning");
          return;
        }
        ctx.ui.notify(formatBgJobDetails(job), "info");
        return;
      }

      const jobs = getBgManager().getRunningJobs().sort((a, b) => b.startedAt - a.startedAt);
      if (jobs.length === 0) {
        ctx.ui.notify("No active background subagent jobs.", "info");
        return;
      }

      const options = jobs.map((job) => formatBgJobSummary(job));
      const selected = await ctx.ui.select("Active background subagents", options);
      if (!selected) return;

      const jobId = selected.split(" ")[0] ?? "";
      const job = getBgManager().getJob(jobId);
      if (!job) {
        ctx.ui.notify(`Background job "${jobId}" not found.`, "warning");
        return;
      }
      ctx.ui.notify(formatBgJobDetails(job), "info");
    },
  });

  // ─── /bg-cancel slash command ─────────────────────────────────────────────
  pi.registerCommand("fast-subagent:bg-cancel", {
    description: "Cancel running background subagent. Usage: /fast-subagent:bg-cancel [sa-job-id] — omit ID to choose with arrow keys.",
    getArgumentCompletions(prefix: string) {
      return getBgManager().getRunningJobs()
        .filter((job) => job.id.startsWith(prefix))
        .map((job) => ({ value: job.id, label: formatBgJobSummary(job) }));
    },
    async handler(args: string, ctx) {
      let jobId = args.trim();

      if (!jobId) {
        const jobs = getBgManager().getRunningJobs().sort((a, b) => b.startedAt - a.startedAt);
        if (jobs.length === 0) {
          ctx.ui.notify("No running background subagent jobs to cancel.", "info");
          return;
        }

        const options = jobs.map((job) => formatBgJobSummary(job));
        const selected = await ctx.ui.select("Cancel background subagent", options);
        if (!selected) return;
        jobId = selected.split(" ")[0] ?? "";
      }

      const job = getBgManager().getJob(jobId);
      if (!job) {
        ctx.ui.notify(`Background job "${jobId}" not found.`, "warning");
        return;
      }
      if (job.status !== "running") {
        ctx.ui.notify(`Background job "${jobId}" already ${job.status}.`, "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Cancel background subagent?",
        `${formatBgJobSummary(job)}\n\nTask:\n${job.task}`,
      );
      if (!confirmed) return;

      const result = getBgManager().cancel(jobId);
      const msg = result === "cancelled" ? `Background job "${jobId}" cancelled.`
        : result === "already_done" ? `Background job "${jobId}" already completed.`
        : `Background job "${jobId}" not found.`;
      ctx.ui.notify(msg, result === "cancelled" ? "info" : "warning");
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
        if (details.backgroundJobId) return `moved to background · ${details.backgroundJobId}`;
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

          // ── Prompt ────────────────────────────────────────────────────
          if (details.task) {
            out.push("Prompt:");
            if (expanded) {
              for (const line of details.task.split("\n")) {
                for (const w of wrapLine(indent + line, width)) out.push(w);
              }
            } else {
              // Up to 8 visual lines in collapsed mode
              const PROMPT_PREVIEW_LINES = 8;
              if (cache.width !== width || cache.promptLines === undefined) {
                const preview = truncateToVisualLines(details.task, PROMPT_PREVIEW_LINES, width - indent.length);
                cache.promptLines = preview.visualLines.map((l) => truncateToWidth(indent + l, width, "..."));
                cache.promptSkipped = preview.skippedCount;
              }
              out.push(...cache.promptLines);
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
          `**Tools:** ${formatTools(agent.tools)}`,
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

      // ── Foreground → background detach ────────────────────────────────────────
      if (params.action === "detach") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId (fg_xxxxx) to detach." }] };
        const fgEntry = _fgJobs.get(params.jobId);
        if (!fgEntry) return { content: [{ type: "text", text: `Foreground job "${params.jobId}" not found (already completed or invalid).` }] };
        const bgJobId = fgEntry.detach();
        return { content: [{ type: "text", text: `Moved to background: ${bgJobId}\nTo check status, ask me to poll job ${bgJobId}.` }] };
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
          return { content: [{ type: "text", text: `Background job started: ${jobId}\nTo check status, ask me to poll job ${jobId}.` }] };
        }

        // Foreground run with detach support
        const fgId = `fg_${randomUUID().slice(0, 8)}`;
        const agentAbort = new AbortController();
        const forwardAbort = () => agentAbort.abort();
        signal?.addEventListener("abort", forwardAbort, { once: true });

        let detachResolveFn: ((bgJobId: string) => void) | null = null;
        const detachPromise = new Promise<string>((resolve) => { detachResolveFn = resolve; });

        // Wrap onUpdate so detach can stop forwarding updates to the parent
        // agent's listener (which becomes invalid once execute() returns).
        let forwardUpdates = true;
        const wrappedOnUpdate: OnUpdate | undefined = onUpdate
          ? (partial) => { if (forwardUpdates) onUpdate(partial); }
          : undefined;

        const agentRunPromise: Promise<RunResult> = runAgent(
          agent, params.task, cwd, params.model, agentAbort.signal, wrappedOnUpdate,
        );

        // Derived promise for the bg manager (used only if we detach)
        const bgResultPromise: Promise<BackgroundJobResult> = agentRunPromise
          .then((r) => ({ summary: r.output, exitCode: r.exitCode, error: r.error, model: r.model }));

        _fgJobs.set(fgId, {
          agentName: agent.name,
          task: params.task,
          detach: () => {
            forwardUpdates = false;
            signal?.removeEventListener("abort", forwardAbort);
            const bgHandle: BackgroundHandleLike = { abort: () => agentAbort.abort() };
            const bgJobId = getBgManager().adoptHandle(agent.name, params.task, cwd, bgHandle, bgResultPromise);
            refreshBgStatus();
            detachResolveFn?.(bgJobId);
            return bgJobId;
          },
        });

        ctx.ui.setStatus(FG_STATUS_KEY, `${agent.name} running · Ctrl+Shift+B to move to background`);

        let runResult: RunResult | null = null;
        const outcome = await Promise.race([
          agentRunPromise.then((r) => { runResult = r; return "done" as const; }),
          detachPromise.then(() => "detached" as const),
        ]).finally(() => {
          _fgJobs.delete(fgId);
          signal?.removeEventListener("abort", forwardAbort);
          ctx.ui.setStatus(FG_STATUS_KEY, undefined);
        });

        if (outcome === "detached") {
          const bgJobId = await detachPromise; // already resolved — instant
          return {
            content: [{ type: "text", text: `Moved to background: ${bgJobId}. Completion will be announced automatically.` }],
            details: {
              task: params.task,
              usage: { input: 0, output: 0, cost: 0, turns: 0 },
              running: false,
              backgroundJobId: bgJobId,
              toolCalls: [],
            } satisfies SubagentDetails,
          };
        }

        const result = runResult!;
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
