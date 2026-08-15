import path from "node:path";
import type { ArtifactRecord, TaskDefinition, RunState } from "@story/shared";

const REFERENCE = /\$\{\{\s*(inputs|tasks|item)(?:\.([^}]+?))?\s*\}\}/g;

function artifactValue(artifact: ArtifactRecord): unknown {
  if (Object.prototype.hasOwnProperty.call(artifact, "value")) return artifact.value;
  return artifact.path ?? artifact.directory;
}

function parallelOutputValue(
  taskId: string,
  outputName: string,
  state: RunState,
): unknown {
  const children = Object.values(state.tasks)
    .filter((candidate) => candidate.baseTaskId === taskId && candidate.id !== taskId)
    .sort((left, right) => (left.itemIndex ?? 0) - (right.itemIndex ?? 0));
  if (
    children.length === 0 ||
    children.some(
      (child) => child.status !== "completed" || !child.outputs[outputName],
    )
  ) {
    return undefined;
  }

  const artifacts = children.map((child) => child.outputs[outputName]!);
  if (artifacts.every((artifact) => artifact.directory)) {
    const directories = artifacts.map((artifact) => artifact.directory!);
    if (directories.every((directory) => directory === directories[0])) {
      return directories[0];
    }
    const parent = path.dirname(directories[0]!);
    if (directories.every((directory) => path.dirname(directory) === parent)) {
      return parent;
    }
  }
  return artifacts.map(artifactValue);
}

function lookup(
  expressionRoot: string,
  expressionPath: string | undefined,
  inputs: Record<string, unknown>,
  state: RunState,
  item: unknown,
  itemName: string | undefined,
): unknown {
  if (expressionRoot === "item") {
    let current = item;
    for (const part of expressionPath?.split(".") ?? []) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
  const parts = expressionPath?.split(".") ?? [];
  let current: unknown;
  if (expressionRoot === "inputs") {
    current = inputs;
  } else {
    const taskPath = expressionPath ?? "";
    const marker = ".outputs.";
    const markerIndex = taskPath.indexOf(marker);
    if (markerIndex <= 0) {
      throw new Error(
        `Invalid task output reference "${expressionRoot}.${expressionPath ?? ""}"`,
      );
    }
    const taskId = taskPath.slice(0, markerIndex);
    const outputPath = taskPath.slice(markerIndex + marker.length).split(".");
    const outputName = outputPath.shift();
    if (!outputName) {
      throw new Error(
        `Invalid task output reference "${expressionRoot}.${expressionPath ?? ""}"`,
      );
    }
    const task = state.tasks[taskId];
    if (!task) throw new Error(`Output reference uses unknown task "${taskId}"`);
    const artifact = task.outputs[outputName];
    if (!artifact) {
      current = parallelOutputValue(taskId, outputName, state);
      if (current === undefined) {
        throw new Error(`Task "${taskId}" has no completed output "${outputName}"`);
      }
    } else {
      current = artifactValue(artifact);
    }
    parts.splice(0, parts.length, ...outputPath);
  }
  if (itemName && parts[0] === itemName) {
    current = item;
    parts.shift();
  }
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveInputValue(
  value: unknown,
  inputs: Record<string, unknown>,
  state: RunState,
  item?: unknown,
  itemName?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolveInputValue(entry, inputs, state, item, itemName),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveInputValue(entry, inputs, state, item, itemName),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  const matches = [...value.matchAll(REFERENCE)];
  if (matches.length === 1 && matches[0]?.[0] === value) {
    return lookup(matches[0][1]!, matches[0][2], inputs, state, item, itemName);
  }
  return value.replace(REFERENCE, (_match, root: string, path: string) => {
    const resolved = lookup(root, path, inputs, state, item, itemName);
    return resolved === undefined ? "" : String(resolved);
  });
}

export function resolveTaskInputs(
  task: TaskDefinition,
  inputs: Record<string, unknown>,
  state: RunState,
  item?: unknown,
): Record<string, unknown> {
  return resolveInputValue(
    task.inputs,
    inputs,
    state,
    item,
    task.parallelForEach?.itemName,
  ) as Record<string, unknown>;
}
