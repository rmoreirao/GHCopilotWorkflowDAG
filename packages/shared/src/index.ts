export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "skipped"
  | "cancelled";

export type RunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface OutputDefinition {
  path?: string;
  directory?: string;
  schema?: string;
  value?: unknown;
}

export interface TaskDefinition {
  id: string;
  description?: string;
  dependsOn: string[];
  executor: {
    type: "skill" | "agent" | "command";
    name?: string;
    command?: string;
  };
  inputs: Record<string, unknown>;
  outputs: Record<string, OutputDefinition>;
  retry: {
    maxAttempts: number;
  };
  parallelForEach?: {
    input: string;
    itemName: string;
    maxConcurrency: number;
  };
}

export interface WorkflowDefinition {
  name: string;
  version: number;
  description?: string;
  inputs: Record<string, unknown>;
  tasks: TaskDefinition[];
}

export interface ArtifactRecord {
  name: string;
  path?: string;
  directory?: string;
  value?: unknown;
  sha256?: string;
  size?: number;
  schemaValid?: boolean;
}

export interface TaskAttempt {
  number: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface TaskState {
  id: string;
  baseTaskId: string;
  description?: string;
  status: TaskStatus;
  dependsOn: string[];
  attempt: number;
  attempts: TaskAttempt[];
  outputs: Record<string, ArtifactRecord>;
  item?: unknown;
  itemIndex?: number;
  subagent?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface RunState {
  runId: string;
  workflowName: string;
  workflowVersion: number;
  status: RunStatus;
  storyPrompt: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  pid?: number;
  tasks: Record<string, TaskState>;
}

export interface WorkflowEvent {
  id: string;
  timestamp: string;
  runId: string;
  source: "workflow" | "copilot" | "hook" | "otel";
  type: string;
  taskId?: string;
  attempt?: number;
  data?: Record<string, unknown>;
}

export interface CreateRunRequest {
  storyPrompt: string;
  sceneCount?: number;
  visualStyle?: string;
  maxParallelScenes?: number;
  executor?: "copilot" | "deterministic";
}

export interface RunSummary {
  state: RunState;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  durationMs: number;
}
