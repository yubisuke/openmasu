import type { OpenMMPMetricDefinitionV02 } from "./generated/contract-types.js";

const CONTRACT_VERSION = "0.2.0";
const RULE_BUNDLE_ID = "metric-stage-b";
const RULE_BUNDLE_HASH = "2".repeat(64);
const AGGREGATION_TIME_ZONE = "UTC";
const TARGET_CURRENCY = "USD";
const TARGET_SCALE = 6;
const COHORT_DAYS = [0, 1, 3, 7] as const;

export const M1B_COHORT_KEY = ["app_id", "campaign_id", "country", "cohort_date"] as const;
export const M1B_DEFAULT_ACTIVITY_EVENTS = ["session_start"] as const;

function ruleBundle(): Pick<
  OpenMMPMetricDefinitionV02,
  "rule_bundle_id" | "rule_bundle_version" | "rule_bundle_hash"
> {
  return {
    rule_bundle_id: RULE_BUNDLE_ID,
    rule_bundle_version: CONTRACT_VERSION,
    rule_bundle_hash: RULE_BUNDLE_HASH,
  };
}

function roas(day: (typeof COHORT_DAYS)[number]): OpenMMPMetricDefinitionV02 {
  return {
    metric_name: `d${day}_roas`,
    metric_definition_version: CONTRACT_VERSION,
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

function retention(day: 1 | 7): OpenMMPMetricDefinitionV02 {
  return {
    metric_name: `retention_d${day}`,
    metric_definition_version: CONTRACT_VERSION,
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

function ltv(day: (typeof COHORT_DAYS)[number]): OpenMMPMetricDefinitionV02 {
  return {
    metric_name: `cohort_ltv_d${day}_usd`,
    metric_definition_version: CONTRACT_VERSION,
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

export const M1B_METRIC_DEFINITIONS: ReadonlyArray<OpenMMPMetricDefinitionV02> = [
  ...COHORT_DAYS.map(roas),
  retention(1),
  retention(7),
  ...COHORT_DAYS.map(ltv),
  {
    metric_name: "cohort_install_count",
    metric_definition_version: CONTRACT_VERSION,
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
