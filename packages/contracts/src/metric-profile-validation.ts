import type { OpenMasuMetricDefinitionV04 as Definition } from "./generated/contract-types.js";
import { acquisitionDetailBase } from "./m1b-metric-definitions.js";
import { validateMetricDefinition } from "./event-validation.js";
import { ACQUISITION_KPI_BUNDLE } from "./acquisition-kpi-definitions.js";
import {
  METRIC_PROFILE_BINDINGS, PURCHASE_NET_METRIC_SERIES, TOTAL_NET_METRIC_SERIES,
  APPLE_AGGREGATE_METRIC_SERIES, DEEP_LINK_METRIC_SERIES, AGGREGATE_EVENT_NAMES,
  ENGAGEMENT_METRIC_NAMES, CONVERSION_CALCULATIONS,
} from "./metric-profiles.js";

type JsonObject = Record<string, unknown>;
/** Validated schedule shape, deliberately not a claim that legacy input passed the closed schema. */
export type ScheduledMetricDefinition = JsonObject & Readonly<Pick<Definition,
  "metric_name" | "metric_definition_version" | "anchor_event" | "aggregation_time_zone" | "value_type"
  | "rule_bundle_id" | "rule_bundle_version" | "rule_bundle_hash">> & { definition: JsonObject };
const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const metricName = /^[a-z][a-z0-9_]{2,127}$/;
const metricGroupingKeys = new Set([
  "campaign_id", "ad_group_id", "creative_id", "network", "country",
  "attribution_status", "apple_conversion_bucket", "cohort_date", "metric_date",
]);
const metricDefinitionFields = new Set([
  "metric_name", "metric_definition_version", "anchor_event", "aggregation_time_zone", "value_type",
  "currency", "amount_scale", "ratio_scale", "definition", "activity_events", "event_names",
  "grouping_dimensions", "fraud_policy", "acquisition_basis", "conversion_event_key", "cost_selection_policy",
  "refund_reversal_policy", "rule_bundle_id", "rule_bundle_version", "rule_bundle_hash",
]);
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function validStringArray(value: unknown, allowed?: ReadonlySet<string>): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every(entry => typeof entry === "string" && entry.length > 0 && (!allowed || allowed.has(entry)))
    && new Set(value).size === value.length;
}

