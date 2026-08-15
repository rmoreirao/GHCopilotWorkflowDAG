import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRecord,
  RunState,
  TaskDefinition,
  TaskState,
  WorkflowDefinition,
  WorkflowEvent,
} from "@story/shared";
import { resolveInputValue, resolveTaskInputs } from "./references.js";
import { validateTaskOutputs } from "./outputs.js";
import { validateWorkflowDefinition } from "./workflow.js";

export const MAX_PARALLEL_ITEMS = 10_000;
export const MAX_PARALLEL_ITEM_BYTES = 65_536;
const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 120_000;

interface RunContext {
  workflow: WorkflowDefinition;
  inputs: Record<string, unknown>;
}

export interface InitializeRunOptions {
  runId?: string;
  storyPrompt: string;
  inputs?: Record<string, unknown>;
  sessionId?: string;
  pid?: number;
}

export interface RunStoreOptions {
  runsDirectory?: string;
  outputCwd?: string;
  now?: () => Date;
}

export class RunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreError";
  }
}

function initialTaskState(task: TaskDefinition): TaskState {
  return {
    id: task.id,
    baseTaskId: task.id,
    ...(task.description ? { description: task.description } : {}),
    status: "pending",
    dependsOn: [...task.dependsOn],
    attempt: 0,
    attempts: [],
    outputs: {},
  };
}

function updateRunStatus(state: RunState): void {
  if (state.status === "cancelled" || state.status === "interrupted") return;
  const tasks = Object.values(state.tasks);
  if (tasks.some((task) => task.status === "failed")) {
    state.status = "failed";
  } else if (
    tasks.length > 0 &&
    tasks.every((task) =>
      ["completed", "skipped", "cancelled"].includes(task.status),
    )
  ) {
    state.status = tasks.some((task) => task.status === "cancelled")
      ? "cancelled"
      : "completed";
  } else {
    state.status = "running";
  }
}

function requireTask(state: RunState, taskId: string): TaskState {
  const task = state.tasks[taskId];
  if (!task) throw new RunStoreError(`Unknown task "${taskId}"`);
  return task;
}

function applyEvent(state: RunState | undefined, event: WorkflowEvent): RunState {
  if (event.type === "run.initialized") {
    const workflow = validateWorkflowDefinition(event.data?.workflow);
    const tasks = Object.fromEntries(
      workflow.tasks.map((task) => [task.id, initialTaskState(task)]),
    );
    return {
      runId: event.runId,
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      status: "running",
      storyPrompt: String(event.data?.storyPrompt ?? ""),
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      ...(typeof event.data?.sessionId === "string"
        ? { sessionId: event.data.sessionId }
        : {}),
      ...(typeof event.data?.pid === "number" ? { pid: event.data.pid } : {}),
      tasks,
    };
  }
  if (!state) throw new RunStoreError("Event stream does not start with run.initialized");
  state.updatedAt = event.timestamp;
  const task = event.taskId ? requireTask(state, event.taskId) : undefined;

  switch (event.type) {
    case "tasks.expanded": {
      const baseTaskId = String(event.data?.baseTaskId ?? "");
      const base = requireTask(state, baseTaskId);
      const expanded = event.data?.tasks;
      if (!Array.isArray(expanded)) {
        throw new RunStoreError("tasks.expanded event has invalid tasks");
      }
      base.status = "skipped";
      base.completedAt = event.timestamp;
      const childIds: string[] = [];
      for (const childValue of expanded) {
        const child = childValue as TaskState;
        state.tasks[child.id] = child;
        childIds.push(child.id);
      }
      for (const candidate of Object.values(state.tasks)) {
        if (candidate.id === baseTaskId || candidate.baseTaskId === baseTaskId) continue;
        if (candidate.dependsOn.includes(baseTaskId)) {
          candidate.dependsOn = candidate.dependsOn.flatMap((dependency) =>
            dependency === baseTaskId ? childIds : [dependency],
          );
        }
      }
      break;
    }
    case "task.ready":
      if (task?.status === "pending") task.status = "ready";
      break;
    case "task.claimed": {
      if (!task) break;
      task.status = "running";
      task.attempt = event.attempt ?? task.attempt + 1;
      task.startedAt = event.timestamp;
      task.completedAt = undefined;
      task.error = undefined;
      task.attempts.push({ number: task.attempt, startedAt: event.timestamp });
      break;
    }
    case "task.completed": {
      if (!task) break;
      task.status = "completed";
      task.completedAt = event.timestamp;
      task.outputs = (event.data?.outputs ?? {}) as Record<string, ArtifactRecord>;
      const attempt = task.attempts.at(-1);
      if (attempt) attempt.completedAt = event.timestamp;
      break;
    }
    case "task.failed": {
      if (!task) break;
      task.status = "failed";
      task.completedAt = event.timestamp;
      task.error = String(event.data?.error ?? "Task failed");
      const attempt = task.attempts.at(-1);
      if (attempt) {
        attempt.completedAt = event.timestamp;
        attempt.error = task.error;
      }
      break;
    }
    case "task.retry":
      if (task) {
        task.status = "pending";
        task.completedAt = undefined;
        task.error = undefined;
      }
      state.status = "running";
      break;
    case "task.interrupted": {
      if (!task) break;
      task.status = "interrupted";
      task.completedAt = event.timestamp;
      task.error = String(event.data?.error ?? "Task interrupted");
      const attempt = task.attempts.at(-1);
      if (attempt) {
        attempt.completedAt = event.timestamp;
        attempt.error = task.error;
      }
      state.status = "interrupted";
      break;
    }
    case "run.cancelled":
      for (const candidate of Object.values(state.tasks)) {
        if (["pending", "ready", "running", "interrupted"].includes(candidate.status)) {
          candidate.status = "cancelled";
          candidate.completedAt = event.timestamp;
        }
      }
      state.status = "cancelled";
      break;
    case "run.finished":
      state.status = "completed";
      break;
    default:
      throw new RunStoreError(`Unsupported event type "${event.type}"`);
  }
  if (!["run.cancelled", "task.interrupted"].includes(event.type)) {
    updateRunStatus(state);
  }
  return state;
}

