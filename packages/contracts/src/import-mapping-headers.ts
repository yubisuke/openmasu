import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { ImportMapping, MappingExpression } from "./import-mapping.js";

export const IMPORT_HEADER_LIMITS = { maxColumns: 256, maxColumnBytes: 256, maxManifestBytes: 65_536 } as const;

/** Private approval material: persist only inside the protected mapping definition. */
export type ImportHeaderManifest = { version: 1; columns: string[]; expectation_digest: string };
export type ImportHeaderComparison = {
  status: "unchanged" | "order_only" | "unknown_columns" | "columns_changed" | "required_sources_missing";
  approved_count: number;
  current_count: number;
  added_count: number;
  removed_count: number;
  /** Missing expression/filter requirements, not distinct source-column names. */
  required_sources_missing: number;
  expectation_changed: boolean;
  limitations: ["header_only_no_value_types_or_empty_distribution"];
};

export class ImportHeaderError extends Error {
  constructor(readonly code: "header_format_unsupported" | "header_invalid" | "header_limits_exceeded" | "header_manifest_invalid") {
    super(code);
  }
}

function checkedColumns(columns: readonly string[]): string[] {
  if (!Array.isArray(columns) || columns.length === 0) throw new ImportHeaderError("header_invalid");
  if (columns.length > IMPORT_HEADER_LIMITS.maxColumns) throw new ImportHeaderError("header_limits_exceeded");
  for (const column of columns) {
    if (typeof column !== "string" || !column || column !== column.trim() || /[\u0000-\u001f\u007f]/.test(column)) {
      throw new ImportHeaderError("header_invalid");
    }
    if (Buffer.byteLength(column, "utf8") > IMPORT_HEADER_LIMITS.maxColumnBytes) {
      throw new ImportHeaderError("header_limits_exceeded");
    }
  }
  if (new Set(columns).size !== columns.length) throw new ImportHeaderError("header_invalid");
  return [...columns];
}

function checkManifestBytes(manifest: ImportHeaderManifest): void {
  if (Buffer.byteLength(canonicalize(manifest), "utf8") > IMPORT_HEADER_LIMITS.maxManifestBytes) {
    throw new ImportHeaderError("header_limits_exceeded");
  }
}

function expectationDigest(mapping: ImportMapping): string {
  if (mapping.format !== "csv") throw new ImportHeaderError("header_format_unsupported");
  // Rule order can affect overlapping targets; canonicalize object keys, never reorder rules.
  return createHash("sha256").update(canonicalize({
    version: mapping.version, kind: mapping.kind, format: mapping.format,
    rules: mapping.rules, row_filter: mapping.row_filter ?? null,
  })).digest("hex");
}

export function createImportHeaderManifest(mapping: ImportMapping, columns: readonly string[]): ImportHeaderManifest {
  const manifest: ImportHeaderManifest = {
    version: 1, columns: checkedColumns(columns), expectation_digest: expectationDigest(mapping),
  };
  checkManifestBytes(manifest);
  return manifest;
}

const unknownValue = Symbol("header-present-value-unknown");
const empty = (value: unknown): boolean => value === undefined || value === null || value === "";

function missingRequirements(mapping: ImportMapping, columns: readonly string[]): number {
  const available = new Set(columns);
  // CSV rows are flat string maps. A literal dotted header is not a nested source path.
  const present = (source: string | undefined): boolean => !!source && !source.includes(".") && available.has(source);
  const inspect = (expression: MappingExpression): number => {
    if (expression.object) return Object.values(expression.object).reduce((sum, child) => sum + inspect(child), 0);
    let value: unknown = Object.hasOwn(expression, "const")
      ? expression.const : present(expression.source) ? unknownValue : undefined;
    if (empty(value) && expression.fallback_column) value = present(expression.fallback_column) ? unknownValue : undefined;
    if (empty(value) && Object.hasOwn(expression, "default")) value = expression.default;
    // A map runs before omit_if_empty, so an absent source without a matching/default map is not optional.
    if (expression.map && value !== unknownValue) {
      if (Object.hasOwn(expression.map, String(value))) value = expression.map[String(value)];
      else if (Object.hasOwn(expression, "map_default")) value = expression.map_default;
      else return 1;
    }
    if (expression.omit_if_empty && empty(value)) return 0;
    if (expression.boolean && value !== unknownValue) {
      const key = String(value).trim().toLowerCase();
      const includes = (values: unknown[]): boolean => values.some((item) => String(item).trim().toLowerCase() === key);
      if (includes(expression.boolean.true_values)) value = true;
      else if (includes(expression.boolean.false_values)) value = false;
      else if (expression.boolean.default !== undefined) value = expression.boolean.default;
      else if (value === undefined) return 1;
    }
    if (value === undefined) return 1;
    let missing = 0;
    if (expression.money?.currency_source && !expression.money.currency_default && !present(expression.money.currency_source)) {
      missing += 1;
    }
    // A configured timezone column has no runtime default fallback. With unknown row values,
    // require it conservatively; a known zoned constant/default does not need that column.
    const knownZone = typeof value === "string" && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value.trim());
    if (expression.timestamp?.timezone_source && !knownZone && !present(expression.timestamp.timezone_source)) missing += 1;
    return missing;
  };
  const filters = mapping.row_filter ? Array.isArray(mapping.row_filter) ? mapping.row_filter : [mapping.row_filter] : [];
  return mapping.rules.reduce((sum, rule) => sum + inspect(rule.expression), 0)
    + filters.filter((filter) => !present(filter.source)).length;
}

/** Counts-only metadata safe for reports. This is not row validation or approval of value semantics. */
export function compareImportHeaders(
  mapping: ImportMapping, approved: ImportHeaderManifest, columns: readonly string[],
): ImportHeaderComparison {
  if (!approved || approved.version !== 1 || !/^[a-f0-9]{64}$/.test(approved.expectation_digest)) {
    throw new ImportHeaderError("header_manifest_invalid");
  }
  const previous = checkedColumns(approved.columns);
  checkManifestBytes({ version: 1, columns: previous, expectation_digest: approved.expectation_digest });
  const current = createImportHeaderManifest(mapping, columns);
  const previousSet = new Set(previous);
  const currentSet = new Set(current.columns);
  const added = current.columns.filter((column) => !previousSet.has(column)).length;
  const removed = previous.filter((column) => !currentSet.has(column)).length;
  const missing = missingRequirements(mapping, current.columns);
  return {
    status: missing > 0 ? "required_sources_missing" : added > 0 ? "unknown_columns" : removed > 0 ? "columns_changed"
      : previous.some((column, index) => column !== current.columns[index]) ? "order_only" : "unchanged",
    approved_count: previous.length, current_count: current.columns.length, added_count: added, removed_count: removed,
    required_sources_missing: missing,
    expectation_changed: approved.expectation_digest !== current.expectation_digest,
    limitations: ["header_only_no_value_types_or_empty_distribution"],
  };
}
