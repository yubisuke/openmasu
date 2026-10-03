import type { OpenMasuMetricDefinitionV04 } from "./generated/contract-types.js";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

const CONTRACT_VERSION = "0.3.1";
const RULE_BUNDLE_ID = "metric-stage-m3";
const RULE_BUNDLE_HASH = nonFraudBundleHash("metric-stage-m3");

function dailyEventCount(
  metricName: string,
  eventName: "click" | "install" | "deep_link_open",
  groupingDimensions: OpenMasuMetricDefinitionV04["grouping_dimensions"],
): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: metricName,
    metric_definition_version: CONTRACT_VERSION,
    anchor_event: "calendar_day",
    aggregation_time_zone: "UTC",
    value_type: "count",
    definition: {
      calculation: "event_count",
      window: { type: "calendar_day", day: 0 },
      numerator: "events",
    },
    event_names: [eventName],
    grouping_dimensions: groupingDimensions,
    rule_bundle_id: RULE_BUNDLE_ID,
    rule_bundle_version: CONTRACT_VERSION,
    rule_bundle_hash: RULE_BUNDLE_HASH,
  };
}

export const M3_METRIC_DEFINITIONS: ReadonlyArray<OpenMasuMetricDefinitionV04> = [
  dailyEventCount("daily_click_count", "click", ["metric_date", "campaign_id", "network", "country"]),
  dailyEventCount("daily_install_count", "install", ["metric_date", "campaign_id", "network", "country", "attribution_status"]),
  {
    ...dailyEventCount("daily_deep_link_opens", "deep_link_open", ["metric_date", "campaign_id"]),
    metric_definition_version: "0.4.7",
  },
  {
    ...dailyEventCount("daily_deep_link_opens_by_status", "deep_link_open", ["metric_date", "campaign_id", "attribution_status"]),
    metric_definition_version: "0.4.7",
  },
];

/** Opt-in acquisition counts; never reinterpret the historical recorded-dimension daily series. */
export const SELECTED_DAILY_ACQUISITION_METRIC_DEFINITIONS: ReadonlyArray<OpenMasuMetricDefinitionV04> = [{
  ...dailyEventCount("daily_selected_install_count", "install",
    ["metric_date", "cohort_date", "campaign_id", "network", "country", "attribution_status", "acquisition_campaign_state"]),
  metric_definition_version: "0.4.18",
  acquisition_basis: "selected_first_party_click",
  rule_bundle_id: "metric-selected-daily-acquisition",
  rule_bundle_version: "0.4.18",
  rule_bundle_hash: nonFraudBundleHash("metric-selected-daily-acquisition"),
}];
