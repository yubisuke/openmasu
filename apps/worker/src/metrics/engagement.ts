import { sha256 } from "@openmasu/attribution-core/canonical";
import type { MetricClient as Queryable, MetricDefinition, MetricFxPolicy, MetricGrouping, MetricScope as Scope, MetricValue } from "./model.js";

type EngagementRow = {
  tenant_id: string; app_id: string; record_id: string; tracking_link_id: string;
  campaign_id: string; attribution_id: string; attribution: unknown;
};

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
  const result = await client.query<EngagementRow>(opensSql, [scope.tenant_id, scope.app_id, watermark]);
  return result.rows.sort((a, b) => a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0)
    .map(row => [row.tenant_id, row.app_id, row.record_id, row.tracking_link_id, row.campaign_id,
      row.attribution_id, sha256(row.attribution)]);
}

export async function engagementMetricValue(
  client: Queryable, scope: Scope, watermark: string, grouping: MetricGrouping | undefined,
  definition: MetricDefinition, fxPolicy: MetricFxPolicy, privacyState: "before" | "after",
): Promise<MetricValue> {
  if (typeof grouping?.metric_date !== "string" || Object.keys(grouping).some(key => !["metric_date", "campaign_id"].includes(key))) {
    throw new Error("engagement_metric_requires_anchor_date");
  }
  if (definition.value_type === "money" && (fxPolicy.target_currency !== definition.currency || fxPolicy.target_scale !== definition.amount_scale)) {
    throw new Error("engagement_metric_fx_target_mismatch");
  }
  if (definition.rule_bundle_id === "metric-engagement-policy")
    return engagementPolicyMetricValue(client, scope, watermark, grouping, definition, fxPolicy, privacyState);
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
       FROM credited LEFT JOIN jsonb_to_recordset($9::jsonb) AS rate(currency text,rate_unscaled text,rate_scale integer,effective_date date,as_of text)
         ON credited.currency=rate.currency
           AND (NOT $11::boolean OR (rate.effective_date=timezone('UTC',credited.occurred_at)::date
             AND control.canonical_timestamp_value(rate.as_of) <= control.canonical_timestamp_value($3)))
     ) SELECT population.count AS population,totals.* FROM population CROSS JOIN totals`,
    [scope.tenant_id, scope.app_id, watermark, grouping.metric_date, grouping.campaign_id ?? null, privacyState,
      definition.definition.calculation, definition.conversion_event_key ?? null, JSON.stringify(fxPolicy.rates), fxPolicy.target_scale,
      !!fxPolicy.rate_selection],
  );
  const row = result.rows[0];
  if (row.missing_fx !== "0") {
    if (fxPolicy.rate_selection) return { value_state: "undefined", undefined_reason: "missing_fx_rate" };
    throw new Error("engagement_metric_fx_rate_missing");
  }
  return row.population === "0" ? { value_state: "undefined", undefined_reason: "empty_cohort" }
    : { value_state: "present", value_unscaled: row.value_unscaled };
}

async function engagementPolicyMetricValue(
  client: Queryable, scope: Scope, watermark: string, grouping: MetricGrouping,
  definition: MetricDefinition, fxPolicy: MetricFxPolicy, privacyState: "before" | "after",
): Promise<MetricValue> {
  // Fixed fragments only. All operator policy/filter values remain bound parameters.
  const selection = `timezone('UTC',chosen.opened_at)::date=$4::date AND ($5::text IS NULL OR chosen.campaign_id=$5)
    AND ($6::text='before' OR chosen.payload_lifecycle_status='available') AND chosen.inactivity_state='eligible'`;
  const result = await client.query<{ population: string; unknown: string; value_unscaled: string; missing_fx: string }>(
    `WITH opens AS MATERIALIZED (${opensSql}),
     history_identities AS (
       SELECT logical_event_id,installation_id FROM ledger.install_facts WHERE tenant_id=$1 AND app_id=$2 AND $12::int>0
       UNION ALL SELECT logical_event_id,installation_id FROM ledger.session_facts WHERE tenant_id=$1 AND app_id=$2 AND $12::int>0
       UNION ALL SELECT logical_event_id,installation_id FROM ledger.custom_event_facts WHERE tenant_id=$1 AND app_id=$2 AND $12::int>0
       UNION ALL SELECT logical_event_id,installation_id FROM ledger.deep_link_open_facts WHERE tenant_id=$1 AND app_id=$2 AND $12::int>0
     ), history AS MATERIALIZED (
       SELECT history.installation_id,raw.event_name,control.canonical_timestamp_value(raw.occurred_at) AS occurred_at,
         raw.payload_lifecycle_status FROM history_identities AS history
       JOIN ledger.logical_events AS logical ON logical.logical_event_id=history.logical_event_id
         AND logical.tenant_id=$1 AND logical.app_id=$2
       JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id
         AND raw.record_id=logical.record_id
       WHERE raw.received_at <= $3 AND raw.producer IN ('sdk-android','sdk-ios')
     ), classified AS MATERIALIZED (
       SELECT opens.*, CASE WHEN $12::int=0 THEN 'eligible'
         WHEN EXISTS (SELECT 1 FROM history WHERE history.installation_id=opens.installation_id
           AND history.event_name IN ('session_start','custom_event','deep_link_open')
           AND history.occurred_at >= opens.opened_at - $12::int * interval '1 day' AND history.occurred_at < opens.opened_at
           AND ($6::text='before' OR history.payload_lifecycle_status='available')) THEN 'active'
         WHEN EXISTS (SELECT 1 FROM history WHERE history.installation_id=opens.installation_id
           AND history.event_name IN ('session_start','custom_event','deep_link_open')
           AND history.occurred_at >= opens.opened_at - $12::int * interval '1 day' AND history.occurred_at < opens.opened_at
           AND $6::text='after' AND history.payload_lifecycle_status<>'available')
           OR NOT EXISTS (SELECT 1 FROM history WHERE history.installation_id=opens.installation_id
             AND history.event_name='install' AND history.occurred_at <= opens.opened_at - $12::int * interval '1 day'
             AND ($6::text='before' OR history.payload_lifecycle_status='available')) THEN 'unknown'
         ELSE 'eligible' END AS inactivity_state FROM opens
     ), population AS (
       SELECT count(*) FILTER (WHERE inactivity_state='eligible')::text AS count,
         count(*) FILTER (WHERE inactivity_state='unknown')::text AS unknown FROM classified
       WHERE timezone('UTC',opened_at)::date=$4::date AND ($5::text IS NULL OR campaign_id=$5)
         AND ($6::text='before' OR payload_lifecycle_status='available')
     ), observations AS (
       SELECT coalesce(custom.installation_id,revenue.installation_id) AS installation_id,
         control.canonical_timestamp_value(raw.occurred_at) AS occurred_at,
         revenue.amount_unscaled,revenue.amount_scale,revenue.currency
       FROM ledger.logical_events AS logical
       JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
       LEFT JOIN ledger.custom_event_facts AS custom ON custom.logical_event_id=logical.logical_event_id AND custom.tenant_id=$1 AND custom.app_id=$2
       LEFT JOIN ledger.ad_revenue_facts AS revenue ON revenue.logical_event_id=logical.logical_event_id AND revenue.tenant_id=$1 AND revenue.app_id=$2
       WHERE logical.tenant_id=$1 AND logical.app_id=$2 AND raw.received_at <= $3
         AND ($6::text='before' OR raw.payload_lifecycle_status='available')
         AND (($7::text='converted_installations' AND logical.event_name='custom_event' AND custom.event_key=$8::text)
           OR ($7::text='revenue' AND logical.event_name='ad_revenue' AND revenue.installation_id IS NOT NULL))
     ), credited_observations AS (
       SELECT observation.* FROM observations AS observation JOIN LATERAL (
         SELECT candidate.* FROM classified AS candidate WHERE candidate.installation_id=observation.installation_id
           AND candidate.opened_at <= observation.occurred_at ORDER BY candidate.opened_at DESC,candidate.record_id COLLATE "C" ASC LIMIT 1
       ) AS chosen ON true
       WHERE observation.occurred_at < chosen.opened_at + $13::int * interval '1 day' AND ${selection}
     ), credited_purchases AS MATERIALIZED (
       SELECT purchase.installation_id,raw.record_id,purchase.amount_unscaled,purchase.amount_scale,purchase.currency,
         purchase.occurred_at_ts AS occurred_at,chosen.opened_at
       FROM ledger.purchase_facts AS purchase
       JOIN ledger.logical_events AS logical ON logical.logical_event_id=purchase.logical_event_id AND logical.tenant_id=$1 AND logical.app_id=$2
       JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
       JOIN ledger.raw_records AS policy ON policy.tenant_id=raw.tenant_id AND policy.app_id=raw.app_id AND policy.record_id=raw.record_id
       JOIN LATERAL (SELECT candidate.* FROM classified AS candidate WHERE candidate.installation_id=purchase.installation_id
         AND candidate.opened_at <= purchase.occurred_at_ts ORDER BY candidate.opened_at DESC,candidate.record_id COLLATE "C" ASC LIMIT 1) AS chosen ON true
       WHERE $7::text='purchase_net_revenue' AND purchase.tenant_id=$1 AND purchase.app_id=$2
         AND purchase.financial_status='settled' AND raw.producer LIKE 'adapter:%'
         AND policy.policy_digest IN ('google-play-product-verification-v1','verified-commerce-v1')
         AND raw.received_at <= $3 AND ($6::text='before' OR raw.payload_lifecycle_status='available')
         AND purchase.occurred_at_ts < chosen.opened_at + $13::int * interval '1 day' AND ${selection}
     ), credited_refunds AS (
       SELECT refund.installation_id,refund.amount_unscaled,refund.amount_scale,refund.currency,refund.occurred_at_ts AS occurred_at
       FROM ledger.refund_facts AS refund
       JOIN ledger.logical_events AS logical ON logical.logical_event_id=refund.logical_event_id AND logical.tenant_id=$1 AND logical.app_id=$2
       JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
       JOIN ledger.raw_records AS policy ON policy.tenant_id=raw.tenant_id AND policy.app_id=raw.app_id AND policy.record_id=raw.record_id
       JOIN credited_purchases AS purchase ON purchase.record_id=refund.correction_target_record_id
         AND purchase.installation_id=refund.installation_id AND purchase.currency=refund.currency
       WHERE refund.tenant_id=$1 AND refund.app_id=$2 AND refund.financial_status='settled'
         AND raw.producer LIKE 'adapter:%' AND policy.policy_digest IN ('google-play-product-verification-v1','verified-commerce-v1')
         AND raw.received_at <= $3 AND ($6::text='before' OR raw.payload_lifecycle_status='available')
         AND refund.occurred_at_ts >= purchase.occurred_at AND refund.occurred_at_ts < purchase.opened_at + $13::int * interval '1 day'
         AND NOT EXISTS (
           SELECT 1 FROM ledger.refund_facts AS reversal
           JOIN ledger.logical_events AS reversal_logical ON reversal_logical.logical_event_id=reversal.logical_event_id
             AND reversal_logical.tenant_id=$1 AND reversal_logical.app_id=$2
           JOIN ledger.raw_records_current AS reversal_raw ON reversal_raw.tenant_id=reversal_logical.tenant_id
             AND reversal_raw.app_id=reversal_logical.app_id AND reversal_raw.record_id=reversal_logical.record_id
           JOIN ledger.raw_records AS reversal_policy ON reversal_policy.tenant_id=reversal_raw.tenant_id
             AND reversal_policy.app_id=reversal_raw.app_id AND reversal_policy.record_id=reversal_raw.record_id
           WHERE reversal.tenant_id=$1 AND reversal.app_id=$2 AND reversal.financial_status='reversed'
             AND reversal_raw.producer LIKE 'adapter:%' AND reversal_policy.policy_digest IN ('google-play-product-verification-v1','verified-commerce-v1')
             AND reversal.artifact->>'reverses_refund_record_id'=raw.record_id
             AND reversal.correction_target_record_id=refund.correction_target_record_id
             AND reversal.installation_id=refund.installation_id AND reversal.original_transaction_id=refund.original_transaction_id
             AND reversal.currency=refund.currency AND reversal.amount_unscaled::numeric * power(10::numeric,refund.amount_scale)
               =refund.amount_unscaled::numeric * power(10::numeric,reversal.amount_scale)
             AND reversal.occurred_at_ts >= refund.occurred_at_ts AND reversal_raw.received_at >= raw.received_at
             AND reversal_raw.received_at <= $3 AND ($6::text='before' OR reversal_raw.payload_lifecycle_status='available')
         )
     ), credited AS (
       SELECT installation_id,amount_unscaled,amount_scale,currency,occurred_at,1 AS sign FROM credited_observations
       UNION ALL SELECT installation_id,amount_unscaled,amount_scale,currency,occurred_at,1 FROM credited_purchases
       UNION ALL SELECT installation_id,amount_unscaled,amount_scale,currency,occurred_at,-1 FROM credited_refunds
     ), totals AS (
       SELECT trim_scale(CASE WHEN $7::text='converted_installations' THEN count(DISTINCT installation_id)::numeric
         ELSE coalesce(sum(sign * ledger.half_even_div(credited.amount_unscaled::numeric * rate.rate_unscaled::numeric * power(10::numeric,$10::int),
           power(10::numeric,credited.amount_scale+rate.rate_scale))),0) END)::text AS value_unscaled,
         count(*) FILTER (WHERE $7::text<>'converted_installations' AND rate.rate_unscaled IS NULL)::text AS missing_fx
       FROM credited LEFT JOIN jsonb_to_recordset($9::jsonb) AS rate(currency text,rate_unscaled text,rate_scale integer,effective_date date,as_of text)
         ON credited.currency=rate.currency AND (NOT $11::boolean OR (rate.effective_date=timezone('UTC',credited.occurred_at)::date
           AND control.canonical_timestamp_value(rate.as_of) <= control.canonical_timestamp_value($3)))
     ) SELECT population.count AS population,population.unknown,totals.* FROM population CROSS JOIN totals`,
    [scope.tenant_id, scope.app_id, watermark, grouping.metric_date, grouping.campaign_id ?? null, privacyState,
      definition.definition.numerator, definition.conversion_event_key ?? null, JSON.stringify(fxPolicy.rates), fxPolicy.target_scale,
      !!fxPolicy.rate_selection, definition.engagement_inactivity_days, definition.definition.window.day + 1],
  );
  const row = result.rows[0];
  if (row.unknown !== "0") return { value_state: "undefined", undefined_reason: "insufficient_activity_history" };
  if (row.population === "0") return { value_state: "undefined", undefined_reason: "empty_cohort" };
  if (row.missing_fx !== "0") {
    if (fxPolicy.rate_selection) return { value_state: "undefined", undefined_reason: "missing_fx_rate" };
    throw new Error("engagement_metric_fx_rate_missing");
  }
  return { value_state: "present", value_unscaled: row.value_unscaled };
}
