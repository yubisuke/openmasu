import type { Pool } from "pg";
import { withTenant } from "@open-mmp/runtime";
import type { AdminIdentity } from "./admin-auth.js";

type Any = Record<string, any>;
export type ReportFormat = "json" | "csv";

const metricColumns = [
  "metric_run_id", "metric_name", "metric_definition_version", "policy_versions",
  "input_received_at_watermark", "input_snapshot_id", "data_freshness",
  "value_state", "undefined_reason", "value_unscaled", "value_type",
  "currency", "amount_scale", "ratio_scale", "grouping",
] as const;

const differenceColumns = [
  "reconciliation_id", "input_snapshot_id", "external_snapshot_id",
  "difference_reason_code", "difference_reason_version", "matching_keys",
  "candidates", "exclusions", "windows", "joins", "freshness",
  "supersedes_reconciliation_id",
] as const;

function metricRow(artifact: Any): Any {
  return {
    metric_run_id: artifact.metric_run_id,
    metric_name: artifact.metric_name,
    metric_definition_version: artifact.metric_definition_version,
    policy_versions: [
      `rule_bundle:${artifact.rule_bundle_version}`,
      ...(artifact.fx_policy_version ? [`fx:${artifact.fx_policy_version}`] : []),
    ],
    input_received_at_watermark: artifact.input_received_at_watermark,
    input_snapshot_id: artifact.input_snapshot_id,
    data_freshness: artifact.data_freshness,
    value_state: artifact.value_state ?? "present",
    undefined_reason: artifact.undefined_reason ?? null,
    ...(artifact.value_unscaled === undefined ? {} : { value_unscaled: artifact.value_unscaled }),
    value_type: artifact.value_type,
    currency: artifact.currency ?? null,
    amount_scale: artifact.amount_scale ?? null,
    ratio_scale: artifact.ratio_scale ?? null,
    grouping: artifact.grouping?.dimensions ?? {},
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows: Any[], columns: readonly string[]): string {
  return `${[
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n")}\n`;
}

export async function metricReport(pool: Pool, identity: AdminIdentity): Promise<Any[]> {
  return withTenant(pool, identity.tenantId, async (client) => {
    const result = await client.query<{ artifact: Any }>(
      `SELECT artifact FROM ledger.metric_runs
       WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id`,
      [identity.tenantId, identity.appId],
    );
    return result.rows.map(({ artifact }) => metricRow(artifact));
  });
}

export async function differenceAudit(pool: Pool, identity: AdminIdentity): Promise<Any[]> {
  return withTenant(pool, identity.tenantId, async (client) => {
    const result = await client.query<{ artifact: Any }>(
      `SELECT artifact FROM ledger.reconciliation_results
       WHERE tenant_id=$1 AND app_id=$2 ORDER BY reconciliation_id`,
      [identity.tenantId, identity.appId],
    );
    return result.rows.map(({ artifact }) => artifact);
  });
}

export function encodeMetricReport(rows: Any[], format: ReportFormat): {
  contentType: string;
  body: string;
} {
  return format === "csv"
    ? { contentType: "text/csv; charset=utf-8", body: csv(rows, metricColumns) }
    : { contentType: "application/json", body: `${JSON.stringify({ data: rows })}\n` };
}

export function encodeDifferenceAudit(rows: Any[], format: ReportFormat): {
  contentType: string;
  body: string;
} {
  return format === "csv"
    ? { contentType: "text/csv; charset=utf-8", body: csv(rows, differenceColumns) }
    : { contentType: "application/json", body: `${JSON.stringify({ data: rows })}\n` };
}