function taskDependenciesComplete(task: TaskState, state: RunState): boolean {
  return task.dependsOn.every((dependency) => {
    const status = state.tasks[dependency]?.status;
    return status === "completed" || status === "skipped";
  });
}

export function calculateReadyTasks(state: RunState): TaskState[] {
  if (!["created", "running", "failed"].includes(state.status)) return [];
  const runningByBase = new Map<string, number>();
  for (const task of Object.values(state.tasks)) {
    if (task.status === "running") {
      runningByBase.set(task.baseTaskId, (runningByBase.get(task.baseTaskId) ?? 0) + 1);
    }
  }
  const selectedByBase = new Map<string, number>();
  return Object.values(state.tasks).filter((task) => {
    if (!["pending", "ready"].includes(task.status)) return false;
    if (!taskDependenciesComplete(task, state)) return false;
    if (task.itemIndex === undefined) return true;
    const limit = Number(
      (task as TaskState & { maxConcurrency?: number }).maxConcurrency ??
        Number.MAX_SAFE_INTEGER,
    );
    const used =
      (runningByBase.get(task.baseTaskId) ?? 0) +
      (selectedByBase.get(task.baseTaskId) ?? 0);
    if (used >= limit) return false;
    selectedByBase.set(task.baseTaskId, (selectedByBase.get(task.baseTaskId) ?? 0) + 1);
    return true;
  });
}

