---
name: animated-story-workflow
description: Orchestrates a stateful DAG that creates an original, accessible animated story web app. Use for animated-story workflow runs managed by the story-workflow MCP server.
---

# Animated story workflow

Run the entire DAG in the current Copilot CLI session. You are the coordinator, not an
artifact author. Use repository custom agents as subagents and treat the
`story-workflow` MCP server as the only authority for run and task state.

## Non-negotiable state protocol

1. Call `workflow_get_run` and `workflow_get_ready_tasks` before scheduling work.
2. Claim every task with `workflow_claim_task` before invoking its configured custom
   agent. Never describe a task as started, running, completed, or failed before the
   corresponding MCP call succeeds.
3. Give the subagent the run ID, claimed task ID, resolved inputs, attempt number,
   `STORY_WORKFLOW_RUN_DIR`, exact output paths, and applicable schemas.
4. A subagent may write artifacts, but all state claims and terminal state changes must
   be made through `story-workflow` MCP tools. Do not maintain a parallel checklist,
   infer state from files, or edit workflow state files.
5. Validate every artifact locally, then call `workflow_complete_task` with only the
   declared outputs. On an error call `workflow_fail_task` with a concise actionable
   error. Never report success merely because a subagent returned.
6. Re-query ready tasks after each state transition. Launch all simultaneously ready
   tasks in parallel. Wait for all dependencies before fan-in tasks.
7. Call `workflow_finish_run` only after the MCP server reports no ready, running,
   failed, or interrupted tasks. If finalization rejects, follow its state guidance.

If an MCP state tool is unavailable or rejects a transition, stop scheduling new work
and surface that failure through the available `workflow_fail_task` or run-state tool.
Never substitute prose for an MCP transition.

## DAG execution

Use `.github/skills/animated-story-workflow/workflow.yaml`.

1. `story-plan`
2. In parallel: `script`, `art-direction`, `sound-design`, `ui-theme`
3. Dynamically expand `generate-scenes` over `story-plan.sceneItems`; run scene
   animator subagents up to the configured concurrency.
4. `assemble-app` after every scene plus script, art, sound, and theme complete.
5. In parallel: `accessibility-review`, `browser-test`
6. `fix-and-optimize`
7. `publish`

The single coordinator session must remain active through finalization. Subagents must
not create nested subagents.

## Artifact root and originality

All generated artifacts belong under:

`$STORY_WORKFLOW_RUN_DIR/artifacts/`

Use these stable relative paths in MCP output payloads:

- `plan/story-plan.json`
- `script/story-script.json`
- `design/art-direction.json`
- `design/sound-design.json`
- `design/ui-theme.json`
- `design/theme.css`
- `scenes/<scene-id>/scene.json`
- `scenes/<scene-id>/scene.html`
- `scenes/<scene-id>/scene.css`
- `scenes/<scene-id>/scene.js`
- `app/index.html`, `app/styles.css`, `app/app.js`
- `reviews/accessibility.json`, `reviews/browser.json`
- `final/final-manifest.json`
- `published/` (copy of the final static application)

All prose, visuals, animation code, sound cues, CSS, HTML, and JavaScript must be
newly authored for the supplied premise. Do not download, trace, embed, or imitate
copyrighted characters, stories, music, images, fonts, or third-party site assets.
The published app must be a local, dependency-free static site.

## Schemas and templates

Validate JSON with the schemas in `schemas/`. They use JSON Schema draft 2020-12:

- `plan.schema.json`
- `script.schema.json`
- `art-direction.schema.json`
- `sound-design.schema.json`
- `ui-theme-manifest.schema.json`
- `scene-manifest.schema.json`
- `review-result.schema.json`
- `final-manifest.schema.json`

Templates in `templates/` are structural starting points only. Replace all marked
content and keep generated story assets inside the active run directory.

## Quality gates

- Plain HTML, CSS, and JavaScript; no remote runtime dependencies.
- Keyboard operable controls, visible focus, semantic landmarks, captions/transcript
  for meaningful audio, reduced-motion behavior, and sufficient contrast.
- Browser review checks loading, navigation, scene transitions, console errors,
  responsive layout, reduced motion, and missing local resources.
- `fix-and-optimize` must resolve all blocking findings and record any accepted
  non-blocking finding in the final manifest.
- `publish` copies only validated app assets and emits a schema-valid final manifest
  containing paths, review summaries, and a deterministic entry point.
