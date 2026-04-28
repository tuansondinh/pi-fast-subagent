/**
 * In-process subagent runner.
 *
 * Creates a transient AgentSession per task, streams tool/message events back
 * via `onUpdate`, and enforces the per-agent `maxDepth` gate on nested calls.
 */

import {
  AuthStorage,
  createAgentSession,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

import { type AgentConfig, agentNeedsExtensions } from "./agents.js";
import { allowUiPaint, defaultLoaderPool, LoaderPool } from "./loader-pool.js";
import { summarizeToolArgs } from "./format.js";
import type { ExecutionEvent, OnUpdate, RunResult, SubagentDetails, ToolCallEntry } from "./types.js";

// ─── Auth singletons ─────────────────────────────────────────────────────────

let _authStorage: ReturnType<typeof AuthStorage.create> | null = null;
let _modelRegistry: ReturnType<typeof ModelRegistry.create> | null = null;

export function getAuth() {
  if (!_authStorage) _authStorage = AuthStorage.create();
  if (!_modelRegistry) _modelRegistry = ModelRegistry.create(_authStorage);
  return { authStorage: _authStorage, modelRegistry: _modelRegistry };
}

// ─── Depth gating ────────────────────────────────────────────────────────────

export const DEFAULT_MAX_DEPTH = 0;
export const DEPTH_ENV = "PI_FAST_SUBAGENT_DEPTH";
export const MAX_DEPTH_ENV = "PI_FAST_SUBAGENT_MAX_DEPTH";

/**
 * Pure helper: given the current nesting depth and the allowed max depth,
 * decide whether a nested subagent call should be rejected.
 *
 * depth === 0  → top-level call, always allowed
 * depth > 0    → nested call, allowed only if depth <= maxDepth
 */
export function checkDepthGate(depth: number, maxDepth: number): { allowed: boolean; reason?: string } {
  if (depth <= 0) return { allowed: true };
  if (depth > maxDepth) {
    return {
      allowed: false,
      reason: `Nested subagents are disabled by default. Set maxDepth: ${depth} (or higher) in the parent agent frontmatter to allow this call.`,
    };
  }
  return { allowed: true };
}

// Module-level depth counters for nested in-process subagent calls.
let _currentDepth = 0;
let _currentMaxDepth = DEFAULT_MAX_DEPTH;

/** Read-only accessors for the current in-flight depth (used by parallel mode). */
export function getCurrentDepth(): number {
  return _currentDepth;
}

// ─── runAgent ────────────────────────────────────────────────────────────────

export interface RunAgentDeps {
  loaderPool?: LoaderPool;
  modelRegistry?: ModelRegistry;
  /** Pass a Model object directly to bypass registry lookup (used for model: inherit). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelObject?: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function modelRef(model: any): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Resolve provider/modelId into a Model object.
 *
 * `ModelRegistry.find()` only returns bundled/custom registry entries. Pi itself
 * can run ad-hoc provider model IDs (for example via `--model
 * anthropic/claude-sonnet-4-6`) by cloning provider config from a known model.
 * Do same here so `model: inherit` can use main session's exact model ID even
 * before pi's bundled registry knows it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveModelObject(modelRegistry: ModelRegistry, modelReference: string | undefined): any | undefined {
  const ref = modelReference?.trim();
  if (!ref) return undefined;

  const allModels = modelRegistry.getAll();
  const lowerRef = ref.toLowerCase();
  const exact = allModels.find((m) => modelRef(m).toLowerCase() === lowerRef || m.id.toLowerCase() === lowerRef);
  if (exact) return exact;

  const slash = ref.indexOf("/");
  if (slash === -1) return undefined;

  const providerRef = ref.slice(0, slash).trim();
  const modelId = ref.slice(slash + 1).trim();
  if (!providerRef || !modelId) return undefined;

  const providerModels = allModels.filter((m) => m.provider.toLowerCase() === providerRef.toLowerCase());
  if (providerModels.length === 0) return undefined;
  const provider = providerModels[0]!.provider;

  const found = modelRegistry.find(provider, modelId);
  if (found) return found;

  // Unknown model ID for known provider: clone closest provider model so auth,
  // API, baseUrl, headers, compat, cost shape, and token defaults survive.
  const idLower = modelId.toLowerCase();
  const family = ["opus", "sonnet", "haiku", "gpt", "gemini", "kimi", "glm", "grok"].find((token) => idLower.includes(token));
  const familyModels = family ? providerModels.filter((m) => m.id.toLowerCase().includes(family)) : [];
  const base = (familyModels[0] ?? providerModels[0])!;
  return {
    ...base,
    provider,
    id: modelId,
    name: modelId,
  };
}

export async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  modelOverride: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  parentDepth?: number,
  deps: RunAgentDeps = {},
): Promise<RunResult> {
  const pool = deps.loaderPool ?? defaultLoaderPool;
  const depth = parentDepth ?? _currentDepth;
  const gate = checkDepthGate(depth, _currentMaxDepth);
  if (!gate.allowed) {
    return {
      output: "",
      exitCode: 1,
      error: gate.reason,
      toolCalls: [],
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
  }

  const bootStartedAt = Date.now();
  const { authStorage, modelRegistry: defaultRegistry } = getAuth();
  const modelRegistry = deps.modelRegistry ?? defaultRegistry;
  const agentDir = getAgentDir();
  const noExtensions = !agentNeedsExtensions(agent.tools);
  const coldLoader = !pool.isWarm(cwd, agentDir, noExtensions);

  // Fire an immediate "running" emit so the UI draws the agent header + prompt
  // before the (potentially slow) extension/session load. Without this, pi looks
  // frozen while `loader.reload()` and `createAgentSession()` are in flight.
  onUpdate?.({
    content: [{ type: "text", text: "" }],
    details: {
      agentName: agent.name,
      task,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      running: true,
      elapsedMs: 0,
      model: modelOverride ?? agent.model,
      toolCalls: [],
    } satisfies SubagentDetails,
  });
  await allowUiPaint(coldLoader);

  const createPrevEnvDepth = process.env[DEPTH_ENV];
  process.env[DEPTH_ENV] = String(depth + 1);
  const loaderLease = await pool.acquire(
    cwd,
    agentDir,
    noExtensions,
    agent.systemPrompt || undefined,
  );

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  try {
    const created = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      authStorage,
      modelRegistry,
      resourceLoader: loaderLease.loader,
      ...(deps.modelObject ? { model: deps.modelObject } : {}),
    });
    session = created.session;
  } catch (e) {
    loaderLease.release();
    if (createPrevEnvDepth === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = createPrevEnvDepth;
    return {
      output: "",
      exitCode: 1,
      error: e instanceof Error ? e.message : String(e),
      toolCalls: [],
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
  }
  if (createPrevEnvDepth === undefined) delete process.env[DEPTH_ENV];
  else process.env[DEPTH_ENV] = createPrevEnvDepth;

  // Resolve and apply model. Force this even when createAgentSession received
  // modelObject so restore/default fallback cannot silently win.
  const modelStr = modelOverride ?? (agent.model === "inherit" ? undefined : agent.model);
  const model = deps.modelObject ?? resolveModelObject(modelRegistry, modelStr);
  if (model) await session.setModel(model);

  // Apply tools allowlist.
  //   "all"    → no restriction (everything registered stays active)
  //   "none"   → disable every tool
  //   string[] → explicit allowlist
  if (agent.tools === "none") {
    session.setActiveToolsByName([]);
  } else if (Array.isArray(agent.tools) && agent.tools.length > 0) {
    session.setActiveToolsByName(agent.tools);
  }

  const usage = { input: 0, output: 0, cost: 0, turns: 0 };
  let lastOutput = "";
  let currentDelta = "";
  let detectedModel: string | undefined;
  const startedAt = bootStartedAt;
  const configuredModel = modelOverride ?? agent.model;
  const toolCalls: ToolCallEntry[] = [];
  const toolStartTimes = new Map<string, number>();
  const executionEvents: ExecutionEvent[] = [];

  let done = false;

  function emitUpdate(): void {
    if (done) return;
    onUpdate?.({
      content: [{ type: "text", text: currentDelta || lastOutput || "" }],
      details: {
        agentName: agent.name,
        task,
        usage,
        running: true,
        elapsedMs: Date.now() - startedAt,
        model: detectedModel ?? configuredModel,
        toolCalls: [...toolCalls],
        executionEvents: [...executionEvents],
      } satisfies SubagentDetails,
    });
  }

  emitUpdate();
  const heartbeat = setInterval(emitUpdate, 1000);

  const unsubscribe = session.subscribe((event: any) => {
    const now = Date.now();

    if (event.type === "tool_execution_start") {
      const startTime = now;
      toolStartTimes.set(event.toolCallId, startTime);
      const argSummary = summarizeToolArgs(event.toolName, event.args);
      toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        argSummary,
      });
      executionEvents.push({
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argSummary,
        timestamp: now,
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
      const durMs = startedAtTool != null ? now - startedAtTool : undefined;
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
        entry.durMs = durMs;
      }
      executionEvents.push({
        type: "tool_end",
        toolCallId: event.toolCallId,
        result: resultText,
        isError: event.isError,
        durMs: durMs ?? 0,
        timestamp: now,
      });
      emitUpdate();
      return;
    }

    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (e?.type === "text_delta" && e.delta) {
        currentDelta += e.delta;
        executionEvents.push({
          type: "text_delta",
          text: e.delta,
          timestamp: now,
        });
        emitUpdate();
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

    for (const part of msg.content ?? []) {
      if (part.type === "text") {
        lastOutput = part.text;
        break;
      }
    }
    currentDelta = "";

    onUpdate?.({
      content: [{ type: "text", text: lastOutput || "(running...)" }],
      details: {
        agentName: agent.name,
        usage,
        running: true,
        elapsedMs: Date.now() - startedAt,
        model: detectedModel ?? configuredModel,
        toolCalls: [...toolCalls],
        executionEvents: [...executionEvents],
      } as unknown as SubagentDetails,
    });
  });

  // Propagate depth to nested calls. `maxDepth` is per-agent and defaults to 0,
  // so subagents cannot spawn subagents unless their frontmatter opts in.
  const prevEnvDepth = process.env[DEPTH_ENV];
  const prevEnvMaxDepth = process.env[MAX_DEPTH_ENV];
  const prevDepth = _currentDepth;
  const prevMaxDepth = _currentMaxDepth;
  const maxDepth = Math.max(DEFAULT_MAX_DEPTH, agent.maxDepth ?? DEFAULT_MAX_DEPTH);
  _currentDepth = depth + 1;
  _currentMaxDepth = depth + maxDepth;
  process.env[DEPTH_ENV] = String(_currentDepth);
  process.env[MAX_DEPTH_ENV] = String(_currentMaxDepth);

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
    loaderLease.release();
    if (prevEnvDepth === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = prevEnvDepth;
    if (prevEnvMaxDepth === undefined) delete process.env[MAX_DEPTH_ENV];
    else process.env[MAX_DEPTH_ENV] = prevEnvMaxDepth;
    _currentDepth = prevDepth;
    _currentMaxDepth = prevMaxDepth;
  }

  return { output: lastOutput, exitCode, error, model: detectedModel, toolCalls, executionEvents, usage };
}

// ─── Concurrency helper ─────────────────────────────────────────────────────

export async function mapConcurrent<TIn, TOut>(
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
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}