/** Legacy schedule admission and closed opt-ins are distinct; this does not claim schema validity. */
export function validateScheduledMetricDefinition(input: unknown): input is ScheduledMetricDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as JsonObject;
  if (value.retention_maturity_policy !== undefined || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.standard_retention.rule_bundle_id) {
    return validateMetricDefinition(value);
  }
  if (value.rule_bundle_id === ACQUISITION_KPI_BUNDLE || String(value.metric_name).startsWith("acquisition_d7_")
      || ["cost_sum", "cost_over_cohort"].includes(String((value.definition as JsonObject | undefined)?.calculation))) {
    return validateMetricDefinition(value);
  }
  if (value.calendar_cohort_policy !== undefined || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.calendar.rule_bundle_id
      || /^(platform_|imported_)?calendar_/.test(String(value.metric_name))) return validateMetricDefinition(value);
  if (value.import_provider !== undefined || value.acquisition_basis === "selected_imported_provider"
      || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.imported.rule_bundle_id
      || String(value.metric_name).startsWith("imported_")) return validateMetricDefinition(value);
  if (value.acquisition_basis === "selected_verified_platform" || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.platform.rule_bundle_id
      || String(value.metric_name).startsWith("platform_")) return validateMetricDefinition(value);
  if (value.metric_name === "daily_selected_install_count" || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.daily_acquisition.rule_bundle_id) {
    return validateMetricDefinition(value);
  }
  if (value.engagement_credit_policy !== undefined || value.anchor_event === "deep_link_open"
      || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.engagement.rule_bundle_id
      || ENGAGEMENT_METRIC_NAMES.has(String(value.metric_name))) {
    return validateMetricDefinition(value);
  }
  if (value.acquisition_dimension_policy !== undefined || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.detail.rule_bundle_id
      || (Array.isArray(value.grouping_dimensions) && value.grouping_dimensions.some(key => ["ad_group_id", "creative_id"].includes(String(key))))) {
    return validateMetricDefinition(value) && value.acquisition_dimension_policy === "selected_link_ad_group_creative"
      && validateScheduledMetricDefinition(acquisitionDetailBase(value));
  }
  if (value.refund_reversal_policy !== undefined || value.rule_bundle_id === METRIC_PROFILE_BINDINGS.refund.rule_bundle_id) {
    if (value.refund_reversal_policy !== "cancel_target_refund_at_watermark" || value.rule_bundle_id !== METRIC_PROFILE_BINDINGS.refund.rule_bundle_id
        || value.metric_definition_version !== METRIC_PROFILE_BINDINGS.refund.metric_definition_version || value.rule_bundle_version !== METRIC_PROFILE_BINDINGS.refund.metric_definition_version
        || value.rule_bundle_hash !== METRIC_PROFILE_BINDINGS.refund.rule_bundle_hash) return false;
    const base: JsonObject = { ...value, metric_definition_version: METRIC_PROFILE_BINDINGS.commerce.metric_definition_version, rule_bundle_id: METRIC_PROFILE_BINDINGS.commerce.rule_bundle_id,
      rule_bundle_version: METRIC_PROFILE_BINDINGS.commerce.metric_definition_version, rule_bundle_hash: METRIC_PROFILE_BINDINGS.commerce.rule_bundle_hash };
    delete base.refund_reversal_policy;
    return validateScheduledMetricDefinition(base);
  }
  const selectedCommerce = value.rule_bundle_id === METRIC_PROFILE_BINDINGS.commerce.rule_bundle_id;
  const customConversion = value.rule_bundle_id === METRIC_PROFILE_BINDINGS.custom.rule_bundle_id;
  if (!selectedCommerce && value.cost_selection_policy !== undefined && (value.cost_selection_policy !== "reject_overlapping_grains"
      || value.metric_definition_version !== METRIC_PROFILE_BINDINGS.safe_cost.metric_definition_version || value.rule_bundle_id !== METRIC_PROFILE_BINDINGS.safe_cost.rule_bundle_id
      || value.rule_bundle_version !== METRIC_PROFILE_BINDINGS.safe_cost.metric_definition_version)) return false;
  if (!selectedCommerce && !customConversion && !value.cost_selection_policy && value.acquisition_basis !== undefined && (value.acquisition_basis !== "selected_first_party_click"
      || value.anchor_event !== "install" || value.metric_definition_version !== METRIC_PROFILE_BINDINGS.selected.metric_definition_version
      || value.rule_bundle_id !== METRIC_PROFILE_BINDINGS.selected.rule_bundle_id || value.rule_bundle_version !== METRIC_PROFILE_BINDINGS.selected.metric_definition_version)) return false;
  if (Object.keys(value).some((key) => !metricDefinitionFields.has(key))
      || typeof value.metric_name !== "string" || !metricName.test(value.metric_name)
      || !boundedText(value.metric_definition_version, 64)
      || !["install", "calendar_day"].includes(String(value.anchor_event))
      || !["UTC", "Asia/Tokyo"].includes(String(value.aggregation_time_zone))
      || !["money", "ratio", "count"].includes(String(value.value_type))
      || typeof value.rule_bundle_id !== "string" || !identifier.test(value.rule_bundle_id)
      || !boundedText(value.rule_bundle_version, 64)
      || typeof value.rule_bundle_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.rule_bundle_hash)) return false;
  const definition = value.definition;
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return false;
  const operation = definition as JsonObject;
  if (Object.keys(operation).some((key) => !["calculation", "window", "numerator", "denominator", "cost_basis"].includes(key))
      || !["revenue_sum", "revenue_over_cost", "active_installations_over_cohort", "revenue_over_cohort", "cohort_size", "event_count", "converted_installations", "converted_installations_over_cohort"].includes(String(operation.calculation))
      || !["revenue", "purchase_net_revenue", "total_net_revenue", "active_installations", "cohort_size", "events", "converted_installations"].includes(String(operation.numerator))) return false;
  const window = operation.window;
  if (!window || typeof window !== "object" || Array.isArray(window)) return false;
  const boundedWindow = window as JsonObject;
  const conversionCalculations = CONVERSION_CALCULATIONS;
  if (customConversion || value.conversion_event_key !== undefined || operation.numerator === "converted_installations"
      || conversionCalculations.includes(String(operation.calculation))) {
    const count = operation.calculation === "converted_installations";
    if (!customConversion || typeof value.conversion_event_key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value.conversion_event_key)
        || value.metric_definition_version !== METRIC_PROFILE_BINDINGS.custom.metric_definition_version || value.rule_bundle_version !== METRIC_PROFILE_BINDINGS.custom.metric_definition_version
        || value.rule_bundle_hash !== METRIC_PROFILE_BINDINGS.custom.rule_bundle_hash
        || value.acquisition_basis !== "selected_first_party_click" || value.anchor_event !== "install" || value.aggregation_time_zone !== "UTC"
        || operation.numerator !== "converted_installations" || !conversionCalculations.includes(String(operation.calculation))
        || boundedWindow.type !== "elapsed" || boundedWindow.day !== 7 || value.value_type !== (count ? "count" : "ratio")
        || (count ? operation.denominator !== undefined || value.ratio_scale !== undefined
          : operation.denominator !== "cohort_size" || value.ratio_scale !== 6)
        || ["activity_events", "event_names", "cost_selection_policy", "currency", "amount_scale"].some(key => value[key] !== undefined)
        || operation.cost_basis !== undefined || !validStringArray(value.grouping_dimensions,
          new Set(["campaign_id", "network", "country", "cohort_date", "attribution_status"]))) return false;
  }
  if (selectedCommerce && (value.acquisition_basis !== "selected_first_party_click"
      || value.metric_definition_version !== METRIC_PROFILE_BINDINGS.commerce.metric_definition_version || value.rule_bundle_version !== METRIC_PROFILE_BINDINGS.commerce.metric_definition_version
      || value.rule_bundle_hash !== METRIC_PROFILE_BINDINGS.commerce.rule_bundle_hash
      || value.anchor_event !== "install" || value.aggregation_time_zone !== "UTC"
      || !["purchase_net_revenue", "total_net_revenue"].includes(String(operation.numerator))
      || boundedWindow.type !== "elapsed"
      || (operation.calculation === "revenue_over_cost"
        ? value.cost_selection_policy !== "reject_overlapping_grains" : value.cost_selection_policy !== undefined))) return false;
  if (!selectedCommerce && value.cost_selection_policy && (value.anchor_event !== "install" || value.aggregation_time_zone !== "UTC"
      || value.rule_bundle_hash !== METRIC_PROFILE_BINDINGS.safe_cost.rule_bundle_hash
      || value.value_type !== "ratio" || operation.calculation !== "revenue_over_cost"
      || operation.denominator !== "cost" || operation.cost_basis !== "cohort_acquisition_day_current_snapshot"
      || boundedWindow.type !== "elapsed" || !["revenue", "total_net_revenue"].includes(String(operation.numerator))
      || (value.acquisition_basis !== undefined && (value.acquisition_basis !== "selected_first_party_click" || operation.numerator !== "revenue")))) return false;
  if (Object.keys(boundedWindow).some((key) => !["type", "day"].includes(key))
      || !["elapsed", "calendar_day", "activity_day"].includes(String(boundedWindow.type))
      || !Number.isSafeInteger(boundedWindow.day) || Number(boundedWindow.day) < 0
      || Number(boundedWindow.day) > 3650) return false;
  if (value.value_type === "money"
      && (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)
        || !Number.isSafeInteger(value.amount_scale) || Number(value.amount_scale) < 0
        || Number(value.amount_scale) > 18)) return false;
  if (value.value_type === "ratio"
      && (!Number.isSafeInteger(value.ratio_scale) || Number(value.ratio_scale) < 0
        || Number(value.ratio_scale) > 18)) return false;
  if (value.activity_events !== undefined && !validStringArray(value.activity_events)) return false;
  if (value.event_names !== undefined && !validStringArray(value.event_names,
    new Set(["click", "install", "skan_postback", "adattributionkit_postback", "deep_link_open"]))) return false;
  if (value.grouping_dimensions !== undefined
      && !validStringArray(value.grouping_dimensions, metricGroupingKeys)) return false;
  return value.fraud_policy === undefined || value.fraud_policy === "gross" || value.fraud_policy === "net";
}

