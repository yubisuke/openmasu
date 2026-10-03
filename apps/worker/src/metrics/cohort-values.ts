import type { RoasOperands, TotalNetRoasOperands } from "@openmasu/runtime";
import { metricAcquisitionSql, metricAcquisitionJoinSql } from "./selected-acquisition.js";
import { engagementMetricValue } from "./engagement.js";
import { customConversionValue, eventCountValue } from "./event-values.js";
import type { CostSelection, MetricClient, MetricDefinition, MetricFxPolicy, MetricGrouping, MetricScope, MetricValue } from "./model.js";

// Keep total, purchase and ad-revenue calculation together: total recursively
// delegates to the ad-revenue/cohort calculations, not to a parallel evaluator.
async function purchaseNetRevenueValue(
  client: MetricClient,
  scope: MetricScope,
  watermark: string,
  grouping: MetricGrouping | undefined,
  definition: MetricDefinition,
  fxPolicy: MetricFxPolicy,
  privacyState: "before" | "after",
): Promise<{ value_state: "present"; value_unscaled: string; commerce: {
  purchase_revenue_unscaled: string; refund_deduction_unscaled: string;
  purchase_event_count: string; refund_event_count: string;
  refund_reversal_unscaled?: string; refund_reversal_event_count?: string;
} } | { value_state: "undefined"; undefined_reason: "missing_fx_rate" }> {
  if (definition.definition.calculation !== "revenue_sum"
      || definition.definition.window?.type !== "elapsed") {
    throw new Error(`SQL purchase net revenue definition is invalid: ${definition.metric_name}`);
  }
  const result = await client.query<{ value_unscaled: string; missing_fx_count: string;
    purchase_revenue_unscaled: string; refund_deduction_unscaled: string;
    purchase_event_count: string; refund_event_count: string;
    refund_reversal_unscaled: string; refund_reversal_event_count: string }>(
    `WITH
       acquisition AS (SELECT * FROM (${metricAcquisitionSql(definition.acquisition_basis === "selected_verified_platform")}) AS selected WHERE $15::boolean),
       rates AS (
         SELECT currency, rate_unscaled::numeric AS rate_unscaled, rate_scale, effective_date, as_of
         FROM jsonb_to_recordset($10::jsonb)
           AS rate(currency text, rate_unscaled text, rate_scale integer, effective_date date, as_of text)
       ),
       cohort AS (
         SELECT install.installation_id, install.occurred_at_ts AS installed_at
         FROM ledger.install_facts AS install
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=install.logical_event_id
          AND logical.tenant_id=install.tenant_id
          AND logical.app_id=install.app_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         LEFT JOIN LATERAL (
           SELECT candidate.status, candidate.reason_code
           FROM ledger.attribution_results AS candidate
           WHERE candidate.tenant_id=install.tenant_id
             AND candidate.app_id=install.app_id
             AND candidate.subject_scope='installation_level'
             AND candidate.subject_ref=install.installation_id
           ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC
           LIMIT 1
         ) AS attribution ON true
         ${metricAcquisitionJoinSql("$15", "$12", definition.acquisition_basis === "selected_verified_platform")}
         WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.occurred_at IS NOT NULL
           ${definition.acquisition_basis === "selected_first_party_click" ? "AND logical.producer NOT LIKE 'import:%'" : ""}
           ${definition.acquisition_basis === "selected_verified_platform" ? "AND acquisition_source.network IS NOT NULL" : ""}
           AND raw.received_at <= $3
           AND ($12='before' OR raw.payload_lifecycle_status='available')
           AND ($4::text IS NULL OR ${definition.acquisition_basis === "selected_verified_platform" ? "acquisition_source.campaign_id" : "coalesce(install.campaign_id, acquisition_source.campaign_id)"}=$4)
           AND ($5::text IS NULL OR ${definition.acquisition_basis === "selected_verified_platform" ? "acquisition_source.network" : "coalesce(install.network, acquisition_source.network)"}=$5)
           AND ($6::text IS NULL OR install.country=$6)
           AND ($7::text IS NULL OR timezone($8, install.occurred_at_ts)::date::text=$7)
           AND ($13::text IS NULL OR (CASE WHEN $15 THEN coalesce(acquisition.status, 'unattributed') ELSE attribution.status END)=$13)
           AND ($14='gross' OR (CASE WHEN $15 THEN acquisition.reason_code ELSE attribution.reason_code END) IS DISTINCT FROM 'fraud_excluded')
           AND ($17::text IS NULL OR acquisition_source.ad_group_id=$17)
           AND ($18::text IS NULL OR acquisition_source.creative_id=$18)
       ),
       purchase_candidates AS (
         SELECT purchase.amount_unscaled, purchase.amount_scale,
                rate.rate_unscaled, rate.rate_scale, 1::numeric AS sign, false AS reversed
         FROM ledger.purchase_facts AS purchase
         JOIN cohort ON cohort.installation_id=purchase.installation_id
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=purchase.logical_event_id
          AND logical.tenant_id=purchase.tenant_id
          AND logical.app_id=purchase.app_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         LEFT JOIN rates AS rate ON rate.currency=purchase.currency
           AND (NOT $19::boolean OR (rate.effective_date=timezone('UTC',purchase.occurred_at_ts)::date
             AND control.canonical_timestamp_value(rate.as_of) <= control.canonical_timestamp_value($3)))
         WHERE purchase.tenant_id=$1 AND purchase.app_id=$2
           AND purchase.financial_status='settled'
           AND raw.received_at <= $3
           AND ($12='before' OR raw.payload_lifecycle_status='available')
           AND purchase.occurred_at_ts >= cohort.installed_at
           AND purchase.occurred_at_ts < cohort.installed_at + (($9 + 1) * interval '1 day')
       ),
       refund_candidates AS (
         SELECT refund.amount_unscaled, refund.amount_scale,
                rate.rate_unscaled, rate.rate_scale, -1::numeric AS sign,
                ($16::boolean AND EXISTS (
                  SELECT 1 FROM ledger.refund_facts AS reversal
                  JOIN ledger.logical_events AS reversal_logical USING (logical_event_id, tenant_id, app_id)
                  JOIN ledger.raw_records_current AS reversal_raw
                    ON reversal_raw.tenant_id=reversal.tenant_id AND reversal_raw.app_id=reversal.app_id
                   AND reversal_raw.record_id=reversal_logical.record_id
                  WHERE reversal.tenant_id=refund.tenant_id AND reversal.app_id=refund.app_id
                    AND reversal.original_transaction_id=refund.original_transaction_id
                    AND reversal.financial_status='reversed'
                    AND reversal.artifact->>'reverses_refund_record_id'=refund_logical.record_id
                    AND reversal.correction_target_record_id=refund.correction_target_record_id
                    AND reversal.installation_id=refund.installation_id AND reversal.currency=refund.currency
                    AND reversal.amount_unscaled::numeric * power(10::numeric, refund.amount_scale)
                      = refund.amount_unscaled::numeric * power(10::numeric, reversal.amount_scale)
                    AND reversal.occurred_at_ts >= refund.occurred_at_ts
                    AND reversal_raw.received_at >= refund_raw.received_at AND reversal_raw.received_at <= $3
                    AND ($12='before' OR reversal_raw.payload_lifecycle_status='available')
                )) AS reversed
         FROM ledger.refund_facts AS refund
         JOIN ledger.logical_events AS refund_logical
           ON refund_logical.logical_event_id=refund.logical_event_id
          AND refund_logical.tenant_id=refund.tenant_id
          AND refund_logical.app_id=refund.app_id
         JOIN ledger.raw_records_current AS refund_raw
           ON refund_raw.record_id=refund_logical.record_id
          AND refund_raw.tenant_id=refund_logical.tenant_id
          AND refund_raw.app_id=refund_logical.app_id
         JOIN ledger.logical_events AS target_logical
           ON target_logical.tenant_id=refund.tenant_id
          AND target_logical.app_id=refund.app_id
          AND target_logical.record_id=refund.correction_target_record_id
         JOIN ledger.purchase_facts AS purchase
           ON purchase.logical_event_id=target_logical.logical_event_id
          AND purchase.tenant_id=target_logical.tenant_id
          AND purchase.app_id=target_logical.app_id
         JOIN ledger.raw_records_current AS purchase_raw
           ON purchase_raw.record_id=target_logical.record_id
          AND purchase_raw.tenant_id=target_logical.tenant_id
          AND purchase_raw.app_id=target_logical.app_id
         JOIN cohort ON cohort.installation_id=purchase.installation_id
         LEFT JOIN rates AS rate ON rate.currency=refund.currency
           AND (NOT $19::boolean OR (rate.effective_date=timezone('UTC',refund.occurred_at_ts)::date
             AND control.canonical_timestamp_value(rate.as_of) <= control.canonical_timestamp_value($3)))
         WHERE refund.tenant_id=$1 AND refund.app_id=$2
           AND refund.financial_status='settled'
           AND purchase.financial_status='settled'
           AND refund.installation_id=purchase.installation_id
           AND refund.currency=purchase.currency
           AND refund_raw.received_at <= $3
           AND purchase_raw.received_at <= $3
           AND ($12='before' OR (refund_raw.payload_lifecycle_status='available'
             AND purchase_raw.payload_lifecycle_status='available'))
           AND refund.occurred_at_ts >= purchase.occurred_at_ts
           AND refund.occurred_at_ts >= cohort.installed_at
           AND refund.occurred_at_ts < cohort.installed_at + (($9 + 1) * interval '1 day')
       ),
       commerce AS (
         SELECT * FROM purchase_candidates
         UNION ALL
         SELECT * FROM refund_candidates
       ), converted AS (
         SELECT sign, reversed, rate_unscaled, ledger.half_even_div(
              amount_unscaled::numeric * rate_unscaled * power(10::numeric, $11),
              power(10::numeric, amount_scale + rate_scale)
            ) AS amount FROM commerce
       )
     SELECT coalesce(sum(CASE WHEN reversed THEN 0 ELSE sign * amount END), 0::numeric)::text AS value_unscaled,
            trim_scale(coalesce(sum(amount) FILTER (WHERE sign=1), 0::numeric))::text AS purchase_revenue_unscaled,
            trim_scale(coalesce(sum(amount) FILTER (WHERE sign=-1), 0::numeric))::text AS refund_deduction_unscaled,
            count(*) FILTER (WHERE sign=1)::text AS purchase_event_count,
            count(*) FILTER (WHERE sign=-1)::text AS refund_event_count,
            trim_scale(coalesce(sum(amount) FILTER (WHERE reversed), 0::numeric))::text AS refund_reversal_unscaled,
            count(*) FILTER (WHERE reversed)::text AS refund_reversal_event_count,
            count(*) FILTER (WHERE rate_unscaled IS NULL AND (NOT $19::boolean OR NOT reversed))::text AS missing_fx_count
     FROM converted`,
    [
      scope.tenant_id,
      scope.app_id,
      watermark,
      grouping?.campaign_id ?? null,
      grouping?.network ?? null,
      grouping?.country ?? null,
      grouping?.cohort_date ?? null,
      definition.aggregation_time_zone,
      definition.definition.window.day,
      JSON.stringify(fxPolicy.rates),
      fxPolicy.target_scale,
      privacyState,
      grouping?.attribution_status ?? null,
      definition.fraud_policy ?? "gross",
      !!definition.acquisition_basis,
      definition.refund_reversal_policy === "cancel_target_refund_at_watermark",
      grouping?.ad_group_id ?? null,
      grouping?.creative_id ?? null,
      !!fxPolicy.rate_selection,
    ],
  );
  const row = result.rows[0];
  if (row.missing_fx_count !== "0") {
    if (fxPolicy.rate_selection) return { value_state: "undefined", undefined_reason: "missing_fx_rate" };
    throw new Error(`missing FX rate for ${definition.metric_name}`);
  }
  return { value_state: "present", value_unscaled: row.value_unscaled, commerce: {
    purchase_revenue_unscaled: row.purchase_revenue_unscaled, refund_deduction_unscaled: row.refund_deduction_unscaled,
    purchase_event_count: row.purchase_event_count, refund_event_count: row.refund_event_count,
    ...(definition.refund_reversal_policy ? { refund_reversal_unscaled: row.refund_reversal_unscaled,
      refund_reversal_event_count: row.refund_reversal_event_count } : {}),
  } };
}

