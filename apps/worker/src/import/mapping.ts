import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020Module, { type ErrorObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

type Any = Record<string, any>;

export type MappingExpression = {
  source?: string;
  const?: unknown;
  default?: unknown;
  map?: Record<string, unknown>;
  map_default?: unknown;
  boolean?: { true_values: unknown[]; false_values: unknown[]; default?: boolean };
  uppercase?: boolean;
  timestamp?: { default_timezone: "UTC"; timezone_source?: string; truncate_to_milliseconds: true };
  money?: { scale: number; currency_source?: string; currency_default?: string };
  object?: Record<string, MappingExpression>;
};

export type ImportMapping = {
  version: "1.0.0";
  kind: "mmp_raw" | "manual_cost";
  source_id: string;
  tenant_id: string;
  app_id: string;
  provider?: string;
  format: "csv" | "json" | "jsonl";
  row_filter?: { source: string; equals: string | number | boolean };
  rules: Array<{ target: string; expression: MappingExpression }>;
};

export class MappingError extends Error {
  constructor(message: string, readonly fields: string[] = []) {
    super(message);
  }
}

const schemaPath = join(process.cwd(), "runtime-schemas", "import-mapping.schema.json");
const Ajv2020 = Ajv2020Module as unknown as new (options: Any) => {
  compile(schema: Any): ((value: unknown) => boolean) & { errors?: ErrorObject[] | null };
};
const addFormats = addFormatsModule as unknown as (instance: unknown) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

function errorFields(errors: ErrorObject[] | null | undefined): string[] {
  return [...new Set((errors ?? []).map((error) => error.instancePath || error.params.missingProperty)
    .filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

export function loadMapping(path: string): ImportMapping {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validate(value)) throw new MappingError("mapping schema validation failed", errorFields(validate.errors));
  const mapping = value as ImportMapping;
  if (mapping.kind === "mmp_raw" && !mapping.provider) {
    throw new MappingError("mmp_raw mappings require provider", ["provider"]);
  }
  return mapping;
}

function sourceValue(row: Any, name: string | undefined): unknown {
  if (!name) return undefined;
  return name.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Any)[part];
  }, row);
}

function normalizeTimestamp(value: unknown, expression: MappingExpression, row: Any): string {
  if (typeof value !== "string" || value.trim() === "") throw new MappingError("timestamp source is empty");
  let text = value.trim();
  const hasZone = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(text);
  if (!hasZone) {
    const zone = expression.timestamp?.timezone_source
      ? sourceValue(row, expression.timestamp.timezone_source)
      : expression.timestamp?.default_timezone;
    if (zone !== "UTC") throw new MappingError("only the verified UTC default timezone is supported");
    text = `${text}Z`;
  }
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf())) throw new MappingError("timestamp source is invalid");
  return parsed.toISOString();
}

function booleanValue(value: unknown, config: NonNullable<MappingExpression["boolean"]>): boolean {
  const normalized = String(value).trim().toLowerCase();
  const candidates = (items: unknown[]): string[] => items.map((item) => String(item).trim().toLowerCase());
  if (candidates(config.true_values).includes(normalized)) return true;
  if (candidates(config.false_values).includes(normalized)) return false;
  if (config.default !== undefined) return config.default;
  throw new MappingError("boolean source is outside the declared vocabulary");
}

function moneyValue(value: unknown, config: NonNullable<MappingExpression["money"]>, row: Any): Any {
  const amount = String(value ?? "").trim();
  if (!/^-?[0-9]+$/.test(amount)) throw new MappingError("money source must be a base-10 integer without exponent notation");
  const currencyValue = config.currency_source ? sourceValue(row, config.currency_source) : undefined;
  const currency = String(currencyValue || config.currency_default || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new MappingError("money currency is missing or invalid");
  return { amount_unscaled: amount, amount_scale: config.scale, currency };
}

export function evaluateExpression(expression: MappingExpression, row: Any): unknown {
  if (expression.object) {
    return Object.fromEntries(Object.entries(expression.object).map(([name, child]) => [name, evaluateExpression(child, row)]));
  }
  let value = Object.prototype.hasOwnProperty.call(expression, "const")
    ? expression.const
    : sourceValue(row, expression.source);
  if ((value === undefined || value === null || value === "") && Object.prototype.hasOwnProperty.call(expression, "default")) {
    value = expression.default;
  }
  if (expression.map) {
    const key = String(value);
    if (Object.prototype.hasOwnProperty.call(expression.map, key)) value = expression.map[key];
    else if (Object.prototype.hasOwnProperty.call(expression, "map_default")) value = expression.map_default;
    else throw new MappingError("enum source is outside the declared map", expression.source ? [expression.source] : []);
  }
  if (expression.boolean) value = booleanValue(value, expression.boolean);
  if (expression.uppercase && typeof value === "string") value = value.toUpperCase();
  if (expression.timestamp) value = normalizeTimestamp(value, expression, row);
  if (expression.money) value = moneyValue(value, expression.money, row);
  if (value === undefined) throw new MappingError("required mapping source is missing", expression.source ? [expression.source] : []);
  return value;
}

function mergeValue(target: Any, key: string, value: unknown): void {
  if (
    target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
    && value && typeof value === "object" && !Array.isArray(value)
  ) {
    Object.assign(target[key], value);
  } else {
    target[key] = value;
  }
}

function setTarget(target: Any, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
      throw new MappingError(`mapping target collides with a scalar: ${path}`, [path]);
    }
    cursor = cursor[part] ??= {};
  }
  mergeValue(cursor, parts.at(-1)!, value);
}

export function rowMatches(mapping: ImportMapping, row: Any): boolean {
  if (!mapping.row_filter) return true;
  return sourceValue(row, mapping.row_filter.source) === mapping.row_filter.equals;
}

export function mapRow(mapping: ImportMapping, row: Any): Any {
  const output: Any = {};
  for (const rule of mapping.rules) setTarget(output, rule.target, evaluateExpression(rule.expression, row));
  return output;
}
