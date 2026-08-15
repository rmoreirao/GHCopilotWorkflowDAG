"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WRITE_TOOLS = new Set([
  "apply_patch",
  "create",
  "edit",
  "multiedit",
  "str_replace_editor",
  "write"
]);
const SHELL_TOOLS = new Set(["bash", "execute", "powershell", "shell", "terminal"]);
const READ_TOOLS = new Set([
  "glob",
  "grep",
  "read",
  "rg",
  "search",
  "view"
]);
const TARGET_KEYS = new Set([
  "cwd",
  "directory",
  "file",
  "file_path",
  "filePath",
  "filename",
  "path",
  "target",
  "target_path",
  "targetPath"
]);

function normalizeToolName(value) {
  return String(value || "").trim().toLowerCase();
}

function expandEnvironment(value, environment) {
  return value
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, name) => environment[name] || "")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => environment[name] || "")
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => environment[name] || "");
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveTarget(value, cwd, environment) {
  const expanded = expandEnvironment(String(value), environment).trim();
  if (!expanded) return null;
  return path.resolve(cwd, expanded);
}

function collectTargets(value, targets = [], key = "") {
  if (typeof value === "string") {
    if (TARGET_KEYS.has(key)) targets.push(value);
    if (key === "patch" || key === "input") {
      for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        targets.push(match[1].trim());
      }
    }
    return targets;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, targets, key);
    return targets;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectTargets(childValue, targets, childKey);
    }
  }
  return targets;
}

function commandText(args) {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "script", "cmd"]) {
    if (typeof args[key] === "string") return args[key];
  }
  return "";
}

function shellCwd(args, payloadCwd, environment) {
  const requested =
    args && typeof args === "object" && typeof args.cwd === "string"
      ? expandEnvironment(args.cwd, environment)
      : payloadCwd;
  return path.resolve(requested || process.cwd());
}

function isBroadlyDestructive(command) {
  const normalized = command.toLowerCase();
  return [
    /(^|[;&|]\s*)(rm|rmdir|del|erase|rd)\b/,
    /\bremove-item\b/,
    /\b(clear-content|set-content|add-content|out-file)\b/,
    /\b(git\s+(clean|reset|restore|checkout))\b/,
    /\b(format|diskpart|mkfs|shutdown|reboot|taskkill|stop-process)\b/,
    /(^|[^>])>>?/,
    /\b(fs\.)?(rm|rmdir|unlink)(sync)?\s*\(/,
    /\b(remove|delete)[-_ ]?(item|file|directory)\b/
  ].some(pattern => pattern.test(normalized));
}

function isReadOnlyValidation(command, artifactsDirectory, cwd, environment) {
  const expanded = expandEnvironment(command, environment).trim();
  const normalized = expanded.toLowerCase();
  if (/^(git\s+(status|diff|log|show)\b|rg\b|grep\b|test-path\b|get-content\b|get-childitem\b|resolve-path\b)/i.test(expanded)) {
    return !isBroadlyDestructive(expanded);
  }
  const check = expanded.match(/^node(?:\.exe)?\s+--check\s+("[^"]+"|'[^']+'|\S+)\s*$/i);
  if (!check) return false;
  const target = check[1].replace(/^['"]|['"]$/g, "");
  const resolved = resolveTarget(target, cwd, environment);
  return Boolean(resolved && isInside(artifactsDirectory, resolved) && !normalized.includes(".."));
}

function deny(reason) {
  return {
    permissionDecision: "deny",
    permissionDecisionReason: reason
  };
}

function evaluatePreToolUse(payload, environment = process.env) {
  const runDirectory = environment.STORY_WORKFLOW_RUN_DIR;
  if (!runDirectory) return {};

  const toolName = normalizeToolName(payload.toolName || payload.tool_name);
  const toolArgs = payload.toolArgs ?? payload.tool_input ?? {};
  const payloadCwd = payload.cwd || process.cwd();
  const artifactsDirectory = path.resolve(runDirectory, "artifacts");

  if (
    toolName.startsWith("story-workflow") ||
    toolName.includes("/workflow_") ||
    toolName.startsWith("workflow_")
  ) {
    return { permissionDecision: "allow" };
  }
  if (READ_TOOLS.has(toolName)) return { permissionDecision: "allow" };

  if (WRITE_TOOLS.has(toolName)) {
    const targets = collectTargets(toolArgs);
    if (targets.length === 0) {
      return deny(`Denied ${toolName}: no writable target could be verified under ${artifactsDirectory}.`);
    }
    const outside = targets.find(target => {
      const resolved = resolveTarget(target, payloadCwd, environment);
      return !resolved || !isInside(artifactsDirectory, resolved);
    });
    if (outside) {
      return deny(`Denied ${toolName}: target "${outside}" is outside the active run artifacts directory.`);
    }
    return { permissionDecision: "allow" };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = commandText(toolArgs);
    const cwd = shellCwd(toolArgs, payloadCwd, environment);
    if (!command) return deny(`Denied ${toolName}: command text was not available for policy inspection.`);
    if (isBroadlyDestructive(command)) {
      return deny(`Denied ${toolName}: broad destructive shell commands are not permitted in workflow sessions.`);
    }
    if (isInside(artifactsDirectory, cwd)) {
      const expanded = expandEnvironment(command, environment);
      if (/(^|[\s"'`])\.\.(?:[\\/]|$)/.test(expanded)) {
        return deny(`Denied ${toolName}: parent-directory traversal is not permitted from run artifacts.`);
      }
      const absolutePaths = expanded.match(/[A-Za-z]:[\\/][^\s"'`;|&]+|\/[^\s"'`;|&]+/g) || [];
      const outside = absolutePaths.find(candidate => !isInside(artifactsDirectory, candidate));
      if (outside) {
        return deny(`Denied ${toolName}: command target "${outside}" is outside run artifacts.`);
      }
      return { permissionDecision: "allow" };
    }
    if (isReadOnlyValidation(command, artifactsDirectory, cwd, environment)) {
      return { permissionDecision: "allow" };
    }
    return deny(`Denied ${toolName}: shell commands must run under ${artifactsDirectory} or be read-only validation.`);
  }

  return deny(`Denied unrecognized tool "${toolName || "unknown"}" during an active workflow run.`);
}

function appendObservation(payload, response) {
  const runDirectory = process.env.STORY_WORKFLOW_RUN_DIR;
  if (!runDirectory) return;
  const record = {
    observedAt: new Date().toISOString(),
    event: process.env.STORY_WORKFLOW_HOOK_EVENT || "unknown",
    runId: process.env.STORY_WORKFLOW_RUN_ID || null,
    payload,
    response
  };
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.appendFileSync(
    path.join(runDirectory, "hook-events.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
}

module.exports = {
  collectTargets,
  evaluatePreToolUse,
  isInside,
  isReadOnlyValidation
};

if (require.main !== module) {
  return;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
});
process.stdin.on("end", () => {
  let payload = {};
  let response = {};
  try {
    payload = input.trim() ? JSON.parse(input) : {};
    if ((process.env.STORY_WORKFLOW_HOOK_EVENT || "") === "preToolUse") {
      response = evaluatePreToolUse(payload);
    }
  } catch (error) {
    if ((process.env.STORY_WORKFLOW_HOOK_EVENT || "") === "preToolUse") {
      response = deny("Denied preToolUse because the hook payload could not be safely evaluated.");
    }
  }
  try {
    appendObservation(payload, response);
  } catch (error) {
    // Logging failure must not corrupt the valid hook decision response.
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});

process.stdin.resume();
