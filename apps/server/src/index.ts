import express, {
  type NextFunction,
  type Request,
  type Response
} from "express";
import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CreateRunRequest, RunState } from "@story/shared";
import { loadWorkflow, RunStore } from "@story/workflow-core";
import { CopilotProcessManager } from "./copilot-process.js";
import {
  getRunDetails,
  listRunStates,
  resolveArtifact,
  runDirectory,
  runsRoot
} from "./files.js";
import { readRunMetrics } from "./metrics.js";
import { SseHub } from "./sse.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(
  process.env.STORY_WORKFLOW_REPOSITORY_ROOT ??
    path.join(moduleDirectory, "..", "..", "..")
);
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "skills",
  "animated-story-workflow",
  "workflow.yaml"
);
const visualizerDist = path.join(repositoryRoot, "apps", "visualizer", "dist");
const store = new RunStore({
  runsDirectory: runsRoot(repositoryRoot),
  outputCwd: repositoryRoot
});
const processes = new CopilotProcessManager();
const sse = new SseHub();
const watchers = new Map<string, FSWatcher>();
const app = express();

app.use(express.json({ limit: "256kb" }));

function asyncRoute(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction
  ) => Promise<void>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };
}

function makeRunId(): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function validateCreateRunRequest(value: unknown): CreateRunRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Request body must be an object");
  }
  const request = value as Partial<CreateRunRequest>;
  if (
    typeof request.storyPrompt !== "string" ||
    request.storyPrompt.trim().length < 3
  ) {
    throw new Error("storyPrompt must contain at least three characters");
  }
  return {
    storyPrompt: request.storyPrompt.trim(),
    sceneCount: Math.min(Math.max(request.sceneCount ?? 3, 1), 8),
    visualStyle: request.visualStyle?.trim() || "paper-cut",
    maxParallelScenes: Math.min(
      Math.max(request.maxParallelScenes ?? 3, 1),
      6
    ),
    executor: request.executor ?? "copilot"
  };
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing route parameter: ${name}`);
  }
  return value;
}

function monitorRun(runId: string): void {
  if (watchers.has(runId)) {
    return;
  }
  const directory = runDirectory(repositoryRoot, runId);
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(directory, (_eventType, filename) => {
    if (filename && filename.toString() !== "state.json") {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      getRunDetails(repositoryRoot, runId)
        .then(details => sse.publish(runId, details))
        .catch(() => undefined);
    }, 40);
  });
  watcher.on("error", () => {
    watchers.delete(runId);
    watcher.close();
  });
  watchers.set(runId, watcher);
}

async function launchCopilot(
  state: RunState,
  storyPrompt: string,
  resume = false
): Promise<void> {
  monitorRun(state.runId);
  await processes.start({
    repositoryRoot,
    runId: state.runId,
    runDirectory: runDirectory(repositoryRoot, state.runId),
    storyPrompt,
    sessionId: resume ? undefined : state.sessionId,
    resumeSessionId: resume ? state.sessionId : undefined,
    onOutput: record =>
      sse.publish(state.runId, { source: "copilot", record }),
    onExit: () => {
      store
        .getState(state.runId)
        .then(current => {
          if (
            current.status !== "completed" &&
            current.status !== "cancelled"
          ) {
            return store.recoverRun(state.runId);
          }
          return current;
        })
        .then(current => sse.publish(state.runId, { state: current }))
        .catch(error =>
          sse.publish(state.runId, {
            source: "server",
            type: "recovery.failed",
            error: error instanceof Error ? error.message : String(error)
          })
        );
    }
  });
}

app.get(
  "/api/workflows",
  asyncRoute(async (_request, response) => {
    const workflow = await loadWorkflow(workflowPath);
    response.json({
      workflows: [
        {
          name: workflow.name,
          version: workflow.version,
          description: workflow.description,
          tasks: workflow.tasks
        }
      ]
    });
  })
);

app.get(
  "/api/runs",
  asyncRoute(async (_request, response) => {
    response.json({ runs: await listRunStates(repositoryRoot) });
  })
);

app.post(
  "/api/runs",
  asyncRoute(async (request, response) => {
    const input = validateCreateRunRequest(request.body);
    if (input.executor !== "copilot") {
      throw new Error("Only the real Copilot executor is exposed by this API");
    }
    const workflow = await loadWorkflow(workflowPath);
    const runId = makeRunId();
    const sessionId = randomUUID();
    const state = await store.createRun(workflow, {
      runId,
      sessionId,
      storyPrompt: input.storyPrompt,
      inputs: {
        storyPrompt: input.storyPrompt,
        sceneCount: input.sceneCount,
        visualStyle: input.visualStyle,
        maxParallelScenes: input.maxParallelScenes
      }
    });
    await launchCopilot(state, input.storyPrompt);
    response.status(201).json({ runId, state });
  })
);

app.get(
  "/api/runs/:runId",
  asyncRoute(async (request, response) => {
    const runId = routeParam(request, "runId");
    const details = await getRunDetails(repositoryRoot, runId);
    response.json({
      ...details,
      metrics: await readRunMetrics(runDirectory(repositoryRoot, runId))
    });
  })
);

app.get(
  "/api/runs/:runId/events",
  asyncRoute(async (request, response) => {
    const runId = routeParam(request, "runId");
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    monitorRun(runId);
    const unsubscribe = sse.subscribe(runId, response);
    request.on("close", unsubscribe);
  })
);

app.post(
  "/api/runs/:runId/retry/:taskId",
  asyncRoute(async (request, response) => {
    const runId = routeParam(request, "runId");
    const state = await store.retryTask(runId, routeParam(request, "taskId"));
    sse.publish(runId, { state });
    response.json({ state });
  })
);

app.post(
  "/api/runs/:runId/resume",
  asyncRoute(async (request, response) => {
    const runId = routeParam(request, "runId");
    if (processes.isActive(runId)) {
      throw new Error("The run already has an active Copilot process");
    }
    const state = await store.recoverRun(runId);
    await launchCopilot(state, state.storyPrompt, true);
    response.json({ state });
  })
);

app.post(
  "/api/runs/:runId/cancel",
  asyncRoute(async (request, response) => {
    const runId = routeParam(request, "runId");
    processes.cancel(runId);
    const state = await store.cancelRun(
      runId,
      "Cancelled from the visualizer"
    );
    sse.publish(runId, { state });
    response.json({ state });
  })
);

app.get(
  "/api/runs/:runId/artifacts/*artifactPath",
  asyncRoute(async (request, response) => {
    const runId = routeParam(request, "runId");
    const artifactPath = request.params.artifactPath;
    const relative = Array.isArray(artifactPath)
      ? artifactPath.join(path.sep)
      : artifactPath;
    if (!relative) {
      throw new Error("Missing artifact path");
    }
    response.sendFile(await resolveArtifact(repositoryRoot, runId, relative), {
      dotfiles: "allow"
    });
  })
);

if (existsSync(visualizerDist)) {
  app.use(express.static(visualizerDist));
  app.get("*splat", (_request, response) => {
    response.sendFile(path.join(visualizerDist, "index.html"));
  });
}

app.use(
  (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    response.status(400).json({ error: message });
  }
);

const port = Number(process.env.PORT ?? 4310);
app.listen(port, () => {
  console.log(`Story workflow server listening on http://localhost:${port}`);
});
