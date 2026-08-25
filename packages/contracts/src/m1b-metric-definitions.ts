import type { OpenMasuMetricDefinitionV04 } from "./generated/contract-types.js";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

// Metric and rule-bundle identifiers are independent of the contract namespace.
const METRIC_DEFINITION_VERSION = "0.3.0";
const RULE_BUNDLE_ID = "metric-stage-b";
const RULE_BUNDLE_HASH = nonFraudBundleHash("metric-stage-b");
const PURCHASE_NET_METRIC_DEFINITION_VERSION = "0.4.8";
const PURCHASE_NET_RULE_BUNDLE_ID = "metric-purchase-net";
const PURCHASE_NET_RULE_BUNDLE_HASH = nonFraudBundleHash("metric-purchase-net");
const TOTAL_NET_METRIC_DEFINITION_VERSION = "0.4.9";
const TOTAL_NET_RULE_BUNDLE_ID = "metric-total-net";
const TOTAL_NET_RULE_BUNDLE_HASH = nonFraudBundleHash("metric-total-net");
const AGGREGATION_TIME_ZONE = "UTC";
const TARGET_CURRENCY = "USD";
const TARGET_SCALE = 6;
const COHORT_DAYS = [0, 1, 3, 7] as const;

function referenceAdRevenue(
  metricName: string,
  aggregationTimeZone: "UTC" | "Asia/Tokyo",
  windowType: "elapsed" | "calendar_day",
): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: metricName,
    metric_definition_version: METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: aggregationTimeZone,
    value_type: "money",
    currency: TARGET_CURRENCY,
    amount_scale: TARGET_SCALE,
    definition: { calculation: "revenue_sum", window: { type: windowType, day: 0 }, numerator: "revenue" },
    rule_bundle_id: "metric-default",
    rule_bundle_version: METRIC_DEFINITION_VERSION,
    rule_bundle_hash: nonFraudBundleHash("metric-default"),
  };
}

export const REFERENCE_AD_REVENUE_METRIC_DEFINITIONS: ReadonlyArray<OpenMasuMetricDefinitionV04> = [
  referenceAdRevenue("d0_install_to_24h_ad_revenue_usd", "UTC", "elapsed"),
  referenceAdRevenue("d0_utc_install_calendar_ad_revenue_usd", "UTC", "calendar_day"),
  referenceAdRevenue("d0_jst_install_calendar_ad_revenue_usd", "Asia/Tokyo", "calendar_day"),
];

export const M1B_COHORT_KEY = ["app_id", "campaign_id", "country", "cohort_date", "attribution_status"] as const;
const METRIC_GROUPING_DIMENSIONS = ["campaign_id", "network", "country", "cohort_date", "attribution_status"] as const;
export const M1B_DEFAULT_ACTIVITY_EVENTS = ["session_start"] as const;

function ruleBundle(): Pick<
  OpenMasuMetricDefinitionV04,
  "rule_bundle_id" | "rule_bundle_version" | "rule_bundle_hash" | "grouping_dimensions"
> {
  return {
    rule_bundle_id: RULE_BUNDLE_ID,
    rule_bundle_version: METRIC_DEFINITION_VERSION,
    rule_bundle_hash: RULE_BUNDLE_HASH,
    grouping_dimensions: [...METRIC_GROUPING_DIMENSIONS],
  };
}

function roas(day: (typeof COHORT_DAYS)[number]): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: `d${day}_roas`,
    metric_definition_version: METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: AGGREGATION_TIME_ZONE,
    value_type: "ratio",
    ratio_scale: TARGET_SCALE,
    definition: {
      calculation: "revenue_over_cost",
      window: { type: "elapsed", day },
      numerator: "revenue",
      denominator: "cost",
      cost_basis: "cohort_acquisition_day_current_snapshot",
    },
    ...ruleBundle(),
  };
}

function retention(day: 1 | 7): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: `retention_d${day}`,
    metric_definition_version: METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: AGGREGATION_TIME_ZONE,
    value_type: "ratio",
    ratio_scale: TARGET_SCALE,
    definition: {
      calculation: "active_installations_over_cohort",
      window: { type: "activity_day", day },
      numerator: "active_installations",
      denominator: "cohort_size",
    },
    activity_events: [...M1B_DEFAULT_ACTIVITY_EVENTS],
    ...ruleBundle(),
  };
}

function ltv(day: (typeof COHORT_DAYS)[number]): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: `cohort_ltv_d${day}_usd`,
    metric_definition_version: METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: AGGREGATION_TIME_ZONE,
    value_type: "money",
    currency: TARGET_CURRENCY,
    amount_scale: TARGET_SCALE,
    definition: {
      calculation: "revenue_over_cohort",
      window: { type: "elapsed", day },
      numerator: "revenue",
      denominator: "cohort_size",
    },
    ...ruleBundle(),
  };
}

