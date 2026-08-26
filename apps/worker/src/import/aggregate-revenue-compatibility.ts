import { readFileSync, statSync } from "node:fs";
import {
  MAX_AGGREGATE_REVENUE_PAGE_ROWS,
  MAX_AGGREGATE_REVENUE_RESPONSE_BYTES,
  normalizeMaxAggregateRevenue,
  validateMaxAggregateRevenueResponse,
} from "./max-revenue.js";

export type AggregateRevenueCompatibilityReport = {
  mode: "compatibility_report";
  persistence: "none";
  format: "json";
  rows: { read: number; selected: number; filtered: 0; accepted: number; rejected: number };
  rejections: Array<{
    reason_code: "aggregate_response_invalid" | "aggregate_row_invalid" | "aggregate_dimension_duplicate";
    count: number;
    fields: [];
  }>;
  compatibility: {
    report_version: "1.0.0";
    kind: "aggregate_revenue_report";
    status: "compatible" | "partially_compatible" | "not_compatible" | "not_evaluated";
    execution_ready: boolean;
    series_semantics: {
      source_series: "provider_reported_aggregate";
      subject_scope: "aggregate";
      cohort_eligible: false;
      separate_from_installation_revenue: true;
    };
    checks: Array<{
      code: "response_shape" | "aggregate_schema" | "retained_dimension_uniqueness" | "cohort_series_separation";
      status: "pass" | "warning" | "fail" | "not_evaluated";
      count: number;
    }>;
  };
  limitations: string[];
};

function report(options: {
  candidate?: unknown[];
  responseValid: boolean;
  maxRows?: number;
}): AggregateRevenueCompatibilityReport {
  const candidate = options.responseValid ? options.candidate : undefined;
  const rowsRead = candidate?.length ?? 0;
  let accepted = 0;
  let rowFailures = 0;
  if (candidate) {
    for (const row of candidate) {
      try {
        normalizeMaxAggregateRevenue({
          tenant_id: "compatibility-tenant",
          app_id: "compatibility-app",
          as_of: "2000-01-01T00:00:00.000Z",
        }, [row], { maxRows: options.maxRows ?? 100_000 });
        accepted += 1;
      } catch {
        rowFailures += 1;
      }
    }
  }
  let duplicateDimensions = 0;
  if (candidate && rowFailures === 0 && candidate.length > 0) {
    try {
      normalizeMaxAggregateRevenue({
        tenant_id: "compatibility-tenant",
        app_id: "compatibility-app",
        as_of: "2000-01-01T00:00:00.000Z",
      }, candidate, { maxRows: options.maxRows ?? 100_000 });
    } catch (error) {
      duplicateDimensions = error instanceof Error && error.message.includes("duplicate retained dimension") ? 1 : 0;
    }
  }
  const responseFailures = candidate ? 0 : 1;
  const evaluated = candidate !== undefined && rowsRead > 0;
  const status = !options.responseValid || candidate === undefined ? "not_compatible" as const
    : rowsRead === 0 ? "not_evaluated" as const
    : duplicateDimensions > 0 || accepted === 0 ? "not_compatible" as const
    : rowFailures > 0 ? "partially_compatible" as const
      : "compatible" as const;
  const rejections: AggregateRevenueCompatibilityReport["rejections"] = [
    ...(responseFailures > 0 ? [{ reason_code: "aggregate_response_invalid" as const, count: 1, fields: [] as [] }] : []),
    ...(rowFailures > 0 ? [{ reason_code: "aggregate_row_invalid" as const, count: rowFailures, fields: [] as [] }] : []),
    ...(duplicateDimensions > 0
      ? [{ reason_code: "aggregate_dimension_duplicate" as const, count: duplicateDimensions, fields: [] as [] }]
      : []),
  ];
  const schemaStatus = !evaluated ? "not_evaluated" as const
    : rowFailures === 0 ? "pass" as const
    : accepted === 0 ? "fail" as const : "warning" as const;
  return {
    mode: "compatibility_report",
    persistence: "none",
    format: "json",
    rows: { read: rowsRead, selected: rowsRead, filtered: 0, accepted, rejected: rowFailures },
    rejections,
    compatibility: {
      report_version: "1.0.0",
      kind: "aggregate_revenue_report",
      status,
      execution_ready: status === "compatible",
      series_semantics: {
        source_series: "provider_reported_aggregate",
        subject_scope: "aggregate",
        cohort_eligible: false,
        separate_from_installation_revenue: true,
      },
      checks: [
        { code: "response_shape", status: candidate ? "pass" : "fail", count: responseFailures },
        { code: "aggregate_schema", status: schemaStatus, count: rowFailures },
        {
          code: "retained_dimension_uniqueness",
          status: !evaluated ? "not_evaluated" : duplicateDimensions > 0 ? "fail" : "pass",
          count: duplicateDimensions,
        },
        { code: "cohort_series_separation", status: candidate ? "pass" : "not_evaluated", count: 0 },
      ],
    },
    limitations: [
      "provider_connectivity_not_checked",
      "database_snapshot_conflicts_not_checked",
      "metric_equivalence_not_checked",
    ],
  };
}

export function reportAggregateRevenueCompatibility(input: unknown, maxRows?: number): AggregateRevenueCompatibilityReport {
  try {
    const candidate = validateMaxAggregateRevenueResponse(input, maxRows ?? MAX_AGGREGATE_REVENUE_PAGE_ROWS);
    return report({ candidate, responseValid: true, maxRows });
  } catch {
    return report({ responseValid: false, maxRows });
  }
}

export function reportAggregateRevenueCompatibilityFile(options: {
  filePath: string;
  maxBytes?: number;
  maxRows?: number;
}): AggregateRevenueCompatibilityReport {
  const maxBytes = options.maxBytes ?? MAX_AGGREGATE_REVENUE_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("aggregate compatibility maxBytes is invalid");
  try {
    if (statSync(options.filePath).size > maxBytes) return report({ responseValid: false, maxRows: options.maxRows });
    return reportAggregateRevenueCompatibility(JSON.parse(readFileSync(options.filePath, "utf8")), options.maxRows);
  } catch {
    return report({ responseValid: false, maxRows: options.maxRows });
  }
}
