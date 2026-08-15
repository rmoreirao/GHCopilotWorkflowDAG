import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CopilotRunOptions {
  repositoryRoot: string;
  runId: string;
  runDirectory: string;
  storyPrompt: string;
  sessionId?: string;
  resumeSessionId?: string;
  onOutput?: (record: unknown) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface CopilotProcessInfo {
  sessionId: string;
  pid?: number;
}

function resolveCopilotCommand(): { command: string; prefixArgs: string[] } {
  if (process.env.COPILOT_EXECUTABLE) {
    return { command: process.env.COPILOT_EXECUTABLE, prefixArgs: [] };
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    const loader = path.join(
      process.env.APPDATA,
      "npm",
      "node_modules",
      "@github",
      "copilot",
      "npm-loader.js"
    );
    if (existsSync(loader)) {
      return { command: process.execPath, prefixArgs: [loader] };
    }
  }
  return { command: "copilot", prefixArgs: [] };
}

function parseJsonLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): void {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        onLine(line);
      }
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) {
      onLine(line);
    }
  });
}

async function initializeIsolatedRepository(directory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init", "--quiet", directory], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git init failed with exit code ${code}`));
      }
    });
  });
}

export class CopilotProcessManager {
  readonly #active = new Map<string, ChildProcess>();

  async start(options: CopilotRunOptions): Promise<CopilotProcessInfo> {
    if (this.#active.has(options.runId)) {
      throw new Error(`Run ${options.runId} already has an active Copilot process`);
    }

    await mkdir(options.runDirectory, { recursive: true });
    await Promise.all([
      cp(
        path.join(options.repositoryRoot, ".github", "skills"),
        path.join(options.runDirectory, ".github", "skills"),
        { recursive: true, force: true }
      ),
      cp(
        path.join(options.repositoryRoot, ".github", "agents"),
        path.join(options.runDirectory, ".github", "agents"),
        { recursive: true, force: true }
      ),
      cp(
        path.join(options.repositoryRoot, ".github", "hooks"),
        path.join(options.runDirectory, ".github", "hooks"),
        { recursive: true, force: true }
      ),
      cp(
        path.join(options.repositoryRoot, "scripts", "hooks"),
        path.join(options.runDirectory, "scripts", "hooks"),
        { recursive: true, force: true }
      )
    ]);
    await initializeIsolatedRepository(options.runDirectory);
    const sessionId =
      options.resumeSessionId ?? options.sessionId ?? randomUUID();
    const mcpConfigPath = path.join(options.runDirectory, "mcp-config.json");
    const mcpCli = path.join(
      options.repositoryRoot,
      "packages",
      "workflow-mcp",
      "src",
      "cli.js"
    );
    const tsxCli = path.join(
      options.repositoryRoot,
      "node_modules",
      "tsx",
      "dist",
      "cli.mjs"
    );
    const mcpSource = mcpCli.replace(`${path.sep}cli.js`, `${path.sep}cli.ts`);
    await writeFile(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            "story-workflow": {
              type: "stdio",
              command: process.execPath,
              args: [tsxCli, mcpSource],
              env: {
                STORY_WORKFLOW_RUN_DIR: options.runDirectory,
                STORY_WORKFLOW_REPOSITORY_ROOT: options.repositoryRoot
              }
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const prompt = [
      "Use the animated-story-workflow skill to execute the active workflow run.",
      `Run ID: ${options.runId}.`,
      `Story premise: ${options.storyPrompt}`,
      "The story-workflow MCP server is the authority for task readiness, claims,",
      "completion, failure, artifact contracts, and run finalization.",
      "Use the repository custom agents as subagents. Delegate all simultaneously",
      "ready tasks in parallel, but never bypass MCP state transitions.",
      "Continue until workflow_finish_run succeeds or the run is cancelled."
    ].join(" ");

    const args = [
      "-C",
      options.runDirectory,
      "--output-format",
      "json",
      "--stream",
      "on",
      "--autopilot",
      "--max-autopilot-continues",
      "50",
      "--allow-all-tools",
      "--no-ask-user",
      "--additional-mcp-config",
      `@${mcpConfigPath}`,
      "--session-id",
      sessionId,
      "--prompt",
      prompt
    ];
    const outputPath = path.join(options.runDirectory, "copilot-output.jsonl");
    const errorPath = path.join(options.runDirectory, "copilot-stderr.log");
    const outputFile = createWriteStream(outputPath, { flags: "a" });
    const errorFile = createWriteStream(errorPath, { flags: "a" });
    const invocation = resolveCopilotCommand();
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      cwd: options.runDirectory,
      env: {
        ...process.env,
        STORY_WORKFLOW_RUN_ID: options.runId,
        STORY_WORKFLOW_RUN_DIR: options.runDirectory,
        COPILOT_OTEL_FILE_EXPORTER_PATH: path.join(
          options.runDirectory,
          "copilot-otel.jsonl"
        ),
        OTEL_SERVICE_NAME: "story-workflow-copilot",
        OTEL_RESOURCE_ATTRIBUTES: `story.workflow.run_id=${options.runId}`
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.#active.set(options.runId, child);

    if (!child.stdout || !child.stderr) {
      throw new Error("Copilot process did not expose output streams");
    }
    parseJsonLines(child.stdout, line => {
      outputFile.write(`${line}\n`);
      try {
        options.onOutput?.(JSON.parse(line));
      } catch {
        options.onOutput?.({ type: "unparsed", line });
      }
    });
    child.stderr.pipe(errorFile);
    child.once("exit", (code, signal) => {
      this.#active.delete(options.runId);
      outputFile.end();
      errorFile.end();
      options.onExit?.(code, signal);
    });
    child.once("error", error => {
      this.#active.delete(options.runId);
      outputFile.end();
      errorFile.end();
      options.onOutput?.({ type: "process.error", message: error.message });
      options.onExit?.(null, null);
    });

    return { sessionId, pid: child.pid };
  }

  cancel(runId: string): boolean {
    const child = this.#active.get(runId);
    if (!child?.pid) {
      return false;
    }
    return child.kill("SIGTERM");
  }

  isActive(runId: string): boolean {
    return this.#active.has(runId);
  }
}