/** Independent calculators share profile constraints, not their calculation implementation. */
export function assertMetricDefinitionSeries(definition: Definition, entry: "reference" | "sql" = "sql"): void {
  const metricName = definition.metric_name;
  if (definition.retention_maturity_policy !== undefined || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.standard_retention.rule_bundle_id) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    return;
  }
  if (definition.rule_bundle_id === ACQUISITION_KPI_BUNDLE || metricName.startsWith("acquisition_d7_")
      || ["cost_sum", "cost_over_cohort"].includes(definition.definition.calculation)) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    return;
  }
  if (definition.calendar_cohort_policy !== undefined || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.calendar.rule_bundle_id
      || /^(platform_|imported_)?calendar_/.test(metricName)) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    return;
  }
  if (definition.import_provider !== undefined || definition.acquisition_basis === "selected_imported_provider"
      || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.imported.rule_bundle_id
      || definition.metric_name.startsWith("imported_")) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    return;
  }
  if (definition.acquisition_basis === "selected_verified_platform" || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.platform.rule_bundle_id
      || metricName.startsWith("platform_")) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    return;
  }
  if (metricName === "daily_selected_install_count" || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.daily_acquisition.rule_bundle_id) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    return;
  }
  if (definition.engagement_credit_policy !== undefined || definition.anchor_event === "deep_link_open"
      || ENGAGEMENT_METRIC_NAMES.has(definition.metric_name)
      || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.engagement.rule_bundle_id) {
    if (!validateMetricDefinition(definition)) throw new Error(entry === "reference" ? `invalid engagement metric profile: ${metricName}` : `metric_definition_series_mismatch:${metricName}`);
    return;
  }
  if (definition.acquisition_dimension_policy !== undefined || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.detail.rule_bundle_id) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    assertMetricDefinitionSeries(acquisitionDetailBase(definition), entry);
    return;
  }
  if (definition.refund_reversal_policy !== undefined || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.refund.rule_bundle_id) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    const base: Definition = { ...definition, metric_definition_version: METRIC_PROFILE_BINDINGS.commerce.metric_definition_version, rule_bundle_id: METRIC_PROFILE_BINDINGS.commerce.rule_bundle_id,
      rule_bundle_version: METRIC_PROFILE_BINDINGS.commerce.metric_definition_version, rule_bundle_hash: METRIC_PROFILE_BINDINGS.commerce.rule_bundle_hash };
    delete base.refund_reversal_policy;
    assertMetricDefinitionSeries(base, entry);
    return;
  }
  if (definition.conversion_event_key !== undefined || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.custom.rule_bundle_id
      || definition.definition?.numerator === "converted_installations"
      || CONVERSION_CALCULATIONS.includes(definition.definition?.calculation)) {
    if (!validateMetricDefinition(definition)) throw new Error(`metric_definition_series_mismatch:${metricName}`);
    return;
  }
  const purchaseNetSeries = PURCHASE_NET_METRIC_SERIES;
  const totalNetSeries = TOTAL_NET_METRIC_SERIES;
  const aggregateSeries = APPLE_AGGREGATE_METRIC_SERIES;
  const aggregateEvents = AGGREGATE_EVENT_NAMES;
  const eventNames = definition.event_names ?? [];
  const grouping = definition.grouping_dimensions ?? [];
  const fail = () => { throw new Error(`metric_definition_series_mismatch:${definition.metric_name}`); };
  const strictCosts = definition.cost_selection_policy !== undefined;
  const selectedCommerce = definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.commerce.rule_bundle_id;
  if (selectedCommerce) {
    if (definition.acquisition_basis !== "selected_first_party_click" || definition.anchor_event !== "install"
        || definition.aggregation_time_zone !== "UTC" || definition.metric_definition_version !== METRIC_PROFILE_BINDINGS.commerce.metric_definition_version
        || definition.rule_bundle_version !== METRIC_PROFILE_BINDINGS.commerce.metric_definition_version
        || definition.rule_bundle_hash !== METRIC_PROFILE_BINDINGS.commerce.rule_bundle_hash
        || !["purchase_net_revenue", "total_net_revenue"].includes(definition.definition.numerator)
        || (definition.definition.calculation === "revenue_over_cost"
          ? definition.cost_selection_policy !== "reject_overlapping_grains" : strictCosts)) fail();
  }
  if (!selectedCommerce && (strictCosts || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.safe_cost.rule_bundle_id)) {
    if (definition.cost_selection_policy !== "reject_overlapping_grains" || definition.anchor_event !== "install"
        || definition.aggregation_time_zone !== "UTC" || definition.metric_definition_version !== METRIC_PROFILE_BINDINGS.safe_cost.metric_definition_version
        || definition.rule_bundle_id !== METRIC_PROFILE_BINDINGS.safe_cost.rule_bundle_id || definition.rule_bundle_version !== METRIC_PROFILE_BINDINGS.safe_cost.metric_definition_version
        || definition.rule_bundle_hash !== METRIC_PROFILE_BINDINGS.safe_cost.rule_bundle_hash
        || definition.definition.calculation !== "revenue_over_cost" || definition.definition.window.type !== "elapsed"
        || !["revenue", "total_net_revenue"].includes(definition.definition.numerator)) fail();
    if (definition.acquisition_basis !== undefined && (definition.acquisition_basis !== "selected_first_party_click"
        || definition.definition.numerator !== "revenue")) fail();
  }
  if (!selectedCommerce && !strictCosts && (definition.acquisition_basis !== undefined || definition.rule_bundle_id === METRIC_PROFILE_BINDINGS.selected.rule_bundle_id)) {
    if (definition.acquisition_basis !== "selected_first_party_click" || definition.anchor_event !== "install"
        || definition.metric_definition_version !== METRIC_PROFILE_BINDINGS.selected.metric_definition_version || definition.rule_bundle_id !== METRIC_PROFILE_BINDINGS.selected.rule_bundle_id
        || definition.rule_bundle_version !== METRIC_PROFILE_BINDINGS.selected.metric_definition_version || definition.rule_bundle_hash !== METRIC_PROFILE_BINDINGS.selected.rule_bundle_hash
        || !["revenue", "active_installations", "cohort_size"].includes(definition.definition.numerator)) fail();
  }
  if (definition.definition?.numerator === "purchase_net_revenue" || purchaseNetSeries.has(definition.metric_name)) {
    const expectedPurchase = purchaseNetSeries.get(definition.metric_name);
    const expectedDay = expectedPurchase?.definition.window.day;
    const expectedVersion = selectedCommerce ? METRIC_PROFILE_BINDINGS.commerce.metric_definition_version : expectedPurchase?.metric_definition_version;
    const expectedHash = selectedCommerce ? METRIC_PROFILE_BINDINGS.commerce.rule_bundle_hash : expectedPurchase?.rule_bundle_hash;
    if (expectedDay === undefined || definition.metric_definition_version !== expectedVersion ||
        definition.anchor_event !== "install" || definition.aggregation_time_zone !== "UTC" ||
        definition.value_type !== "money" || definition.currency !== expectedPurchase?.currency || definition.amount_scale !== expectedPurchase?.amount_scale ||
        definition.rule_bundle_id !== (selectedCommerce ? METRIC_PROFILE_BINDINGS.commerce.rule_bundle_id : METRIC_PROFILE_BINDINGS.purchase.rule_bundle_id) ||
        definition.rule_bundle_version !== expectedVersion || definition.rule_bundle_hash !== expectedHash ||
        definition.definition?.calculation !== "revenue_sum" ||
        definition.definition?.numerator !== "purchase_net_revenue" ||
        definition.definition?.window?.type !== "elapsed" || definition.definition?.window?.day !== expectedDay) fail();
    return;
  }
  if (definition.definition?.numerator === "total_net_revenue" || totalNetSeries.has(definition.metric_name)) {
    const expected = totalNetSeries.get(definition.metric_name);
    if (!expected || definition.metric_definition_version !== (selectedCommerce ? METRIC_PROFILE_BINDINGS.commerce.metric_definition_version : strictCosts ? METRIC_PROFILE_BINDINGS.safe_cost.metric_definition_version : METRIC_PROFILE_BINDINGS.total.metric_definition_version) ||
        definition.anchor_event !== "install" || definition.aggregation_time_zone !== "UTC" ||
        definition.value_type !== expected.value_type ||
        (expected.value_type === "money" && (definition.currency !== expected.currency || definition.amount_scale !== expected.amount_scale)) ||
        (expected.value_type === "ratio" && definition.ratio_scale !== expected.ratio_scale) ||
        definition.rule_bundle_id !== (selectedCommerce ? METRIC_PROFILE_BINDINGS.commerce.rule_bundle_id : strictCosts ? METRIC_PROFILE_BINDINGS.safe_cost.rule_bundle_id : METRIC_PROFILE_BINDINGS.total.rule_bundle_id) ||
        definition.rule_bundle_version !== (selectedCommerce ? METRIC_PROFILE_BINDINGS.commerce.metric_definition_version : strictCosts ? METRIC_PROFILE_BINDINGS.safe_cost.metric_definition_version : METRIC_PROFILE_BINDINGS.total.metric_definition_version)
        || definition.rule_bundle_hash !== (selectedCommerce ? METRIC_PROFILE_BINDINGS.commerce : strictCosts ? METRIC_PROFILE_BINDINGS.safe_cost : METRIC_PROFILE_BINDINGS.total).rule_bundle_hash ||
        definition.definition?.calculation !== expected.definition.calculation ||
        definition.definition?.numerator !== "total_net_revenue" ||
        definition.definition?.window?.type !== "elapsed" || definition.definition?.window?.day !== expected.definition.window.day ||
        (expected.definition.calculation === "revenue_over_cost" &&
          (definition.definition?.denominator !== "cost" ||
            definition.definition?.cost_basis !== "cohort_acquisition_day_current_snapshot")) ||
        (expected.definition.calculation === "revenue_over_cohort" && definition.definition?.denominator !== "cohort_size")) fail();
    return;
  }
  if (aggregateSeries.has(definition.metric_name)) {
    const expected = aggregateSeries.get(definition.metric_name)!;
    const expectedEvent = expected.event;
    const expectedGrouping = expected.grouping;
    if (definition.definition?.calculation !== "event_count" || definition.definition?.numerator !== "events" ||
        definition.aggregation_time_zone !== "UTC" || eventNames.length !== 1 || eventNames[0] !== expectedEvent ||
        grouping.length !== expectedGrouping.length || expectedGrouping.some((value) => !grouping.includes(value))) fail();
    return;
  }
  if (DEEP_LINK_METRIC_SERIES.has(definition.metric_name)) {
    const expectedGrouping = DEEP_LINK_METRIC_SERIES.get(definition.metric_name)!.grouping;
    if (definition.definition?.calculation !== "event_count" || definition.definition?.numerator !== "events" ||
        eventNames.length !== 1 || eventNames[0] !== "deep_link_open" ||
        grouping.length !== expectedGrouping.length || expectedGrouping.some((value) => !grouping.includes(value))) fail();
    return;
  }
  if (eventNames.some((value: string) => aggregateEvents.has(value)) || grouping.includes("apple_conversion_bucket")) fail();
}
