import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  OutputValidationError,
  RunStore,
  RunStoreError,
  WorkflowValidationError,
  parseWorkflowYaml,
  replayEvents,
  loadWorkflow,
  validateWorkflow,
  validateTaskOutputs,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from "../src/index.js";

const testDirectories: string[] = [];
const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function testDirectory(): string {
  const directory = path.join(packageDirectory, `.test-data-${randomUUID()}`);
  testDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function task(
  id: string,
  dependsOn: string[] = [],
  outputs: WorkflowDefinition["tasks"][number]["outputs"] = {},
): WorkflowDefinition["tasks"][number] {
  return {
    id,
    dependsOn,
    executor: { type: "command", command: `echo ${id}` },
    inputs: {},
    outputs,
    retry: { maxAttempts: 2 },
  };
}

describe("workflow parsing and DAG validation", () => {
  it("normalizes YAML defaults", () => {
    const workflow = parseWorkflowYaml(`
name: sample
tasks:
  - id: first
    executor:
      type: command
      command: echo first
`);
    expect(workflow).toEqual({
      name: "sample",
      version: 1,
      inputs: {},
      tasks: [
        {
          id: "first",
          dependsOn: [],
          executor: { type: "command", command: "echo first" },
          inputs: {},
          outputs: {},
          retry: { maxAttempts: 1 },
        },
      ],
    });
  });

  it.each([
    {
      name: "duplicate IDs",
      tasks: [task("same"), task("same")],
      message: 'duplicate task ID "same"',
    },
    {
      name: "missing dependencies",
      tasks: [task("only", ["missing"])],
      message: 'depends on missing task "missing"',
    },
    {
      name: "cycles",
      tasks: [task("one", ["two"]), task("two", ["one"])],
      message: "workflow contains a cycle",
    },
  ])("rejects $name", ({ tasks, message }) => {
    expect(() =>
      validateWorkflowDefinition({ name: "invalid", version: 1, tasks }),
    ).toThrow(message);
  });

  it("rejects bad executors and output definitions with clear issues", () => {
    expect(() =>
      validateWorkflowDefinition({
        name: "invalid",
        tasks: [
          {
            id: "bad",
            executor: { type: "command", name: "wrong" },
            outputs: { result: { path: "a", value: true } },
          },
        ],
      }),
    ).toThrowError(WorkflowValidationError);
    try {
      validateWorkflowDefinition({
        name: "invalid",
        tasks: [
          {
            id: "bad",
            executor: { type: "command", name: "wrong" },
            outputs: { result: { path: "a", value: true } },
          },
        ],
      });
    } catch (error) {
      expect(String(error)).toContain("executor.command");
      expect(String(error)).toContain("exactly one of path, directory, or value");
    }
  });
});

describe("parallel readiness and fan-in", () => {
  it("expands arrays, resolves item inputs, limits claims, and fans in", async () => {
    const directory = testDirectory();
    const workflow: WorkflowDefinition = {
      name: "parallel",
      version: 1,
      inputs: {},
      tasks: [
        task("produce", [], { items: { value: [] } }),
        {
          ...task("fan", ["produce"], { result: { value: null } }),
          inputs: { current: "${{ item }}" },
          parallelForEach: {
            input: "${{ tasks.produce.outputs.items }}",
            itemName: "item",
            maxConcurrency: 2,
          },
        },
        {
          ...task("join", ["fan"]),
          inputs: { results: "${{ tasks.fan.outputs.result }}" },
        },
      ],
    };
    const store = new RunStore({ runsDirectory: directory, outputCwd: directory });
    let state = await store.initializeRun(workflow, {
      runId: "parallel-run",
      storyPrompt: "test",
    });
    expect(state.tasks.produce?.status).toBe("ready");

    await store.claimTask("parallel-run", "produce");
    state = await store.completeTask("parallel-run", "produce", {
      items: ["a", "b", "c"],
    });
    expect(state.tasks.fan?.status).toBe("skipped");
    expect(state.tasks.join?.dependsOn).toEqual(["fan[0]", "fan[1]", "fan[2]"]);

    const first = await store.claimTask("parallel-run", "fan[0]");
    const second = await store.claimTask("parallel-run", "fan[1]");
    expect(first.inputs.current).toBe("a");
    expect(second.inputs.current).toBe("b");
    await expect(store.claimTask("parallel-run", "fan[2]")).rejects.toThrow(
      "blocked by concurrency",
    );

    await store.completeTask("parallel-run", "fan[0]", { result: "done-a" });
    const third = await store.claimTask("parallel-run", "fan[2]");
    expect(third.inputs.current).toBe("c");
    await store.completeTask("parallel-run", "fan[1]", { result: "done-b" });
    state = await store.completeTask("parallel-run", "fan[2]", {
      result: "done-c",
    });
    expect(state.tasks.join?.status).toBe("ready");
    expect((await store.claimTask("parallel-run", "join")).inputs.results).toEqual([
      "done-a",
      "done-b",
      "done-c",
    ]);
  });
});

describe("state transitions", () => {
  it("enforces claim, fail, retry, complete, and cancel transitions", async () => {
    const directory = testDirectory();
    const store = new RunStore({ runsDirectory: directory });
    const workflow: WorkflowDefinition = {
      name: "transitions",
      version: 1,
      inputs: {},
      tasks: [task("one"), task("two", ["one"])],
    };
    await store.initializeRun(workflow, {
      runId: "transition-run",
      storyPrompt: "test",
    });
    await expect(
      store.completeTask("transition-run", "one", {}),
    ).rejects.toThrow("Cannot complete");
    await store.claimTask("transition-run", "one");
    let state = await store.failTask("transition-run", "one", "boom");
    expect(state.status).toBe("failed");
    state = await store.retryTask("transition-run", "one");
    expect(state.tasks.one?.status).toBe("ready");
    await store.claimTask("transition-run", "one");
    state = await store.completeTask("transition-run", "one", {});
    expect(state.tasks.two?.status).toBe("ready");
    state = await store.cancelRun("transition-run", "stop");
    expect(state.status).toBe("cancelled");
    expect(state.tasks.two?.status).toBe("cancelled");
    await expect(store.retryTask("transition-run", "one")).rejects.toThrow(
      RunStoreError,
    );
  });
});

describe("output validation", () => {
  it("validates files, directories, values, hashes, sizes, and schemas", async () => {
    const directory = testDirectory();
    await mkdir(path.join(directory, "folder"), { recursive: true });
    await writeFile(path.join(directory, "file.txt"), "hello", "utf8");
    await writeFile(path.join(directory, "folder", "nested.txt"), "world", "utf8");
    const records = await validateTaskOutputs(
      {
        file: { path: "file.txt" },
        folder: { directory: "folder" },
        data: {
          value: null,
          schema: JSON.stringify({
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          }),
        },
      },
      { data: { ok: true } },
      { cwd: directory },
    );
    expect(records.file?.size).toBe(5);
    expect(records.file?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(records.folder?.size).toBe(5);
    expect(records.data?.schemaValid).toBe(true);
    await expect(
      validateTaskOutputs(
        { data: { value: null, schema: '{"type":"number"}' } },
        { data: "wrong" },
        { cwd: directory },
      ),
    ).rejects.toThrow(OutputValidationError);
  });

  it("rejects artifact paths outside the run artifact root", async () => {
    const directory = testDirectory();
    const artifacts = path.join(directory, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(directory, "repository-file.txt"), "source", "utf8");

    await expect(
      validateTaskOutputs(
        { file: { path: "artifacts/result.txt" } },
        { file: path.join(directory, "repository-file.txt") },
        { cwd: directory, allowedRoot: artifacts }
      )
    ).rejects.toThrow("outside the run artifacts directory");
  });
});

describe("event replay and recovery", () => {
  it("treats events as authoritative and interrupts running tasks on recovery", async () => {
    const directory = testDirectory();
    const store = new RunStore({ runsDirectory: directory });
    const workflow: WorkflowDefinition = {
      name: "recovery",
      version: 1,
      inputs: {},
      tasks: [task("work")],
    };
    await store.initializeRun(workflow, {
      runId: "recovery-run",
      storyPrompt: "test",
    });
    await store.claimTask("recovery-run", "work");
    const statePath = path.join(directory, "recovery-run", "state.json");
    await writeFile(statePath, '{"status":"corrupt cache"}', "utf8");
    let state = await store.loadState("recovery-run");
    expect(state.tasks.work?.status).toBe("running");
    state = await store.recoverRun("recovery-run");
    expect(state.status).toBe("interrupted");
    expect(state.tasks.work?.status).toBe("interrupted");

    const events = (await readFile(
      path.join(directory, "recovery-run", "events.jsonl"),
      "utf8",
    ))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(replayEvents(events)).toEqual(state);
  });
});

describe("stable integration API", () => {
  it("loads workflows and exposes run lifecycle adapters", async () => {
    const directory = testDirectory();
    const workflowPath = path.join(directory, "workflow.yaml");
    await mkdir(directory, { recursive: true });
    await writeFile(
      workflowPath,
      `
name: integration
inputs:
  greeting: hello
tasks:
  - id: work
    executor:
      type: command
      command: echo work
    inputs:
      message: "\${{ inputs.greeting }}"
`,
      "utf8",
    );
    const workflow = await loadWorkflow(workflowPath);
    expect(validateWorkflow(workflow)).toEqual(workflow);

    const store = new RunStore({ runsDirectory: path.join(directory, "runs") });
    let state = await store.createRun(workflow, {
      runId: "integration-run",
      storyPrompt: "test",
    });
    expect((await store.getReadyTasks("integration-run")).map(({ id }) => id)).toEqual([
      "work",
    ]);
    expect(await store.getTaskInputs("integration-run", "work")).toEqual({
      message: "hello",
    });
    await store.claimTask("integration-run", "work");
    state = await store.completeTask("integration-run", "work", {});
    expect(state.status).toBe("completed");
    state = await store.finishRun("integration-run");
    expect(state.status).toBe("completed");
    expect(await store.getState("integration-run")).toEqual(state);
    expect((await store.getEvents("integration-run")).at(-1)?.type).toBe(
      "run.finished",
    );
  });

  it("serializes competing mutations across RunStore instances", async () => {
    const directory = testDirectory();
    const workflow: WorkflowDefinition = {
      name: "locking",
      version: 1,
      inputs: {},
      tasks: [task("work")]
    };
    const first = new RunStore({ runsDirectory: directory });
    const second = new RunStore({ runsDirectory: directory });
    await first.createRun(workflow, {
      runId: "locking-run",
      storyPrompt: "test"
    });

    const results = await Promise.allSettled([
      first.claimTask("locking-run", "work"),
      second.claimTask("locking-run", "work")
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await first.getState("locking-run")).tasks.work?.status).toBe("running");
  });
});
