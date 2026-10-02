import { createHash } from "node:crypto";
import { jcs } from "@openmasu/attribution-core";
import { parseSnapshot, comparisonDigest } from "./cohort-comparison.js";
import { groupingDimensionAllowlist, validateGrouping, type GroupingDimension } from "./report-query.js";
import { parseCsv, CsvFormatError } from "../../worker/src/import/source.js";
import { decimalToUnscaled } from "../../worker/src/import/cost.js";
import { parseExternalDeclaration, type ExternalRoasDeclaration } from "./external-calculation-declaration.js";

type Binding = { column: string; omit_if_empty?: true } | { constant: string };
type CsvMapping = { version: 1; source: string; conditions: ReturnType<typeof parseSnapshot>["conditions"]; external_calculation?: ExternalRoasDeclaration;
  grouping: Partial<Record<GroupingDimension, Binding>>;
  value: { column: string; input: "integer" | "decimal"; scale: number; currency: Binding;
    undefined?: { marker: string; reason: Binding } } };
export class AggregateCsvError extends Error {
  constructor(readonly code: string, readonly row_number: number | null = null) { super(code); }
}
export const csvLimits = { bytes: 4 * 1024 * 1024, rows: 10000 };
function object(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AggregateCsvError("mapping_invalid");
}
function closed(value: Record<string, any>, fields: readonly string[]) {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new AggregateCsvError("mapping_invalid");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new AggregateCsvError("mapping_invalid");
}
function binding(value: unknown, allowOmit = false): Binding {
  object(value);
  const column = Object.hasOwn(value, "column");
  closed(value, [column ? "column" : "constant", ...(Object.hasOwn(value, "omit_if_empty") ? ["omit_if_empty"] : [])]);
  text(value[column ? "column" : "constant"]);
  if (Object.hasOwn(value, "omit_if_empty") && (!column || !allowOmit || value.omit_if_empty !== true)) throw new AggregateCsvError("mapping_invalid");
  return structuredClone(value) as Binding;
}
function parseCsvMapping(input: unknown): CsvMapping {
  object(input); closed(input, ["version", "source", "conditions", "grouping", "value", ...(Object.hasOwn(input, "external_calculation") ? ["external_calculation"] : [])]);
  if (input.version !== 1) throw new AggregateCsvError("mapping_invalid");
  let base: ReturnType<typeof parseSnapshot>;
  try { base = parseSnapshot({ source: input.source, conditions: input.conditions, rows: [] }); }
  catch { throw new AggregateCsvError("mapping_conditions_invalid"); }
  object(input.grouping); const grouping: CsvMapping["grouping"] = {};
  for (const [key, value] of Object.entries(input.grouping)) {
    if (!Object.hasOwn(groupingDimensionAllowlist, key)) throw new AggregateCsvError("mapping_grouping_invalid");
    grouping[key as GroupingDimension] = binding(value, !["cohort_date", "metric_date", "attribution_status"].includes(key));
  }
  if (Boolean(grouping.cohort_date) === Boolean(grouping.metric_date)
      || (base.conditions.attribution_scope !== "all" && !grouping.attribution_status)) throw new AggregateCsvError("mapping_grouping_invalid");
  object(input.value); const value = input.value;
  closed(value, ["column", "input", "scale", "currency", ...(Object.hasOwn(value, "undefined") ? ["undefined"] : [])]);
  text(value.column);
  if (!["integer", "decimal"].includes(value.input) || !Number.isInteger(value.scale) || value.scale < 0 || value.scale > 18) throw new AggregateCsvError("mapping_units_invalid");
  const currency = binding(value.currency);
  let undefinedValue: CsvMapping["value"]["undefined"];
  if (Object.hasOwn(value, "undefined")) {
    object(value.undefined); closed(value.undefined, ["marker", "reason"]);
    if (typeof value.undefined.marker !== "string" || value.undefined.marker.length > 256) throw new AggregateCsvError("mapping_invalid");
    undefinedValue = { marker: value.undefined.marker, reason: binding(value.undefined.reason) };
  }
  let external: ExternalRoasDeclaration | undefined;
  if (Object.hasOwn(input, "external_calculation")) {
    try { external = parseExternalDeclaration(input.external_calculation); }
    catch { throw new AggregateCsvError("mapping_calculation_invalid"); }
    if (external.time_zone !== base.conditions.time_zone || external.aggregation !== base.conditions.aggregation
        || external.ratio_scale !== value.scale || !grouping.cohort_date
        || Object.keys(grouping).some(key => !external!.grouping_dimensions.includes(key as GroupingDimension))) throw new AggregateCsvError("mapping_calculation_mismatch");
  }
  return { version: 1, source: base.source, conditions: base.conditions, grouping, ...(external ? { external_calculation: external } : {}),
    value: { column: value.column, input: value.input, scale: value.scale, currency, ...(undefinedValue ? { undefined: undefinedValue } : {}) } };
}
function boundValue(row: Record<string, any>, value: Binding, rowNumber: number): string | undefined {
  if ("constant" in value) return value.constant;
  if (!Object.hasOwn(row, value.column)) throw new AggregateCsvError("column_missing", rowNumber);
  const result: string = row[value.column];
  return !result && value.omit_if_empty ? undefined : result;
}
/** Aggregate-only offline conversion. Declarations never become captured runtime evidence. */
export function aggregateCsvToSnapshot(bytes: Uint8Array, inputMapping: unknown) {
  if (bytes.byteLength > csvLimits.bytes) throw new AggregateCsvError("input_byte_limit");
  const mapping = parseCsvMapping(inputMapping);
  let sourceRows: Record<string, any>[];
  try { sourceRows = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes), true); }
  catch (error) {
    throw new AggregateCsvError(error instanceof CsvFormatError ? error.code : "csv_invalid", error instanceof CsvFormatError ? error.rowNumber : null);
  }
  if (!sourceRows.length) throw new AggregateCsvError("csv_empty");
  if (sourceRows.length > csvLimits.rows) throw new AggregateCsvError("input_row_limit");
  const seen = new Set<string>();
  const rows = sourceRows.map((row, index) => {
    const number = index + 2, grouping: Record<string, string> = {};
    for (const [key, expression] of Object.entries(mapping.grouping)) {
      const value = boundValue(row, expression!, number); if (value === undefined) continue;
      try { validateGrouping(key as GroupingDimension, value); } catch { throw new AggregateCsvError("grouping_invalid", number); }
      grouping[key] = value;
    }
    const day = grouping.cohort_date ?? grouping.metric_date;
    if (day < mapping.conditions.date_from || day >= mapping.conditions.date_to) throw new AggregateCsvError("date_outside_range", number);
    if ((grouping.attribution_status ?? "all") !== mapping.conditions.attribution_scope) throw new AggregateCsvError("attribution_scope_mismatch", number);
    const key = jcs(grouping);
    if (seen.has(key)) throw new AggregateCsvError("duplicate_grouping", number); seen.add(key);
    const currency = boundValue(row, mapping.value.currency, number)!;
    if (!/^(?:[A-Z]{3}|none)$/.test(currency)) throw new AggregateCsvError("currency_invalid", number);
    if (mapping.external_calculation && currency !== "none") throw new AggregateCsvError("external_units_mismatch", number);
    if (!Object.hasOwn(row, mapping.value.column)) throw new AggregateCsvError("column_missing", number);
    const raw: string = row[mapping.value.column];
    if (mapping.value.undefined && raw === mapping.value.undefined.marker) {
      const reason = boundValue(row, mapping.value.undefined.reason, number)!;
      if (!reason.trim() || reason.length > 256 || /[\u0000-\u001f]/.test(reason)) throw new AggregateCsvError("undefined_reason_missing", number);
      return { key, currency, scale: mapping.value.scale, state: "undefined" as const, reason };
    }
    const amount = raw.trim(); let value: string;
    if (mapping.value.input === "integer") {
      if (!/^-?[0-9]+$/.test(amount)) throw new AggregateCsvError("number_invalid", number);
      value = BigInt(amount).toString();
    } else {
      if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(amount)) throw new AggregateCsvError("number_invalid", number);
      try { value = BigInt(`${amount.startsWith("-") ? "-" : ""}${decimalToUnscaled(amount.replace(/^-/, ""), mapping.value.scale)}`).toString(); }
      catch { throw new AggregateCsvError("precision_exceeded", number); }
    }
    if (value.replace(/^-/, "").length > 100) throw new AggregateCsvError("integer_too_large", number);
    return { key, currency, scale: mapping.value.scale, state: "present" as const, value };
  });
  let output: ReturnType<typeof parseSnapshot>;
  try { output = parseSnapshot({ source: mapping.source, conditions: mapping.conditions, rows,
    ...(mapping.external_calculation ? { external_calculation: { declaration: mapping.external_calculation, declaration_sha256: comparisonDigest(mapping.external_calculation) } } : {}),
    mapping_provenance: { version: 1, format: "csv", interpretation: "operator_declared", row_count: rows.length,
      input_sha256: createHash("sha256").update(bytes).digest("hex"), mapping_sha256: comparisonDigest(mapping) } }); }
  catch { throw new AggregateCsvError("snapshot_invalid"); }
  if (Buffer.byteLength(jcs(output), "utf8") > csvLimits.bytes) throw new AggregateCsvError("output_byte_limit");
  return output;
}

