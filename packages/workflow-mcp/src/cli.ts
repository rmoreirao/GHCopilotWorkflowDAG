#!/usr/bin/env node
import { runWorkflowMcpServer } from "./index.js";

const runDirectory = process.env.STORY_WORKFLOW_RUN_DIR;
if (!runDirectory) {
  console.error("STORY_WORKFLOW_RUN_DIR is required");
  process.exit(1);
}

runWorkflowMcpServer({
  runDirectory,
  repositoryRoot: process.env.STORY_WORKFLOW_REPOSITORY_ROOT
}).catch(error => {
  console.error(error);
  process.exit(1);
});
