import type { OpenMasuMetricDefinitionV04 } from "./generated/contract-types.js";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

export const ACQUISITION_KPI_VERSION = "0.4.23";
export const ACQUISITION_KPI_BUNDLE = "metric-acquisition-kpis";
export const ACQUISITION_KPI_ROLES = ["installs", "cost", "cpi", "ad_revenue", "purchase_net", "total_net", "ad_roas", "total_roas"] as const;
export type AcquisitionKpiRole = (typeof ACQUISITION_KPI_ROLES)[number];
const operations = {
  installs: ["cohort_size", "cohort_size", "count"],
  cost: ["cost_sum", "cost", "money"],
  cpi: ["cost_over_cohort", "cost", "money"],
  ad_revenue: ["revenue_sum", "revenue", "money"],
  purchase_net: ["revenue_sum", "purchase_net_revenue", "money"],
  total_net: ["revenue_sum", "total_net_revenue", "money"],
  ad_roas: ["revenue_over_cost", "revenue", "ratio"],
  total_roas: ["revenue_over_cost", "total_net_revenue", "ratio"],
} as const;

/** One opt-in, saved first-party D7 cohort set. No screen-side arithmetic. */
export const ACQUISITION_KPI_METRIC_DEFINITIONS: readonly OpenMasuMetricDefinitionV04[] = ACQUISITION_KPI_ROLES.map(role => {
  const [calculation, numerator, value_type] = operations[role];
  return {
    metric_name: `acquisition_d7_${role}`, metric_definition_version: ACQUISITION_KPI_VERSION,
    anchor_event: "install", aggregation_time_zone: "UTC", acquisition_basis: "selected_first_party_click",
    value_type, ...(value_type === "money" ? { currency: "USD", amount_scale: 6 } : {}),
    ...(value_type === "ratio" ? { ratio_scale: 6 } : {}),
    definition: { calculation, numerator, window: { type: "elapsed", day: 7 },
      ...(["cost_sum", "cost_over_cohort", "revenue_over_cost"].includes(calculation)
        ? { cost_basis: "cohort_acquisition_day_current_snapshot" as const } : {}),
      ...(calculation === "cost_over_cohort" ? { denominator: "cohort_size" as const }
        : calculation === "revenue_over_cost" ? { denominator: "cost" as const } : {}),
    },
    grouping_dimensions: ["campaign_id", "network", "country", "cohort_date", "attribution_status"],
    cost_selection_policy: "reject_overlapping_grains", rule_bundle_id: ACQUISITION_KPI_BUNDLE,
    rule_bundle_version: ACQUISITION_KPI_VERSION, rule_bundle_hash: nonFraudBundleHash(ACQUISITION_KPI_BUNDLE),
  };
});

export function acquisitionKpiRole(metricName: string): AcquisitionKpiRole | undefined {
  return ACQUISITION_KPI_ROLES.find(role => metricName === `acquisition_d7_${role}`);
}
