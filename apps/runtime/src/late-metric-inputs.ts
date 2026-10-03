import type { PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { validateMetricDefinition } from "@openmasu/contracts/validation";
import { metricAcquisitionSql, metricAcquisitionJoinSql, metricAcquisitionDimensionSql } from "./platform-acquisition.js";
import type { LateEventRecalculationRequest } from "./metric-recalculation.js";

type Any = Record<string, any>;
type InputRow = {
  record_id: string; payload_sha256: string; event_name: string; received_at: string;
  lifecycle: string; logical_event_id: string | null; installation_id: string | null;
  occurred_at: string | null; financial_status: string | null; target_available: boolean; refund_reversal: boolean; producer: string;
  event_key: string | null;
};
export type LateSelection = {
  rows: { metric_run_id: string; replay: Any | null; safe_reason: string | null }[];
  records: { record_id: string; payload_sha256: string; received_at: string; event_name: string }[];
  snapshot: string; counts: Record<string, number>;
  status: "selected" | "no_eligible_inputs" | "no_matching_runs";
};

/** A narrow operational selector, not another metric definition or calculator. */
export function supportsLateMetric(replay: Any): boolean {
  const metric = replay.metric_definition, definition = metric?.definition;
  return !!metric && validateMetricDefinition(metric) && metric.anchor_event === "install"
    && ((["revenue_sum", "revenue_over_cohort", "revenue_over_cost"].includes(definition?.calculation)
      && ["revenue", "purchase_net_revenue", "total_net_revenue"].includes(definition.numerator))
      || (metric.rule_bundle_id === "metric-custom-conversion" && typeof metric.conversion_event_key === "string"
        && ["converted_installations", "converted_installations_over_cohort"].includes(definition?.calculation)))
    && (definition.window?.type === "elapsed" || (metric.calendar_cohort_policy === "cumulative_revenue_on_day_activity"
      && definition.window?.type === "calendar_day")) && Number.isSafeInteger(definition.window.day)
    && definition.window.day >= 0 && definition.window.day <= 90
    && typeof replay.evaluation?.grouping?.cohort_date === "string"
    && Object.keys(replay.evaluation.grouping).every(key =>
      ["campaign_id", "network", "country", "cohort_date", "attribution_status"].includes(key)
        || (metric.acquisition_dimension_policy === "selected_link_ad_group_creative" && ["ad_group_id", "creative_id"].includes(key))
        || (["selected_verified_platform","selected_imported_provider"].includes(metric.acquisition_basis ?? "") && key === "ad_group_id"));
}

/** Attribution membership can change counts and retention as well as revenue. */
export function supportsAttributionMetric(replay: Any): boolean {
  if (supportsLateMetric(replay)) return true;
  const metric = replay.metric_definition;
  return !!metric && validateMetricDefinition(metric) && (["selected_verified_platform","selected_imported_provider"].includes(metric.acquisition_basis ?? "")
    || metric.calendar_cohort_policy === "cumulative_revenue_on_day_activity")
    && ["cohort_size", "active_installations_over_cohort"].includes(metric.definition.calculation)
    && typeof replay.evaluation?.grouping?.cohort_date === "string";
}

export async function selectLateMetricInputs(
  client: PoolClient, scope: { tenantId: string; appId: string }, request: LateEventRecalculationRequest,
  candidateIds?: readonly string[],
  committedReceipt = false,
): Promise<LateSelection> {
  const result = await client.query<InputRow>(
    `SELECT raw.record_id,raw.payload_sha256,raw.event_name,raw.received_at,
       raw.payload_lifecycle_status AS lifecycle,logical.logical_event_id,logical.producer,
       CASE raw.event_name WHEN 'ad_revenue' THEN revenue.installation_id
         WHEN 'purchase' THEN purchase.installation_id WHEN 'refund' THEN target.installation_id
         WHEN 'custom_event' THEN custom.installation_id END AS installation_id,custom.event_key,
       CASE WHEN raw.event_name='custom_event' THEN raw.occurred_at ELSE coalesce(revenue.occurred_at,purchase.occurred_at,
         CASE WHEN refund.artifact ? 'reverses_refund_record_id' THEN cancelled.occurred_at ELSE refund.occurred_at END) END AS occurred_at,
       coalesce(refund.financial_status='reversed' AND refund.artifact ? 'reverses_refund_record_id',false) AS refund_reversal,
       coalesce(purchase.financial_status,refund.financial_status) AS financial_status,
       (raw.event_name<>'refund' OR (target.financial_status='settled'
         AND refund.installation_id=target.installation_id AND refund.currency=target.currency
         AND refund.occurred_at_ts>=target.occurred_at_ts AND target_raw.received_at<=$3
         AND target_raw.payload_lifecycle_status='available'
         AND (refund.financial_status<>'reversed' OR (
           cancelled.financial_status='settled' AND cancelled.correction_target_record_id=target.record_id
           AND cancelled.installation_id=refund.installation_id AND cancelled.currency=refund.currency
           AND cancelled.original_transaction_id=refund.original_transaction_id
           AND refund.amount_unscaled::numeric * power(10::numeric,cancelled.amount_scale)
             = cancelled.amount_unscaled::numeric * power(10::numeric,refund.amount_scale)
           AND refund.occurred_at_ts>=cancelled.occurred_at_ts
           AND cancelled_raw.received_at<=raw.received_at AND cancelled_raw.received_at<=$3
           AND cancelled_raw.payload_lifecycle_status='available')))) IS TRUE AS target_available
     FROM ledger.raw_records_current AS raw
     LEFT JOIN ledger.logical_events AS logical ON logical.tenant_id=raw.tenant_id
       AND logical.app_id=raw.app_id AND logical.record_id=raw.record_id
     LEFT JOIN ledger.ad_revenue_facts AS revenue USING (logical_event_id)
     LEFT JOIN ledger.purchase_facts AS purchase USING (logical_event_id)
     LEFT JOIN ledger.refund_facts AS refund USING (logical_event_id)
     LEFT JOIN ledger.custom_event_facts AS custom USING (logical_event_id)
     LEFT JOIN ledger.purchase_facts AS target ON target.tenant_id=raw.tenant_id AND target.app_id=raw.app_id
       AND target.record_id=refund.correction_target_record_id
     LEFT JOIN ledger.raw_records_current AS target_raw ON target_raw.tenant_id=target.tenant_id
       AND target_raw.app_id=target.app_id AND target_raw.record_id=target.record_id
     LEFT JOIN ledger.logical_events AS cancelled_logical ON cancelled_logical.tenant_id=raw.tenant_id
       AND cancelled_logical.app_id=raw.app_id AND cancelled_logical.record_id=refund.artifact->>'reverses_refund_record_id'
     LEFT JOIN ledger.refund_facts AS cancelled ON cancelled.logical_event_id=cancelled_logical.logical_event_id
       AND cancelled.tenant_id=raw.tenant_id AND cancelled.app_id=raw.app_id
     LEFT JOIN ledger.raw_records_current AS cancelled_raw ON cancelled_raw.tenant_id=raw.tenant_id
       AND cancelled_raw.app_id=raw.app_id AND cancelled_raw.record_id=cancelled_logical.record_id
     WHERE raw.tenant_id=$1 AND raw.app_id=$2
       AND (($4::text[] IS NOT NULL AND raw.record_id=ANY($4::text[]))
         OR ($4::text[] IS NULL AND raw.event_name IN ('ad_revenue','purchase','refund','custom_event')
           AND raw.received_at>$5 AND raw.received_at<=$6))
     ORDER BY raw.record_id COLLATE "C" LIMIT 101`, [scope.tenantId, scope.appId, request.watermark,
      request.source_record_ids ?? null, request.source_received_from ?? null, request.source_received_to ?? null]);
  if (result.rows.length > 100) throw new Error("metric_recalculation_input_limit");
  if (request.source_record_ids && result.rows.length !== request.source_record_ids.length) throw new Error("metric_revision_not_found");
  const counts: Record<string, number> = {};
  const eligible = result.rows.filter(row => {
    const reason = row.lifecycle !== "available" ? "unavailable"
      : !row.logical_event_id ? "non_canonical"
      : !["ad_revenue", "purchase", "refund", "custom_event"].includes(row.event_name) ? "unsupported_input"
      : row.received_at > request.watermark ? "after_watermark"
      : !row.installation_id || !row.occurred_at || !row.target_available
        || (!["ad_revenue", "custom_event"].includes(row.event_name) && row.financial_status !== "settled" && !row.refund_reversal) ? "non_contributing" : "eligible";
    counts[reason] = (counts[reason] ?? 0) + 1;
    return reason === "eligible";
  });
  const records = eligible.map(({ record_id, payload_sha256, received_at, event_name }) =>
    ({ record_id, payload_sha256, received_at, event_name }));
  const selection: LateSelection = { rows: [], records, snapshot: sha256(records), counts,
    status: eligible.length ? "no_matching_runs" : "no_eligible_inputs" };
  if (!eligible.length) return selection;
  // Bound candidate work before per-definition joins. Overflow never creates partial jobs.
  const candidates = await client.query<{ metric_run_id: string; replay: Any | null; watermark: string; pending: boolean; evidence_unavailable: boolean }>(
    `SELECT mr.metric_run_id,manifest.artifact AS replay,mr.input_received_at_watermark AS watermark,
       EXISTS (SELECT 1 FROM control.metric_recalculation_items AS item WHERE item.tenant_id=mr.tenant_id
         AND item.app_id=mr.app_id AND item.source_metric_run_id=mr.metric_run_id
         AND item.state IN ('queued','processing','retry')) AS pending,
       EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(mr.artifact->'evidence_refs','[]'::jsonb)) AS ref
         LEFT JOIN ledger.raw_records_current AS raw ON raw.tenant_id=mr.tenant_id AND raw.app_id=mr.app_id AND raw.record_id=ref->>'ref'
         LEFT JOIN ledger.cost_records AS cost ON cost.tenant_id=mr.tenant_id AND cost.app_id=mr.app_id AND cost.cost_record_id=ref->>'ref'
         WHERE (raw.record_id IS NOT NULL AND raw.payload_lifecycle_status<>'available')
           OR (raw.record_id IS NULL AND cost.cost_record_id IS NULL)) AS evidence_unavailable
     FROM ledger.metric_runs AS mr
     LEFT JOIN control.metric_replay_manifests AS manifest ON manifest.tenant_id=mr.tenant_id
       AND manifest.app_id=mr.app_id AND manifest.source_metric_run_id=mr.metric_run_id
     WHERE mr.tenant_id=$1 AND mr.app_id=$2 AND mr.input_received_at_watermark<$3
       AND mr.grouping->>'cohort_date' BETWEEN $4 AND $5
       AND ($6::text[] IS NULL OR mr.metric_name=ANY($6::text[]))
       AND ($7::text[] IS NULL OR mr.metric_run_id=ANY($7::text[]))
       AND (mr.comparison_context IS NULL OR mr.comparison_context->'definition'->'definition'->>'calculation'
         IN ('revenue_sum','revenue_over_cohort','revenue_over_cost','converted_installations','converted_installations_over_cohort'))
       AND NOT EXISTS (SELECT 1 FROM ledger.metric_runs AS newer WHERE newer.tenant_id=mr.tenant_id
         AND newer.app_id=mr.app_id AND newer.supersedes_metric_run_id=mr.metric_run_id)
     ORDER BY mr.metric_run_id COLLATE "C" LIMIT 101`,
    [scope.tenantId, scope.appId, request.watermark, request.date_from, request.date_to, request.metric_names ?? null, candidateIds ?? null]);
  if (candidates.rows.length > 100) throw new Error("metric_recalculation_selection_limit");
  const matchedRecords = new Set<string>();
  for (const row of candidates.rows) {
    if (!committedReceipt && !eligible.some(event => event.received_at > row.watermark)) continue;
    let reason: string | null = null;
    if (row.replay?.version !== 1 || !row.replay.evaluation || !row.replay.fx_policy) reason = "replay_unavailable";
    else if (!supportsLateMetric(row.replay)) reason = "unsupported_definition";
    else if (row.evidence_unavailable) reason = "input_unavailable";
    else {
      const metric = row.replay.metric_definition;
      const imported = metric.acquisition_basis === "selected_imported_provider";
      const contextDimensions = imported || metric.acquisition_basis === "selected_verified_platform";
      const mode = imported ? "selected_imported_provider" : metric.acquisition_basis === "selected_verified_platform";
      const windowEnd = metric.calendar_cohort_policy
        ? "((timezone($9,install.occurred_at_ts)::date+($6::integer+1))::timestamp AT TIME ZONE $9)"
        : "install.occurred_at_ts+(($6+1)*interval '1 day')";
      const impacted = await client.query(
        `WITH acquisition AS (SELECT * FROM (${metricAcquisitionSql(mode,"$15")}) AS selected WHERE $7::boolean)
         SELECT DISTINCT changed.record_id FROM jsonb_to_recordset($4::jsonb)
           AS changed(record_id text,event_name text,installation_id text,received_at text,occurred_at text,refund_reversal boolean,producer text,event_key text)
         JOIN ledger.install_facts AS install ON install.tenant_id=$1 AND install.app_id=$2
           AND install.installation_id=changed.installation_id
         JOIN ledger.logical_events AS logical ON logical.logical_event_id=install.logical_event_id
         JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id
           AND raw.record_id=logical.record_id
         LEFT JOIN LATERAL (SELECT candidate.status,candidate.reason_code FROM ledger.attribution_results AS candidate
           WHERE candidate.tenant_id=install.tenant_id AND candidate.app_id=install.app_id
             AND candidate.subject_scope='installation_level' AND candidate.subject_ref=install.installation_id
           ORDER BY candidate.decided_at DESC,candidate.attribution_id DESC LIMIT 1) AS attribution ON true
         ${metricAcquisitionJoinSql("$7", "$8", mode,"$15")}
         WHERE ($14::boolean OR changed.received_at>$12) AND raw.received_at<=$3 AND raw.payload_lifecycle_status='available'
           AND (NOT changed.refund_reversal OR $13::boolean)
           ${metric.acquisition_basis === "selected_verified_platform" ? "AND acquisition_source.network IS NOT NULL" : ""}
           ${imported ? "AND acquisition_source.import_provider IS NOT NULL" : ""}
           ${metric.acquisition_basis === "selected_first_party_click" ? "AND logical.producer NOT LIKE 'import:%'" : ""}
           AND ($15::text IS NULL OR changed.producer='import:'||$15::text)
           AND (($11='total_net_revenue' AND changed.event_name IN ('ad_revenue','purchase','refund'))
             OR ($11='purchase_net_revenue' AND changed.event_name IN ('purchase','refund'))
             OR ($11='revenue' AND changed.event_name='ad_revenue')
             OR ($11='converted_installations' AND changed.event_name='custom_event' AND changed.event_key=$16::text))
           AND control.canonical_timestamp_value(changed.occurred_at)>=install.occurred_at_ts
           AND control.canonical_timestamp_value(changed.occurred_at)<${windowEnd}
           AND timezone($9,install.occurred_at_ts)::date::text=$5::jsonb->>'cohort_date'
           AND ($5::jsonb->>'campaign_id' IS NULL OR ${metricAcquisitionDimensionSql("campaign_id", contextDimensions)}=$5::jsonb->>'campaign_id')
           AND ($5::jsonb->>'network' IS NULL OR ${metricAcquisitionDimensionSql("network", contextDimensions)}=$5::jsonb->>'network')
           AND ($5::jsonb->>'ad_group_id' IS NULL OR acquisition_source.ad_group_id=$5::jsonb->>'ad_group_id')
           AND ($5::jsonb->>'creative_id' IS NULL OR acquisition_source.creative_id=$5::jsonb->>'creative_id')
           AND ($5::jsonb->>'country' IS NULL OR ${imported ? "acquisition_source.country" : "install.country"}=$5::jsonb->>'country')
           AND ($5::jsonb->>'attribution_status' IS NULL OR
             (CASE WHEN $7 THEN coalesce(acquisition.status,'unattributed') ELSE attribution.status END)=$5::jsonb->>'attribution_status')
           AND ($10='gross' OR (CASE WHEN $7 THEN acquisition.reason_code ELSE attribution.reason_code END) IS DISTINCT FROM 'fraud_excluded')
         LIMIT 101`, [scope.tenantId, scope.appId, request.watermark, JSON.stringify(eligible),
          JSON.stringify(row.replay.evaluation.grouping), metric.definition.window.day,
          !!metric.acquisition_basis, "after", metric.aggregation_time_zone,
          metric.fraud_policy ?? "gross", metric.definition.numerator, row.watermark,
          metric.refund_reversal_policy === "cancel_target_refund_at_watermark", committedReceipt, metric.import_provider ?? null,
          metric.conversion_event_key ?? null]);
      if (!impacted.rowCount) continue;
      for (const match of impacted.rows) matchedRecords.add(match.record_id);
      if (row.pending) reason = "already_pending";
    }
    selection.rows.push({ metric_run_id: row.metric_run_id, replay: row.replay, safe_reason: reason });
  }
  if (selection.rows.length) selection.status = "selected";
  counts.matched_to_supported_runs = matchedRecords.size;
  counts.not_matched_to_supported_runs = eligible.length - matchedRecords.size;
  return selection;
}
