import path from "node:path";
import { readJsonLines } from "./files.js";

interface OTelRecord {
  name?: string;
  duration?: number;
  attributes?: Record<string, unknown>;
  data?: {
    name?: string;
    duration?: number;
    attributes?: Record<string, unknown>;
  };
}

interface CopilotRecord {
  type?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface RunMetrics {
  modelCalls: number;
  toolCalls: number;
  subagentCalls: number;
  inputTokens: number;
  outputTokens: number;
  copilotRecords: number;
  otelRecords: number;
}

export async function readRunMetrics(runDirectory: string): Promise<RunMetrics> {
  const [otel, copilot] = await Promise.all([
    readJsonLines<OTelRecord>(path.join(runDirectory, "copilot-otel.jsonl")),
    readJsonLines<CopilotRecord>(
      path.join(runDirectory, "copilot-output.jsonl")
    )
  ]);

  let modelCalls = 0;
  let toolCalls = 0;
  let subagentCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const record of otel) {
    const name = record.name ?? record.data?.name ?? "";
    if (name.startsWith("chat ")) {
      modelCalls += 1;
    }
    if (name.startsWith("execute_tool ")) {
      toolCalls += 1;
    }
    if (name.includes("subagent") || name.includes("invoke_agent")) {
      subagentCalls += 1;
    }
    const attributes = record.attributes ?? record.data?.attributes ?? {};
    inputTokens += Number(
      attributes["gen_ai.usage.input_tokens"] ??
        attributes["gen_ai.usage.prompt_tokens"] ??
        0
    );
    outputTokens += Number(
      attributes["gen_ai.usage.output_tokens"] ??
        attributes["gen_ai.usage.completion_tokens"] ??
        0
    );
  }

  for (const record of copilot) {
    inputTokens += record.usage?.input_tokens ?? 0;
    outputTokens += record.usage?.output_tokens ?? 0;
  }

  return {
    modelCalls,
    toolCalls,
    subagentCalls,
    inputTokens,
    outputTokens,
    copilotRecords: copilot.length,
    otelRecords: otel.length
  };
}
