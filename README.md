# StoryForge Copilot Workflow DAG

StoryForge is a sample durable workflow harness for GitHub Copilot CLI. One
Copilot session coordinates an animated-story DAG, repository custom agents run
as subagents, and a TypeScript harness remains authoritative for state,
dependencies, artifacts, retries, and resume behavior.

The result of a successful run is an original, dependency-free animated static
web application.

## Architecture

```text
React visualizer
      |
Express API + SSE
      |
Workflow core ---- .workflow/runs/<run-id>/
      |              state.json
      |              events.jsonl
      |              artifacts/
      |
One Copilot CLI session
      |
Coordinator Skill
      |
Custom-agent subagents
      |
story-workflow MCP server
```

The coordinator can decide how to execute a task, but it cannot directly edit
workflow state. Claims, completions, failures, retries, parallel expansion, and
finalization must pass through the local MCP server.

## Sample DAG

1. Plan the story.
2. Run script, art direction, sound design, and UI theme agents in parallel.
3. Expand and generate scene modules in parallel.
4. Assemble the static application.
5. Run accessibility and browser reviews in parallel.
6. Fix and optimize the application.
7. Publish the validated static site.

## Requirements

- Node.js 22 or newer.
- npm.
- GitHub Copilot CLI installed and authenticated.

Check the CLI and project Skill:

```powershell
copilot --version
copilot skill list
```

## Run locally

```powershell
npm install
npm run build
npm run start -w @story/server
```

Open <http://localhost:4310>. The server hosts both the API and the production
visualizer build.

For separate development servers:

```powershell
npm run dev
```

The visualizer runs on <http://localhost:5173> and proxies API requests to port
4310.

You can also start a run from another terminal:

```powershell
npm run workflow -- "A clockwork firefly helps the moon find its lost song"
```

## Run storage

Every run is stored in:

```text
.workflow/runs/<run-id>/
```

Before Copilot starts, the server copies the coordinator Skill, custom agents,
hook configuration, and hook scripts into the run directory and initializes it
as a nested Git repository. Copilot therefore treats the run workspace, rather
than the harness source tree, as its project root.

Important files:

- `definition.yaml`: immutable workflow snapshot.
- `events.jsonl`: authoritative append-only workflow history.
- `state.json`: atomic current-state projection.
- `copilot-output.jsonl`: Copilot CLI JSONL stream.
- `copilot-otel.jsonl`: model, tool, duration, token, and subagent telemetry.
- `hook-events.jsonl`: observational lifecycle events when Copilot loads the
  repository hooks.
- `artifacts/`: task outputs and the published site.

The visualizer can resume an interrupted run using its persisted Copilot
session ID. Completed tasks and validated artifacts are preserved.

## Workflow customization

- Coordinator Skill:
  `.github/skills/animated-story-workflow/SKILL.md`
- DAG:
  `.github/skills/animated-story-workflow/workflow.yaml`
- Custom agents:
  `.github/agents/*.agent.md`
- Hooks:
  `.github/hooks/workflow-observability.json`
- MCP server:
  `packages/workflow-mcp`

Task inputs should reference explicit upstream outputs. The workflow core
resolves those references and validates declared files, directories, values,
hashes, and JSON Schemas before accepting completion.

## Validation

```powershell
npm run typecheck
npm test
npm run build
```

## Safety

The HTTP API exposes only the repository's predefined animated-story workflow.
It does not accept arbitrary commands or arbitrary Copilot prompts. Copilot
OpenTelemetry content capture is disabled by default, so prompts, responses,
tool arguments, and source content are not intentionally exported.

Workflow events and artifact validation are authoritative. Hooks are
observational only because Copilot CLI may suppress repository hooks in
non-interactive or untrusted-folder environments; `copilot-output.jsonl` and
`copilot-otel.jsonl` remain available for monitoring when that occurs.

This is a local sample with one controller per run. Distributed workers,
multi-host locking, authentication, and untrusted multi-user hosting are out of
scope.
