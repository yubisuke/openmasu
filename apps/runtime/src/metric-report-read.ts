import type { PoolClient } from "pg";
import type { MetricComparisonContext } from "./metric-comparison.js";
import { projectDatedFxSnapshot } from "@openmasu/contracts/definitions";
import { acquisitionKpiSetKey } from "./acquisition-kpi-key.js";
import { calendarActivityUnit, metricSeries } from "./metric-series.js";
import { metricFreshness, type ImportReceiptObservation, type MetricFreshness } from "./metric-freshness.js";
import { buildMetricQuery } from "./metric-report-query.js";
import { ReportQueryError, encodeMetricCursor, type MetricQuery } from "./report-query-model.js";
type Any = Record<string, any>;

export type MetricReportRow = {
  readonly metric_run_id: string;
  readonly metric_name: string;
  readonly metric_definition_version: string;
  readonly policy_versions: readonly string[];
  readonly input_received_at_watermark: string;
  readonly input_snapshot_id: string;
  readonly data_freshness: string;
  readonly value_state: "present" | "undefined" | "unavailable";
  readonly undefined_reason: string | null;
  readonly value_unscaled?: string;
  readonly value_type: string;
  readonly currency: string | null;
  readonly amount_scale: number | null;
  readonly ratio_scale: number | null;
  readonly grouping: Readonly<Record<string, string>>;
  readonly rule_bundle_id: string;
  readonly rule_bundle_hash: string;
  readonly aggregation_time_zone: string;
  readonly computed_at: string;
  readonly reproducibility_status: string;
  readonly supersedes_metric_run_id: string | null;
  readonly input_ledger_position: string;
  readonly grouping_digest: string;
  readonly superseded: boolean;
  readonly comparison_context?: MetricComparisonContext | null;
  readonly cost_update_state?: "recalculation_pending" | "input_revised" | "no_recorded_revision" | "unknown";
  readonly late_input_update_state?: "recalculation_pending" | "unavailable" | "completed" | "no_recorded_request";
  readonly attribution_update_state?: "recalculation_pending" | "unavailable" | "completed" | "no_recorded_request";
  readonly measurement_series?: ReturnType<typeof metricSeries>;
  readonly engagement_evidence_trust?: "device_reported_forgeable" | null;
  readonly privacy_update_state?: "not_affected" | "recalculation_pending" | "unavailable" | "completed";
  readonly unavailable_reason?: "privacy_deletion" | null;
  readonly time_window_maturity?: MetricFreshness["time_window_maturity"];
  readonly source_observation?: MetricFreshness["source_observation"];
  readonly import_completion?: MetricFreshness["import_completion"];
  readonly recalculation_state?: MetricFreshness["recalculation_state"];
  readonly fx_conversion_snapshot?: ReturnType<typeof projectDatedFxSnapshot>;
  readonly acquisition_kpi_set_key?: string | null;
  readonly activity_unit?: ReturnType<typeof calendarActivityUnit>;
  readonly activity_date?: string | null;
};

export type MetricReportPage = {
  readonly data: readonly MetricReportRow[];
  readonly next_cursor?: string;
};

