import type { Pool } from "pg";
import { withTenant, type RoasCalculationEvidence } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { groupingDimensionAllowlist } from "./report-query.js";

type Artifact = Record<string, any>;
export type MetricExplanation = {
  readonly run: {
    readonly metric_run_id: string; readonly metric_name: string;
    readonly metric_definition_version: string; readonly input_snapshot_id: string;
    readonly watermark: string; readonly computed_at: string; readonly data_freshness: string;
    readonly grouping: Readonly<Record<string, string>>;
    readonly value_state: "present" | "undefined"; readonly value_unscaled?: string;
    readonly undefined_reason?: string; readonly ratio_scale?: number;
    readonly rule_bundle_id: string; readonly rule_bundle_version: string; readonly rule_bundle_hash: string;
    readonly superseded: boolean; readonly supersedes_metric_run_id?: string;
  };
  readonly evidence_state: "available" | "not_recorded" | "redaction_affected" | "retention_affected" | "binding_mismatch";
  readonly window_state: "open" | "elapsed" | "empty_cohort" | "unknown";
  readonly calculation?: RoasCalculationEvidence;
};

/** A closed projection. Never expose a raw metric artifact's protected evidence_refs. */
function publicEvidence(value: RoasCalculationEvidence): RoasCalculationEvidence {
  const common = {
    calculation: "revenue_over_cost" as const, denominator: "cost" as const,
    metric_run_id: value.metric_run_id, input_snapshot_id: value.input_snapshot_id,
    metric_definition_version: value.metric_definition_version, definition_digest: value.definition_digest,
    anchor_event: value.anchor_event,
    window: { type: value.window.type, day: value.window.day, boundary: value.window.boundary },
    aggregation_time_zone: value.aggregation_time_zone, fraud_policy: value.fraud_policy,
    cost_basis: value.cost_basis, cost_selection_digest: value.cost_selection_digest,
    fx_policy_version: value.fx_policy_version, fx_snapshot_id: value.fx_snapshot_id,
    target_currency: value.target_currency, target_scale: value.target_scale,
    rates: value.rates.map((rate) => ({ currency: rate.currency, rate_unscaled: rate.rate_unscaled, rate_scale: rate.rate_scale })),
    rounding_mode: value.rounding_mode, ratio_scale: value.ratio_scale,
    operands: { revenue_unscaled: value.operands.revenue_unscaled, cost_unscaled: value.operands.cost_unscaled,
      revenue_event_count: value.operands.revenue_event_count, cost_row_count: value.operands.cost_row_count,
      cohort_size: value.operands.cohort_size, last_window_end: value.operands.last_window_end,
      window_elapsed: value.operands.window_elapsed },
  };
  if (value.version === 1) return { ...common, version: 1, numerator: "revenue" };
  const operands = { ...common.operands,
      ad_revenue_unscaled: value.operands.ad_revenue_unscaled,
      purchase_revenue_unscaled: value.operands.purchase_revenue_unscaled,
      refund_deduction_unscaled: value.operands.refund_deduction_unscaled,
      purchase_event_count: value.operands.purchase_event_count,
      refund_event_count: value.operands.refund_event_count,
  };
  return value.version === 3 ? { ...common, version: 3, numerator: "total_net_revenue",
    refund_reversal_policy: value.refund_reversal_policy,
    operands: { ...operands, refund_reversal_unscaled: value.operands.refund_reversal_unscaled,
      refund_reversal_event_count: value.operands.refund_reversal_event_count } }
    : { ...common, version: 2, numerator: "total_net_revenue", operands };
}

