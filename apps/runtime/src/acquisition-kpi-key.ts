import { ACQUISITION_KPI_BUNDLE, ACQUISITION_KPI_VERSION,
  acquisitionKpiRole, type AcquisitionKpiRole } from "@openmasu/contracts/definitions";
import { comparisonMeaning } from "./metric-comparison.js";
import { comparisonDigest, parseComparisonContext } from "./cohort-comparison.js";
import type { MetricReportRow } from "./metric-report-read.js";

export type AcquisitionKpiScope = { tenantId: string; appId: string };
export function acquisitionKpiObservation(row: MetricReportRow, scope: AcquisitionKpiScope) {
  const role = acquisitionKpiRole(row.metric_name);
  if (!role) return undefined;
  try {
    const context = parseComparisonContext(row.comparison_context), d = context.definition;
    if (!comparisonMeaning(context) || d.rule_bundle_id !== ACQUISITION_KPI_BUNDLE
        || d.metric_definition_version !== ACQUISITION_KPI_VERSION
        || row.metric_run_id !== context.metric_run_id || row.input_snapshot_id !== context.input_snapshot_id
        || row.metric_name !== d.metric_name || row.metric_definition_version !== d.metric_definition_version
        || row.rule_bundle_id !== d.rule_bundle_id || row.rule_bundle_hash !== d.rule_bundle_hash
        || row.aggregation_time_zone !== d.aggregation_time_zone || row.value_type !== d.value_type
        || row.grouping_digest !== comparisonDigest(row.grouping)
        || !row.policy_versions.includes(`rule_bundle:${d.rule_bundle_version}`)
        || row.policy_versions.some(policy => policy.startsWith("fx:") && policy !== `fx:${context.fx.policy_version}`)
        || row.ratio_scale !== (d.ratio_scale ?? null)
        || row.value_state === "present" && (typeof row.value_unscaled !== "string"
          || !/^(?:0|-?[1-9]\d*)$/.test(row.value_unscaled)
          || row.currency !== (d.currency ?? null) || row.amount_scale !== (d.amount_scale ?? null))
        || context.fx.rate_selection && role !== "installs" && (!row.fx_conversion_snapshot
          || row.fx_conversion_snapshot.snapshot_id !== context.fx_digest
          || comparisonDigest(row.fx_conversion_snapshot.policy) !== context.fx_digest)
        || Object.keys(row.grouping).some(key => !d.grouping_dimensions?.includes(key as never))) return undefined;
    const date = row.grouping.cohort_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date
        || !Number.isFinite(Date.parse(row.input_received_at_watermark))) return undefined;
    // The latest install on a cohort date still needs its complete elapsed D7
    // window. Counts/costs do not make the panel mature before its revenue.
    const closesAt = new Date(Date.parse(date) + 9 * 86_400_000).toISOString();
    const key = comparisonDigest({ profile: "saved-acquisition-d7-v1",
      scope: { tenantId: scope.tenantId, appId: scope.appId }, grouping: row.grouping,
      definitionVersion: d.metric_definition_version,
      bundle: [d.rule_bundle_id, d.rule_bundle_version, d.rule_bundle_hash],
      acquisitionBasis: d.acquisition_basis, window: d.definition.window, timeZone: d.aggregation_time_zone,
      costSelection: d.cost_selection_policy, fraud: d.fraud_policy ?? "gross", privacy: context.privacy_state,
      fxDigest: context.fx_digest, policyVersions: [...row.policy_versions].sort().filter(policy => !policy.startsWith("fx:")),
      inputSnapshotId: row.input_snapshot_id, watermark: row.input_received_at_watermark });
    return { role, key, closesAt, fxDigest: context.fx_digest, row };
  } catch {
    // Older saved rows remain readable; never guess their calculation set.
    return undefined;
  }
}

/** Shared JSON/CSV identity. It is a calculation-set key, not a metric run ID. */
export function acquisitionKpiSetKey(row: MetricReportRow, scope: AcquisitionKpiScope): string | null {
  return acquisitionKpiObservation(row, scope)?.key ?? null;
}
