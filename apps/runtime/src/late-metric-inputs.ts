import type { PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { validateMetricDefinition } from "@openmasu/contracts/validation";
import { isPayerMetricDefinition, isVerifiedPurchaseProjection, isCalendarActivityMetricDefinition, isOutcomeCostMetricDefinition } from "@openmasu/contracts/definitions";
import { metricAcquisitionSql, metricAcquisitionJoinSql, metricAcquisitionDimensionSql } from "./platform-acquisition.js";
import { correctionMetricNames, expandAcquisitionCompanions, isCompanionAcquisitionReplay,
  type CorrectionCandidate, type LateEventRecalculationRequest } from "./metric-recalculation.js";

type Any = Record<string, any>;
export type EngagementCorrectionInput = {
  record_id: string; event_name: string; installation_id: string | null; occurred_at: string | null; producer: string;
  event_key?: string | null; policy_digest?: string | null; target_policy_digest?: string | null;
  target_producer?: string | null; target_occurred_at?: string | null;
};
type InputRow = {
  record_id: string; payload_sha256: string; event_name: string; received_at: string;
  lifecycle: string; logical_event_id: string | null; installation_id: string | null;
  occurred_at: string | null; financial_status: string | null; target_available: boolean; refund_reversal: boolean; producer: string;
  event_key: string | null;
  policy_digest: string | null; target_policy_digest: string | null; target_producer: string | null;
  target_occurred_at: string | null;
};

/** The two shipped engagement profiles only; never reinterpret an install cohort. */
export function supportsEngagementMetric(replay: Any): boolean {
  const metric = replay.metric_definition, grouping = replay.evaluation?.grouping;
  if (!metric || !validateMetricDefinition(metric) || metric.anchor_event !== "deep_link_open"
    || !((metric.rule_bundle_id === "metric-first-party-engagement" && metric.metric_definition_version === "0.4.17"
      && metric.rule_bundle_version === "0.4.17")
      || (metric.rule_bundle_id === "metric-engagement-policy" && metric.metric_definition_version === "0.4.28"
        && metric.rule_bundle_version === "0.4.28"))
    || !grouping || typeof grouping.metric_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(grouping.metric_date)
    || !Number.isFinite(Date.parse(grouping.metric_date)) || new Date(grouping.metric_date).toISOString().slice(0, 10) !== grouping.metric_date
    || Object.keys(grouping).some(key => !["metric_date", "campaign_id"].includes(key))) return false;
  return grouping.campaign_id === undefined || typeof grouping.campaign_id === "string"
    && /^[A-Za-z0-9._:-]{1,128}$/.test(grouping.campaign_id);
}

/** Conservative influence, not a second winner/inactivity calculator. The saved date
 * and installation bound the search; a later open can remove credit from another campaign. */
export async function engagementInputMatches(client: PoolClient, scope: { tenantId: string; appId: string }, replay: Any,
  changes: readonly EngagementCorrectionInput[], watermark: string): Promise<string[]> {
  if (changes.length > 100) throw new Error("metric_recalculation_input_limit");
  if (!supportsEngagementMetric(replay)) return [];
  const metric = replay.metric_definition, policy = metric.rule_bundle_id === "metric-engagement-policy";
  const inactivity = policy ? metric.engagement_inactivity_days : 0, numerator = metric.definition.numerator;
  const eligible = changes.filter(event => {
    if (!event.installation_id || !event.occurred_at) return false;
    const history = inactivity > 0 && ["sdk-android", "sdk-ios"].includes(event.producer);
    if (event.event_name === "deep_link_open") return true;
    if (event.event_name === "session_start" || event.event_name === "install") return history;
    if (event.event_name === "custom_event") return history
      || numerator === "converted_installations" && event.event_key === metric.conversion_event_key;
    if (event.event_name === "ad_revenue") return numerator === "revenue";
    if (event.event_name === "purchase" || event.event_name === "refund") return policy && numerator === "purchase_net_revenue"
      && isVerifiedPurchaseProjection(event.producer, event.policy_digest ?? "")
      && (event.event_name !== "refund" || !!event.target_occurred_at
        && isVerifiedPurchaseProjection(event.target_producer ?? "", event.target_policy_digest ?? ""));
    return false;
  });
  if (!eligible.length) return [];
  const result = await client.query<{ record_id: string }>(
    `SELECT DISTINCT changed.record_id COLLATE "C" AS record_id FROM jsonb_to_recordset($4::jsonb)
       AS changed(record_id text,event_name text,installation_id text,occurred_at text,producer text,event_key text,target_occurred_at text)
     JOIN ledger.raw_records_current AS changed_raw ON changed_raw.tenant_id=$1 AND changed_raw.app_id=$2
       AND changed_raw.record_id=changed.record_id AND changed_raw.received_at<=$3 AND changed_raw.payload_lifecycle_status='available'
     JOIN ledger.deep_link_open_facts AS opened ON opened.tenant_id=$1 AND opened.app_id=$2
       AND opened.installation_id=changed.installation_id
     JOIN ledger.logical_events AS logical ON logical.logical_event_id=opened.logical_event_id
       AND logical.tenant_id=$1 AND logical.app_id=$2
     JOIN ledger.raw_records_current AS raw ON raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=logical.record_id
     WHERE raw.received_at<=$3 AND timezone('UTC',opened.occurred_at_ts)::date=$5::date
       AND (
         ((changed.event_name='deep_link_open'
             OR (changed.event_name='ad_revenue' AND $7::text='revenue')
             OR (changed.event_name='custom_event' AND $7::text='converted_installations' AND changed.event_key=$8::text))
           AND control.canonical_timestamp_value(changed.occurred_at)>=opened.occurred_at_ts
           AND control.canonical_timestamp_value(changed.occurred_at)<opened.occurred_at_ts+$6::int*interval '1 day')
         OR (changed.event_name IN ('purchase','refund') AND $7::text='purchase_net_revenue'
           AND control.canonical_timestamp_value(CASE WHEN changed.event_name='refund' THEN changed.target_occurred_at ELSE changed.occurred_at END)>=opened.occurred_at_ts
           AND control.canonical_timestamp_value(CASE WHEN changed.event_name='refund' THEN changed.target_occurred_at ELSE changed.occurred_at END)<opened.occurred_at_ts+$6::int*interval '1 day')
         OR ($9::int>0 AND changed.producer IN ('sdk-android','sdk-ios')
           AND changed.event_name IN ('session_start','custom_event','deep_link_open')
           AND control.canonical_timestamp_value(changed.occurred_at)>=opened.occurred_at_ts-$9::int*interval '1 day'
           AND control.canonical_timestamp_value(changed.occurred_at)<opened.occurred_at_ts)
         OR ($9::int>0 AND changed.producer IN ('sdk-android','sdk-ios') AND changed.event_name='install'
           AND control.canonical_timestamp_value(changed.occurred_at)<=opened.occurred_at_ts-$9::int*interval '1 day'))
     ORDER BY record_id LIMIT 101`, [scope.tenantId, scope.appId, watermark, JSON.stringify(eligible),
      replay.evaluation.grouping.metric_date, metric.definition.window.day + 1, numerator, metric.conversion_event_key ?? null, inactivity]);
  return result.rows.map(row => row.record_id);
}
export type LateSelection = {
  rows: { metric_run_id: string; replay: Any | null; safe_reason: string | null }[];
  records: { record_id: string; payload_sha256: string; received_at: string; event_name: string }[];
  snapshot: string; counts: Record<string, number>;
  status: "selected" | "no_eligible_inputs" | "no_matching_runs";
};

/** A narrow operational selector, not another metric definition or calculator. */
export function supportsLateMetric(replay: Any): boolean {
  if (supportsCorrectableActivityMetric(replay)) return true;
  if (supportsEngagementMetric(replay)) return true;
  const metric = replay.metric_definition, definition = metric?.definition;
  return !!metric && validateMetricDefinition(metric) && metric.anchor_event === "install"
    && ((["revenue_sum", "revenue_over_cohort", "revenue_over_cost"].includes(definition?.calculation)
      && ["revenue", "purchase_net_revenue", "total_net_revenue"].includes(definition.numerator))
      || (metric.rule_bundle_id === "metric-custom-conversion" && typeof metric.conversion_event_key === "string"
        && ["converted_installations", "converted_installations_over_cohort"].includes(definition?.calculation))
      || isPayerMetricDefinition(metric) || isOutcomeCostMetricDefinition(metric))
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
  if (supportsCorrectableActivityMetric(replay)) return false;
  if (supportsLateMetric(replay)) return true;
  const metric = replay.metric_definition;
  return !!metric && validateMetricDefinition(metric) && (["selected_verified_platform","selected_imported_provider"].includes(metric.acquisition_basis ?? "")
    || metric.calendar_cohort_policy === "cumulative_revenue_on_day_activity")
    && ["cohort_size", "active_installations_over_cohort"].includes(metric.definition.calculation)
    && typeof replay.evaluation?.grouping?.cohort_date === "string";
}

function supportsCorrectableActivityMetric(replay: Any): boolean {
  const definition = replay.metric_definition, grouping = replay.evaluation?.grouping;
  const date = grouping?.metric_date;
  return isCalendarActivityMetricDefinition(definition)
    && (definition.conversion_event_key !== undefined || definition.metric_definition_version === "0.4.36")
    && typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
    && Object.keys(grouping).length === 1;
}

export async function selectLateMetricInputs(
  client: PoolClient, scope: { tenantId: string; appId: string }, request: LateEventRecalculationRequest,
  candidateIds?: readonly string[],
  committedReceipt = false,
): Promise<LateSelection> {
  const result = await client.query<InputRow>(
    `SELECT raw.record_id,raw.payload_sha256,raw.event_name,raw.received_at,
       raw.payload_lifecycle_status AS lifecycle,logical.logical_event_id,logical.producer,
       raw_policy.policy_digest,target_policy.policy_digest AS target_policy_digest,target_raw.producer AS target_producer,
       CASE raw.event_name WHEN 'ad_revenue' THEN revenue.installation_id
         WHEN 'purchase' THEN purchase.installation_id WHEN 'refund' THEN target.installation_id
         WHEN 'custom_event' THEN custom.installation_id WHEN 'session_start' THEN session.installation_id
         WHEN 'deep_link_open' THEN opened.installation_id WHEN 'install' THEN installed.installation_id END AS installation_id,custom.event_key,
       target.occurred_at AS target_occurred_at,
       CASE WHEN raw.event_name IN ('custom_event','session_start','deep_link_open','install') THEN raw.occurred_at ELSE coalesce(revenue.occurred_at,purchase.occurred_at,
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
     JOIN ledger.raw_records AS raw_policy ON raw_policy.tenant_id=raw.tenant_id AND raw_policy.app_id=raw.app_id
       AND raw_policy.record_id=raw.record_id
     LEFT JOIN ledger.logical_events AS logical ON logical.tenant_id=raw.tenant_id
       AND logical.app_id=raw.app_id AND logical.record_id=raw.record_id
     LEFT JOIN ledger.ad_revenue_facts AS revenue USING (logical_event_id)
     LEFT JOIN ledger.purchase_facts AS purchase USING (logical_event_id)
     LEFT JOIN ledger.refund_facts AS refund USING (logical_event_id)
     LEFT JOIN ledger.custom_event_facts AS custom USING (logical_event_id)
     LEFT JOIN ledger.session_facts AS session USING (logical_event_id)
     LEFT JOIN ledger.deep_link_open_facts AS opened USING (logical_event_id)
     LEFT JOIN ledger.install_facts AS installed USING (logical_event_id)
     LEFT JOIN ledger.purchase_facts AS target ON target.tenant_id=raw.tenant_id AND target.app_id=raw.app_id
       AND target.record_id=refund.correction_target_record_id
     LEFT JOIN ledger.raw_records_current AS target_raw ON target_raw.tenant_id=target.tenant_id
       AND target_raw.app_id=target.app_id AND target_raw.record_id=target.record_id
     LEFT JOIN ledger.raw_records AS target_policy ON target_policy.tenant_id=target.tenant_id
       AND target_policy.app_id=target.app_id AND target_policy.record_id=target.record_id
     LEFT JOIN ledger.logical_events AS cancelled_logical ON cancelled_logical.tenant_id=raw.tenant_id
       AND cancelled_logical.app_id=raw.app_id AND cancelled_logical.record_id=refund.artifact->>'reverses_refund_record_id'
     LEFT JOIN ledger.refund_facts AS cancelled ON cancelled.logical_event_id=cancelled_logical.logical_event_id
       AND cancelled.tenant_id=raw.tenant_id AND cancelled.app_id=raw.app_id
     LEFT JOIN ledger.raw_records_current AS cancelled_raw ON cancelled_raw.tenant_id=raw.tenant_id
       AND cancelled_raw.app_id=raw.app_id AND cancelled_raw.record_id=cancelled_logical.record_id
     WHERE raw.tenant_id=$1 AND raw.app_id=$2
       AND (($4::text[] IS NOT NULL AND raw.record_id=ANY($4::text[]))
         OR ($4::text[] IS NULL AND raw.event_name IN ('ad_revenue','purchase','refund','custom_event','session_start','deep_link_open','install')
           AND raw.received_at>$5 AND raw.received_at<=$6))
     ORDER BY raw.record_id COLLATE "C" LIMIT 101`, [scope.tenantId, scope.appId, request.watermark,
      request.source_record_ids ?? null, request.source_received_from ?? null, request.source_received_to ?? null]);
  if (result.rows.length > 100) throw new Error("metric_recalculation_input_limit");
  if (request.source_record_ids && result.rows.length !== request.source_record_ids.length) throw new Error("metric_revision_not_found");
  const counts: Record<string, number> = {};
  const eligible = result.rows.filter(row => {
    const reason = row.lifecycle !== "available" ? "unavailable"
      : !row.logical_event_id ? "non_canonical"
      : !["ad_revenue", "purchase", "refund", "custom_event", "session_start", "deep_link_open", "install"].includes(row.event_name) ? "unsupported_input"
      : row.received_at > request.watermark ? "after_watermark"
      : !row.installation_id || !row.occurred_at || !row.target_available
        || (["purchase", "refund"].includes(row.event_name) && row.financial_status !== "settled" && !row.refund_reversal) ? "non_contributing" : "eligible";
    counts[reason] = (counts[reason] ?? 0) + 1;
    return reason === "eligible";
  });
  const records = eligible.map(({ record_id, payload_sha256, received_at, event_name }) =>
    ({ record_id, payload_sha256, received_at, event_name }));
  const selection: LateSelection = { rows: [], records, snapshot: sha256(records), counts,
    status: eligible.length ? "no_matching_runs" : "no_eligible_inputs" };
  if (!eligible.length) return selection;
  // Bound candidate work before per-definition joins. Overflow never creates partial jobs.
  const candidates = await client.query<CorrectionCandidate & { watermark: string }>(
    `SELECT mr.metric_run_id,mr.artifact,mr.comparison_context,mr.grouping_digest,
       manifest.artifact AS replay,mr.input_received_at_watermark AS watermark,
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
       AND (CASE WHEN coalesce(mr.comparison_context->'definition'->>'anchor_event',manifest.artifact->'metric_definition'->>'anchor_event') IN ('deep_link_open','calendar_day')
         THEN mr.grouping->>'metric_date' BETWEEN $4 AND $5
         ELSE $8::boolean AND mr.grouping->>'cohort_date' BETWEEN $4 AND $5 END)
       AND ($6::text[] IS NULL OR mr.metric_name=ANY($6::text[]))
       AND ($7::text[] IS NULL OR mr.metric_run_id=ANY($7::text[]))
       AND (mr.comparison_context IS NULL OR mr.comparison_context->'definition'->>'rule_bundle_id' IN ('metric-basis-acquisition-kpis','metric-horizon-acquisition-kpis')
         OR (mr.comparison_context->'definition'->>'rule_bundle_id'='metric-calendar-activity'
           AND mr.comparison_context->'definition'->>'metric_definition_version' IN ('0.4.32','0.4.36'))
         OR mr.comparison_context->'definition'->'definition'->>'calculation'
         IN ('revenue_sum','revenue_over_cohort','revenue_over_cost','converted_installations','converted_installations_over_cohort',
           'purchase_count','paying_installations','paying_installations_over_cohort','revenue_over_paying_installations','cost_over_outcome'))
       AND NOT EXISTS (SELECT 1 FROM ledger.metric_runs AS newer WHERE newer.tenant_id=mr.tenant_id
         AND newer.app_id=mr.app_id AND newer.supersedes_metric_run_id=mr.metric_run_id)
     ORDER BY mr.metric_run_id COLLATE "C" LIMIT 101`,
    [scope.tenantId, scope.appId, request.watermark, request.date_from, request.date_to, correctionMetricNames(request.metric_names) ?? null, candidateIds ?? null,
      eligible.some(event => ["ad_revenue", "purchase", "refund", "custom_event"].includes(event.event_name))]);
  if (candidates.rows.length > 100) throw new Error("metric_recalculation_selection_limit");
  const matchedRecords = new Set<string>();
  for (const row of candidates.rows) {
    if (!committedReceipt && !eligible.some(event => event.received_at > row.watermark)) continue;
    // Counts/cost/CPI are companions, not individually affected by a revenue event.
    if (isCompanionAcquisitionReplay(row.replay) && !supportsLateMetric(row.replay!)) continue;
    let reason: string | null = null;
    if (row.replay?.version !== 1 || !row.replay.evaluation || !row.replay.fx_policy) reason = "replay_unavailable";
    else if (!supportsLateMetric(row.replay)) reason = "unsupported_definition";
    else if (row.evidence_unavailable) reason = "input_unavailable";
    else if (supportsCorrectableActivityMetric(row.replay)) {
      const definition = row.replay.metric_definition, date = row.replay.evaluation.grouping.metric_date;
      const start = Date.parse(`${date}T00:00:00.000Z`);
      const impacted = eligible.filter(event => (committedReceipt || event.received_at > row.watermark)
        && definition.event_names.includes(event.event_name)
        && (definition.conversion_event_key === undefined || event.event_key === definition.conversion_event_key)
        && Date.parse(event.occurred_at!) >= start
        && Date.parse(event.occurred_at!) < start + (definition.definition.window.day + 1) * 86400000);
      if (!impacted.length) continue;
      for (const event of impacted) matchedRecords.add(event.record_id);
      if (row.pending) reason = "already_pending";
    }
    else if (supportsEngagementMetric(row.replay)) {
      const changes = committedReceipt ? eligible : eligible.filter(event => event.received_at > row.watermark);
      const impacted = await engagementInputMatches(client, scope, row.replay, changes, request.watermark);
      if (!impacted.length) continue;
      for (const recordId of impacted) matchedRecords.add(recordId);
      if (row.pending) reason = "already_pending";
    }
    else {
      const metric = row.replay.metric_definition;
      const contributing = isPayerMetricDefinition(metric) || isOutcomeCostMetricDefinition(metric) && metric.definition.denominator === "paying_installations" ? eligible.filter(event =>
        isVerifiedPurchaseProjection(event.producer, event.policy_digest ?? "")
        && (event.event_name === "purchase" || metric.definition.numerator === "purchase_net_revenue"
          && event.event_name === "refund" && isVerifiedPurchaseProjection(event.target_producer ?? "", event.target_policy_digest ?? ""))) : eligible;
      if (!contributing.length) continue;
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
             OR ($11 IN ('purchases','paying_installations') AND changed.event_name='purchase')
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
         LIMIT 101`, [scope.tenantId, scope.appId, request.watermark, JSON.stringify(contributing),
          JSON.stringify(row.replay.evaluation.grouping), metric.definition.window.day,
          !!metric.acquisition_basis, "after", metric.aggregation_time_zone,
          metric.fraud_policy ?? "gross", isOutcomeCostMetricDefinition(metric) ? metric.definition.denominator : metric.definition.numerator, row.watermark,
          metric.refund_reversal_policy === "cancel_target_refund_at_watermark", committedReceipt, metric.import_provider ?? null,
          metric.conversion_event_key ?? null]);
      if (!impacted.rowCount) continue;
      for (const match of impacted.rows) matchedRecords.add(match.record_id);
      if (row.pending) reason = "already_pending";
    }
    selection.rows.push({ metric_run_id: row.metric_run_id, replay: row.replay, safe_reason: reason });
  }
  selection.rows = expandAcquisitionCompanions(scope, candidates.rows, selection.rows);
  if (selection.rows.length) selection.status = "selected";
  counts.matched_to_supported_runs = matchedRecords.size;
  counts.not_matched_to_supported_runs = eligible.length - matchedRecords.size;
  return selection;
}