export async function metricExplanation(pool: Pool, identity: AppAdminIdentity, metricRunId: string): Promise<MetricExplanation | undefined> {
  return withTenant(pool, identity.tenantId, async (client) => {
    const result = await client.query<{
      artifact: Artifact; calculation: RoasCalculationEvidence | null;
      privacy_changed: boolean; retention_changed: boolean; superseded: boolean;
    }>(
      `SELECT run.artifact, evidence.artifact AS calculation,
         EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(run.artifact->'evidence_refs', '[]'::jsonb)) AS ref
           JOIN ledger.raw_records_current AS raw
             ON raw.tenant_id=run.tenant_id AND raw.app_id=run.app_id AND raw.record_id=ref->>'ref'
           WHERE raw.payload_lifecycle_status <> 'available'
             AND EXISTS (SELECT 1 FROM ledger.raw_payload_states AS state
               WHERE state.tenant_id=run.tenant_id AND state.app_id=run.app_id
                 AND state.record_id=raw.record_id AND state.privacy_request_id IS NOT NULL)) AS privacy_changed,
         EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(run.artifact->'evidence_refs', '[]'::jsonb)) AS ref
           LEFT JOIN ledger.raw_records_current AS raw
             ON raw.tenant_id=run.tenant_id AND raw.app_id=run.app_id AND raw.record_id=ref->>'ref'
           LEFT JOIN ledger.cost_records AS cost
             ON cost.tenant_id=run.tenant_id AND cost.app_id=run.app_id AND cost.cost_record_id=ref->>'ref'
           WHERE (raw.record_id IS NOT NULL AND raw.payload_lifecycle_status <> 'available')
             OR (raw.record_id IS NULL AND cost.cost_record_id IS NULL)) AS retention_changed,
         EXISTS (SELECT 1 FROM ledger.metric_runs AS newer
           WHERE newer.tenant_id=run.tenant_id AND newer.app_id=run.app_id
             AND newer.supersedes_metric_run_id=run.metric_run_id) AS superseded
       FROM ledger.metric_runs AS run
       LEFT JOIN ledger.metric_calculation_evidence AS evidence
         ON evidence.metric_run_id=run.metric_run_id AND evidence.tenant_id=run.tenant_id AND evidence.app_id=run.app_id
       WHERE run.tenant_id=$1 AND run.app_id=$2 AND run.metric_run_id=$3`,
      [identity.tenantId, identity.appId, metricRunId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const artifact = row.artifact;
    const grouping: Record<string, string> = {};
    for (const key of Object.keys(groupingDimensionAllowlist)) {
      const value = artifact.grouping?.dimensions?.[key];
      if (typeof value === "string") grouping[key] = value;
    }
    const run: MetricExplanation["run"] = {
      metric_run_id: artifact.metric_run_id, metric_name: artifact.metric_name,
      metric_definition_version: artifact.metric_definition_version, input_snapshot_id: artifact.input_snapshot_id,
      watermark: artifact.input_received_at_watermark, computed_at: artifact.computed_at,
      data_freshness: artifact.data_freshness, grouping,
      value_state: artifact.value_state ?? "present",
      ...(artifact.value_unscaled !== undefined ? { value_unscaled: artifact.value_unscaled } : {}),
      ...(artifact.undefined_reason ? { undefined_reason: artifact.undefined_reason } : {}),
      ...(artifact.ratio_scale !== undefined ? { ratio_scale: artifact.ratio_scale } : {}),
      rule_bundle_id: artifact.rule_bundle_id, rule_bundle_version: artifact.rule_bundle_version, rule_bundle_hash: artifact.rule_bundle_hash,
      superseded: row.superseded,
      ...(artifact.supersedes_metric_run_id ? { supersedes_metric_run_id: artifact.supersedes_metric_run_id } : {}),
    };
    const value = row.calculation;
    const evidenceState: MetricExplanation["evidence_state"] = row.privacy_changed ? "redaction_affected"
      : row.retention_changed ? "retention_affected" : !value ? "not_recorded"
        : value.metric_run_id !== run.metric_run_id || value.input_snapshot_id !== run.input_snapshot_id
          || value.metric_definition_version !== run.metric_definition_version ? "binding_mismatch" : "available";
    if (evidenceState !== "available" || !value) return { run, evidence_state: evidenceState, window_state: "unknown" };
    const calculation = publicEvidence(value);
    return { run, evidence_state: "available", calculation,
      window_state: calculation.operands.cohort_size === "0" ? "empty_cohort"
        : calculation.operands.window_elapsed === null ? "unknown"
          : calculation.operands.window_elapsed ? "elapsed" : "open" };
  });
}