async function totalNetRevenueValue(
  client: MetricClient,
  scope: MetricScope,
  watermark: string,
  grouping: MetricGrouping | undefined,
  definition: MetricDefinition,
  fxPolicy: MetricFxPolicy,
  privacyState: "before" | "after",
  selectedCosts?: CostSelection,
): Promise<MetricValue> {
  const revenueDefinition: MetricDefinition = {
    ...definition,
    definition: { calculation: "revenue_sum", window: definition.definition.window, numerator: "revenue" },
  };
  const purchaseDefinition: MetricDefinition = {
    ...definition,
    definition: {
      calculation: "revenue_sum",
      window: definition.definition.window,
      numerator: "purchase_net_revenue",
    },
  };
  const adRevenue = await metricValue(
    client, scope, watermark, grouping, revenueDefinition, fxPolicy, privacyState, selectedCosts,
  );
  const purchaseNet = await purchaseNetRevenueValue(
    client, scope, watermark, grouping, purchaseDefinition, fxPolicy, privacyState,
  );
  if (fxPolicy.rate_selection && adRevenue.value_state === "undefined") return adRevenue;
  if (purchaseNet.value_state === "undefined") return purchaseNet;
  if (adRevenue.value_state !== "present") throw new Error(`unexpected ad revenue state: ${definition.metric_name}`);
  const total = BigInt(adRevenue.value_unscaled) + BigInt(purchaseNet.value_unscaled);
  const calculation = definition.definition.calculation;
  if (calculation === "revenue_sum") return { value_state: "present", value_unscaled: total.toString() };
  if (calculation === "revenue_over_cohort") {
    const cohort = await metricValue(client, scope, watermark, grouping, {
      ...definition,
      value_type: "count",
      definition: { calculation: "cohort_size", window: definition.definition.window, numerator: "cohort_size" },
    }, fxPolicy, privacyState);
    if (cohort.value_state !== "present" || cohort.value_unscaled === "0") {
      return { value_state: "undefined", undefined_reason: "empty_cohort" };
    }
    const value = await client.query<{ value_unscaled: string }>(
      "SELECT ledger.half_even_div($1::numeric, $2::numeric)::text AS value_unscaled",
      [total.toString(), cohort.value_unscaled],
    );
    return { value_state: "present", value_unscaled: value.rows[0].value_unscaled };
  }
  if (calculation !== "revenue_over_cost") {
    throw new Error(`SQL total net definition is invalid: ${definition.metric_name}`);
  }
  const cost = await client.query<{
    value_unscaled: string;
    mismatched_currency_count: string;
    cost_row_count: string;
    missing_fx_count: string;
  }>(
    `WITH rates AS (
       SELECT * FROM jsonb_to_recordset($12::jsonb)
         AS rate(currency text,rate_unscaled text,rate_scale integer,effective_date date,as_of text)
     ), current_cost AS (
       SELECT * FROM (
         SELECT DISTINCT ON (cost_key_digest) spend_unscaled, spend_scale, currency, cost_date AS date
         FROM ledger.cost_records
         WHERE $11::jsonb IS NULL AND tenant_id=$1 AND app_id=$2 AND as_of <= $3 AND NOT (artifact ? 'creative_id')
           AND ($8::text IS NULL OR $8='non_organic')
           AND ($4::text IS NULL OR campaign_id=$4)
           AND ($5::text IS NULL OR network=$5)
           AND ($6::text IS NULL OR country=$6)
           AND ($7::date IS NULL OR cost_date=$7::date)
         ORDER BY cost_key_digest, as_of DESC, cost_record_id COLLATE "C" DESC
       ) AS selected
       UNION ALL
       SELECT * FROM jsonb_to_recordset($11::jsonb)
         AS supplied(spend_unscaled text, spend_scale integer, currency text, date date)
     )
     SELECT trim_scale(coalesce(sum(
       CASE WHEN $13::boolean THEN ledger.half_even_div(spend_unscaled::numeric * rate.rate_unscaled::numeric * power(10::numeric,$10),
         power(10::numeric,spend_scale+rate.rate_scale))
       WHEN spend_scale <= $10
         THEN spend_unscaled::numeric * power(10::numeric, $10 - spend_scale)
         ELSE ledger.half_even_div(spend_unscaled::numeric, power(10::numeric, spend_scale - $10)) END
       ), 0::numeric))::text AS value_unscaled,
       count(*) FILTER (WHERE NOT $13::boolean AND current_cost.currency <> $9)::text AS mismatched_currency_count,
       count(*) FILTER (WHERE $13::boolean AND rate.rate_unscaled IS NULL)::text AS missing_fx_count,
       count(*)::text AS cost_row_count
     FROM current_cost LEFT JOIN rates AS rate ON $13::boolean AND rate.currency=current_cost.currency
       AND rate.effective_date=current_cost.date
       AND control.canonical_timestamp_value(rate.as_of) <= control.canonical_timestamp_value($3)`,
    [scope.tenant_id, scope.app_id, watermark, grouping?.campaign_id ?? null,
      grouping?.network ?? null, grouping?.country ?? null, grouping?.cohort_date ?? null,
      grouping?.attribution_status ?? null, fxPolicy.target_currency, fxPolicy.target_scale,
      selectedCosts ? JSON.stringify(selectedCosts.rows) : null, JSON.stringify(fxPolicy.rates), !!fxPolicy.rate_selection],
  );
  if (cost.rows[0].mismatched_currency_count !== "0") {
    throw new Error(`cost currency mismatch for ${definition.metric_name}`);
  }
  if (fxPolicy.rate_selection && cost.rows[0].missing_fx_count !== "0") {
    return { value_state: "undefined", undefined_reason: "missing_fx_rate" };
  }
  // Capture only the supported D30 total-net series, using the exact aggregates
  // already consumed above; never recalculate components when serving HTTP.
  const totalNetOperands: TotalNetRoasOperands | undefined = definition.metric_name === "d30_total_net_roas"
    && adRevenue.revenueAggregates ? {
      ...adRevenue.revenueAggregates, ...purchaseNet.commerce,
      ad_revenue_unscaled: adRevenue.value_unscaled, revenue_unscaled: total.toString(),
      cost_unscaled: cost.rows[0].value_unscaled, cost_row_count: cost.rows[0].cost_row_count,
    } : undefined;
  const evidence = totalNetOperands ? { totalNetOperands } : {};
  if (cost.rows[0].value_unscaled === "0") {
    return { value_state: "undefined", undefined_reason: "no_attributed_cost", ...evidence };
  }
  const ratio = await client.query<{ value_unscaled: string }>(
    "SELECT ledger.half_even_div($1::numeric * power(10::numeric, $3), $2::numeric)::text AS value_unscaled",
    [total.toString(), cost.rows[0].value_unscaled, definition.ratio_scale ?? 6],
  );
  return { value_state: "present", value_unscaled: ratio.rows[0].value_unscaled, ...evidence };
}
export async function metricValue(
  client: MetricClient,
  scope: MetricScope,
  watermark: string,
  grouping: MetricGrouping | undefined,
  definition: MetricDefinition,
  fxPolicy: MetricFxPolicy,
  privacyState: "before" | "after",
  selectedCosts?: CostSelection,
): Promise<MetricValue> {
  const calculation = definition.definition.calculation;
  if (definition.engagement_credit_policy) {
    return engagementMetricValue(client, scope, watermark, grouping, definition, fxPolicy, privacyState);
  }
  if (["converted_installations", "converted_installations_over_cohort"].includes(calculation)) {
    return customConversionValue(client, scope, watermark, grouping, definition, privacyState);
  }
  const costCalculation = ["cost_sum", "cost_over_cohort"].includes(calculation);
  const usesCost = costCalculation || calculation === "revenue_over_cost";
  if (!fxPolicy.rate_selection && usesCost && selectedCosts?.rows.some((cost) => cost.currency !== fxPolicy.target_currency)) {
    throw new Error(`cost currency mismatch for ${definition.metric_name}`);
  }
  if (usesCost && selectedCosts?.overlapping) {
    return { value_state: "undefined", undefined_reason: "overlapping_cost_grains" };
  }
  if (definition.definition.numerator === "total_net_revenue") {
    return totalNetRevenueValue(client, scope, watermark, grouping, definition, fxPolicy, privacyState, selectedCosts);
  }
  if (definition.definition.numerator === "purchase_net_revenue") {
    return purchaseNetRevenueValue(client, scope, watermark, grouping, definition, fxPolicy, privacyState);
  }
  if (calculation === "event_count") {
    return eventCountValue(client, scope, watermark, grouping, definition, privacyState);
  }
  const activityEvents = definition.activity_events ?? ["session_start"];
  const calendar = !!definition.calendar_cohort_policy;
  const windowEnd = calendar
    ? "(timezone($8, cohort.installed_at)::date + ($9::integer + 1))::timestamp AT TIME ZONE $8"
    : "cohort.installed_at + (($9 + 1) * interval '1 day')";
  const activityWindow = calendar
    ? "session.occurred_at_ts >= cohort.installed_at AND timezone($8, session.occurred_at_ts)::date = timezone($8, cohort.installed_at)::date + $9::integer"
    : "session.occurred_at_ts >= cohort.installed_at + ($9 * interval '1 day') AND session.occurred_at_ts < cohort.installed_at + (($9 + 1) * interval '1 day')";
  const finalWindowEnd = calendar
    ? "(timezone($8, installed_at)::date + ($9::integer + 1))::timestamp AT TIME ZONE $8"
    : "installed_at + (($9 + 1) * interval '1 day')";
  const imported = definition.acquisition_basis === "selected_imported_provider";
  const acquisitionMode = imported ? "selected_imported_provider" : definition.acquisition_basis === "selected_verified_platform";
  const contextDimensions = imported || definition.acquisition_basis === "selected_verified_platform";
  if (calculation === "active_installations_over_cohort" &&
      activityEvents.some((eventName: string) => eventName !== "session_start")) {
    throw new Error(`SQL activity projection does not support ${activityEvents.join(",")}`);
  }
  const result = await client.query<{
    value_unscaled: string | null;
    missing_fx_count: string;
    mismatched_cost_currency_count: string;
    missing_cost_fx_count: string;
    revenue_value: string;
    cost_value: string;
    revenue_event_count: string;
    cost_row_count: string;
    cohort_size: string;
    last_window_end: string | null;
    window_elapsed: boolean | null;
  }>(
    `WITH
       acquisition AS (SELECT * FROM (${metricAcquisitionSql(acquisitionMode)}) AS selected WHERE $18::boolean),
       rates AS (
         SELECT currency, rate_unscaled::numeric AS rate_unscaled, rate_scale, effective_date, as_of
         FROM jsonb_to_recordset($12::jsonb)
           AS rate(currency text, rate_unscaled text, rate_scale integer, effective_date date, as_of text)
       ),
       cohort AS (
         SELECT install.installation_id, install.occurred_at_ts AS installed_at
         FROM ledger.install_facts AS install
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=install.logical_event_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         LEFT JOIN LATERAL (
           SELECT candidate.status, candidate.reason_code
           FROM ledger.attribution_results AS candidate
           WHERE candidate.tenant_id=install.tenant_id
             AND candidate.app_id=install.app_id
             AND candidate.subject_scope='installation_level'
             AND candidate.subject_ref=install.installation_id
           ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC
           LIMIT 1
         ) AS attribution ON true
         ${metricAcquisitionJoinSql("$18", "$15", acquisitionMode)}
         WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.occurred_at IS NOT NULL
           ${definition.acquisition_basis === "selected_verified_platform" ? "AND acquisition_source.network IS NOT NULL" : ""}
           ${imported ? "AND acquisition_source.import_provider IS NOT NULL" : ""}
           AND ($22::text IS NULL OR logical.producer='import:'||$22)
           ${definition.acquisition_basis === "selected_first_party_click" ? "AND logical.producer NOT LIKE 'import:%'" : ""}
           AND raw.received_at <= $3
           AND ($15='before' OR raw.payload_lifecycle_status='available')
           AND ($4::text IS NULL OR ${contextDimensions ? "acquisition_source.campaign_id" : "coalesce(install.campaign_id, acquisition_source.campaign_id)"}=$4)
           AND ($5::text IS NULL OR ${contextDimensions ? "acquisition_source.network" : "coalesce(install.network, acquisition_source.network)"}=$5)
           AND ($6::text IS NULL OR ${imported ? "acquisition_source.country" : "install.country"}=$6)
           AND ($7::text IS NULL OR timezone($8, install.occurred_at_ts)::date::text=$7)
           AND ($16::text IS NULL OR (CASE WHEN $18 THEN coalesce(acquisition.status, 'unattributed') ELSE attribution.status END)=$16)
           AND ($17='gross' OR (CASE WHEN $18 THEN acquisition.reason_code ELSE attribution.reason_code END) IS DISTINCT FROM 'fraud_excluded')
           AND ($20::text IS NULL OR acquisition_source.ad_group_id=$20)
           AND ($21::text IS NULL OR acquisition_source.creative_id=$21)
       ),
       revenue_candidates AS (
         SELECT revenue.*, cohort.installed_at, rate.rate_unscaled, rate.rate_scale
         FROM ledger.ad_revenue_facts AS revenue
         JOIN cohort USING (installation_id)
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=revenue.logical_event_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         LEFT JOIN rates AS rate ON rate.currency=revenue.currency
           AND (NOT $23::boolean OR (rate.effective_date=timezone('UTC',revenue.occurred_at_ts)::date
             AND control.canonical_timestamp_value(rate.as_of) <= control.canonical_timestamp_value($3)))
         WHERE revenue.tenant_id=$1 AND revenue.app_id=$2
           AND ($22::text IS NULL OR logical.producer='import:'||$22)
           AND raw.received_at <= $3
           AND ($15='before' OR raw.payload_lifecycle_status='available')
           AND revenue.occurred_at_ts >= cohort.installed_at
           AND revenue.occurred_at_ts < (${windowEnd})
       ),
       revenue AS (
         SELECT coalesce(sum(ledger.half_even_div(
           amount_unscaled::numeric * rate_unscaled * power(10::numeric, $13),
           power(10::numeric, amount_scale + rate_scale)
         )), 0::numeric) AS value,
         count(*) FILTER (WHERE rate_unscaled IS NULL)::bigint AS missing_fx_count,
         count(*)::bigint AS revenue_event_count
         FROM revenue_candidates
       ),
       activities AS (
         SELECT count(DISTINCT session.installation_id)::numeric AS value
         FROM ledger.session_facts AS session
         JOIN cohort USING (installation_id)
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=session.logical_event_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         WHERE session.tenant_id=$1 AND session.app_id=$2
           AND ($22::text IS NULL OR logical.producer='import:'||$22)
           AND raw.received_at <= $3
           AND ($15='before' OR raw.payload_lifecycle_status='available')
           AND (${activityWindow})
       ),
       current_cost AS (
         SELECT * FROM (
           SELECT DISTINCT ON (cost_key_digest) spend_unscaled, spend_scale, currency, cost_date AS date
           FROM ledger.cost_records
           WHERE $19::jsonb IS NULL AND tenant_id=$1 AND app_id=$2 AND as_of <= $3 AND NOT (artifact ? 'creative_id')
             AND ($16::text IS NULL OR $16='non_organic')
             AND ($4::text IS NULL OR campaign_id=$4)
             AND ($5::text IS NULL OR network=$5)
             AND ($6::text IS NULL OR country=$6)
             AND ($7::date IS NULL OR cost_date=$7::date)
           ORDER BY cost_key_digest, as_of DESC, cost_record_id COLLATE "C" DESC
         ) AS selected
         UNION ALL
         SELECT * FROM jsonb_to_recordset($19::jsonb)
           AS supplied(spend_unscaled text, spend_scale integer, currency text, date date)
       ),
       cost AS (
         SELECT coalesce(sum(
           CASE
             WHEN $23::boolean THEN ledger.half_even_div(spend_unscaled::numeric * rate.rate_unscaled * power(10::numeric,$13),
               power(10::numeric,spend_scale+rate.rate_scale))
             WHEN spend_scale <= $13
               THEN spend_unscaled::numeric * power(10::numeric, $13 - spend_scale)
             ELSE ledger.half_even_div(spend_unscaled::numeric, power(10::numeric, spend_scale - $13))
           END
         ), 0::numeric) AS value,
         count(*) FILTER (WHERE NOT $23::boolean AND current_cost.currency <> $11)::bigint AS mismatched_currency_count,
         count(*) FILTER (WHERE $23::boolean AND rate.rate_unscaled IS NULL)::bigint AS missing_cost_fx_count,
         count(*)::bigint AS cost_row_count
         FROM current_cost LEFT JOIN rates AS rate ON $23::boolean AND rate.currency=current_cost.currency
           AND rate.effective_date=current_cost.date
           AND control.canonical_timestamp_value(rate.as_of) <= control.canonical_timestamp_value($3)
       ),
       values AS (
         SELECT revenue.value AS revenue_value,
                (SELECT count(DISTINCT installation_id)::numeric FROM cohort) AS cohort_size,
                activities.value AS active_count,
                cost.value AS cost_value,
                revenue.revenue_event_count,
                cost.cost_row_count,
                (SELECT to_char(max(${finalWindowEnd}) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM cohort) AS last_window_end,
                (SELECT max(${finalWindowEnd})
                   <= control.canonical_timestamp_value($3) FROM cohort) AS window_elapsed,
                revenue.missing_fx_count,
                cost.missing_cost_fx_count,
                cost.mismatched_currency_count
         FROM revenue, activities, cost
       )
     SELECT CASE $10
              WHEN 'revenue_sum' THEN revenue_value
              WHEN 'cost_sum' THEN CASE WHEN cost_row_count=0 THEN NULL ELSE cost_value END
              WHEN 'cost_over_cohort' THEN
                CASE WHEN cohort_size=0 OR cost_row_count=0 THEN NULL
                     ELSE ledger.half_even_div(cost_value, cohort_size) END
              WHEN 'revenue_over_cost' THEN
                CASE WHEN cost_value=0 THEN NULL
                     ELSE ledger.half_even_div(revenue_value * power(10::numeric, $14), cost_value) END
              WHEN 'active_installations_over_cohort' THEN
                CASE WHEN cohort_size=0 THEN NULL
                     ELSE ledger.half_even_div(active_count * power(10::numeric, $14), cohort_size) END
              WHEN 'revenue_over_cohort' THEN
                CASE WHEN cohort_size=0 THEN NULL
                     ELSE ledger.half_even_div(revenue_value, cohort_size) END
              WHEN 'cohort_size' THEN cohort_size
            END::text AS value_unscaled,
            missing_fx_count::text,
            missing_cost_fx_count::text,
            mismatched_currency_count::text AS mismatched_cost_currency_count,
            trim_scale(revenue_value)::text AS revenue_value,
            trim_scale(cost_value)::text AS cost_value, revenue_event_count::text,
            cost_row_count::text, cohort_size::text, last_window_end, window_elapsed
     FROM values`,
    [
      scope.tenant_id,
      scope.app_id,
      watermark,
      grouping?.campaign_id ?? null,
      grouping?.network ?? null,
      grouping?.country ?? null,
      grouping?.cohort_date ?? null,
      definition.aggregation_time_zone,
      definition.definition.window.day,
      calculation,
      fxPolicy.target_currency,
      JSON.stringify(fxPolicy.rates),
      fxPolicy.target_scale,
      definition.ratio_scale ?? 0,
      privacyState,
      grouping?.attribution_status ?? null,
      definition.fraud_policy ?? "gross",
      !!definition.acquisition_basis,
      selectedCosts ? JSON.stringify(selectedCosts.rows) : null,
      grouping?.ad_group_id ?? null,
      grouping?.creative_id ?? null,
      definition.import_provider ?? null,
      !!fxPolicy.rate_selection,
    ],
  );
  const row = result.rows[0];
  const usesFx = costCalculation || ["revenue_sum", "revenue_over_cost", "revenue_over_cohort"].includes(calculation);
  if (fxPolicy.rate_selection) {
    if (usesFx && (!costCalculation && row.missing_fx_count !== "0" || usesCost && row.missing_cost_fx_count !== "0")) {
      return { value_state: "undefined", undefined_reason: "missing_fx_rate" };
    }
  } else if (!costCalculation && row.missing_fx_count !== "0") throw new Error(`missing FX rate for ${definition.metric_name}`);
  if (row.mismatched_cost_currency_count !== "0") {
    throw new Error(`cost currency mismatch for ${definition.metric_name}`);
  }
  const aggregates: RoasOperands | undefined = ["revenue_sum", "revenue_over_cost"].includes(calculation)
    && definition.definition.numerator === "revenue" && (definition.definition.window.type === "elapsed" || calendar)
    ? { revenue_unscaled: row.revenue_value, cost_unscaled: row.cost_value,
      revenue_event_count: row.revenue_event_count, cost_row_count: row.cost_row_count,
      cohort_size: row.cohort_size, last_window_end: row.last_window_end, window_elapsed: row.window_elapsed }
    : undefined;
  const operands = calculation === "revenue_over_cost" ? aggregates : undefined;
  if (row.value_unscaled !== null) return { value_state: "present", value_unscaled: row.value_unscaled,
    ...(operands ? { operands } : {}), ...(aggregates ? { revenueAggregates: aggregates } : {}) };
  return {
    value_state: "undefined",
    undefined_reason: calculation === "revenue_over_cost" || calculation === "cost_sum"
      || calculation === "cost_over_cohort" && row.cohort_size !== "0" ? "no_attributed_cost" : "empty_cohort",
    ...(operands ? { operands } : {}),
  };
}
