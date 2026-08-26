import { prepareCostImportRows, type CostInput } from "./cost.js";
import { CostInputError, normalizeCostInput, type CostInputRejectionCode } from "./cost-cli.js";
import { declaredMappingTargetFields, type ImportCompatibilityStatus } from "./compatibility.js";
import { loadMapping, mapRow, MappingError, rowMatches, type ImportMapping } from "./mapping.js";
import { readRows, type ImportLimits } from "./source.js";

type Any = Record<string, any>;

export type ManualCostRejectionCode =
  | "mapping_validation_failed"
  | "timestamp_invalid"
  | CostInputRejectionCode
  | "cost_dimension_duplicate";

export type ManualCostRejection = {
  reason_code: ManualCostRejectionCode;
  count: number;
  fields: string[];
};

export type ManualCostCompatibilityReport = {
  report_version: "1.0.0";
  kind: "manual_cost";
  status: ImportCompatibilityStatus;
  execution_ready: boolean;
  field_coverage: {
    declared_target_fields: string[];
    required_target_fields: string[];
    optional_target_fields: string[];
    missing_required_target_fields: string[];
    evidence_coverage: Array<{
      field: string;
      state: "observed" | "absent" | "unmapped";
      count: number;
    }>;
  };
  money: {
    input: "integer" | "decimal";
    scale: number;
    currency_origin: "source" | "default" | "missing";
  };
  checks: Array<{
    code: "rows_selected" | "mapping_transform" | "cost_schema" | "retained_dimension_uniqueness";
    status: "pass" | "warning" | "fail" | "not_evaluated";
    count: number;
  }>;
};

export type ManualCostCompatibilityAnalysis = {
  mapping: ImportMapping;
  rows: { read: number; selected: number; filtered: number; accepted: number; rejected: number };
  rejections: ManualCostRejection[];
  observedFieldCounts: ReadonlyMap<string, number>;
  duplicateDimensions: number;
};

const requiredFields = [
  "as_of",
  "date",
  "money.amount_scale",
  "money.amount_unscaled",
  "money.currency",
  "network",
].sort();
const optionalFields = ["ad_group_id", "campaign_id", "country"].sort();

function expandedDeclaredFields(mapping: ImportMapping): string[] {
  const declared = declaredMappingTargetFields(mapping);
  return [...new Set(declared.flatMap((field) => field === "money"
    ? ["money.amount_scale", "money.amount_unscaled", "money.currency"]
    : [field]))].sort();
}

function costFieldValue(row: CostInput, field: string): unknown {
  if (field === "money.amount_unscaled") return row.amount_unscaled;
  if (field === "money.amount_scale") return row.amount_scale;
  if (field === "money.currency") return row.currency;
  return (row as Any)[field];
}

