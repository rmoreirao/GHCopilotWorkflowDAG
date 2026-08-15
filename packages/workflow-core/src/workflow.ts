import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type {
  OutputDefinition,
  TaskDefinition,
  WorkflowDefinition,
} from "@story/shared";

export class WorkflowValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid workflow:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return "";
  }
  return value;
}

function normalizeOutput(
  value: unknown,
  path: string,
  issues: string[],
): OutputDefinition {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  const allowed = new Set(["path", "directory", "value", "schema"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not supported`);
  }
  const kinds = ["path", "directory", "value"].filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  if (kinds.length !== 1) {
    issues.push(`${path} must define exactly one of path, directory, or value`);
  }
  if ("path" in value && (typeof value.path !== "string" || value.path === "")) {
    issues.push(`${path}.path must be a non-empty string`);
  }
  if (
    "directory" in value &&
    (typeof value.directory !== "string" || value.directory === "")
  ) {
    issues.push(`${path}.directory must be a non-empty string`);
  }
  if ("schema" in value && typeof value.schema !== "string") {
    issues.push(`${path}.schema must be a string`);
  }
  if ("schema" in value && "directory" in value) {
    issues.push(`${path}.schema is not supported for directory outputs`);
  }
  return {
    ...("path" in value ? { path: value.path as string } : {}),
    ...("directory" in value ? { directory: value.directory as string } : {}),
    ...("value" in value ? { value: value.value } : {}),
    ...("schema" in value ? { schema: value.schema as string } : {}),
  };
}

function normalizeTask(
  value: unknown,
  index: number,
  issues: string[],
): TaskDefinition {
  const path = `tasks[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const task = value as Record<string, unknown>;
  const id = assertString(task.id, `${path}.id`, issues);
  const dependsOn = task.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== "string")) {
    issues.push(`${path}.dependsOn must be an array of task IDs`);
  }

  const executor = isRecord(task.executor) ? task.executor : {};
  if (!isRecord(task.executor)) issues.push(`${path}.executor must be an object`);
  const executorType = executor.type;
  if (!["skill", "agent", "command"].includes(String(executorType))) {
    issues.push(`${path}.executor.type must be skill, agent, or command`);
  }
  if (executorType === "command") {
    assertString(executor.command, `${path}.executor.command`, issues);
    if ("name" in executor) issues.push(`${path}.executor.name is invalid for command`);
  } else if (executorType === "skill" || executorType === "agent") {
    assertString(executor.name, `${path}.executor.name`, issues);
    if ("command" in executor) {
      issues.push(`${path}.executor.command is invalid for ${executorType}`);
    }
  }

  const inputs = task.inputs ?? {};
  if (!isRecord(inputs)) issues.push(`${path}.inputs must be an object`);
  const outputValues = task.outputs ?? {};
  if (!isRecord(outputValues)) issues.push(`${path}.outputs must be an object`);
  const outputs: Record<string, OutputDefinition> = {};
  if (isRecord(outputValues)) {
    for (const [name, output] of Object.entries(outputValues)) {
      if (name === "") issues.push(`${path}.outputs contains an empty name`);
      outputs[name] = normalizeOutput(output, `${path}.outputs.${name}`, issues);
    }
  }

  const retryValue = task.retry ?? {};
  if (!isRecord(retryValue)) issues.push(`${path}.retry must be an object`);
  const maxAttempts = isRecord(retryValue)
    ? (retryValue.maxAttempts ?? 1)
    : 1;
  if (!Number.isInteger(maxAttempts) || Number(maxAttempts) < 1) {
    issues.push(`${path}.retry.maxAttempts must be a positive integer`);
  }

  let parallelForEach: TaskDefinition["parallelForEach"];
  if (task.parallelForEach !== undefined) {
    if (!isRecord(task.parallelForEach)) {
      issues.push(`${path}.parallelForEach must be an object`);
    } else {
      const parallel = task.parallelForEach;
      const input = assertString(parallel.input, `${path}.parallelForEach.input`, issues);
      const itemName = assertString(
        parallel.itemName,
        `${path}.parallelForEach.itemName`,
        issues,
      );
      const maxConcurrency = parallel.maxConcurrency ?? 1;
      if (!Number.isInteger(maxConcurrency) || Number(maxConcurrency) < 1) {
        issues.push(
          `${path}.parallelForEach.maxConcurrency must be a positive integer`,
        );
      }
      parallelForEach = {
        input,
        itemName,
        maxConcurrency: Number(maxConcurrency),
      };
    }
  }

  return {
    id,
    ...(typeof task.description === "string"
      ? { description: task.description }
      : {}),
    dependsOn: Array.isArray(dependsOn)
      ? dependsOn.filter((item): item is string => typeof item === "string")
      : [],
    executor: {
      type: ["skill", "agent", "command"].includes(String(executorType))
        ? (executorType as "skill" | "agent" | "command")
        : "command",
      ...(typeof executor.name === "string" ? { name: executor.name } : {}),
      ...(typeof executor.command === "string"
        ? { command: executor.command }
        : {}),
    },
    inputs: isRecord(inputs) ? inputs : {},
    outputs,
    retry: { maxAttempts: Number(maxAttempts) || 1 },
    ...(parallelForEach ? { parallelForEach } : {}),
  };
}

function validateDag(tasks: TaskDefinition[], issues: string[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) issues.push(`duplicate task ID "${task.id}"`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push(`task "${task.id}" depends on missing task "${dependency}"`);
      }
      if (dependency === task.id) {
        issues.push(`task "${task.id}" cannot depend on itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string, trail: string[]): void => {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      issues.push(`workflow contains a cycle: ${[...trail.slice(start), id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    for (const dependency of task?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id, []);
}

export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new WorkflowValidationError(["workflow must be an object"]);
  }
  const name = assertString(value.name, "name", issues);
  const version = value.version ?? 1;
  if (!Number.isInteger(version) || Number(version) < 1) {
    issues.push("version must be a positive integer");
  }
  const inputs = value.inputs ?? {};
  if (!isRecord(inputs)) issues.push("inputs must be an object");
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    issues.push("tasks must be a non-empty array");
  }
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map((task, index) => normalizeTask(task, index, issues))
    : [];
  validateDag(tasks, issues);
  if (issues.length > 0) throw new WorkflowValidationError([...new Set(issues)]);
  return {
    name,
    version: Number(version),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    inputs: isRecord(inputs) ? inputs : {},
    tasks,
  };
}

export function parseWorkflowYaml(source: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError([`YAML parse error: ${message}`]);
  }
  return validateWorkflowDefinition(parsed);
}

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new WorkflowValidationError([
      `cannot read workflow "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return parseWorkflowYaml(source);
}

export const validateWorkflow = validateWorkflowDefinition;