function metricRow(artifact: Any, groupingDigest: string, superseded: boolean, comparisonContext: MetricComparisonContext | null, costUpdateState: MetricReportRow["cost_update_state"], lateInputUpdateState: MetricReportRow["late_input_update_state"], privacyChanged: boolean, privacyUpdateState: MetricReportRow["privacy_update_state"], retentionChanged = false): MetricReportRow {
  const valueState = artifact.value_state ?? "present";
  if (valueState === "present" && typeof artifact.value_unscaled !== "string") {
    throw new Error(`metric run ${artifact.metric_run_id} has no present value`);
  }
  if (valueState === "undefined" && typeof artifact.undefined_reason !== "string") {
    throw new Error(`metric run ${artifact.metric_run_id} has no undefined reason`);
  }
  return {
    metric_run_id: artifact.metric_run_id,
    metric_name: artifact.metric_name,
    metric_definition_version: artifact.metric_definition_version,
    policy_versions: [
      `rule_bundle:${artifact.rule_bundle_version}`,
      ...(artifact.fx_policy_version || artifact.fx_conversion_snapshot?.policy?.policy_version
        ? [`fx:${artifact.fx_policy_version ?? artifact.fx_conversion_snapshot.policy.policy_version}`] : []),
    ],
    input_received_at_watermark: artifact.input_received_at_watermark,
    input_snapshot_id: artifact.input_snapshot_id,
    data_freshness: artifact.data_freshness,
    value_state: privacyChanged ? "unavailable" : valueState,
    undefined_reason: privacyChanged ? null : artifact.undefined_reason ?? null,
    ...(valueState === "present" && !privacyChanged ? { value_unscaled: artifact.value_unscaled } : {}),
    value_type: artifact.value_type,
    currency: artifact.currency ?? null,
    amount_scale: artifact.amount_scale ?? null,
    ratio_scale: artifact.ratio_scale ?? null,
    grouping: artifact.grouping?.dimensions ?? {},
    rule_bundle_id: artifact.rule_bundle_id,
    rule_bundle_hash: artifact.rule_bundle_hash,
    aggregation_time_zone: artifact.aggregation_time_zone,
    computed_at: artifact.computed_at,
    reproducibility_status: privacyChanged ? "redaction_affected" : retentionChanged ? "retention_affected" : artifact.reproducibility_status,
    supersedes_metric_run_id: artifact.supersedes_metric_run_id ?? null,
    input_ledger_position: artifact.input_ledger_position,
    grouping_digest: groupingDigest,
    superseded,
    comparison_context: comparisonContext,
    cost_update_state: costUpdateState ?? "unknown",
    late_input_update_state: lateInputUpdateState ?? "no_recorded_request",
    measurement_series: metricSeries(artifact.metric_name),
    engagement_evidence_trust: metricSeries(artifact.metric_name) === "first_party_engagement" ? "device_reported_forgeable" : null,
    activity_unit: calendarActivityUnit(comparisonContext?.definition),
    activity_date: calendarActivityUnit(comparisonContext?.definition) ? artifact.grouping?.dimensions?.metric_date ?? null : null,
    privacy_update_state: privacyChanged ? privacyUpdateState ?? "unavailable" : "not_affected",
    unavailable_reason: privacyChanged ? "privacy_deletion" : null,
    ...(projectDatedFxSnapshot(artifact.fx_conversion_snapshot)
      ? { fx_conversion_snapshot: projectDatedFxSnapshot(artifact.fx_conversion_snapshot) } : {}),
  };
}

/** Reuse the ordinary keyset projection inside a caller-owned consistent read. */
export async function metricReportOnClient(client: PoolClient, query: MetricQuery, checkEvidence = false): Promise<MetricReportPage> {
    const statement = buildMetricQuery(query, checkEvidence);
    const result = await client.query<{ artifact: Any; grouping_digest: string; superseded: boolean; comparison_context: MetricComparisonContext | null; cost_update_state: MetricReportRow["cost_update_state"]; late_input_update_state: MetricReportRow["late_input_update_state"]; attribution_update_state: MetricReportRow["attribution_update_state"]; privacy_changed: boolean; retention_changed: boolean; privacy_update_state: MetricReportRow["privacy_update_state"]; evidence_unavailable?: boolean; import_receipt_observation?: ImportReceiptObservation }>(
      statement.text,
      [...statement.values],
    );
    if (checkEvidence && result.rows.some(row => row.evidence_unavailable)) throw new ReportQueryError("comparison_evidence_unavailable");
    const hasNext = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit).map((row) => {
      const result = metricRow(
        row.artifact,
        row.grouping_digest,
        row.superseded,
        row.comparison_context,
        row.cost_update_state,
        row.late_input_update_state,
        row.privacy_changed,
        row.privacy_update_state,
        row.retention_changed,
      );
      return { ...result, acquisition_kpi_set_key: acquisitionKpiSetKey(result, { tenantId: query.tenantId, appId: query.appId }), attribution_update_state:row.attribution_update_state??"no_recorded_request", ...metricFreshness({...result,attribution_update_state:row.attribution_update_state??"no_recorded_request"}, row.import_receipt_observation,
        Array.isArray(row.artifact.evidence_refs) ? row.artifact.evidence_refs.length : undefined) };
    });
    const last = rows.at(-1);
    return {
      data: rows,
      ...(hasNext && last ? {
        next_cursor: encodeMetricCursor({
          metricName: last.metric_name,
          groupingDigest: last.grouping_digest,
          metricRunId: last.metric_run_id,
        }),
      } : {}),
    };
}