function purchaseNetRevenue(day: (typeof COHORT_DAYS)[number]): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: `cohort_purchase_net_revenue_d${day}_usd`,
    metric_definition_version: PURCHASE_NET_METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: AGGREGATION_TIME_ZONE,
    value_type: "money",
    currency: TARGET_CURRENCY,
    amount_scale: TARGET_SCALE,
    definition: {
      calculation: "revenue_sum",
      window: { type: "elapsed", day },
      numerator: "purchase_net_revenue",
    },
    rule_bundle_id: PURCHASE_NET_RULE_BUNDLE_ID,
    rule_bundle_version: PURCHASE_NET_METRIC_DEFINITION_VERSION,
    rule_bundle_hash: PURCHASE_NET_RULE_BUNDLE_HASH,
    grouping_dimensions: [...METRIC_GROUPING_DIMENSIONS],
  };
}

function horizonPurchaseNetRevenue(day: 30 | 90): OpenMasuMetricDefinitionV04 {
  return {
    ...purchaseNetRevenue(7),
    metric_name: `cohort_purchase_net_revenue_d${day}_usd`,
    metric_definition_version: TOTAL_NET_METRIC_DEFINITION_VERSION,
    definition: {
      calculation: "revenue_sum",
      window: { type: "elapsed", day },
      numerator: "purchase_net_revenue",
    },
    rule_bundle_version: TOTAL_NET_METRIC_DEFINITION_VERSION,
    rule_bundle_hash: nonFraudBundleHash("metric-purchase-net-v0.4.9"),
  };
}

function totalNetRevenue(day: 30 | 90): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: `cohort_total_net_revenue_d${day}_usd`,
    metric_definition_version: TOTAL_NET_METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: AGGREGATION_TIME_ZONE,
    value_type: "money",
    currency: TARGET_CURRENCY,
    amount_scale: TARGET_SCALE,
    definition: {
      calculation: "revenue_sum",
      window: { type: "elapsed", day },
      numerator: "total_net_revenue",
    },
    rule_bundle_id: TOTAL_NET_RULE_BUNDLE_ID,
    rule_bundle_version: TOTAL_NET_METRIC_DEFINITION_VERSION,
    rule_bundle_hash: TOTAL_NET_RULE_BUNDLE_HASH,
    grouping_dimensions: [...METRIC_GROUPING_DIMENSIONS],
  };
}

function totalNetRoas(day: 30 | 90): OpenMasuMetricDefinitionV04 {
  return {
    metric_name: `d${day}_total_net_roas`,
    metric_definition_version: TOTAL_NET_METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: AGGREGATION_TIME_ZONE,
    value_type: "ratio",
    ratio_scale: TARGET_SCALE,
    definition: {
      calculation: "revenue_over_cost",
      window: { type: "elapsed", day },
      numerator: "total_net_revenue",
      denominator: "cost",
      cost_basis: "cohort_acquisition_day_current_snapshot",
    },
    rule_bundle_id: TOTAL_NET_RULE_BUNDLE_ID,
    rule_bundle_version: TOTAL_NET_METRIC_DEFINITION_VERSION,
    rule_bundle_hash: TOTAL_NET_RULE_BUNDLE_HASH,
    grouping_dimensions: [...METRIC_GROUPING_DIMENSIONS],
  };
}

function totalNetLtv(day: 30 | 90): OpenMasuMetricDefinitionV04 {
  return {
    ...totalNetRevenue(day),
    metric_name: `cohort_total_net_ltv_d${day}_usd`,
    definition: {
      calculation: "revenue_over_cohort",
      window: { type: "elapsed", day },
      numerator: "total_net_revenue",
      denominator: "cohort_size",
    },
  };
}

export const M1B_METRIC_DEFINITIONS: ReadonlyArray<OpenMasuMetricDefinitionV04> = [
  ...COHORT_DAYS.map(roas),
  retention(1),
  retention(7),
  ...COHORT_DAYS.map(ltv),
  ...COHORT_DAYS.map(purchaseNetRevenue),
  ...([30, 90] as const).map(horizonPurchaseNetRevenue),
  ...([30, 90] as const).map(totalNetRevenue),
  ...([30, 90] as const).map(totalNetRoas),
  ...([30, 90] as const).map(totalNetLtv),
  {
    metric_name: "cohort_install_count",
    metric_definition_version: METRIC_DEFINITION_VERSION,
    anchor_event: "install",
    aggregation_time_zone: AGGREGATION_TIME_ZONE,
    value_type: "count",
    definition: {
      calculation: "cohort_size",
      window: { type: "elapsed", day: 0 },
      numerator: "cohort_size",
    },
    ...ruleBundle(),
  },
];
