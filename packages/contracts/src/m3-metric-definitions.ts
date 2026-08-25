import type { OpenMMPMetricDefinitionV03 } from "./generated/contract-types.js";

const CONTRACT_VERSION = "0.3.1";
const RULE_BUNDLE_ID = "metric-stage-m3";
const RULE_BUNDLE_HASH = "3".repeat(64);

function dailyEventCount(
  metricName: string,
  eventName: "click" | "install",
  groupingDimensions: OpenMMPMetricDefinitionV03["grouping_dimensions"],
): OpenMMPMetricDefinitionV03 {
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

export const M3_METRIC_DEFINITIONS: ReadonlyArray<OpenMMPMetricDefinitionV03> = [
  dailyEventCount("daily_click_count", "click", ["metric_date", "campaign_id", "network", "country"]),
  dailyEventCount("daily_install_count", "install", ["metric_date", "campaign_id", "network", "country", "attribution_status"]),
];
