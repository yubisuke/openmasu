import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportMapping, MappingExpression } from "./mapping.js";

export type ImportCompatibilityStatus =
  | "compatible"
  | "partially_compatible"
  | "not_compatible"
  | "not_evaluated";

export type ImportCompatibilityCheck = {
  code: "rows_selected" | "mapping_transform" | "contract_schema" | "event_id_namespace";
  status: "pass" | "warning" | "fail" | "not_evaluated";
  count: number;
};

export type ImportCompatibilityReport = {
  report_version: "1.0.0";
  status: ImportCompatibilityStatus;
  event_name: { mode: "constant" | "row_derived"; value?: string };
  field_coverage: {
    declared_target_fields: string[];
    required_target_fields: string[];
    missing_required_target_fields: string[];
    unmapped_optional_schema_fields: string[];
    evidence_coverage: Array<{
      field: string;
      state: "observed" | "absent" | "unmapped";
      count: number;
    }>;
  };
  checks: ImportCompatibilityCheck[];
};

type PreviewRows = { selected: number; accepted: number; rejected: number };
type PreviewRejection = { reason_code: string; count: number };

function expressionTargets(target: string, expression: MappingExpression): string[] {
  const children = Object.entries(expression.object ?? {});
  if (children.length === 0) return [target];
  return children.flatMap(([name, child]) => expressionTargets(`${target}.${name}`, child));
}

export function declaredMappingTargetFields(mapping: ImportMapping): string[] {
  return [...new Set(mapping.rules.flatMap(({ target, expression }) => expressionTargets(target, expression)))].sort();
}

function eventSchemaFields(eventName: string | undefined): { required: string[]; optional: string[] } {
  if (!eventName) return { required: ["event_id", "event_name", "occurred_at"], optional: [] };
  const path = join(process.cwd(), "schemas", "events", `${eventName.replaceAll("_", "-")}.schema.json`);
  const schema = JSON.parse(readFileSync(path, "utf8")) as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  const requiredPayload = new Set((schema.required ?? []).filter((field) => field !== "event_name"));
  return {
    required: [
      "event_id",
      "event_name",
      "occurred_at",
      ...[...requiredPayload].map((field) => `payload.${field}`),
    ].sort(),
    optional: Object.keys(schema.properties ?? {})
      .filter((field) => field !== "event_name" && !requiredPayload.has(field))
      .map((field) => `payload.${field}`)
      .sort(),
  };
}

function rejectionCount(rejections: readonly PreviewRejection[], reasons: readonly string[]): number {
  const selected = new Set(reasons);
  return rejections
    .filter(({ reason_code }) => selected.has(reason_code))
    .reduce((total, { count }) => total + count, 0);
}

export function buildImportCompatibilityReport(options: {
  mapping: ImportMapping;
  rows: PreviewRows;
  warningCount: number;
  eventIdNamespaceEvaluated: boolean;
  rejections: readonly PreviewRejection[];
  observedFieldCounts: ReadonlyMap<string, number>;
}): ImportCompatibilityReport {
  const constantEventName = options.mapping.rules
    .find(({ target }) => target === "event_name")?.expression.const;
  const eventName = typeof constantEventName === "string" ? constantEventName : undefined;
  const declared = declaredMappingTargetFields(options.mapping);
  const schemaFields = eventSchemaFields(eventName);
  const declaredSet = new Set(declared);
  const isDeclared = (field: string): boolean => declaredSet.has(field) || declared.some((value) => value.startsWith(`${field}.`));
  const missingRequired = schemaFields.required.filter((field) => !isDeclared(field));
  const unmappedOptional = schemaFields.optional.filter((field) => !isDeclared(field));
  const mappingFailures = rejectionCount(options.rejections, ["mapping_validation_failed", "timestamp_invalid"]);
  const schemaFailures = rejectionCount(options.rejections, ["row_schema_invalid"]);
  const evaluated = options.rows.selected > 0;

  const checks: ImportCompatibilityCheck[] = [
    {
      code: "rows_selected",
      status: evaluated ? "pass" : "not_evaluated",
      count: options.rows.selected,
    },
    {
      code: "mapping_transform",
      status: !evaluated ? "not_evaluated"
        : mappingFailures === 0 ? "pass"
        : mappingFailures === options.rows.selected ? "fail" : "warning",
      count: mappingFailures,
    },
    {
      code: "contract_schema",
      status: !evaluated ? "not_evaluated"
        : schemaFailures === 0 && missingRequired.length === 0 ? "pass"
        : options.rows.accepted === 0 ? "fail" : "warning",
      count: schemaFailures,
    },
    {
      code: "event_id_namespace",
      status: !options.eventIdNamespaceEvaluated ? "not_evaluated"
        : options.warningCount === 0 ? "pass" : "warning",
      count: options.warningCount,
    },
  ];

  const status: ImportCompatibilityStatus = !evaluated ? "not_evaluated"
    : options.rows.accepted === 0 ? "not_compatible"
    : options.rows.rejected > 0 || options.warningCount > 0 || missingRequired.length > 0
      ? "partially_compatible" : "compatible";

  return {
    report_version: "1.0.0",
    status,
    event_name: eventName ? { mode: "constant", value: eventName } : { mode: "row_derived" },
    field_coverage: {
      declared_target_fields: declared,
      required_target_fields: schemaFields.required,
      missing_required_target_fields: missingRequired,
      unmapped_optional_schema_fields: unmappedOptional,
      evidence_coverage: [
        ...declared.map((field) => {
          const count = options.observedFieldCounts.get(field) ?? 0;
          return { field, state: count > 0 ? "observed" as const : "absent" as const, count };
        }),
        ...[...missingRequired, ...unmappedOptional]
          .filter((field, index, fields) => fields.indexOf(field) === index)
          .sort()
          .map((field) => ({ field, state: "unmapped" as const, count: 0 })),
      ].sort((left, right) => left.field.localeCompare(right.field)),
    },
    checks,
  };
}
