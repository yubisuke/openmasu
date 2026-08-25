import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

export type FraudAuditRow = {
  readonly metric_date: string;
  readonly campaign_id: string;
  readonly network: string;
  readonly site_id: string;
  readonly remote_click_refs: readonly string[];
  readonly clicks: string;
  readonly installs: string;
  readonly suspected: string;
  readonly confirmed: string;
  readonly excluded: string;
  readonly quarantined: string;
};

export const fraudAuditColumns = [
  "metric_date", "campaign_id", "network", "site_id", "remote_click_refs",
  "clicks", "installs", "suspected", "confirmed", "excluded", "quarantined",
] as const;

export class FraudAuditQueryError extends Error {}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseFraudAuditQuery(params: URLSearchParams): {
  appId: string; from: string; to: string; format: "json" | "csv";
} {
  const allowed = new Set(["app_id", "from", "to", "format"]);
  for (const key of params.keys()) if (!allowed.has(key)) throw new FraudAuditQueryError("unknown_filter");
  const appId = params.get("app_id") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const format = params.get("format") ?? "json";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(appId)) throw new FraudAuditQueryError("app_id_invalid");
  if (!validDate(from) || !validDate(to) || from >= to) {
    throw new FraudAuditQueryError("date_range_invalid");
  }
  if (format !== "json" && format !== "csv") throw new FraudAuditQueryError("format_invalid");
  return { appId, from, to, format };
}

export async function fraudAudit(
  pool: Pool,
  identity: AppAdminIdentity,
  range: { from: string; to: string },
): Promise<readonly FraudAuditRow[]> {
  return withTenant(pool, identity.tenantId, async (client) => {
    const result = await client.query<FraudAuditRow>(
      `WITH latest_aggregate AS (
         SELECT DISTINCT ON (tenant_id,app_id,metric_date,campaign_id,network,site_id) *
         FROM ledger.source_day_aggregates
         WHERE tenant_id=$1 AND app_id=$2
           AND metric_date >= $3::date AND metric_date < $4::date
         ORDER BY tenant_id,app_id,metric_date,campaign_id,network,site_id,
           computed_at DESC,input_snapshot_id DESC
       ), latest_decision AS (
         SELECT decision.*
         FROM ledger.fraud_decisions decision
         WHERE decision.tenant_id=$1 AND decision.app_id=$2 AND decision.subject_scope='source'
           AND NOT EXISTS (
             SELECT 1 FROM ledger.fraud_decisions newer
             WHERE newer.tenant_id=decision.tenant_id AND newer.app_id=decision.app_id
               AND newer.supersedes_fraud_decision_id=decision.fraud_decision_id
           )
       )
       SELECT aggregate.metric_date::text,aggregate.campaign_id,aggregate.network,aggregate.site_id,
         coalesce(refs.remote_click_refs,'{}'::text[]) AS remote_click_refs,
         aggregate.clicks::text,aggregate.installs::text,
         count(decision.fraud_decision_id) FILTER (WHERE decision.decision='suspected')::text AS suspected,
         count(decision.fraud_decision_id) FILTER (WHERE decision.decision='confirmed')::text AS confirmed,
         count(decision.fraud_decision_id) FILTER (WHERE decision.action='exclude')::text AS excluded,
         count(decision.fraud_decision_id) FILTER (WHERE decision.action='quarantine')::text AS quarantined
       FROM latest_aggregate aggregate
       LEFT JOIN latest_decision decision
         ON decision.tenant_id=aggregate.tenant_id AND decision.app_id=aggregate.app_id
        AND decision.subject_scope='source'
        AND decision.subject_ref=concat('source:',aggregate.tenant_id,':',aggregate.app_id,':',
          aggregate.metric_date,':',aggregate.campaign_id,':',aggregate.network,':',aggregate.site_id)
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT click.remote_click_ref ORDER BY click.remote_click_ref)
           FILTER (WHERE click.remote_click_ref IS NOT NULL) AS remote_click_refs
         FROM ledger.click_facts click
         WHERE click.tenant_id=aggregate.tenant_id AND click.app_id=aggregate.app_id
           AND coalesce(click.campaign_id,'unattributed')=aggregate.campaign_id
           AND coalesce(click.network,'unattributed')=aggregate.network
           AND coalesce(click.site_id,'unattributed')=aggregate.site_id
           AND timezone('UTC',control.canonical_timestamp_value(click.redirector_click_at))::date=aggregate.metric_date
       ) refs ON true
       GROUP BY aggregate.metric_date,aggregate.campaign_id,aggregate.network,aggregate.site_id,
         aggregate.clicks,aggregate.installs,refs.remote_click_refs
       ORDER BY aggregate.metric_date,aggregate.campaign_id,aggregate.network,aggregate.site_id`,
      [identity.tenantId, identity.appId, range.from, range.to],
    );
    return result.rows;
  });
}

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function encodeFraudAudit(rows: readonly FraudAuditRow[], format: "json" | "csv"): {
  contentType: string; body: string;
} {
  if (format === "json") return { contentType: "application/json; charset=utf-8", body: JSON.stringify({ data: rows }) };
  const lines = [fraudAuditColumns.join(","), ...rows.map((row) =>
    fraudAuditColumns.map((column) => csvCell(row[column])).join(","))];
  return { contentType: "text/csv; charset=utf-8", body: `${lines.join("\r\n")}\r\n` };
}
