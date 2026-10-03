import type { PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";

type Any = Record<string, any>;
type Queryable = Pick<PoolClient, "query">;
type Scope = { tenant_id: string; app_id: string };

// Do not filter lifecycle or campaign/date before choosing the latest open:
// a removed or differently grouped winner must not transfer credit backwards.
const opensSql = `
  SELECT deep.tenant_id,deep.app_id,deep.installation_id,deep.tracking_link_id,deep.campaign_id,
    deep.occurred_at_ts AS opened_at,raw.record_id,raw.payload_lifecycle_status,
    attribution.attribution_id,attribution.artifact AS attribution
  FROM ledger.deep_link_open_facts AS deep
  JOIN ledger.logical_events AS logical
    ON logical.logical_event_id=deep.logical_event_id AND logical.tenant_id=deep.tenant_id AND logical.app_id=deep.app_id
  JOIN ledger.raw_records_current AS raw
    ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
  JOIN LATERAL (
    SELECT candidate.attribution_id,candidate.status,candidate.method,candidate.artifact
    FROM ledger.attribution_results AS candidate
    WHERE candidate.tenant_id=deep.tenant_id AND candidate.app_id=deep.app_id
      AND candidate.subject_scope='engagement_level' AND candidate.subject_ref='engagement:' || raw.record_id
      AND candidate.decided_at <= $3 AND candidate.artifact->>'input_cutoff_at' <= $3
    ORDER BY candidate.decided_at DESC,candidate.attribution_id COLLATE "C" ASC LIMIT 1
  ) AS attribution ON true
  WHERE deep.tenant_id=$1 AND deep.app_id=$2 AND raw.received_at <= $3
    AND deep.campaign_id IS NOT NULL AND deep.campaign_id<>''
    AND attribution.status='non_organic' AND attribution.method='deep_link'`;

export async function engagementSnapshotRows(client: Queryable, scope: Scope, watermark: string): Promise<unknown[][]> {
  const result = await client.query<Any>(opensSql, [scope.tenant_id, scope.app_id, watermark]);
  return result.rows.sort((a, b) => a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0)
    .map(row => [row.tenant_id, row.app_id, row.record_id, row.tracking_link_id, row.campaign_id,
      row.attribution_id, sha256(row.attribution)]);
}

export async function engagementMetricValue(
  client: Queryable, scope: Scope, watermark: string, grouping: Any,
  definition: Any, fxPolicy: Any, privacyState: "before" | "after",
): Promise<{ value_state: "present"; value_unscaled: string } | { value_state: "undefined"; undefined_reason: "empty_cohort" }> {
  if (typeof grouping?.metric_date !== "string" || Object.keys(grouping).some(key => !["metric_date", "campaign_id"].includes(key))) {
    throw new Error("engagement_metric_requires_anchor_date");
  }
  if (definition.value_type === "money" && (fxPolicy.target_currency !== definition.currency || fxPolicy.target_scale !== definition.amount_scale)) {
    throw new Error("engagement_metric_fx_target_mismatch");
  }
  const result = await client.query<{ population: string; value_unscaled: string; missing_fx: string }>(
    `WITH opens AS MATERIALIZED (${opensSql}),
     population AS (
       SELECT count(DISTINCT installation_id)::text AS count FROM opens
       WHERE timezone('UTC',opened_at)::date=$4::date AND ($5::text IS NULL OR campaign_id=$5)
         AND ($6::text='before' OR payload_lifecycle_status='available')
     ), outcomes AS (
       SELECT logical.event_name,coalesce(custom.installation_id,revenue.installation_id) AS installation_id,
         control.canonical_timestamp_value(raw.occurred_at) AS occurred_at,
         revenue.amount_unscaled,revenue.amount_scale,revenue.currency
       FROM ledger.logical_events AS logical
       JOIN ledger.raw_records_current AS raw
         ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
       LEFT JOIN ledger.custom_event_facts AS custom
         ON custom.logical_event_id=logical.logical_event_id AND custom.tenant_id=logical.tenant_id AND custom.app_id=logical.app_id
       LEFT JOIN ledger.ad_revenue_facts AS revenue
         ON revenue.logical_event_id=logical.logical_event_id AND revenue.tenant_id=logical.tenant_id AND revenue.app_id=logical.app_id
       WHERE logical.tenant_id=$1 AND logical.app_id=$2 AND raw.received_at <= $3
         AND ($6::text='before' OR raw.payload_lifecycle_status='available')
         AND (($7::text='converted_installations' AND logical.event_name='custom_event' AND custom.event_key=$8::text)
           OR ($7::text='revenue_sum' AND logical.event_name='ad_revenue' AND revenue.installation_id IS NOT NULL))
     ), credited AS (
       SELECT outcome.* FROM outcomes AS outcome
       JOIN LATERAL (
         SELECT candidate.* FROM opens AS candidate
         WHERE candidate.installation_id=outcome.installation_id AND candidate.opened_at <= outcome.occurred_at
         ORDER BY candidate.opened_at DESC,candidate.record_id COLLATE "C" ASC LIMIT 1
       ) AS chosen ON true
       WHERE outcome.occurred_at < chosen.opened_at + interval '24 hours'
         AND timezone('UTC',chosen.opened_at)::date=$4::date AND ($5::text IS NULL OR chosen.campaign_id=$5)
         AND ($6::text='before' OR chosen.payload_lifecycle_status='available')
     ), totals AS (
       SELECT CASE WHEN $7::text='converted_installations' THEN count(DISTINCT installation_id)::numeric
         ELSE coalesce(sum(ledger.half_even_div(credited.amount_unscaled::numeric * rate.rate_unscaled::numeric * power(10::numeric,$10::int),
           power(10::numeric,credited.amount_scale+rate.rate_scale))),0) END::text AS value_unscaled,
         count(*) FILTER (WHERE $7::text='revenue_sum' AND rate.rate_unscaled IS NULL)::text AS missing_fx
       FROM credited LEFT JOIN jsonb_to_recordset($9::jsonb) AS rate(currency text,rate_unscaled text,rate_scale integer)
         ON credited.currency=rate.currency
     ) SELECT population.count AS population,totals.* FROM population CROSS JOIN totals`,
    [scope.tenant_id, scope.app_id, watermark, grouping.metric_date, grouping.campaign_id ?? null, privacyState,
      definition.definition.calculation, definition.conversion_event_key ?? null, JSON.stringify(fxPolicy.rates), fxPolicy.target_scale],
  );
  const row = result.rows[0];
  if (row.missing_fx !== "0") throw new Error("engagement_metric_fx_rate_missing");
  return row.population === "0" ? { value_state: "undefined", undefined_reason: "empty_cohort" }
    : { value_state: "present", value_unscaled: row.value_unscaled };
}
