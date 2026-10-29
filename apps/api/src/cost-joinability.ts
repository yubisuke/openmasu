import type { Pool } from "pg";
import { costCoverageMatchesGrouping, selectDisjointCosts, type ScopedCost } from "@openmasu/attribution-core";
import { acquirePrivacyTenantSessionReadFence, selectedAcquisitionReportSql, selectedClickJoinSql } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { metricReportOnClient } from "./reporting.js";

export const costJoinabilityLimits = { days: 31, rows: 10000, metrics: 1000, schedules: 100, milliseconds: 5000 } as const;
export type CostJoinabilityQuery = { date_from: string; date_to: string; watermark_at_most: string };
const dimensions = ["network", "campaign_id", "ad_group_id", "creative_id", "country"] as const;
type Dimension = typeof dimensions[number];
export type AcquisitionDimensions = { date: string; status: string } & Record<Dimension, string | null>;
export type JoinabilityCost = ScopedCost & { reporting_time_zone?: string | null };
export class CostJoinabilityError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
export function parseCostJoinabilityQuery(params: URLSearchParams): CostJoinabilityQuery {
  const fields = ["date_from", "date_to", "watermark_at_most"];
  for (const key of params.keys()) if (!fields.includes(key)) throw new CostJoinabilityError("unknown_filter");
  if (fields.some(key => params.getAll(key).length !== 1)) throw new CostJoinabilityError("required_or_duplicate_filter");
  const from = params.get("date_from")!, to = params.get("date_to")!, cutoff = params.get("watermark_at_most")!;
  const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!day(from) || !day(to) || from >= to || Date.parse(to) - Date.parse(from) > costJoinabilityLimits.days * 86400000) {
    throw new CostJoinabilityError("date_range_invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)
      || !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff) throw new CostJoinabilityError("watermark_invalid");
  return { date_from: from, date_to: to, watermark_at_most: cutoff };
}

/** Keys retain the date and known parent IDs; matching names across networks cannot join. */
function dimensionKey(row: { date: string } & Partial<Record<Dimension, string | null>>, dimension: Dimension): string | undefined {
  const fields: Dimension[] = dimension === "country" ? ["network", "campaign_id", "country"]
    : dimensions.slice(0, dimensions.indexOf(dimension) + 1);
  return fields.some(field => !row[field]) ? undefined : JSON.stringify([row.date, ...fields.map(field => row[field])]);
}

/** Observations only: neither a denominator calculation nor a claim of provider completeness. */
export function projectCostJoinability(acquisition: readonly AcquisitionDimensions[], revisions: readonly JoinabilityCost[]) {
  if (acquisition.length > costJoinabilityLimits.rows || revisions.length > costJoinabilityLimits.rows) {
    throw new CostJoinabilityError("cost_joinability_source_limit", 413);
  }
  const costs = selectDisjointCosts(revisions, true).rows;
  const paid = acquisition.filter(row => row.status === "non_organic");
  const data = dimensions.map(dimension => {
    const a = new Set(paid.flatMap(row => { const key = dimensionKey(row, dimension); return key ? [key] : []; }));
    const c = new Set(costs.flatMap(row => { const key = dimensionKey(row, dimension); return key ? [key] : []; }));
    const both = [...a].filter(key => c.has(key)).length;
    return { dimension, both_observed_exact_key: both, acquisition_only: a.size - both, cost_only: c.size - both,
      missing_acquisition_dimension: paid.filter(row => !dimensionKey(row, dimension)).length,
      missing_cost_dimension: costs.filter(row => !dimensionKey(row, dimension)).length,
      state: !a.size && !c.size ? "neither_observed" : both ? "both_observed"
        : a.size && c.size ? "no_exact_key_match" : a.size ? "acquisition_only" : "cost_only" };
  });
  // Keep unrestricted parent coverage separate from explicitly selected children.
  const unrestricted = selectDisjointCosts(revisions, true, cost => costCoverageMatchesGrouping(cost, undefined, false));
  return { native_installations: acquisition.length, non_organic_installations: paid.length,
    other_or_unrecorded_installations: acquisition.length - paid.length, current_cost_rows: costs.length, dimensions: data,
    coverage: {
      parent_grain: costs.filter(row => !row.ad_group_id && !row.creative_id).length,
      ad_group_grain: costs.filter(row => row.ad_group_id && !row.creative_id).length,
      creative_grain: costs.filter(row => row.creative_id).length,
      coverage_not_declared: costs.filter(row => row.coverage_scope == null).length,
      selected_child_requires_exact_detail: costs.filter(row => row.coverage_scope === "matching_detail_only").length,
      overlapping_unrestricted_grains: unrestricted.overlapping,
      reporting_time_zone_unknown: costs.filter(row => !row.reporting_time_zone).length,
      reporting_time_zone_not_utc: costs.filter(row => row.reporting_time_zone && row.reporting_time_zone !== "UTC").length,
    } };
}

