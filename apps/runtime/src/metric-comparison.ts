import type { OpenMasuMetricDefinitionV04 as MetricDefinition } from "../../../packages/contracts/src/generated/contract-types.js";
import { cohortDayStart, addCalendarDays, canonicalDatedFxPolicy, isCalendarActivityMetric, isPayerMetric, isPayerMetricDefinition,
  isCalendarActivityMetricDefinition, metricProfileMetadata, ENGAGEMENT_POLICY_BUNDLE, ENGAGEMENT_POLICY_VERSION,
  ENGAGEMENT_POLICY_METRIC_NAMES, type DatedFxPolicyInput } from "@openmasu/contracts/definitions";

/** Aggregate-only metadata. Never store a replay manifest or evidence IDs here. */
export type ComparisonFx = {
  policy_version: string;
  target_currency: string;
  target_scale: number;
  rounding_mode: "half_even";
  rate_selection?: DatedFxPolicyInput["rate_selection"];
  rates: { currency: string; rate_unscaled: string; rate_scale: number; as_of: string; effective_date?: string; source?: string }[];
};
export type MetricComparisonContext = {
  version: 1;
  profile: "openmasu-sql-metric-v1";
  metric_run_id: string;
  input_snapshot_id: string;
  definition: MetricDefinition;
  definition_digest: string;
  fx: ComparisonFx;
  fx_digest: string;
  privacy_state: "before" | "after";
};

/** Closed shared identity for schedule selection and captured comparison contexts. */
export function projectMetricComparisonDefinition(definition: MetricDefinition): MetricDefinition {
  // Closed projection even if a caller supplies an object with extra properties.
  return {
    metric_name: definition.metric_name, metric_definition_version: definition.metric_definition_version,
    anchor_event: definition.anchor_event, aggregation_time_zone: definition.aggregation_time_zone,
    value_type: definition.value_type,
    ...(definition.currency !== undefined ? { currency: definition.currency } : {}),
    ...(definition.amount_scale !== undefined ? { amount_scale: definition.amount_scale } : {}),
    ...(definition.ratio_scale !== undefined ? { ratio_scale: definition.ratio_scale } : {}),
    definition: { calculation: definition.definition.calculation, numerator: definition.definition.numerator,
      window: { type: definition.definition.window.type, day: definition.definition.window.day },
      ...(definition.definition.denominator !== undefined ? { denominator: definition.definition.denominator } : {}),
      ...(definition.definition.cost_basis !== undefined ? { cost_basis: definition.definition.cost_basis } : {}) },
    ...(definition.activity_events ? { activity_events: [...definition.activity_events] } : {}),
    ...(definition.event_names ? { event_names: [...definition.event_names] } : {}),
    ...(definition.grouping_dimensions ? { grouping_dimensions: [...definition.grouping_dimensions] } : {}),
    ...(definition.fraud_policy ? { fraud_policy: definition.fraud_policy } : {}),
    ...(definition.acquisition_basis ? { acquisition_basis: definition.acquisition_basis } : {}),
    ...(definition.import_provider ? { import_provider: definition.import_provider } : {}),
    ...(definition.calendar_cohort_policy ? { calendar_cohort_policy: definition.calendar_cohort_policy } : {}),
    ...(definition.retention_maturity_policy ? { retention_maturity_policy: definition.retention_maturity_policy } : {}),
    ...(definition.acquisition_dimension_policy ? { acquisition_dimension_policy: definition.acquisition_dimension_policy } : {}),
    ...(definition.conversion_event_key !== undefined ? { conversion_event_key: definition.conversion_event_key } : {}),
    ...(definition.cost_selection_policy ? { cost_selection_policy: definition.cost_selection_policy } : {}),
    ...(definition.refund_reversal_policy ? { refund_reversal_policy: definition.refund_reversal_policy } : {}),
    ...(definition.engagement_credit_policy ? { engagement_credit_policy: definition.engagement_credit_policy } : {}),
    ...(definition.engagement_inactivity_days !== undefined ? { engagement_inactivity_days: definition.engagement_inactivity_days } : {}),
    rule_bundle_id: definition.rule_bundle_id, rule_bundle_version: definition.rule_bundle_version,
    rule_bundle_hash: definition.rule_bundle_hash,
  };
}

