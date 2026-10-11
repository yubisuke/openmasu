import type { Pool } from "pg";
import { withTenant, uuidV7 } from "@openmasu/runtime";
import { ACQUISITION_KPI_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import type { AppAdminIdentity } from "./admin-auth.js";
import { assertRoleAllows } from "./authorization.js";
import { parseMetricQuery, ReportQueryError, type MetricQuery, groupingDimensionAllowlist } from "./report-query.js";
import { reportSelectionParams } from "./dashboard/report-controls.js";
import { recordDashboardAuditWithClient } from "./session.js";

export const dailyAnalysisMetrics = [...ACQUISITION_KPI_METRIC_DEFINITIONS.map(d => d.metric_name),
  "retention_d1", "retention_d3", "retention_d7", "retention_d14", "retention_d30"].sort();
const allowed = new Set(["metric_name", "metric_definition_version", "metric_schedule_id",
  "date_from", "date_to", "watermark_at_most", ...Object.keys(groupingDimensionAllowlist)
    .filter(key => !["cohort_date", "metric_date"].includes(key)).map(key => `grouping_${key}`)]);
export type SavedAnalysis = { view_id: string; name: string; selection: string; display: "all" | "exceptions"; created_at: string };

/** Reuse the ordinary report grammar, but never persist credentials, cursors, scopes or arbitrary settings. */
export function analysisQuery(scope: Pick<AppAdminIdentity, "tenantId" | "appId">, params: URLSearchParams): MetricQuery {
  if (params.toString().length > 4096 || [...params.keys()].some(key => !allowed.has(key))) {
    throw new ReportQueryError("analysis_filter_not_allowed");
  }
  const query = parseMetricQuery({ ...scope, searchParams: params }).query;
  if (!query.dateFrom || !query.dateTo || !query.watermarkAtMost) throw new ReportQueryError("analysis_dates_and_cutoff_required");
  const days = (Date.parse(query.dateTo) - Date.parse(query.dateFrom)) / 86_400_000;
  if (days < 1 || days > 366 || Date.parse(query.dateFrom) - days * 86_400_000 < Date.parse("0001-01-01")) {
    throw new ReportQueryError("analysis_period_limit");
  }
  return { ...query, metricNames: query.metricNames ?? dailyAnalysisMetrics, supersession: "latest" };
}

export function previousAnalysisQuery(query: MetricQuery): MetricQuery {
  const span = Date.parse(query.dateTo!) - Date.parse(query.dateFrom!);
  return { ...query, dateFrom: new Date(Date.parse(query.dateFrom!) - span).toISOString().slice(0, 10), dateTo: query.dateFrom };
}

export function savedAnalysisInput(identity: AppAdminIdentity, input: { name: string; selection: string; display: string }) {
  if (!input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name)
      || !["all", "exceptions"].includes(input.display)) throw new ReportQueryError("analysis_settings_invalid");
  const query = analysisQuery(identity, new URLSearchParams(input.selection));
  const params = reportSelectionParams(query); params.delete("supersession");
  return { name: input.name.trim(), selection: params.toString(), display: input.display as SavedAnalysis["display"] };
}

export async function listSavedAnalyses(pool: Pool, identity: AppAdminIdentity): Promise<SavedAnalysis[]> {
  return withTenant(pool, identity.tenantId, async client => (await client.query<SavedAnalysis>(
    `SELECT view_id,name,selection,display,created_at FROM control.saved_analysis_views
     WHERE tenant_id=$1 AND app_id=$2 ORDER BY created_at,view_id LIMIT 100`, [identity.tenantId, identity.appId])).rows);
}
export async function getSavedAnalysis(pool: Pool, identity: AppAdminIdentity, id: string): Promise<SavedAnalysis | undefined> {
  return withTenant(pool, identity.tenantId, async client => (await client.query<SavedAnalysis>(
    `SELECT view_id,name,selection,display,created_at FROM control.saved_analysis_views
     WHERE tenant_id=$1 AND app_id=$2 AND view_id=$3`, [identity.tenantId, identity.appId, id])).rows[0]);
}
export async function saveAnalysis(pool: Pool, identity: AppAdminIdentity, input: Parameters<typeof savedAnalysisInput>[1]): Promise<string> {
  assertRoleAllows(identity.role, "operate");
  const saved = savedAnalysisInput(identity, input), id = uuidV7();
  return withTenant(pool, identity.tenantId, async client => {
    // One small mutable configuration table; serialize its bounded per-app list.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["saved-analysis", identity.tenantId, identity.appId])]);
    const app = await client.query("SELECT app_id FROM control.apps WHERE tenant_id=$1 AND app_id=$2", [identity.tenantId, identity.appId]);
    if (!app.rowCount) throw new ReportQueryError("analysis_not_found");
    const count = await client.query<{ count: string }>("SELECT count(*) FROM control.saved_analysis_views WHERE tenant_id=$1 AND app_id=$2", [identity.tenantId, identity.appId]);
    if (Number(count.rows[0].count) >= 100) throw new ReportQueryError("analysis_view_limit");
    await client.query(`INSERT INTO control.saved_analysis_views (view_id,tenant_id,app_id,name,selection,display,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, identity.tenantId, identity.appId, saved.name, saved.selection, saved.display, new Date().toISOString()]);
    await recordDashboardAuditWithClient(client, { tenantId: identity.tenantId, appId: identity.appId,
      actorRef: `admin_key:${identity.keyId}`, action: "saved_analysis_created", targetScope: "app", targetRef: id, outcome: "succeeded" });
    return id;
  });
}
export async function deleteSavedAnalysis(pool: Pool, identity: AppAdminIdentity, id: string): Promise<boolean> {
  assertRoleAllows(identity.role, "operate");
  return withTenant(pool, identity.tenantId, async client => {
    const result = await client.query("DELETE FROM control.saved_analysis_views WHERE tenant_id=$1 AND app_id=$2 AND view_id=$3", [identity.tenantId, identity.appId, id]);
    if (!result.rowCount) return false;
    await recordDashboardAuditWithClient(client, { tenantId: identity.tenantId, appId: identity.appId,
      actorRef: `admin_key:${identity.keyId}`, action: "saved_analysis_deleted", targetScope: "app", targetRef: id, outcome: "succeeded" });
    return true;
  });
}
