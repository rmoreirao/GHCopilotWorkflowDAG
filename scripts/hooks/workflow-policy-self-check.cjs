"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { evaluatePreToolUse } = require("./workflow-observability.cjs");

const repository = process.cwd();
const runDirectory = path.join(repository, ".workflow", "runs", "policy-self-check");
const artifacts = path.join(runDirectory, "artifacts");
const environment = {
  ...process.env,
  STORY_WORKFLOW_RUN_DIR: runDirectory
};

function decision(toolName, toolArgs, cwd = repository) {
  return evaluatePreToolUse({ toolName, toolArgs, cwd }, environment).permissionDecision;
}

assert.equal(
  decision("create", { path: path.join(artifacts, "app", "index.html") }),
  "allow",
  "artifact writes must be allowed"
);
assert.equal(
  decision("edit", { path: path.join(repository, "packages", "workflow-core", "src", "workflow.ts") }),
  "deny",
  "repository source edits must be denied"
);
assert.equal(
  decision("apply_patch", {
    patch: "*** Begin Patch\n*** Update File: .workflow/runs/policy-self-check/artifacts/app/app.js\n@@\n-old\n+new\n*** End Patch\n"
  }),
  "allow",
  "artifact patches must be allowed"
);
assert.equal(
  decision("apply_patch", {
    patch: "*** Begin Patch\n*** Update File: packages/workflow-core/src/workflow.ts\n@@\n-old\n+new\n*** End Patch\n"
  }),
  "deny",
  "repository source patches must be denied"
);
assert.equal(
  decision("view", { path: path.join(repository, "packages", "workflow-core", "src", "workflow.ts") }),
  "allow",
  "reads must remain allowed"
);
assert.equal(
  decision("story-workflow/workflow_complete_task", { taskId: "publish" }),
  "allow",
  "workflow MCP tools must remain allowed"
);
assert.equal(
  decision("powershell", { command: "Remove-Item -Recurse -Force *", cwd: artifacts }),
  "deny",
  "broad destructive shell commands must be denied"
);
assert.equal(
  decision("powershell", { command: "node --check app.js", cwd: path.join(artifacts, "app") }),
  "allow",
  "artifact-scoped shell validation must be allowed"
);
assert.equal(
  decision("powershell", {
    command: `node --check "${path.join(artifacts, "app", "app.js")}"`,
    cwd: repository
  }),
  "allow",
  "read-only validation of an artifact target must be allowed"
);
assert.equal(
  decision("powershell", { command: "npm run build", cwd: repository }),
  "deny",
  "repository-scoped shell commands must be denied"
);
assert.equal(
  decision("unrecognized_mutating_tool", { path: path.join(artifacts, "unknown.txt") }),
  "deny",
  "unrecognized tools must fail closed during workflow runs"
);

console.log("Workflow hook policy self-check passed (11 cases).");
