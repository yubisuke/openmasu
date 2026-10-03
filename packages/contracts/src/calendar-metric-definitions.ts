import type { OpenMasuMetricDefinitionV04 as Definition } from "./generated/contract-types.js";
import { SELECTED_ACQUISITION_METRIC_DEFINITIONS, VERIFIED_PLATFORM_METRIC_DEFINITIONS,
  importedAcquisitionMetricDefinitions } from "./m1b-metric-definitions.js";
import { COHORT_TIME_ZONES, type CohortTimeZone } from "./calendar-time.js";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

/** Separate registered meaning; historical calendar-on-one-day/elapsed definitions stay immutable. */
export function calendarAcquisitionMetricDefinitions(zone: CohortTimeZone,
  basis: NonNullable<Definition["acquisition_basis"]> = "selected_first_party_click", provider?: string): Definition[] {
  if (!COHORT_TIME_ZONES.includes(zone)) throw new Error("calendar_time_zone_unsupported");
  if (basis !== "selected_imported_provider" && provider !== undefined) throw new Error("calendar_import_provider_forbidden");
  const source = basis === "selected_imported_provider" ? importedAcquisitionMetricDefinitions(provider ?? "")
    : basis === "selected_verified_platform" ? VERIFIED_PLATFORM_METRIC_DEFINITIONS
    : basis === "selected_first_party_click" ? SELECTED_ACQUISITION_METRIC_DEFINITIONS : undefined;
  if (!source) throw new Error("calendar_acquisition_basis_invalid");
  const suffix = zone === "UTC" ? "utc" : zone === "Asia/Tokyo" ? "jst" : "ny";
  return source.map(definition => ({ ...definition,
    metric_name: definition.metric_name.replace(/^(platform_|imported_)?/, (_, prefix = "") => `${prefix}calendar_${suffix}_`),
    metric_definition_version: "0.4.21", aggregation_time_zone: zone,
    calendar_cohort_policy: "cumulative_revenue_on_day_activity",
    definition: { ...definition.definition, window: { ...definition.definition.window, type: "calendar_day" } },
    ...(definition.definition.calculation === "revenue_over_cost" ? { cost_selection_policy: "reject_overlapping_grains" as const } : {}),
    rule_bundle_id: "metric-calendar-acquisition", rule_bundle_version: "0.4.21",
    rule_bundle_hash: nonFraudBundleHash("metric-calendar-acquisition"),
  }));
}
