/**
 * fast-subagent — In-process subagent delegation.
 *
 * Uses createAgentSession() to run subagents in the same process as pi —
 * no subprocess spawn, no cold-start overhead.
 *
 * Drop-in replacement for pi-subagents subprocess mode.
 * Supports: single, parallel, chain.
 * Agent .md files are compatible with pi-subagents frontmatter format.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";

// ─── Shared auth (created once, reused across calls) ─────────────────────────

let _authStorage: ReturnType<typeof AuthStorage.create> | null = null;
let _modelRegistry: ReturnType<typeof ModelRegistry.create> | null = null;

function getAuth() {
  if (!_authStorage) _authStorage = AuthStorage.create();
  if (!_modelRegistry) _modelRegistry = ModelRegistry.create(_authStorage);
  return { authStorage: _authStorage, modelRegistry: _modelRegistry };
}

// ─── In-process runner ───────────────────────────────────────────────────────

const MAX_DEPTH = 2;
const DEPTH_ENV = "PI_FAST_SUBAGENT_DEPTH";

interface RunResult {
  output: string;
  exitCode: number;
  error?: string;
  model?: string;
  usage: { input: number; output: number; cost: number; turns: number };
}

type OnUpdate = (partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void;

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  modelOverride: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
): Promise<RunResult> {
  const depth = parseInt(process.env[DEPTH_ENV] ?? "0", 10);
  if (depth >= MAX_DEPTH) {
    return {
      output: "",
      exitCode: 1,
      error: `Max subagent depth (${MAX_DEPTH}) exceeded. Increase PI_FAST_SUBAGENT_DEPTH env to allow deeper nesting.`,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
  }

  const { authStorage, modelRegistry } = getAuth();
  const agentDir = getAgentDir();

  // Build resource loader — no extensions/context files to keep subagent lean
  const loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
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

  onUpdate?.({
    content: [{ type: "text", text: "Starting subagent..." }],
    details: {
      agent: agent.name,
      usage,
      running: true,
      elapsedMs: 0,
      model: configuredModel,
    },
  });

  const heartbeat = setInterval(() => {
    onUpdate?.({
      content: [{ type: "text", text: currentDelta || lastOutput || "Running..." }],
      details: {
        agent: agent.name,
        usage,
        running: true,
        elapsedMs: Date.now() - startedAt,
        model: detectedModel ?? configuredModel,
      },
    });
  }, 1000);

  const unsubscribe = session.subscribe((event: any) => {
    // Stream text deltas live to the UI
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (e?.type === "text_delta" && e.delta) {
        currentDelta += e.delta;
        onUpdate?.({
          content: [{ type: "text", text: currentDelta }],
          details: {
            agent: agent.name,
            usage,
            running: true,
            elapsedMs: Date.now() - startedAt,
            model: detectedModel ?? configuredModel,
          },
        });
      }
      return;
    }

    if (event.type !== "message_end" || !event.message) return;
    const msg = event.message;
    if (msg.role !== "assistant") return;

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

  // Propagate depth to any nested fast-subagent calls
  const prevDepth = process.env[DEPTH_ENV];
  process.env[DEPTH_ENV] = String(depth + 1);

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
    clearInterval(heartbeat);
    unsubscribe();
    session.dispose();
    if (prevDepth === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = prevDepth;
  }

  return { output: lastOutput, exitCode, error, model: detectedModel, usage };
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

const ChainItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.Optional(
    Type.String({
      description:
        "Task template. Supports {previous} (output from prior step) and {task} (first step task). " +
        "Defaults to {previous} for steps 2+.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (provider/model)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
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

  // Chain mode
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Sequential chain. Use {previous} in task to receive prior step output.",
    }),
  ),

  // Management
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("get"),
      ],
      { description: "'list' to discover agents, 'get' to inspect one agent" },
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
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents. Runs IN-PROCESS — no subprocess cold-start overhead.",
      "Modes: single ({ agent, task }), parallel ({ tasks: [...] }), chain ({ chain: [...] }).",
      "Chain supports {task} (first step task) and {previous} (prior step output) template vars.",
      "Agents defined as .md files in ~/.pi/agent/agents/ (user) or .pi/agents/ (project).",
      "Use { action: 'list' } to discover available agents.",
    ].join(" "),
    parameters: SubagentParams,

    renderResult(result, { isPartial }, theme) {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const details = (result.details ?? {}) as {
        usage?: RunResult["usage"];
        running?: boolean;
        elapsedMs?: number;
        model?: string;
      };

      const statusLines: string[] = [];
      if (details.running) {
        const statusParts: string[] = ["running"];
        if (details.usage?.turns) statusParts.push(`${details.usage.turns} turn${details.usage.turns > 1 ? "s" : ""}`);
        if (details.elapsedMs !== undefined) statusParts.push(formatDuration(details.elapsedMs));
        if (details.model) statusParts.push(details.model);
        statusLines.push(statusParts.join(" · "));
      } else if (details.usage) {
        const usageStr = formatUsage(details.usage, details.model);
        if (usageStr) statusLines.push(usageStr);
      }

      // Apply dim per-line rather than across the whole block to avoid ANSI codes spanning
      // newlines, which confuses wrapTextWithAnsi ANSI state tracking.
      const textLines = (text || (isPartial ? "Running..." : "")).split("\n");
      const styledLines = isPartial
        ? [...textLines.map((l) => theme.fg("dim", l)), ...statusLines]
        : [...textLines, ...statusLines];

      // Use a custom component with truncateToWidth per line instead of Text + wrapTextWithAnsi.
      // visibleWidth (used by wrapTextWithAnsi) undercounts wide chars (emoji/CJK), causing the
      // TUI to crash with "Rendered line exceeds terminal width". truncateToWidth uses
      // graphemeWidth internally and correctly measures wide chars.
      return {
        invalidate() {},
        render(width: number): string[] {
          return styledLines.map((line) => truncateToWidth(line, width, "...", true));
        },
      };
    },

    async execute(_id, params, signal, onUpdate, ctx) {
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
      if (params.action === "list" || (!params.agent && !params.tasks && !params.chain)) {
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

      // ── Single mode ───────────────────────────────────────────────────────────
      if (params.agent && params.task) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };

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
            usage: result.usage,
            running: false,
            elapsedMs: undefined,
            model: result.model,
          },
          isError: result.exitCode !== 0,
        };
      }

      // ── Parallel mode ─────────────────────────────────────────────────────────
      if (params.tasks && params.tasks.length > 0) {
        // Expand count shorthand
        const expanded: Array<{ agent: string; task: string; model?: string; cwd?: string }> = [];
        for (const t of params.tasks) {
          const n = t.count ?? 1;
          for (let i = 0; i < n; i++) expanded.push({ agent: t.agent, task: t.task, model: t.model, cwd: t.cwd });
        }

        const concurrency = params.concurrency ?? 4;
        let doneCount = 0;

        const allResults = await mapConcurrent(
          expanded,
          concurrency,
          async (t, _i) => {
            const { agent, error } = findAgent(t.agent);
            if (error || !agent) {
              return { agentName: t.agent, output: "", exitCode: 1, error, model: undefined, usage: { input: 0, output: 0, cost: 0, turns: 0 } };
            }
            const result = await runAgent(agent, t.task, t.cwd ?? cwd, t.model, signal, undefined);
            doneCount++;
            onUpdate?.({
              content: [{ type: "text", text: `Parallel: ${doneCount}/${expanded.length} done...` }],
              details: {},
            });
            return { ...result, agentName: t.agent };
          },
        );

        const successCount = allResults.filter((r) => r.exitCode === 0).length;
        const summaries = allResults.map((r) => {
          const out = getFinalText(r);
          const preview = out.length > 300 ? `${out.slice(0, 300)}...` : out;
          return `**[${r.agentName}]** ${r.exitCode === 0 ? "✓" : "✗"}\n${preview}`;
        });
        const totalUsage = allResults.reduce(
          (acc, r) => ({
            input: acc.input + r.usage.input,
            output: acc.output + r.usage.output,
            cost: acc.cost + r.usage.cost,
            turns: acc.turns + r.usage.turns,
          }),
          { input: 0, output: 0, cost: 0, turns: 0 },
        );

        return {
          content: [{
            type: "text",
            text: [
              `Parallel: ${successCount}/${allResults.length} succeeded`,
              "",
              summaries.join("\n\n"),
              "",
              formatUsage(totalUsage),
            ].join("\n"),
          }],
        };
      }

      // ── Chain mode ────────────────────────────────────────────────────────────
      if (params.chain && params.chain.length > 0) {
        const firstTask = params.chain[0]?.task ?? "";
        let previousOutput = "";

        const stepResults: Array<RunResult & { agentName: string; step: number }> = [];

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const { agent, error } = findAgent(step.agent);
          if (error || !agent) {
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${error ?? "Not found"}` }],
              isError: true,
            };
          }

          // Resolve task template
          let task = step.task ?? (i === 0 ? firstTask : "{previous}");
          task = task
            .replace(/\{previous\}/g, previousOutput)
            .replace(/\{task\}/g, firstTask);

          if (onUpdate) {
            onUpdate({
              content: [{
                type: "text",
                text: `Chain step ${i + 1}/${params.chain.length}: ${step.agent}...`,
              }],
              details: {},
            });
          }

          const result = await runAgent(
            agent,
            task,
            step.cwd ?? cwd,
            step.model,
            signal,
            onUpdate,
          );

          stepResults.push({ ...result, agentName: step.agent, step: i + 1 });

          if (result.exitCode !== 0) {
            return {
              content: [{
                type: "text",
                text: `Chain failed at step ${i + 1} (${step.agent}): ${result.error ?? "(no output)"}`,
              }],
              isError: true,
            };
          }

          previousOutput = result.output;
        }

        const last = stepResults[stepResults.length - 1];
        const totalUsage = stepResults.reduce(
          (acc, r) => ({
            input: acc.input + r.usage.input,
            output: acc.output + r.usage.output,
            cost: acc.cost + r.usage.cost,
            turns: acc.turns + r.usage.turns,
          }),
          { input: 0, output: 0, cost: 0, turns: 0 },
        );

        return {
          content: [{
            type: "text",
            text: [
              last.output,
              "",
              `Chain: ${stepResults.length} steps · ${formatUsage(totalUsage)}`,
            ].join("\n"),
          }],
        };
      }

      // Shouldn't reach here
      return { content: [{ type: "text", text: "Provide agent+task, tasks array, or chain array." }] };
    },
  });
}
