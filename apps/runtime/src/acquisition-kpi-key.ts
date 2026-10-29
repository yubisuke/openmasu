import { ACQUISITION_KPI_BUNDLE, ACQUISITION_KPI_VERSION,
  BASIS_ACQUISITION_KPI_BUNDLE, BASIS_ACQUISITION_KPI_VERSION,
  HORIZON_ACQUISITION_KPI_BUNDLE, HORIZON_ACQUISITION_KPI_VERSION,
  acquisitionKpiHorizon, acquisitionKpiRole } from "@openmasu/contracts/definitions";
import { comparisonMeaning } from "./metric-comparison.js";
import { comparisonDigest, parseComparisonContext } from "./cohort-comparison.js";
import type { MetricReportRow } from "./metric-report-read.js";

export type AcquisitionKpiScope = { tenantId: string; appId: string };
export type AcquisitionKpiBasis = "selected_first_party_click" | "selected_verified_platform" | "selected_imported_provider";
export function acquisitionKpiObservation(row: MetricReportRow, scope: AcquisitionKpiScope) {
  const role = acquisitionKpiRole(row.metric_name), horizon = acquisitionKpiHorizon(row.metric_name);
  if (!role || horizon === undefined) return undefined;
  try {
    const context = parseComparisonContext(row.comparison_context), d = context.definition;
    const native = d.rule_bundle_id === ACQUISITION_KPI_BUNDLE && d.metric_definition_version === ACQUISITION_KPI_VERSION;
    const extended = d.rule_bundle_id === BASIS_ACQUISITION_KPI_BUNDLE && d.metric_definition_version === BASIS_ACQUISITION_KPI_VERSION;
    const horizonProfile = d.rule_bundle_id === HORIZON_ACQUISITION_KPI_BUNDLE && d.metric_definition_version === HORIZON_ACQUISITION_KPI_VERSION;
    const basis = d.acquisition_basis as AcquisitionKpiBasis;
    const provider = basis === "selected_imported_provider" ? d.import_provider ?? null : null;
    if (!comparisonMeaning(context) || (!native && !extended && !horizonProfile)
        || horizonProfile && (basis !== "selected_first_party_click" || d.import_provider !== undefined
          || ![0, 30].includes(horizon) || row.metric_name !== `acquisition_d${horizon}_${role}` || d.definition.window.day !== horizon)
        || extended && (basis === "selected_imported_provider"
          ? typeof provider !== "string" || !/^[a-z0-9-]{1,64}$/.test(provider) || row.metric_name !== `imported_acquisition_d7_${role}`
          : basis !== "selected_verified_platform" || d.import_provider !== undefined || row.metric_name !== `platform_acquisition_d7_${role}`)
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
    // The latest install on a cohort date still needs its complete elapsed
    // window. Counts/costs do not make the panel mature before its revenue.
    const closesAt = new Date(Date.parse(date) + (horizon + 2) * 86_400_000).toISOString();
    const key = comparisonDigest({ profile: horizonProfile ? "saved-acquisition-horizon-v1" : extended ? "saved-acquisition-d7-v2" : "saved-acquisition-d7-v1",
      scope: { tenantId: scope.tenantId, appId: scope.appId }, grouping: row.grouping,
      definitionVersion: d.metric_definition_version,
      bundle: [d.rule_bundle_id, d.rule_bundle_version, d.rule_bundle_hash],
      acquisitionBasis: d.acquisition_basis, window: d.definition.window, timeZone: d.aggregation_time_zone,
      ...(extended ? { importProvider: provider } : {}),
      costSelection: d.cost_selection_policy, fraud: d.fraud_policy ?? "gross", privacy: context.privacy_state,
      fxDigest: context.fx_digest, policyVersions: [...row.policy_versions].sort().filter(policy => !policy.startsWith("fx:")),
      inputSnapshotId: row.input_snapshot_id, watermark: row.input_received_at_watermark });
    return { role, horizon, key, basis, provider, closesAt, fxDigest: context.fx_digest, row };
  } catch {
    // Older saved rows remain readable; never guess their calculation set.
    return undefined;
  }
}

/** Shared JSON/CSV identity. It is a calculation-set key, not a metric run ID. */
export function acquisitionKpiSetKey(row: MetricReportRow, scope: AcquisitionKpiScope): string | null {
  return acquisitionKpiObservation(row, scope)?.key ?? null;
}

/** Presentation identity only: these labels are not new contract grouping dimensions. */
export function acquisitionKpiDimensions(row: MetricReportRow, scope: AcquisitionKpiScope): Record<string, string> {
  const dimensions = Object.fromEntries(Object.entries(row.grouping).filter(([key]) => !["cohort_date", "metric_date"].includes(key)).sort());
  if (/^acquisition_d(?:0|30)_/.test(row.metric_name)) {
    const observation = acquisitionKpiObservation(row, scope);
    return { ...dimensions, acquisition_horizon: observation ? `D${observation.horizon}` : "unverified" };
  }
  // Keep legacy native daily/period identity unchanged.
  if (!/^(platform_|imported_)acquisition_d7_/.test(row.metric_name)) return dimensions;
  const observation = acquisitionKpiObservation(row, scope);
  return { ...dimensions, acquisition_basis: observation?.basis ?? "unverified",
    ...(observation?.provider ? { import_provider: observation.provider } : {}) };
}