type Receipt = { cost_schedule_id: string; state: string; last_outcome: string | null; last_row_count: number | null;
  last_since: string | null; last_until: string | null; last_success_at: string | null; safe_reason: string | null;
  provider: string | null; grain: string | null; coverage: string | null; creative_binding: string | null };
export type CostJoinabilityReport = ReturnType<typeof projectCostJoinability> & {
  selection: CostJoinabilityQuery & { app_id: string; time_zone: "UTC" };
  acquisition_basis: "selected_first_party_click"; privacy: "current"; upstream_completeness: "unknown";
  saved_metric_reasons: { reason: string; count: number }[];
  current_receipts: { temporal_scope: "current_not_as_of_cutoff"; data: Receipt[] };
};

export async function costJoinabilityReport(pool: Pool, identity: AppAdminIdentity, query: CostJoinabilityQuery): Promise<CostJoinabilityReport> {
  const client = await pool.connect();
  let fence: (() => Promise<void>) | undefined, transaction = false, previousTimeout: string | undefined;
  try {
    previousTimeout = (await client.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
    await client.query("SELECT set_config('statement_timeout',$1,false)", [String(costJoinabilityLimits.milliseconds)]);
    fence = await acquirePrivacyTenantSessionReadFence(client, identity.tenantId);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [identity.tenantId]);
    const pending = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
    if (pending.rows[0]?.pending_count !== "0") throw new CostJoinabilityError("cost_joinability_privacy_pending", 409);
    const scope = [identity.tenantId, identity.appId, query.watermark_at_most, query.date_from, query.date_to];
    const acquisition = await client.query<{ cohort_count: number; observations: AcquisitionDimensions[] }>(
      `WITH cohort AS MATERIALIZED (
         SELECT install.installation_id,install.logical_event_id FROM ledger.install_facts install
         JOIN ledger.logical_events logical USING (logical_event_id,tenant_id,app_id)
         JOIN ledger.raw_records_current raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
         WHERE install.tenant_id=$1 AND install.app_id=$2 AND logical.producer NOT LIKE 'import:%'
           AND raw.received_at_ts<=$3::text::timestamptz AND raw.payload_lifecycle_status='available'
           AND timezone('UTC',install.occurred_at_ts)::date >= $4::date AND timezone('UTC',install.occurred_at_ts)::date < $5::date
         LIMIT $6
       ), acquisition AS (${selectedAcquisitionReportSql}), observations AS (
       SELECT timezone('UTC',install.occurred_at_ts)::date::text AS date,
         CASE WHEN acquisition.status='non_organic' THEN 'non_organic' ELSE 'other_or_unrecorded' END AS status,
         acquisition_source.network,acquisition_source.campaign_id,acquisition_source.ad_group_id,acquisition_source.creative_id,install.country
       FROM cohort JOIN ledger.install_facts install USING (installation_id,logical_event_id)
       JOIN ledger.logical_events logical USING (logical_event_id,tenant_id,app_id)
       ${selectedClickJoinSql("$7", "$8")}
       WHERE install.tenant_id=$1 AND install.app_id=$2
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(acquisition.artifact->'evidence_refs','[]'::jsonb)) ref
           JOIN ledger.raw_records_current evidence ON evidence.tenant_id=$1 AND evidence.app_id=$2 AND evidence.record_id=ref->>'ref'
           WHERE evidence.payload_lifecycle_status<>'available')
       ) SELECT (SELECT count(*)::integer FROM cohort) AS cohort_count,
         coalesce(jsonb_agg(to_jsonb(observations)), '[]'::jsonb) AS observations FROM observations`,
      [...scope, costJoinabilityLimits.rows + 1, true, "after"],
    );
    // Read all bounded visible revisions; the shared pure selector chooses latest
    // before applying coverage. No current-view shortcut can leak later costs.
    const costs = await client.query<JoinabilityCost>(
      `SELECT tenant_id,app_id,cost_record_id,as_of,network,campaign_id,ad_group_id,country,cost_date::text AS date,
         artifact->>'creative_id' AS creative_id,artifact->>'coverage_scope' AS coverage_scope,
         artifact->>'reporting_time_zone' AS reporting_time_zone
       FROM ledger.cost_records WHERE tenant_id=$1 AND app_id=$2 AND as_of<=$3
         AND cost_date >= $4::date AND cost_date < $5::date LIMIT $6`, [...scope, costJoinabilityLimits.rows + 1]);
    if (acquisition.rows[0].cohort_count > costJoinabilityLimits.rows) throw new CostJoinabilityError("cost_joinability_source_limit", 413);
    const projection = projectCostJoinability(acquisition.rows[0].observations, costs.rows);
    const page = await metricReportOnClient(client, { tenantId: identity.tenantId, appId: identity.appId,
      dateFrom: query.date_from, dateTo: query.date_to, watermarkAtMost: query.watermark_at_most,
      supersession: "latest", limit: costJoinabilityLimits.metrics });
    if (page.next_cursor) throw new CostJoinabilityError("cost_joinability_metric_limit", 413);
    const reasons = new Map<string, number>();
    for (const row of page.data) {
      if (row.comparison_context?.definition.acquisition_basis !== "selected_first_party_click") continue;
      const reason = row.unavailable_reason ?? row.undefined_reason;
      const safe = reason && ["no_attributed_cost", "overlapping_cost_grains", "missing_fx_rate", "privacy_deletion"].includes(reason) ? reason : undefined;
      if (safe) reasons.set(safe, (reasons.get(safe) ?? 0) + 1);
    }
    const receipts = await client.query<Receipt>(
      `SELECT schedule.cost_schedule_id,checkpoint.state,checkpoint.last_outcome,checkpoint.last_row_count,
         checkpoint.last_since::text,checkpoint.last_until::text,checkpoint.last_success_at,
         CASE WHEN checkpoint.safe_reason IN ('reauth_required','credentials_unavailable','source_unavailable','source_invalid','source_rejected','acquisition_timeout','retry_exhausted','acquisition_limit')
           THEN checkpoint.safe_reason WHEN checkpoint.safe_reason IS NULL THEN NULL ELSE 'other_recorded_failure' END AS safe_reason,
         CASE WHEN schedule.adapter_capability->>'provider' IN ('google_ads','apple_ads') THEN schedule.adapter_capability->>'provider' END AS provider,
         CASE WHEN schedule.adapter_capability->>'grain' IN ('campaign','provider_partitioned','ad_group','ad') THEN schedule.adapter_capability->>'grain' END AS grain,
         CASE WHEN schedule.adapter_capability->>'coverage' IN ('provider_partitioned','explicit_selection') THEN schedule.adapter_capability->>'coverage' END AS coverage,
         CASE WHEN schedule.adapter_capability->>'creative_binding' IN ('operator_explicit','not_provided') THEN schedule.adapter_capability->>'creative_binding' END AS creative_binding
       FROM control.cost_schedules_current schedule JOIN control.cost_schedule_checkpoints checkpoint USING (tenant_id,app_id,cost_schedule_id)
       WHERE schedule.tenant_id=$1 AND schedule.app_id=$2 ORDER BY schedule.cost_schedule_id COLLATE "C" LIMIT $3`,
      [identity.tenantId, identity.appId, costJoinabilityLimits.schedules + 1]);
    if (receipts.rows.length > costJoinabilityLimits.schedules) throw new CostJoinabilityError("cost_joinability_schedule_limit", 413);
    await client.query("COMMIT"); transaction = false;
    return { selection: { app_id: identity.appId, ...query, time_zone: "UTC" }, acquisition_basis: "selected_first_party_click",
      privacy: "current", upstream_completeness: "unknown", ...projection,
      saved_metric_reasons: [...reasons].sort(([a], [b]) => a.localeCompare(b, "en")).map(([reason, count]) => ({ reason, count })),
      current_receipts: { temporal_scope: "current_not_as_of_cutoff", data: receipts.rows } };
  } catch (error) {
    if (error instanceof CostJoinabilityError) throw error;
    throw new CostJoinabilityError("cost_joinability_unavailable", 503);
  } finally {
    let failed: Error | undefined;
    try {
      if (transaction) await client.query("ROLLBACK");
      if (fence) await fence();
      if (previousTimeout !== undefined) await client.query("SELECT set_config('statement_timeout',$1,false)", [previousTimeout]);
    } catch { failed = new Error("cost_joinability_cleanup_failed"); }
    client.release(failed);
    if (failed) throw new CostJoinabilityError("cost_joinability_unavailable", 503);
  }
}
