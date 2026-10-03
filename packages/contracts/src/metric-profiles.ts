import type { OpenMasuMetricDefinitionV04 } from "./generated/contract-types.js";
import { M1B_METRIC_DEFINITIONS } from "./m1b-metric-definitions.js";
import { M3_METRIC_DEFINITIONS } from "./m3-metric-definitions.js";
import { NON_FRAUD_RULE_BUNDLES, nonFraudBundleHash, type NonFraudRuleBundleKey } from "./rule-bundle-provenance.js";

export type MetricBundleBinding = Readonly<Pick<OpenMasuMetricDefinitionV04,
  "metric_definition_version" | "rule_bundle_id" | "rule_bundle_version" | "rule_bundle_hash">>;

function binding(key: NonFraudRuleBundleKey): MetricBundleBinding {
  const bundle = NON_FRAUD_RULE_BUNDLES[key];
  return { metric_definition_version: bundle.version, rule_bundle_id: bundle.id,
    rule_bundle_version: bundle.version, rule_bundle_hash: nonFraudBundleHash(key) };
}

/** Bundle identity comes from the existing registered definitions, never another hash/version table. */
export const METRIC_PROFILE_BINDINGS = {
  reference: binding("metric-default"), cohort: binding("metric-stage-b"),
  purchase: binding("metric-purchase-net"), purchase_horizon: binding("metric-purchase-net-v0.4.9"),
  total: binding("metric-total-net"), daily: binding("metric-stage-m3"),
  selected: binding("metric-selected-acquisition"), safe_cost: binding("metric-disjoint-cost"),
  platform: binding("metric-verified-platform-acquisition"),
  imported: binding("metric-imported-provider-acquisition"),
  calendar: binding("metric-calendar-acquisition"),
  daily_acquisition: binding("metric-selected-daily-acquisition"),
  commerce: binding("metric-selected-commerce"), refund: binding("metric-refund-reversal"),
  detail: binding("metric-acquisition-detail"), custom: binding("metric-custom-conversion"),
  engagement: binding("metric-first-party-engagement"),
} as const;

type Definition = OpenMasuMetricDefinitionV04;
export const PURCHASE_NET_METRIC_SERIES: ReadonlyMap<string, Definition> = new Map(
  M1B_METRIC_DEFINITIONS.filter(value => value.definition.numerator === "purchase_net_revenue")
    .map(value => [value.metric_name, value]),
);
export const TOTAL_NET_METRIC_SERIES: ReadonlyMap<string, Definition> = new Map(
  M1B_METRIC_DEFINITIONS.filter(value => value.definition.numerator === "total_net_revenue")
    .map(value => [value.metric_name, value]),
);

type EventSeries = Readonly<{ event: NonNullable<Definition["event_names"]>[number];
  grouping: readonly NonNullable<Definition["grouping_dimensions"]>[number][] }>;
export const APPLE_AGGREGATE_METRIC_SERIES: ReadonlyMap<string, EventSeries> = new Map([
  ["skan_attributed_installs", { event: "skan_postback", grouping: ["metric_date"] }],
  ["skan_conversion_value_distribution", { event: "skan_postback", grouping: ["metric_date", "apple_conversion_bucket"] }],
  ["aak_attributed_installs", { event: "adattributionkit_postback", grouping: ["metric_date"] }],
  ["aak_attributed_reengagements", { event: "adattributionkit_postback", grouping: ["metric_date"] }],
]);
export const DEEP_LINK_METRIC_SERIES: ReadonlyMap<string, EventSeries> = new Map(
  M3_METRIC_DEFINITIONS.filter(value => value.event_names?.includes("deep_link_open"))
    .map(value => [value.metric_name, { event: "deep_link_open", grouping: value.grouping_dimensions ?? [] }]),
);
export const AGGREGATE_EVENT_NAMES: ReadonlySet<string> = new Set(
  [...APPLE_AGGREGATE_METRIC_SERIES.values()].map(value => value.event),
);
export const ENGAGEMENT_METRIC_NAMES: ReadonlySet<string> = new Set(["engagement_custom_event_converters_24h", "engagement_ad_revenue_24h_usd"]);
export const CONVERSION_CALCULATIONS: readonly string[] = ["converted_installations", "converted_installations_over_cohort"];

export type MetricProfileKey = keyof typeof METRIC_PROFILE_BINDINGS;
export type MetricProfileMetadata = Readonly<{
  key: MetricProfileKey;
  label: string;
  binding: Readonly<Pick<Definition, "rule_bundle_id" | "rule_bundle_version" | "rule_bundle_hash">>;
  scheduleValidation: "legacy_operation" | "manual_profile" | "schema_profile";
  evaluationValidation: "operation" | "manual_profile" | "named_series" | "schema_profile";
}>;
const labels: Record<MetricProfileKey, string> = {
  reference: "Reference advertising revenue", cohort: "Historical cohort",
  purchase: "Purchase net revenue", purchase_horizon: "Purchase net revenue horizons",
  total: "Total net revenue", daily: "Daily events", selected: "Selected acquisition",
  safe_cost: "Disjoint cost", commerce: "Selected commerce", refund: "Refund reversal",
  detail: "Acquisition detail", custom: "Custom conversion", engagement: "First-party engagement",
  daily_acquisition: "Daily selected acquisition",
  platform: "Verified platform acquisition",
  imported: "Imported provider acquisition",
  calendar: "Calendar acquisition cohorts",
};
export const METRIC_PROFILE_METADATA: readonly MetricProfileMetadata[] =
  (Object.keys(METRIC_PROFILE_BINDINGS) as MetricProfileKey[]).map(key => ({
    key, label: labels[key], binding: {
      rule_bundle_id: METRIC_PROFILE_BINDINGS[key].rule_bundle_id,
      rule_bundle_version: METRIC_PROFILE_BINDINGS[key].rule_bundle_version,
      rule_bundle_hash: METRIC_PROFILE_BINDINGS[key].rule_bundle_hash,
    },
    scheduleValidation: ["detail", "engagement", "daily_acquisition", "platform", "imported", "calendar"].includes(key) ? "schema_profile"
      : ["selected", "safe_cost", "commerce", "refund", "custom"].includes(key) ? "manual_profile" : "legacy_operation",
    evaluationValidation: ["refund", "detail", "custom", "engagement", "daily_acquisition", "platform", "imported", "calendar"].includes(key) ? "schema_profile"
      : ["purchase", "purchase_horizon", "total", "commerce"].includes(key) ? "named_series"
      : ["selected", "safe_cost"].includes(key) ? "manual_profile" : "operation",
  }));

/** Presentation metadata is not validation. Unknown identities never become a registered profile. */
export function metricProfileMetadata(value: unknown): MetricProfileMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return METRIC_PROFILE_METADATA.find(profile => candidate.rule_bundle_id === profile.binding.rule_bundle_id
    && candidate.rule_bundle_version === profile.binding.rule_bundle_version
    && candidate.rule_bundle_hash === profile.binding.rule_bundle_hash);
}