export function captureMetricComparisonContext(
  run: { metric_run_id: string; input_snapshot_id: string },
  definition: MetricDefinition,
  fxPolicy: ComparisonFx,
  privacyState: "before" | "after",
  digest: (value: unknown) => string,
): MetricComparisonContext {
  const savedDefinition = projectMetricComparisonDefinition(definition);
  const fx: ComparisonFx = fxPolicy.rate_selection ? canonicalDatedFxPolicy(fxPolicy) : {
    policy_version: fxPolicy.policy_version, target_currency: fxPolicy.target_currency,
    target_scale: fxPolicy.target_scale, rounding_mode: fxPolicy.rounding_mode,
    rates: fxPolicy.rates.map(rate => ({ currency: rate.currency, rate_unscaled: rate.rate_unscaled,
      rate_scale: rate.rate_scale, as_of: rate.as_of })).sort((a, b) => a.currency.localeCompare(b.currency, "en")),
  };
  return { version: 1, profile: "openmasu-sql-metric-v1", metric_run_id: run.metric_run_id,
    input_snapshot_id: run.input_snapshot_id, definition: savedDefinition,
    definition_digest: digest(savedDefinition), fx, fx_digest: digest(fx), privacy_state: privacyState };
}

/** Explicit implemented profile, not a metric-name heuristic or bundle-ID match. */
export function comparisonMeaning(context: MetricComparisonContext) {
  const d = context.definition, calculation = d.definition.calculation, window = d.definition.window;
  const revenue = ["revenue_sum", "revenue_over_cost", "revenue_over_cohort"].includes(calculation);
  const cost = ["cost_sum", "cost_over_cohort"].includes(calculation);
  const conversion = ["converted_installations", "converted_installations_over_cohort"].includes(calculation);
  if (isPayerMetric(d)) {
    if (!isPayerMetricDefinition(d) || d.value_type === "money" &&
        (context.fx.target_currency !== d.currency || context.fx.target_scale !== d.amount_scale)) return undefined;
    return {
      profile: context.profile, anchor_event: "install", time_zone: "UTC", calculation,
      numerator: d.definition.numerator, denominator: d.definition.denominator ?? null,
      cost_basis: null, aggregation: "cumulative", window: { ...window, boundary: "half_open" },
      population: "native_cohort_verified_settled_store_projections", acquisition_basis: d.acquisition_basis,
      cost_selection_policy: "not_applicable", fraud_policy: "gross",
      grouping_dimensions: [...d.grouping_dimensions!].sort(), privacy_state: context.privacy_state,
      payer_identity: "tenant_app_installation_not_person", refunded_payer: "retained_historical_purchase",
      refund_reversal_policy: d.refund_reversal_policy, value_type: d.value_type,
      currency: d.currency ?? null, amount_scale: d.amount_scale ?? null, ratio_scale: d.ratio_scale ?? null,
      fx: d.value_type === "money" ? { target_currency: context.fx.target_currency, target_scale: context.fx.target_scale,
        ...(context.fx.rate_selection ? { rate_selection: context.fx.rate_selection } : {}),
        rounding_mode: context.fx.rounding_mode, conversion: "per_event_round_then_sum", rates: context.fx.rates } : null,
    };
  }
  if (isCalendarActivityMetric(d)) {
    if (!isCalendarActivityMetricDefinition(d)) return undefined;
    return {
      profile: context.profile, anchor_event: "calendar_day", time_zone: "UTC", calculation,
      numerator: d.definition.numerator, denominator: null, cost_basis: null, aggregation: "on_day",
      window: { ...window, boundary: "half_open" }, population: "accepted_calendar_activity",
      acquisition_basis: "not_applicable", cost_selection_policy: "not_applicable", fraud_policy: "gross",
      grouping_dimensions: ["metric_date"], event_names: [...d.event_names!].sort(),
      distinct_scope: calculation === "active_installations_count" ? "tenant_app_installation_per_day" : null,
      activity_unit: calculation === "active_installations_count" ? "distinct_installations"
        : d.metric_name === "daily_session_starts" ? "session_starts" : "custom_events",
      privacy_state: context.privacy_state, value_type: "count", currency: null, amount_scale: null, ratio_scale: null, fx: null,
    };
  }
  if (d.engagement_credit_policy) {
    const explicit = d.rule_bundle_id === ENGAGEMENT_POLICY_BUNDLE;
    if (explicit && (metricProfileMetadata(d)?.key !== "engagement_policy"
        || d.metric_definition_version !== ENGAGEMENT_POLICY_VERSION
        || !ENGAGEMENT_POLICY_METRIC_NAMES.some(name => name === d.metric_name)
        || !Number.isInteger(d.engagement_inactivity_days) || d.engagement_inactivity_days! < 0 || d.engagement_inactivity_days! > 90
        || !Number.isInteger(window.day) || window.day < 0 || window.day > 29)) return undefined;
    if (!explicit && d.engagement_inactivity_days !== undefined) return undefined;
    if (d.anchor_event !== "deep_link_open" || d.engagement_credit_policy !== "latest_eligible_open_before_outcome"
        || d.aggregation_time_zone !== "UTC" || window.type !== "elapsed" || (!explicit && window.day !== 0)
        || !["converted_installations", "revenue_sum"].includes(calculation)
        || (conversion && (!d.conversion_event_key || d.definition.numerator !== "converted_installations"))
        || (revenue && (!(explicit ? ["revenue", "purchase_net_revenue"].includes(d.definition.numerator) : d.definition.numerator === "revenue")
          || context.fx.target_currency !== d.currency || context.fx.target_scale !== d.amount_scale))) return undefined;
    return {
      profile: context.profile, anchor_event: d.anchor_event, time_zone: "UTC", calculation,
      numerator: d.definition.numerator, denominator: null, cost_basis: null, aggregation: "cumulative",
      window: { ...window, boundary: "half_open" }, population: "server_resolved_non_organic_engagement",
      acquisition_basis: "server_resolved_deep_link", cost_selection_policy: "not_applicable", fraud_policy: "gross",
      engagement_credit_policy: d.engagement_credit_policy, evidence_trust: "device_reported_forgeable",
      ...(explicit ? { engagement_inactivity_days: d.engagement_inactivity_days,
        inactivity_evidence_policy: "recorded_sdk_install_prefix_and_activity", unknown_history_policy: "undefined_selected_population" } : {}),
      ...(explicit && d.definition.numerator === "purchase_net_revenue" ? {
        purchase_authority: "verified_settled_store_projections", refund_credit_policy: "original_purchase_open",
        refund_reversal_policy: d.refund_reversal_policy,
      } : {}),
      ...(conversion ? { conversion_event_key: d.conversion_event_key } : {}),
      grouping_dimensions: [...(d.grouping_dimensions ?? [])].sort(), privacy_state: context.privacy_state,
      value_type: d.value_type, currency: d.currency ?? null, amount_scale: d.amount_scale ?? null, ratio_scale: null,
      fx: revenue ? { target_currency: context.fx.target_currency, target_scale: context.fx.target_scale,
        ...(context.fx.rate_selection ? { rate_selection: context.fx.rate_selection } : {}),
        rounding_mode: context.fx.rounding_mode, conversion: "per_event_round_then_sum", rates: context.fx.rates } : null,
    };
  }
  const supported = d.anchor_event === (calculation === "event_count" ? "calendar_day" : "install")
    && (revenue ? (window.type === "elapsed" || !!d.calendar_cohort_policy && window.type === "calendar_day") && ["revenue", "purchase_net_revenue", "total_net_revenue"].includes(d.definition.numerator)
      : cost ? window.type === "elapsed" && d.definition.numerator === "cost"
        && d.definition.cost_basis === "cohort_acquisition_day_current_snapshot"
        && (calculation !== "cost_over_cohort" || d.definition.denominator === "cohort_size")
      : calculation === "active_installations_over_cohort" ? (window.type === "activity_day" || !!d.calendar_cohort_policy && window.type === "calendar_day") && d.definition.numerator === "active_installations"
      : calculation === "event_count" ? window.type === "calendar_day" && window.day === 0 && d.definition.numerator === "events"
      : conversion ? window.type === "elapsed" && window.day === 7 && d.definition.numerator === "converted_installations"
        && typeof d.conversion_event_key === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(d.conversion_event_key)
        && d.acquisition_basis === "selected_first_party_click" && d.aggregation_time_zone === "UTC"
      : calculation === "cohort_size" && d.definition.numerator === "cohort_size")
    && (calculation !== "event_count" || (d.event_names?.length === 1 && ["click", "install", "deep_link_open"].includes(d.event_names[0])))
    && (calculation !== "active_installations_over_cohort" || (d.activity_events ?? ["session_start"]).every(name => name === "session_start"))
    && (calculation !== "revenue_over_cost" || (d.definition.denominator === "cost" && d.definition.cost_basis === "cohort_acquisition_day_current_snapshot"))
    && (!["active_installations_over_cohort", "revenue_over_cohort", "converted_installations_over_cohort"].includes(calculation) || d.definition.denominator === "cohort_size")
    && (!(revenue || cost) || context.fx.target_currency === (d.currency ?? context.fx.target_currency))
    && (d.value_type !== "money" || d.amount_scale === context.fx.target_scale);
  if (!supported) return undefined;
  const aggregation = calculation === "event_count" || calculation === "active_installations_over_cohort" ? "on_day" : "cumulative";
  return {
    profile: context.profile,
    anchor_event: d.anchor_event, time_zone: d.aggregation_time_zone,
    calculation, numerator: d.definition.numerator, denominator: d.definition.denominator ?? null,
    cost_basis: d.definition.cost_basis ?? null, aggregation,
    window: { ...window, boundary: "half_open" },
    population: calculation === "event_count" ? "accepted_logical_events" : "accepted_installation_cohort",
    acquisition_basis: d.acquisition_basis ?? "recorded_dimensions",
    ...(d.retention_maturity_policy ? { retention_maturity_policy: d.retention_maturity_policy } : {}),
    ...(d.calendar_cohort_policy ? { calendar_cohort_policy: d.calendar_cohort_policy,
      cohort_date_basis: "installation_local_date", cost_reporting_time_zone: "same_as_aggregation_time_zone" } : {}),
    ...(d.import_provider ? { import_provider: d.import_provider,
      outcome_binding: "same_import_producer_explicit_installation", dimensions: "canonical_import_context",
      attribution_revision: "selected_provider_reported_at_watermark" } : {}),
    ...(d.acquisition_dimension_policy ? { acquisition_dimension_policy: d.acquisition_dimension_policy } : {}),
    ...(conversion ? { conversion_event_key: d.conversion_event_key } : {}),
    cost_selection_policy: d.cost_selection_policy ?? "legacy_dimension_digest_latest",
    ...(d.refund_reversal_policy ? { refund_reversal_policy: d.refund_reversal_policy } : {}),
    grouping_dimensions: [...(d.grouping_dimensions ?? [])].sort(),
    activity_events: calculation === "active_installations_over_cohort" ? [...(d.activity_events ?? ["session_start"])].sort() : [],
    event_names: calculation === "event_count" ? [...(d.event_names ?? [])].sort() : [],
    fraud_policy: d.fraud_policy ?? "gross", privacy_state: context.privacy_state,
    value_type: d.value_type, currency: d.currency ?? null,
    amount_scale: d.amount_scale ?? null, ratio_scale: d.ratio_scale ?? null,
    fx: revenue || cost ? { target_currency: context.fx.target_currency, target_scale: context.fx.target_scale,
      rounding_mode: context.fx.rounding_mode, conversion: cost ? "per_cost_row_round_then_sum" : "per_event_round_then_sum",
      ...(context.fx.rate_selection ? { rate_selection: context.fx.rate_selection, cost_conversion: "per_cost_row_round_then_sum" } : {}),
      rates: context.fx.rate_selection ? context.fx.rates : context.fx.rates.map(({ currency, rate_unscaled, rate_scale, as_of }) => ({ currency, rate_unscaled, rate_scale, as_of })) } : null,
  };
}

