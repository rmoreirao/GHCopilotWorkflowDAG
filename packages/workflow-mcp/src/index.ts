import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RunStore } from "@story/workflow-core";
import { z } from "zod";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : { value }
  };
}

export interface WorkflowMcpOptions {
  runDirectory: string;
  repositoryRoot?: string;
}

export function createWorkflowMcpServer(
  options: WorkflowMcpOptions
): McpServer {
  const runDirectory = path.resolve(options.runDirectory);
  const runId = path.basename(runDirectory);
  const store = new RunStore({
    runsDirectory: path.dirname(runDirectory),
    outputCwd: options.repositoryRoot ?? process.cwd()
  });
  const server = new McpServer({
    name: "story-workflow",
    version: "0.1.0"
  });

  server.registerTool(
    "workflow_get_run",
    {
      description:
        "Get the authoritative workflow run state. Always inspect this before coordinating work.",
      inputSchema: {}
    },
    async () => result(await store.getState(runId))
  );

  server.registerTool(
    "workflow_get_ready_tasks",
    {
      description:
        "List tasks whose dependencies are complete and that may be delegated now. Independent tasks should be delegated to custom-agent subagents in parallel.",
      inputSchema: {}
    },
    async () => result({ tasks: await store.getReadyTasks(runId) })
  );

  server.registerTool(
    "workflow_get_task_inputs",
    {
      description:
        "Resolve a task's declared inputs, including upstream artifact references.",
      inputSchema: {
        taskId: z.string().min(1)
      }
    },
    async ({ taskId }) =>
      result({
        taskId,
        inputs: await store.getTaskInputs(runId, taskId)
      })
  );

  server.registerTool(
    "workflow_claim_task",
    {
      description:
        "Atomically claim a ready task before delegating or executing it. Returns the resolved input contract.",
      inputSchema: {
        taskId: z.string().min(1)
      }
    },
    async ({ taskId }) => result(await store.claimTask(runId, taskId))
  );

  server.registerTool(
    "workflow_complete_task",
    {
      description:
        "Complete a claimed task. The harness validates every declared artifact and rejects missing or invalid outputs.",
      inputSchema: {
        taskId: z.string().min(1),
        outputs: z.record(z.string(), z.unknown())
      }
    },
    async ({ taskId, outputs }) =>
      result(await store.completeTask(runId, taskId, outputs))
  );

  server.registerTool(
    "workflow_fail_task",
    {
      description:
        "Record an explicit task failure. Do not report success-shaped output when execution failed.",
      inputSchema: {
        taskId: z.string().min(1),
        error: z.string().min(1)
      }
    },
    async ({ taskId, error }) =>
      result(await store.failTask(runId, taskId, error))
  );

  server.registerTool(
    "workflow_expand_parallel_task",
    {
      description:
        "Expand a ready parallelForEach task into isolated task instances after its array input is available.",
      inputSchema: {
        taskId: z.string().min(1)
      }
    },
    async ({ taskId }) =>
      result(await store.expandParallelTask(runId, taskId))
  );

  server.registerTool(
    "workflow_retry_task",
    {
      description:
        "Move an eligible failed or interrupted task back to pending for another attempt.",
      inputSchema: {
        taskId: z.string().min(1)
      }
    },
    async ({ taskId }) => result(await store.retryTask(runId, taskId))
  );

  server.registerTool(
    "workflow_finish_run",
    {
      description:
        "Finalize the run only after every required task is complete. The harness rejects premature finalization.",
      inputSchema: {}
    },
    async () => result(await store.finishRun(runId))
  );

  return server;
}

export async function runWorkflowMcpServer(
  options: WorkflowMcpOptions
): Promise<void> {
  const server = createWorkflowMcpServer(options);
  await server.connect(new StdioServerTransport());
}
