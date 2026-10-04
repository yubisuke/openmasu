import type { OpenMasuMetricDefinitionV04 as Definition } from "./generated/contract-types.js";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

export const STANDARD_RETENTION_DAYS = [3, 14, 30] as const;
export type StandardRetentionDay = (typeof STANDARD_RETENTION_DAYS)[number];

/** Opt-in elapsed activity days; historical D1/D7 definitions are not upgraded. */
export function standardRetentionMetricDefinitions(
  basis: NonNullable<Definition["acquisition_basis"]> = "selected_first_party_click",
  provider?: string,
): Definition[] {
  if (!["selected_first_party_click", "selected_verified_platform", "selected_imported_provider"].includes(basis)
      || (basis === "selected_imported_provider" ? !provider || !/^[a-z0-9-]{1,64}$/.test(provider) : provider !== undefined)) {
    throw new Error("standard_retention_basis_invalid");
  }
  const prefix = basis === "selected_verified_platform" ? "platform_" : basis === "selected_imported_provider" ? "imported_" : "";
  return STANDARD_RETENTION_DAYS.map(day => ({
    metric_name: `${prefix}retention_d${day}`, metric_definition_version: "0.4.24",
    anchor_event: "install", aggregation_time_zone: "UTC", value_type: "ratio", ratio_scale: 6,
    definition: { calculation: "active_installations_over_cohort", numerator: "active_installations",
      denominator: "cohort_size", window: { type: "activity_day", day } },
    activity_events: ["session_start"], acquisition_basis: basis,
    ...(provider ? { import_provider: provider } : {}),
    retention_maturity_policy: "complete_activity_window",
    grouping_dimensions: ["campaign_id", "network", "country", "cohort_date", "attribution_status",
      ...(basis === "selected_first_party_click" ? [] : ["ad_group_id" as const])],
    rule_bundle_id: "metric-standard-retention", rule_bundle_version: "0.4.24",
    rule_bundle_hash: nonFraudBundleHash("metric-standard-retention"),
  }));
}

/** Full cohort-date end plus Dn's exclusive activity-window end. Never uses now. */
export function standardRetentionClosesAt(definition: Pick<Definition, "retention_maturity_policy" | "definition">,
  cohortDate?: string): string | undefined {
  if (!definition.retention_maturity_policy) return undefined;
  if (!cohortDate || !/^\d{4}-\d{2}-\d{2}$/.test(cohortDate)
      || !Number.isFinite(Date.parse(cohortDate)) || new Date(cohortDate).toISOString().slice(0, 10) !== cohortDate) {
    throw new Error("standard_retention_cohort_date_required");
  }
  return new Date(Date.parse(cohortDate) + (definition.definition.window.day + 2) * 86_400_000).toISOString();
}
