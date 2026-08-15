import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RunState, WorkflowEvent } from "@story/shared";

export function assertRunId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,80}$/.test(value)) {
    throw new Error("Invalid run ID");
  }
  return value;
}

export function runsRoot(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".workflow", "runs");
}

export function runDirectory(repositoryRoot: string, runId: string): string {
  return path.join(runsRoot(repositoryRoot), assertRunId(runId));
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function listRunStates(repositoryRoot: string): Promise<RunState[]> {
  try {
    const entries = await readdir(runsRoot(repositoryRoot), {
      withFileTypes: true
    });
    const states = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(entry =>
          readJson<RunState>(
            path.join(runsRoot(repositoryRoot), entry.name, "state.json")
          ).catch(() => undefined)
        )
    );
    return states
      .filter((state): state is RunState => Boolean(state))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function getRunDetails(
  repositoryRoot: string,
  runId: string
): Promise<{ state: RunState; events: WorkflowEvent[] }> {
  const directory = runDirectory(repositoryRoot, runId);
  return {
    state: await readJson<RunState>(path.join(directory, "state.json")),
    events: await readJsonLines<WorkflowEvent>(
      path.join(directory, "events.jsonl")
    )
  };
}

export async function resolveArtifact(
  repositoryRoot: string,
  runId: string,
  requestedPath: string
): Promise<string> {
  const directory = runDirectory(repositoryRoot, runId);
  const artifactsRoot = path.resolve(directory, "artifacts");
  const target = path.resolve(artifactsRoot, requestedPath);
  if (target !== artifactsRoot && !target.startsWith(`${artifactsRoot}${path.sep}`)) {
    throw new Error("Artifact path escapes the run directory");
  }
  const details = await stat(target);
  if (!details.isFile()) {
    throw new Error("Artifact is not a file");
  }
  return target;
}
