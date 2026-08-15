import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import type { ArtifactRecord, OutputDefinition } from "@story/shared";

export class OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputValidationError";
  }
}

export interface ValidateOutputsOptions {
  cwd?: string;
  allowedRoot?: string;
}

function assertInside(
  allowedRoot: string | undefined,
  candidate: string,
  outputName: string
): void {
  if (!allowedRoot) {
    return;
  }
  const root = path.resolve(allowedRoot);
  const relative = path.relative(root, candidate);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new OutputValidationError(
      `Output "${outputName}" resolves outside the run artifacts directory`
    );
  }
}

async function loadSchema(schema: string, cwd: string): Promise<unknown> {
  const trimmed = schema.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new OutputValidationError(
        `Invalid inline JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const schemaPath = path.resolve(cwd, schema);
  try {
    return JSON.parse(await readFile(schemaPath, "utf8"));
  } catch (error) {
    throw new OutputValidationError(
      `Cannot read JSON Schema "${schema}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function validateSchema(
  definition: OutputDefinition,
  value: unknown,
  cwd: string,
  outputName: string,
): Promise<boolean | undefined> {
  if (!definition.schema) return undefined;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  let validate;
  try {
    validate = ajv.compile((await loadSchema(definition.schema, cwd)) as AnySchema);
  } catch (error) {
    if (error instanceof OutputValidationError) throw error;
    throw new OutputValidationError(
      `Invalid JSON Schema for output "${outputName}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!validate(value)) {
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new OutputValidationError(
      `Output "${outputName}" does not match its JSON Schema: ${details}`,
    );
  }
  return true;
}

async function fileRecord(
  name: string,
  configuredPath: string,
  supplied: unknown,
  cwd: string,
  allowedRoot?: string
): Promise<ArtifactRecord> {
  const candidate =
    typeof supplied === "string"
      ? supplied
      : supplied &&
          typeof supplied === "object" &&
          typeof (supplied as { path?: unknown }).path === "string"
        ? (supplied as { path: string }).path
        : configuredPath;
  const absolutePath = path.resolve(cwd, candidate);
  assertInside(allowedRoot, absolutePath, name);
  let information;
  try {
    information = await stat(absolutePath);
  } catch {
    throw new OutputValidationError(
      `Output "${name}" file does not exist: ${absolutePath}`,
    );
  }
  if (!information.isFile()) {
    throw new OutputValidationError(`Output "${name}" is not a file: ${absolutePath}`);
  }
  const content = await readFile(absolutePath);
  return {
    name,
    path: candidate,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: information.size,
  };
}

async function directoryRecord(
  name: string,
  configuredPath: string,
  supplied: unknown,
  cwd: string,
  allowedRoot?: string
): Promise<ArtifactRecord> {
  const candidate =
    typeof supplied === "string"
      ? supplied
      : supplied &&
          typeof supplied === "object" &&
          typeof (supplied as { directory?: unknown }).directory === "string"
        ? (supplied as { directory: string }).directory
        : configuredPath;
  const absolutePath = path.resolve(cwd, candidate);
  assertInside(allowedRoot, absolutePath, name);
  let information;
  try {
    information = await stat(absolutePath);
  } catch {
    throw new OutputValidationError(
      `Output "${name}" directory does not exist: ${absolutePath}`,
    );
  }
  if (!information.isDirectory()) {
    throw new OutputValidationError(
      `Output "${name}" is not a directory: ${absolutePath}`,
    );
  }

  const hash = createHash("sha256");
  let size = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absoluteEntry = path.join(directory, entry.name);
      const relativeEntry = path.relative(absolutePath, absoluteEntry);
      if (entry.isDirectory()) {
        hash.update(`d:${relativeEntry}\0`);
        await walk(absoluteEntry);
      } else if (entry.isFile()) {
        const content = await readFile(absoluteEntry);
        hash.update(`f:${relativeEntry}\0`);
        hash.update(content);
        size += content.byteLength;
      } else {
        throw new OutputValidationError(
          `Output "${name}" contains unsupported entry: ${absoluteEntry}`,
        );
      }
    }
  };
  await walk(absolutePath);
  return {
    name,
    directory: candidate,
    sha256: hash.digest("hex"),
    size,
  };
}

export async function validateTaskOutputs(
  definitions: Record<string, OutputDefinition>,
  supplied: Record<string, unknown>,
  options: ValidateOutputsOptions = {},
): Promise<Record<string, ArtifactRecord>> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const allowedRoot = options.allowedRoot
    ? path.resolve(options.allowedRoot)
    : undefined;
  const unexpected = Object.keys(supplied).filter((name) => !(name in definitions));
  if (unexpected.length > 0) {
    throw new OutputValidationError(
      `Unexpected output${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`,
    );
  }
  const records: Record<string, ArtifactRecord> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if ("path" in definition && definition.path !== undefined) {
      const record = await fileRecord(
        name,
        definition.path,
        supplied[name],
        cwd,
        allowedRoot
      );
      if (definition.schema) {
        let jsonValue: unknown;
        try {
          jsonValue = JSON.parse(
            await readFile(path.resolve(cwd, record.path!), "utf8"),
          );
        } catch (error) {
          throw new OutputValidationError(
            `Output "${name}" must contain valid JSON for schema validation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        record.schemaValid = await validateSchema(
          definition,
          jsonValue,
          cwd,
          name,
        );
      }
      records[name] = record;
      continue;
    }
    if ("directory" in definition && definition.directory !== undefined) {
      records[name] = await directoryRecord(
        name,
        definition.directory,
        supplied[name],
        cwd,
        allowedRoot
      );
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(supplied, name) &&
        !Object.prototype.hasOwnProperty.call(definition, "value")) {
      throw new OutputValidationError(`Missing value output "${name}"`);
    }
    const value = Object.prototype.hasOwnProperty.call(supplied, name)
      ? supplied[name]
      : definition.value;
    const schemaValid = await validateSchema(definition, value, cwd, name);
    records[name] = {
      name,
      value,
      ...(schemaValid === undefined ? {} : { schemaValid }),
      size: Buffer.byteLength(JSON.stringify(value) ?? "null"),
      sha256: createHash("sha256")
        .update(JSON.stringify(value) ?? "null")
        .digest("hex"),
    };
  }
  return records;
}
