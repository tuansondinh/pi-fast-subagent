import { randomUUID } from "node:crypto";
import type {
  BackgroundHandleLike,
  BackgroundJobManagerOptions,
  BackgroundJobResult,
  BackgroundSubagentJob,
} from "./background-types.js";

export type { BackgroundSubagentJob } from "./background-types.js";

export class BackgroundJobManager {
  private jobs = new Map<string, BackgroundSubagentJob>();
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private maxRunning: number;
  private maxTotal: number;
  private evictionMs: number;
  private onJobComplete?: (job: BackgroundSubagentJob) => void;
  private isShutdown = false;

  constructor(options: BackgroundJobManagerOptions = {}) {
    this.maxRunning = options.maxRunning ?? 10;
    this.maxTotal = options.maxTotal ?? 50;
    this.evictionMs = options.evictionMs ?? 5 * 60 * 1000;
    this.onJobComplete = options.onJobComplete;
  }

  adoptHandle(
    agentName: string,
    task: string,
    cwd: string,
    handle: BackgroundHandleLike,
    resultPromise: Promise<BackgroundJobResult>,
  ): string {
    handle.detach?.();

    const abortController = new AbortController();
    const onAbort = () => handle.abort();
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    return this.attachJob(agentName, task, cwd, abortController, resultPromise.finally(() => {
      abortController.signal.removeEventListener("abort", onAbort);
    }));
  }

  cancel(id: string): "cancelled" | "not_found" | "already_done" {
    const job = this.jobs.get(id);
    if (!job) return "not_found";
    if (job.status !== "running") return "already_done";

    job.status = "cancelled";
    job.completedAt = Date.now();
    job.abortController.abort();
    this.scheduleEviction(id);
    return "cancelled";
  }

  getJob(id: string): BackgroundSubagentJob | undefined {
    return this.jobs.get(id);
  }

  getRunningJobs(): BackgroundSubagentJob[] {
    return [...this.jobs.values()].filter((job) => job.status === "running");
  }

  getAllJobs(): BackgroundSubagentJob[] {
    return [...this.jobs.values()];
  }

  shutdown(): void {
    this.isShutdown = true;
    for (const timer of this.evictionTimers.values()) {
      clearTimeout(timer);
    }
    this.evictionTimers.clear();

    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.status = "cancelled";
        job.completedAt = Date.now();
        job.abortController.abort();
      }
    }
  }

  private attachJob(
    agentName: string,
    task: string,
    cwd: string,
    abortController: AbortController,
    resultPromise: Promise<BackgroundJobResult>,
  ): string {
    if (this.getRunningJobs().length >= this.maxRunning) {
      throw new Error(`Maximum concurrent background subagents reached (${this.maxRunning}).`);
    }

    if (this.jobs.size >= this.maxTotal) {
      this.evictOldestCompleted();
      if (this.jobs.size >= this.maxTotal) {
        throw new Error(`Maximum total background subagent jobs reached (${this.maxTotal}).`);
      }
    }

    const id = `sa_${randomUUID().slice(0, 8)}`;
    const job: BackgroundSubagentJob = {
      id,
      agentName,
      task,
      cwd,
      status: "running",
      startedAt: Date.now(),
      abortController,
      promise: undefined as unknown as Promise<void>,
    };

    job.promise = resultPromise
      .then((result) => {
        if (job.status === "cancelled") {
          this.scheduleEviction(id);
          return;
        }
        job.status = result.exitCode === 0 ? "completed" : "failed";
        job.completedAt = Date.now();
        job.exitCode = result.exitCode;
        job.resultSummary = result.summary;
        job.error = result.error;
        job.model = result.model;
        this.scheduleEviction(id);
        this.deliverResult(job);
      })
      .catch((error) => {
        if (job.status === "cancelled") {
          this.scheduleEviction(id);
          return;
        }
        job.status = "failed";
        job.completedAt = Date.now();
        job.exitCode = 1;
        job.error = error instanceof Error ? error.message : String(error);
        this.scheduleEviction(id);
        this.deliverResult(job);
      });

    this.jobs.set(id, job);
    return id;
  }

  private deliverResult(job: BackgroundSubagentJob): void {
    if (!this.onJobComplete) return;
    queueMicrotask(() => this.onJobComplete?.(job));
  }

  private scheduleEviction(id: string): void {
    if (this.isShutdown) return;
    const existing = this.evictionTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.evictionTimers.delete(id);
      this.jobs.delete(id);
    }, this.evictionMs);

    this.evictionTimers.set(id, timer);
  }

  private evictOldestCompleted(): void {
    let oldest: BackgroundSubagentJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.status === "running") continue;
      if (!oldest || job.startedAt < oldest.startedAt) oldest = job;
    }
    if (!oldest) return;

    const timer = this.evictionTimers.get(oldest.id);
    if (timer) clearTimeout(timer);
    this.evictionTimers.delete(oldest.id);
    this.jobs.delete(oldest.id);
  }
}
