/**
 * Shared runtime types for the subagent tool.
 */

export interface ToolCallEntry {
  id: string;
  name: string;
  argSummary: string;
  result?: string;
  isError?: boolean;
  durMs?: number;
}

export interface RunResult {
  output: string;
  exitCode: number;
  error?: string;
  model?: string;
  toolCalls: ToolCallEntry[];
  usage: { input: number; output: number; cost: number; turns: number };
}

export interface AgentRowStatus {
  name: string;
  taskSummary: string;
  status: "pending" | "running" | "done" | "error";
  durMs?: number;
  toolCalls?: ToolCallEntry[];
  responseText?: string;
}

export interface SubagentDetails {
  mode?: "single" | "parallel";
  agentName?: string;
  task?: string;
  parallelAgents?: AgentRowStatus[];
  usage: RunResult["usage"];
  running: boolean;
  elapsedMs?: number;
  model?: string;
  backgroundJobId?: string;
  toolCalls: ToolCallEntry[];
}

export type OnUpdate = (partial: {
  content: [{ type: "text"; text: string }];
  details: unknown;
}) => void;
