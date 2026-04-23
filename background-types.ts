export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundSubagentJob {
  id: string;
  agentName: string;
  task: string;
  cwd: string;
  status: BackgroundJobStatus;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  resultSummary?: string;
  error?: string;
  model?: string;
  abortController: AbortController;
  promise: Promise<void>;
}

export interface BackgroundJobManagerOptions {
  maxRunning?: number;
  maxTotal?: number;
  evictionMs?: number;
  onJobComplete?: (job: BackgroundSubagentJob) => void;
}

export interface BackgroundJobResult {
  summary: string;
  exitCode: number;
  error?: string;
  model?: string;
}

export interface BackgroundHandleLike {
  abort: () => void;
  detach?: () => void;
}
