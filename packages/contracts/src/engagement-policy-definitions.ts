import type { OpenMasuMetricDefinitionV04 as Definition } from "./generated/contract-types.js";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

export const ENGAGEMENT_POLICY_BUNDLE = "metric-engagement-policy";
export const ENGAGEMENT_POLICY_VERSION = "0.4.28";
export const ENGAGEMENT_POLICY_METRIC_NAMES = [
  "engagement_policy_custom_event_converters", "engagement_policy_ad_revenue_usd", "engagement_policy_purchase_net_usd",
] as const;

/** Explicit recorded-activity policy, not proof of human inactivity or incremental lift. */
export function engagementPolicyMetricDefinitions(options: {
  windowDays: number; minimumInactivityDays: number; eventKey: string;
}): Definition[] {
  if (!Number.isInteger(options.windowDays) || options.windowDays < 1 || options.windowDays > 30
      || !Number.isInteger(options.minimumInactivityDays) || options.minimumInactivityDays < 0 || options.minimumInactivityDays > 90)
    throw new Error("engagement_policy_window_invalid");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(options.eventKey)) throw new Error("conversion_event_key_invalid");
  const common = {
    metric_definition_version: ENGAGEMENT_POLICY_VERSION, anchor_event: "deep_link_open" as const,
    aggregation_time_zone: "UTC" as const, engagement_credit_policy: "latest_eligible_open_before_outcome" as const,
    engagement_inactivity_days: options.minimumInactivityDays,
    grouping_dimensions: ["campaign_id", "metric_date"] as ["campaign_id", "metric_date"],
    rule_bundle_id: ENGAGEMENT_POLICY_BUNDLE, rule_bundle_version: ENGAGEMENT_POLICY_VERSION,
    rule_bundle_hash: nonFraudBundleHash(ENGAGEMENT_POLICY_BUNDLE),
  };
  const window = { type: "elapsed" as const, day: options.windowDays - 1 };
  return [
    { ...common, metric_name: ENGAGEMENT_POLICY_METRIC_NAMES[0], value_type: "count", conversion_event_key: options.eventKey,
      definition: { calculation: "converted_installations", numerator: "converted_installations", window } },
    { ...common, metric_name: ENGAGEMENT_POLICY_METRIC_NAMES[1], value_type: "money", currency: "USD", amount_scale: 6,
      definition: { calculation: "revenue_sum", numerator: "revenue", window } },
    { ...common, metric_name: ENGAGEMENT_POLICY_METRIC_NAMES[2], value_type: "money", currency: "USD", amount_scale: 6,
      refund_reversal_policy: "cancel_target_refund_at_watermark",
      definition: { calculation: "revenue_sum", numerator: "purchase_net_revenue", window } },
  ];
}
