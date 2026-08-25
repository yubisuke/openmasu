import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

type JsonObject = Record<string, unknown>;

export type EventPayloadValidation =
  | { valid: true; fields: readonly [] }
  | { valid: false; fields: readonly string[] };

const commonSchemaId = "urn:open-mmp:schema:common:v0.3";
const schemaRoot = fileURLToPath(new URL("../../../schemas/", import.meta.url));

function loadJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function fixRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, child]) => [
    key,
    key === "$ref" && typeof child === "string"
      ? child
        .replace("../common.schema.json", commonSchemaId)
        .replace("common.schema.json", commonSchemaId)
      : fixRefs(child),
  ]));
}

function eventNameFromSchema(schema: JsonObject): string {
  const properties = schema.properties as JsonObject | undefined;
  const eventName = properties?.event_name as JsonObject | undefined;
  if (typeof eventName?.const !== "string") {
    throw new Error(`event schema ${String(schema.$id)} has no constant event_name`);
  }
  return eventName.const;
}

function invalidFields(errors: ErrorObject[] | null | undefined): string[] {
  return [...new Set((errors ?? []).map((error) => {
    const missing = typeof error.params.missingProperty === "string"
      ? `/${error.params.missingProperty}`
      : "";
    return `${error.instancePath}${missing}` || "/";
  }))].sort();
}

const Ajv2020 = Ajv2020Module as unknown as new (options: JsonObject) => {
  addSchema(schema: unknown): void;
  getSchema(id: string): ValidateFunction | undefined;
};
const addFormats = addFormatsModule as unknown as (instance: unknown) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(fixRefs(loadJson(`${schemaRoot}/common.schema.json`)));

const validators = new Map<string, ValidateFunction>();
for (const name of readdirSync(`${schemaRoot}/events`).filter((value) => value.endsWith(".schema.json")).sort()) {
  const schema = fixRefs(loadJson(`${schemaRoot}/events/${name}`)) as JsonObject;
  ajv.addSchema(schema);
  const id = String(schema.$id);
  const validator = ajv.getSchema(id);
  if (!validator) throw new Error(`event schema did not compile: ${id}`);
  validators.set(eventNameFromSchema(schema), validator);
}

/**
 * Validate an event payload with the same closed schemas used by the contract gate.
 * Diagnostics contain schema paths only; input values are never returned or logged.
 */
export function validateEventPayload(eventName: string, payload: unknown): EventPayloadValidation {
  const validator = validators.get(eventName);
  if (!validator || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, fields: [validator ? "/" : "/event_name"] };
  }
  const valid = validator({ ...(payload as JsonObject), event_name: eventName });
  return valid ? { valid: true, fields: [] } : { valid: false, fields: invalidFields(validator.errors) };
}