/** Conservative temporal maturity, not a promise of provider completeness. */
export function comparisonMaturity(context: MetricComparisonContext, grouping: Record<string, string>, watermark: string) {
  const d = context.definition, calculation = d.definition.calculation;
  const day = calculation === "event_count" || isCalendarActivityMetric(d) || d.engagement_credit_policy ? grouping.metric_date : grouping.cohort_date;
  if (!comparisonMeaning(context) || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)
      || new Date(day).toISOString().slice(0, 10) !== day) return { state: "unknown", closes_at: null } as const;
  const offset = d.aggregation_time_zone === "Asia/Tokyo" ? 9 * 3_600_000 : 0;
  if (d.calendar_cohort_policy) {
    const closesAt = cohortDayStart(addCalendarDays(day, calculation === "cohort_size" ? 1 : d.definition.window.day + 1), d.aggregation_time_zone);
    return { state: Date.parse(watermark) >= Date.parse(closesAt) ? "window_elapsed" : "unknown", closes_at: closesAt } as const;
  }
  // Installs may occur anywhere within the cohort date. Use its exclusive end,
  // plus the complete elapsed/activity window, never an inferred install time.
  const days = calculation === "event_count" || isCalendarActivityMetric(d) || calculation === "cohort_size" ? 1 : d.definition.window.day + 2;
  const closesAt = new Date(Date.parse(day) - offset + days * 86_400_000).toISOString();
  return { state: Date.parse(watermark) >= Date.parse(closesAt) ? "window_elapsed" : "unknown",
    closes_at: closesAt } as const;
}
