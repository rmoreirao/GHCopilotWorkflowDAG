import type {
  CreateRunRequest,
  RunState,
  RunSummary,
  WorkflowDefinition,
  WorkflowEvent,
} from "@story/shared";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (isRecord(body) && typeof body.message === "string") message = body.message;
    if (isRecord(body) && typeof body.error === "string") message = body.error;
    if (typeof body === "string" && body.length < 500) message = body;
    throw new Error(message);
  }

  return body as T;
}

function getState(value: unknown): RunState | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.runId === "string" && isRecord(value.tasks)) return value as unknown as RunState;
  for (const key of ["state", "run", "summary"]) {
    const candidate = value[key];
    const state = getState(candidate);
    if (state) return state;
  }
  return undefined;
}

export function summarize(state: RunState): RunSummary {
  const tasks = Object.values(state.tasks);
  const start = Date.parse(state.createdAt);
  const end = Date.parse(state.updatedAt);
  return {
    state,
    taskCount: tasks.length,
    completedTasks: tasks.filter((task) => task.status === "completed").length,
    failedTasks: tasks.filter((task) => task.status === "failed").length,
    runningTasks: tasks.filter((task) => task.status === "running").length,
    durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
  };
}

function normalizeSummary(value: unknown): RunSummary | undefined {
  const state = getState(value);
  if (!state) return undefined;
  const metrics = isRecord(value) && isRecord(value.metrics) ? value.metrics : value;
  if (
    isRecord(metrics) &&
    typeof metrics.taskCount === "number" &&
    typeof metrics.completedTasks === "number"
  ) {
    return {
      state,
      taskCount: metrics.taskCount,
      completedTasks: metrics.completedTasks,
      failedTasks: typeof metrics.failedTasks === "number" ? metrics.failedTasks : 0,
      runningTasks: typeof metrics.runningTasks === "number" ? metrics.runningTasks : 0,
      durationMs: typeof metrics.durationMs === "number" ? metrics.durationMs : 0,
    };
  }
  return summarize(state);
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const body = await request<unknown>("/api/workflows");
  const values = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.workflows)
      ? body.workflows
      : [];
  return values.filter(
    (value): value is WorkflowDefinition =>
      isRecord(value) &&
      typeof value.name === "string" &&
      typeof value.version === "number" &&
      Array.isArray(value.tasks),
  );
}

export async function listRuns(): Promise<RunSummary[]> {
  const body = await request<unknown>("/api/runs");
  const values = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.runs)
      ? body.runs
      : [];
  return values
    .map(normalizeSummary)
    .filter((run): run is RunSummary => Boolean(run))
    .sort((a, b) => Date.parse(b.state.updatedAt) - Date.parse(a.state.updatedAt));
}

export async function getRun(runId: string): Promise<{
  summary: RunSummary;
  events: WorkflowEvent[];
}> {
  const body = await request<unknown>(`/api/runs/${encodeURIComponent(runId)}`);
  const summary = normalizeSummary(body);
  if (!summary) throw new Error("The server returned an invalid run.");
  const events =
    isRecord(body) && Array.isArray(body.events)
      ? body.events.map(parseEvent).filter((event): event is WorkflowEvent => Boolean(event))
      : [];
  return { summary, events };
}

export async function createRun(input: CreateRunRequest): Promise<RunSummary> {
  const body = await request<unknown>("/api/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const summary = normalizeSummary(body);
  if (!summary) throw new Error("The server did not return the created run.");
  return summary;
}

export async function runAction(
  runId: string,
  action: "retry" | "resume" | "cancel",
  taskId?: string,
): Promise<RunSummary | undefined> {
  if (action === "retry" && !taskId) throw new Error("Select a failed task to retry.");
  const suffix =
    action === "retry"
      ? `/retry/${encodeURIComponent(taskId!)}`
      : `/${action}`;
  const body = await request<unknown>(`/api/runs/${encodeURIComponent(runId)}${suffix}`, {
    method: "POST",
  });
  return normalizeSummary(body);
}

export function parseEvent(value: unknown): WorkflowEvent | undefined {
  const candidate = isRecord(value) && isRecord(value.event) ? value.event : value;
  if (
    !isRecord(candidate) ||
    typeof candidate.id !== "string" ||
    typeof candidate.timestamp !== "string" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.type !== "string"
  ) {
    return undefined;
  }
  return candidate as unknown as WorkflowEvent;
}

export function storyUrl(state: RunState): string | undefined {
  return state.status === "completed"
    ? `/api/runs/${encodeURIComponent(state.runId)}/artifacts/published/index.html`
    : undefined;
}
