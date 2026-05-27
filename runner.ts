/**
 * In-process subagent runner.
 *
 * Creates a transient AgentSession per task, streams tool/message events back
 * via `onUpdate`, and enforces the per-agent `maxDepth` gate on nested calls.
 */

import { AsyncLocalStorage } from "node:async_hooks";

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

export interface DepthState {
  depth: number;
  maxDepth: number;
}

const TOP_LEVEL_DEPTH: DepthState = { depth: 0, maxDepth: DEFAULT_MAX_DEPTH };
const _depthContext = new AsyncLocalStorage<DepthState>();

/** Read the depth/maxDepth in the current async context, or top-level defaults if none. */
export function getDepthState(): DepthState {
  return _depthContext.getStore() ?? TOP_LEVEL_DEPTH;
}

/** Run `fn` with `state` set as the current async-scoped depth context. */
export function runWithDepth<T>(state: DepthState, fn: () => Promise<T>): Promise<T> {
  return _depthContext.run(state, fn);
}

// ─── runAgent ────────────────────────────────────────────────────────────────

export interface RunAgentDeps {
  loaderPool?: LoaderPool;
}

export async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  modelOverride: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  deps: RunAgentDeps = {},
): Promise<RunResult> {
  const pool = deps.loaderPool ?? defaultLoaderPool;
  const { depth, maxDepth } = getDepthState();
  const gate = checkDepthGate(depth, maxDepth);
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
  const { authStorage, modelRegistry } = getAuth();
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
    });
    session = created.session;
  } catch (e) {
    loaderLease.release();
    return {
      output: "",
      exitCode: 1,
      error: e instanceof Error ? e.message : String(e),
      toolCalls: [],
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
  }

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

  // Per-agent maxDepth; defaults to 0 so subagents can't spawn subagents unless
  // their frontmatter opts in. AsyncLocalStorage scopes this to the nested
  // call, so overlapping parallel agents don't trample each other's state.
  const agentMaxDepth = Math.max(DEFAULT_MAX_DEPTH, agent.maxDepth ?? DEFAULT_MAX_DEPTH);
  const childState: DepthState = { depth: depth + 1, maxDepth: depth + agentMaxDepth };

  let exitCode = 0;
  let error: string | undefined;

  try {
    if (signal?.aborted) throw new Error("Aborted");

    const onAbort = () => void session.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await runWithDepth(childState, () => session.prompt(task));
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