function groupRejections(values: Array<{ reason_code: ManualCostRejectionCode; fields: string[] }>): ManualCostRejection[] {
  const groups = new Map<string, ManualCostRejection>();
  for (const value of values) {
    const fields = [...new Set(value.fields)].sort();
    const key = `${value.reason_code}:${fields.join(",")}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { ...value, fields, count: 1 });
  }
  return [...groups.values()].sort((left, right) => left.reason_code.localeCompare(right.reason_code));
}

export function analyzeManualCostImport(options: {
  mappingPath: string;
  filePath: string;
  limits?: ImportLimits;
}): ManualCostCompatibilityAnalysis {
  const mapping = loadMapping(options.mappingPath);
  if (mapping.kind !== "manual_cost") throw new Error("manual cost compatibility requires a manual_cost mapping");
  const loaded = readRows(options.filePath, mapping, options.limits ?? {
    maxBytes: 4 * 1024 * 1024 * 1024,
    maxRows: 20_000_000,
    maxRowBytes: 64 * 1024,
  });
  const selectedRows = loaded.rows.filter((row) => rowMatches(mapping, row));
  const acceptedRows: CostInput[] = [];
  const rawRejections: Array<{ reason_code: ManualCostRejectionCode; fields: string[] }> = [];
  for (const row of selectedRows) {
    try {
      acceptedRows.push(normalizeCostInput(mapping, mapRow(mapping, row)));
    } catch (error) {
      if (error instanceof CostInputError) {
        rawRejections.push({ reason_code: error.code, fields: error.fields });
      } else {
        const mappingError = error instanceof MappingError ? error : new MappingError("row mapping failed");
        rawRejections.push({
          reason_code: mappingError.message.includes("timestamp") ? "timestamp_invalid" : "mapping_validation_failed",
          fields: [],
        });
      }
    }
  }

  let duplicateDimensions = 0;
  if (acceptedRows.length > 0) {
    try {
      prepareCostImportRows(acceptedRows);
    } catch {
      duplicateDimensions = 1;
      rawRejections.push({ reason_code: "cost_dimension_duplicate", fields: [] });
    }
  }
  const observedFieldCounts = new Map<string, number>();
  for (const row of acceptedRows) {
    for (const field of [...requiredFields, ...optionalFields]) {
      const value = costFieldValue(row, field);
      if (value !== undefined && value !== null && value !== "") {
        observedFieldCounts.set(field, (observedFieldCounts.get(field) ?? 0) + 1);
      }
    }
  }
  return {
    mapping,
    rows: {
      read: loaded.rows.length,
      selected: selectedRows.length,
      filtered: loaded.rows.length - selectedRows.length,
      accepted: acceptedRows.length,
      rejected: selectedRows.length - acceptedRows.length,
    },
    rejections: groupRejections(rawRejections),
    observedFieldCounts,
    duplicateDimensions,
  };
}

export function buildManualCostCompatibilityReport(
  analysis: ManualCostCompatibilityAnalysis,
): ManualCostCompatibilityReport {
  const declared = expandedDeclaredFields(analysis.mapping);
  const declaredSet = new Set(declared);
  const missingRequired = requiredFields.filter((field) => !declaredSet.has(field));
  const evaluated = analysis.rows.selected > 0;
  const mappingFailures = analysis.rejections
    .filter(({ reason_code }) => reason_code === "mapping_validation_failed" || reason_code === "timestamp_invalid")
    .reduce((sum, { count }) => sum + count, 0);
  const schemaFailures = analysis.rejections
    .filter(({ reason_code }) => reason_code.startsWith("cost_") && reason_code !== "cost_dimension_duplicate")
    .reduce((sum, { count }) => sum + count, 0);
  const status: ImportCompatibilityStatus = !evaluated ? "not_evaluated"
    : analysis.duplicateDimensions > 0 || analysis.rows.accepted === 0 ? "not_compatible"
    : analysis.rows.rejected > 0 || missingRequired.length > 0 ? "partially_compatible"
      : "compatible";
  const checkStatus = (failures: number): "pass" | "warning" | "fail" | "not_evaluated" => !evaluated
    ? "not_evaluated"
    : failures === 0 ? "pass"
    : analysis.rows.accepted === 0 ? "fail" : "warning";
  const money = analysis.mapping.rules.find(({ target }) => target === "money")?.expression.money;
  return {
    report_version: "1.0.0",
    kind: "manual_cost",
    status,
    execution_ready: status === "compatible",
    field_coverage: {
      declared_target_fields: declared,
      required_target_fields: requiredFields,
      optional_target_fields: optionalFields,
      missing_required_target_fields: missingRequired,
      evidence_coverage: [...requiredFields, ...optionalFields].sort().map((field) => {
        const count = analysis.observedFieldCounts.get(field) ?? 0;
        return {
          field,
          state: !declaredSet.has(field) ? "unmapped" as const
            : count > 0 ? "observed" as const : "absent" as const,
          count,
        };
      }),
    },
    money: {
      input: money?.input ?? "integer",
      scale: money?.scale ?? 0,
      currency_origin: money?.currency_source ? "source"
        : money?.currency_default ? "default" : "missing",
    },
    checks: [
      { code: "rows_selected", status: evaluated ? "pass" : "not_evaluated", count: analysis.rows.selected },
      { code: "mapping_transform", status: checkStatus(mappingFailures), count: mappingFailures },
      { code: "cost_schema", status: checkStatus(schemaFailures + missingRequired.length), count: schemaFailures },
      {
        code: "retained_dimension_uniqueness",
        status: !evaluated ? "not_evaluated" : analysis.duplicateDimensions > 0 ? "fail" : "pass",
        count: analysis.duplicateDimensions,
      },
    ],
  };
}