function parseEvents(content: string, filePath: string): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as WorkflowEvent);
    } catch (error) {
      throw new RunStoreError(
        `Invalid JSON in ${filePath} at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events;
}

export function replayEvents(events: readonly WorkflowEvent[]): RunState {
  let state: RunState | undefined;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  if (!state) throw new RunStoreError("Cannot replay an empty event stream");
  return state;
}

export class RunStore {
  readonly runsDirectory: string;
  readonly outputCwd: string;
  private readonly now: () => Date;
  private operation = Promise.resolve();

  constructor(options: RunStoreOptions = {}) {
    this.runsDirectory = path.resolve(
      options.runsDirectory ?? path.join(process.cwd(), ".workflow", "runs"),
    );
    this.outputCwd = path.resolve(options.outputCwd ?? process.cwd());
    this.now = options.now ?? (() => new Date());
  }

  private runDirectory(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
      throw new RunStoreError(`Invalid run ID "${runId}"`);
    }
    return path.join(this.runsDirectory, runId);
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withRunLock<T>(
    runId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const directory = this.runDirectory(runId);
    const lockPath = path.join(directory, ".state.lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    await mkdir(directory, { recursive: true });

    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(
            JSON.stringify({
              pid: process.pid,
              createdAt: new Date().toISOString()
            }),
            "utf8"
          );
          return await action();
        } finally {
          await handle.close();
          await unlink(lockPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const information = await stat(lockPath).catch(() => undefined);
        if (
          information &&
          Date.now() - information.mtimeMs > STALE_LOCK_MS
        ) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new RunStoreError(
            `Timed out waiting for the state lock for run "${runId}"`
          );
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  private event(
    runId: string,
    type: string,
    taskId?: string,
    data?: Record<string, unknown>,
    attempt?: number,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
      timestamp: this.now().toISOString(),
      runId,
      source: "workflow",
      type,
      ...(taskId ? { taskId } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(data ? { data } : {}),
    };
  }

  private async readEvents(runId: string): Promise<WorkflowEvent[]> {
    const eventsPath = path.join(this.runDirectory(runId), "events.jsonl");
    let content: string;
    try {
      content = await readFile(eventsPath, "utf8");
    } catch (error) {
      throw new RunStoreError(
        `Cannot read run "${runId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseEvents(content, eventsPath);
  }

  private context(events: WorkflowEvent[]): RunContext {
    const initialized = events[0];
    if (initialized?.type !== "run.initialized") {
      throw new RunStoreError("Event stream does not start with run.initialized");
    }
    return {
      workflow: validateWorkflowDefinition(initialized.data?.workflow),
      inputs:
        initialized.data?.inputs &&
        typeof initialized.data.inputs === "object" &&
        !Array.isArray(initialized.data.inputs)
          ? (initialized.data.inputs as Record<string, unknown>)
          : {},
    };
  }

  private async writeSnapshot(state: RunState): Promise<void> {
    const directory = this.runDirectory(state.runId);
    const temporary = path.join(directory, `state.${randomUUID()}.tmp`);
    const destination = path.join(directory, "state.json");
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  }

  private async append(
    state: RunState,
    event: WorkflowEvent,
  ): Promise<RunState> {
    await appendFile(
      path.join(this.runDirectory(state.runId), "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
    const next = applyEvent(state, event);
    await this.writeSnapshot(next);
    return next;
  }

  async initializeRun(
    workflowValue: WorkflowDefinition,
    options: InitializeRunOptions,
  ): Promise<RunState> {
    return this.serialized(async () => {
      const workflow = validateWorkflowDefinition(workflowValue);
      const runId = options.runId ?? randomUUID();
      const directory = this.runDirectory(runId);
      await mkdir(directory, { recursive: true });
      const event = this.event(runId, "run.initialized", undefined, {
        workflow,
        inputs: { ...workflow.inputs, ...(options.inputs ?? {}) },
        storyPrompt: options.storyPrompt,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
      });
      try {
        await writeFile(
          path.join(directory, "events.jsonl"),
          `${JSON.stringify(event)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        throw new RunStoreError(
          `Cannot initialize run "${runId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let state = applyEvent(undefined, event);
      await this.writeSnapshot(state);
      state = await this.refresh(state, workflow, {
        ...workflow.inputs,
        ...(options.inputs ?? {}),
      });
      return state;
    });
  }

  async createRun(
    workflow: WorkflowDefinition,
    options: InitializeRunOptions,
  ): Promise<RunState> {
    return this.initializeRun(workflow, options);
  }

  async loadState(runId: string): Promise<RunState> {
    return replayEvents(await this.readEvents(runId));
  }

  async getState(runId: string): Promise<RunState> {
    return this.loadState(runId);
  }

  async loadEvents(runId: string): Promise<WorkflowEvent[]> {
    return this.readEvents(runId);
  }

  async getEvents(runId: string): Promise<WorkflowEvent[]> {
    return this.loadEvents(runId);
  }

  private async refresh(
    initialState: RunState,
    workflow: WorkflowDefinition,
    inputs: Record<string, unknown>,
    onlyTaskId?: string,
  ): Promise<RunState> {
    let state = initialState;
    for (const definition of workflow.tasks) {
      if (onlyTaskId !== undefined && definition.id !== onlyTaskId) continue;
      const base = state.tasks[definition.id];
      if (
        !definition.parallelForEach ||
        !base ||
        base.status !== "pending" ||
        !taskDependenciesComplete(base, state)
      ) {
        continue;
      }
      const resolvedInputs = resolveTaskInputs(definition, inputs, state);
      const source = Object.prototype.hasOwnProperty.call(
        resolvedInputs,
        definition.parallelForEach.input,
      )
        ? resolvedInputs[definition.parallelForEach.input]
        : resolveInputValue(
            definition.parallelForEach.input,
            inputs,
            state,
          );
      if (!Array.isArray(source)) {
        throw new RunStoreError(
          `parallelForEach input for task "${definition.id}" must resolve to an array`,
        );
      }
      if (source.length > MAX_PARALLEL_ITEMS) {
        throw new RunStoreError(
          `parallelForEach task "${definition.id}" exceeds ${MAX_PARALLEL_ITEMS} items`,
        );
      }
      const tasks = source.map((item, itemIndex) => {
        const itemBytes = Buffer.byteLength(JSON.stringify(item) ?? "null");
        if (itemBytes > MAX_PARALLEL_ITEM_BYTES) {
          throw new RunStoreError(
            `parallelForEach item ${itemIndex} for task "${definition.id}" exceeds ${MAX_PARALLEL_ITEM_BYTES} bytes`,
          );
        }
        const childId = `${definition.id}[${itemIndex}]`;
        if (state.tasks[childId]) {
          throw new RunStoreError(
            `parallelForEach task "${definition.id}" generated conflicting task ID "${childId}"`,
          );
        }
        return {
          ...initialTaskState(definition),
          id: childId,
          baseTaskId: definition.id,
          dependsOn: [...base.dependsOn],
          item,
          itemIndex,
          maxConcurrency: definition.parallelForEach!.maxConcurrency,
        } as TaskState & { maxConcurrency: number };
      });
      state = await this.append(
        state,
        this.event(state.runId, "tasks.expanded", undefined, {
          baseTaskId: definition.id,
          tasks,
        }),
      );
    }
    for (const task of calculateReadyTasks(state)) {
      if (task.status === "pending") {
        state = await this.append(
          state,
          this.event(state.runId, "task.ready", task.id),
        );
      }
    }
    return state;
  }

  async getReadyTasks(runId: string): Promise<TaskState[]> {
    let ready: TaskState[] = [];
    await this.mutate(runId, async (state, context) => {
      const current = await this.refresh(state, context.workflow, context.inputs);
      ready = calculateReadyTasks(current);
      return current;
    });
    return ready;
  }

  async expandParallelTask(runId: string, taskId: string): Promise<RunState> {
    return this.mutate(runId, async (state, context) => {
      const definition = context.workflow.tasks.find(
        (candidate) => candidate.id === taskId,
      );
      if (!definition?.parallelForEach) {
        throw new RunStoreError(`Task "${taskId}" is not a parallelForEach task`);
      }
      const base = requireTask(state, taskId);
      if (
        base.status === "pending" &&
        !taskDependenciesComplete(base, state)
      ) {
        throw new RunStoreError(`Task "${taskId}" has incomplete dependencies`);
      }
      return this.refresh(state, context.workflow, context.inputs, taskId);
    });
  }

  async getTaskInputs(
    runId: string,
    taskId: string,
  ): Promise<Record<string, unknown>> {
    let resolved: Record<string, unknown> = {};
    await this.mutate(runId, async (state, context) => {
      const current = await this.refresh(state, context.workflow, context.inputs);
      const task = requireTask(current, taskId);
      const definition = context.workflow.tasks.find(
        (candidate) => candidate.id === task.baseTaskId,
      );
      if (!definition) throw new RunStoreError(`Missing definition for "${taskId}"`);
      resolved = resolveTaskInputs(definition, context.inputs, current, task.item);
      return current;
    });
    return resolved;
  }

  private async mutate(
    runId: string,
    action: (
      state: RunState,
      context: RunContext,
    ) => Promise<RunState>,
  ): Promise<RunState> {
    return this.serialized(() =>
      this.withRunLock(runId, async () => {
        const events = await this.readEvents(runId);
        return action(replayEvents(events), this.context(events));
      })
    );
  }

  async claimTask(runId: string, taskId: string): Promise<{
    state: RunState;
    inputs: Record<string, unknown>;
  }> {
    let resolved: Record<string, unknown> = {};
    const state = await this.mutate(runId, async (loaded, context) => {
      let current = await this.refresh(loaded, context.workflow, context.inputs);
      const task = requireTask(current, taskId);
      if (task.status !== "ready") {
        if (
          task.status === "pending" &&
          task.itemIndex !== undefined &&
          taskDependenciesComplete(task, current)
        ) {
          throw new RunStoreError(`Task "${taskId}" is blocked by concurrency`);
        }
        throw new RunStoreError(
          `Cannot claim task "${taskId}" from status "${task.status}"`,
        );
      }
      const available = calculateReadyTasks(current).some(
        (candidate) => candidate.id === taskId,
      );
      if (!available) {
        throw new RunStoreError(`Task "${taskId}" is blocked by concurrency`);
      }
      const definition = context.workflow.tasks.find(
        (candidate) => candidate.id === task.baseTaskId,
      );
      if (!definition) throw new RunStoreError(`Missing definition for "${taskId}"`);
      if (task.attempt >= definition.retry.maxAttempts) {
        throw new RunStoreError(`Task "${taskId}" has no attempts remaining`);
      }
      resolved = resolveTaskInputs(definition, context.inputs, current, task.item);
      current = await this.append(
        current,
        this.event(
          runId,
          "task.claimed",
          taskId,
          undefined,
          task.attempt + 1,
        ),
      );
      return current;
    });
    return { state, inputs: resolved };
  }

  async completeTask(
    runId: string,
    taskId: string,
    outputs: Record<string, unknown>,
  ): Promise<RunState> {
    return this.mutate(runId, async (state, context) => {
      const task = requireTask(state, taskId);
      if (task.status !== "running") {
        throw new RunStoreError(
          `Cannot complete task "${taskId}" from status "${task.status}"`,
        );
      }
      const definition = context.workflow.tasks.find(
        (candidate) => candidate.id === task.baseTaskId,
      );
      if (!definition) throw new RunStoreError(`Missing definition for "${taskId}"`);
      const records = await validateTaskOutputs(definition.outputs, outputs, {
        cwd: this.outputCwd,
        allowedRoot: path.join(this.runDirectory(runId), "artifacts"),
      });
      let current = await this.append(
        state,
        this.event(runId, "task.completed", taskId, { outputs: records }, task.attempt),
      );
      current = await this.refresh(current, context.workflow, context.inputs);
      return current;
    });
  }

  async failTask(runId: string, taskId: string, error: string): Promise<RunState> {
    return this.mutate(runId, async (state) => {
      const task = requireTask(state, taskId);
      if (task.status !== "running") {
        throw new RunStoreError(
          `Cannot fail task "${taskId}" from status "${task.status}"`,
        );
      }
      return this.append(
        state,
        this.event(runId, "task.failed", taskId, { error }, task.attempt),
      );
    });
  }

  async retryTask(runId: string, taskId: string): Promise<RunState> {
    return this.mutate(runId, async (state, context) => {
      const task = requireTask(state, taskId);
      if (!["failed", "interrupted"].includes(task.status)) {
        throw new RunStoreError(
          `Cannot retry task "${taskId}" from status "${task.status}"`,
        );
      }
      const definition = context.workflow.tasks.find(
        (candidate) => candidate.id === task.baseTaskId,
      );
      if (!definition || task.attempt >= definition.retry.maxAttempts) {
        throw new RunStoreError(`Task "${taskId}" has no attempts remaining`);
      }
      let current = await this.append(
        state,
        this.event(runId, "task.retry", taskId),
      );
      current = await this.refresh(current, context.workflow, context.inputs);
      return current;
    });
  }

  async cancelRun(runId: string, reason?: string): Promise<RunState> {
    return this.mutate(runId, async (state) => {
      if (["completed", "cancelled"].includes(state.status)) {
        throw new RunStoreError(`Cannot cancel run from status "${state.status}"`);
      }
      return this.append(
        state,
        this.event(runId, "run.cancelled", undefined, {
          ...(reason ? { reason } : {}),
        }),
      );
    });
  }

  async interruptTask(
    runId: string,
    taskId: string,
    error = "Task interrupted",
  ): Promise<RunState> {
    return this.mutate(runId, async (state) => {
      const task = requireTask(state, taskId);
      if (task.status !== "running") {
        throw new RunStoreError(
          `Cannot interrupt task "${taskId}" from status "${task.status}"`,
        );
      }
      return this.append(
        state,
        this.event(runId, "task.interrupted", taskId, { error }, task.attempt),
      );
    });
  }

  async recoverRun(runId: string): Promise<RunState> {
    return this.mutate(runId, async (state) => {
      let current = state;
      for (const task of Object.values(state.tasks)) {
        if (task.status === "running") {
          current = await this.append(
            current,
            this.event(
              runId,
              "task.interrupted",
              task.id,
              { error: "Interrupted during run recovery" },
              task.attempt,
            ),
          );
        }
      }
      return current;
    });
  }

  async finishRun(runId: string): Promise<RunState> {
    return this.mutate(runId, async (state) => {
      if (state.status === "cancelled" || state.status === "interrupted") {
        throw new RunStoreError(`Cannot finish run from status "${state.status}"`);
      }
      const unfinished = Object.values(state.tasks).filter(
        (task) => !["completed", "skipped"].includes(task.status),
      );
      if (unfinished.length > 0) {
        throw new RunStoreError(
          `Cannot finish run; unfinished tasks: ${unfinished
            .map((task) => `${task.id} (${task.status})`)
            .join(", ")}`,
        );
      }
      return this.append(state, this.event(runId, "run.finished"));
    });
  }
}
