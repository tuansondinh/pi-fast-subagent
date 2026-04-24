/**
 * Typebox parameter schema for the `subagent` tool.
 */

import { Type } from "@sinclair/typebox";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  model: Type.Optional(Type.String({ description: "Model override (provider/model)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  count: Type.Optional(Type.Number({ description: "Repeat this task N times" })),
});

export const SubagentParams = Type.Object({
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
      {
        description:
          "'list'/'get' for agents, 'status' for bg jobs, 'poll'/'cancel' for a specific job, 'detach' to move a foreground job to background",
      },
    ),
  ),
  agentScope: Type.Optional(
    Type.Union(
      [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
      { description: "Agent scope filter", default: "both" },
    ),
  ),
});
