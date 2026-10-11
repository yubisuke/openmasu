import { comparisonMeaning, type MetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import { cohortDayStart, addCalendarDays, DATED_FX_POLICY_VERSION, validDatedFxPolicy, canonicalDatedFxPolicy, type DatedFxRate, type DatedFxPolicyInput } from "@openmasu/contracts/definitions";
import type { GroupingDimension } from "./report-query.js";

type Rounding = "half_even" | "half_up" | "truncate";
/** An operator's description, never a captured execution or provider attestation. */
export type ExternalRoasDeclaration = {
  version: 1; profile: "external-elapsed-ad-roas-v1";
  anchor_event: "install"; calculation: "revenue_over_cost"; numerator: "revenue"; denominator: "cost";
  aggregation: "cumulative"; time_zone: "UTC" | "Asia/Tokyo";
  window: { type: "elapsed"; day: number; boundary: "half_open" };
  population: "accepted_installation_cohort";
  acquisition_basis: "recorded_dimensions" | "selected_first_party_click" | "selected_verified_platform";
  cost_basis: "cohort_acquisition_day_current_snapshot";
  cost_selection_policy: "legacy_dimension_digest_latest" | "reject_overlapping_grains";
  grouping_dimensions: GroupingDimension[];
  fraud_policy: "gross" | "net"; privacy_state: "before" | "after";
  value_type: "ratio"; ratio_scale: number;
  fx: { target_currency: string; target_scale: number; conversion: "per_event_round_then_sum" | "round_after_sum";
    rounding_mode: Rounding; rates: { currency: string; rate_unscaled: string; rate_scale: number; as_of: string }[] };
  final_rounding: Rounding;
};
/** Closed installation-cohort families; null means explicitly not applicable, not unknown. */
export type ExternalCohortDeclaration = Omit<ExternalRoasDeclaration,
  "version" | "profile" | "calculation" | "numerator" | "denominator" | "aggregation" | "window" | "cost_basis" | "value_type" | "ratio_scale" | "fx"> & {
  version: 2; profile: "external-install-cohort-v2";
  calculation: "revenue_sum" | "revenue_over_cost" | "revenue_over_cohort" | "active_installations_over_cohort" | "converted_installations_over_cohort";
  numerator: "revenue" | "purchase_net_revenue" | "total_net_revenue" | "active_installations" | "converted_installations";
  denominator: "cost" | "cohort_size" | null; aggregation: "cumulative" | "on_day";
  window: { type: "elapsed" | "activity_day" | "calendar_day"; day: number; boundary: "half_open" };
  cost_basis: "cohort_acquisition_day_current_snapshot" | null;
  value_type: "money" | "ratio"; currency: string | null; amount_scale: number | null; ratio_scale: number | null;
  calendar_cohort_policy: "cumulative_revenue_on_day_activity" | null;
  cohort_date_basis: "installation_local_date" | null; cost_reporting_time_zone: "same_as_aggregation_time_zone" | null;
  retention_maturity_policy: "complete_activity_window" | null;
  acquisition_dimension_policy: "selected_link_ad_group_creative" | null;
  refund_policy: "settled_linked_refunds_own_window" | null;
  refund_reversal_policy: "cancel_target_refund_at_watermark" | null;
  conversion_event_key: string | null; activity_events: string[]; event_names: [];
  fx: (ExternalRoasDeclaration["fx"] & { rate_selection?: DatedFxPolicyInput["rate_selection"];
    cost_conversion?: "per_cost_row_round_then_sum"; rates: (ExternalRoasDeclaration["fx"]["rates"][number] | DatedFxRate)[] }) | null;
};
export type ExternalDeclaration = ExternalRoasDeclaration | ExternalCohortDeclaration;
export type ExternalCalculation = { declaration: ExternalDeclaration; declaration_sha256: string };
const dimensions = ["cohort_date", "campaign_id", "network", "country", "attribution_status", "ad_group_id", "creative_id", "acquisition_campaign_state"];
const fields = ["version", "profile", "anchor_event", "calculation", "numerator", "denominator", "aggregation", "time_zone",
  "window", "population", "acquisition_basis", "cost_basis", "cost_selection_policy", "grouping_dimensions", "fraud_policy",
  "privacy_state", "value_type", "ratio_scale", "fx", "final_rounding"];
function closed(value: unknown, allowed: readonly string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) throw Error("invalid_external_declaration_fields");
}
function choice(value: unknown, allowed: readonly unknown[]) {
  if (!allowed.includes(value)) throw Error("unsupported_external_declaration_value");
}
function scale(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 18) throw Error("invalid_external_declaration_scale");
}
function parseLegacyDeclaration(input: unknown): ExternalRoasDeclaration {
  closed(input, fields);
  for (const [key, value] of Object.entries({ version: 1, profile: "external-elapsed-ad-roas-v1", anchor_event: "install",
    calculation: "revenue_over_cost", numerator: "revenue", denominator: "cost", aggregation: "cumulative",
    population: "accepted_installation_cohort", cost_basis: "cohort_acquisition_day_current_snapshot", value_type: "ratio" })) choice(input[key], [value]);
  choice(input.time_zone, ["UTC", "Asia/Tokyo"]);
  choice(input.acquisition_basis, ["recorded_dimensions", "selected_first_party_click", "selected_verified_platform"]);
  choice(input.cost_selection_policy, ["legacy_dimension_digest_latest", "reject_overlapping_grains"]);
  choice(input.fraud_policy, ["gross", "net"]); choice(input.privacy_state, ["before", "after"]);
  choice(input.final_rounding, ["half_even", "half_up", "truncate"]); scale(input.ratio_scale);
  closed(input.window, ["type", "day", "boundary"]);
  choice(input.window.type, ["elapsed"]); choice(input.window.boundary, ["half_open"]);
  if (!Number.isInteger(input.window.day) || input.window.day < 0 || input.window.day > 3650) throw Error("invalid_external_declaration_window");
  if (!Array.isArray(input.grouping_dimensions) || !input.grouping_dimensions.includes("cohort_date")
      || new Set(input.grouping_dimensions).size !== input.grouping_dimensions.length
      || input.grouping_dimensions.some((key: unknown) => typeof key !== "string" || !dimensions.includes(key))) throw Error("invalid_external_declaration_grouping");
  legacyFx(input.fx);
  return structuredClone(input) as ExternalRoasDeclaration;
}
function legacyFx(fx: unknown) {
  closed(fx, ["target_currency", "target_scale", "conversion", "rounding_mode", "rates"]);
  choice(fx.conversion, ["per_event_round_then_sum", "round_after_sum"]);
  choice(fx.rounding_mode, ["half_even", "half_up", "truncate"]); scale(fx.target_scale);
  if (typeof fx.target_currency !== "string" || !/^[A-Z]{3}$/.test(fx.target_currency)
      || !Array.isArray(fx.rates) || fx.rates.length !== 1) throw Error("invalid_external_declaration_fx");
  for (const rate of fx.rates) {
    closed(rate, ["currency", "rate_unscaled", "rate_scale", "as_of"]); scale(rate.rate_scale);
    if (typeof rate.currency !== "string" || !/^[A-Z]{3}$/.test(rate.currency) || typeof rate.rate_unscaled !== "string"
        || !/^(?:0|[1-9]\d{0,99})$/.test(rate.rate_unscaled) || typeof rate.as_of !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(rate.as_of)
        || !Number.isFinite(Date.parse(rate.as_of)) || new Date(rate.as_of).toISOString().slice(0, 19) !== rate.as_of.slice(0, 19)) throw Error("invalid_external_declaration_fx");
  }
}

const nullablePolicies = ["calendar_cohort_policy", "cohort_date_basis", "cost_reporting_time_zone", "retention_maturity_policy",
  "acquisition_dimension_policy", "refund_reversal_policy", "conversion_event_key"] as const;
const cohortFields = [...fields, "currency", "amount_scale", "refund_policy", "activity_events", "event_names", ...nullablePolicies];
export function parseExternalDeclaration(input: unknown): ExternalDeclaration {
  if (input && typeof input === "object" && "version" in input && input.version === 1) return parseLegacyDeclaration(input);
  closed(input, cohortFields);
  choice(input.version, [2]); choice(input.profile, ["external-install-cohort-v2"]);
  choice(input.anchor_event, ["install"]); choice(input.population, ["accepted_installation_cohort"]);
  choice(input.calculation, ["revenue_sum", "revenue_over_cost", "revenue_over_cohort", "active_installations_over_cohort", "converted_installations_over_cohort"]);
  const revenue = input.calculation.startsWith("revenue_"), retention = input.calculation === "active_installations_over_cohort";
  choice(input.numerator, revenue ? ["revenue", "purchase_net_revenue", "total_net_revenue"] : [retention ? "active_installations" : "converted_installations"]);
  choice(input.denominator, [null, "cost", "cohort_size"]);
  choice(input.cost_basis, [null, "cohort_acquisition_day_current_snapshot"]);
  choice(input.aggregation, [retention ? "on_day" : "cumulative"]);
  choice(input.time_zone, ["UTC", "Asia/Tokyo"]);
  choice(input.acquisition_basis, ["recorded_dimensions", "selected_first_party_click", "selected_verified_platform"]);
  choice(input.cost_selection_policy, ["legacy_dimension_digest_latest", "reject_overlapping_grains"]);
  choice(input.fraud_policy, ["gross", "net"]); choice(input.privacy_state, ["before", "after"]);
  choice(input.final_rounding, ["half_even", "half_up", "truncate"]);
  closed(input.window, ["type", "day", "boundary"]); choice(input.window.boundary, ["half_open"]);
  choice(input.window.type, retention ? ["activity_day", "calendar_day"] : revenue ? ["elapsed", "calendar_day"] : ["elapsed"]);
  if (!Number.isInteger(input.window.day) || input.window.day < 0 || input.window.day > 3650) throw Error("invalid_external_declaration_window");
  const calendar = input.window.type === "calendar_day";
  choice(input.calendar_cohort_policy, [calendar ? "cumulative_revenue_on_day_activity" : null]);
  choice(input.cohort_date_basis, [calendar ? "installation_local_date" : null]);
  choice(input.cost_reporting_time_zone, [calendar ? "same_as_aggregation_time_zone" : null]);
  choice(input.retention_maturity_policy, retention ? [null, "complete_activity_window"] : [null]);
  choice(input.acquisition_dimension_policy, [null, "selected_link_ad_group_creative"]);
  const net = ["purchase_net_revenue", "total_net_revenue"].includes(input.numerator);
  choice(input.refund_policy, [net ? "settled_linked_refunds_own_window" : null]);
  choice(input.refund_reversal_policy, net ? [null, "cancel_target_refund_at_watermark"] : [null]);
  if (!Array.isArray(input.activity_events) || (retention ? input.activity_events.length !== 1 || input.activity_events[0] !== "session_start" : input.activity_events.length !== 0)
      || !Array.isArray(input.event_names) || input.event_names.length !== 0) throw Error("invalid_external_declaration_events");
  if (!revenue && !retention) {
    if (typeof input.conversion_event_key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(input.conversion_event_key)) throw Error("invalid_external_declaration_event_key");
  } else choice(input.conversion_event_key, [null]);
  if (!Array.isArray(input.grouping_dimensions) || !input.grouping_dimensions.includes("cohort_date")
      || new Set(input.grouping_dimensions).size !== input.grouping_dimensions.length
      || input.grouping_dimensions.some((key: unknown) => typeof key !== "string" || !dimensions.includes(key))) throw Error("invalid_external_declaration_grouping");
  const money = ["revenue_sum", "revenue_over_cohort"].includes(input.calculation);
  choice(input.value_type, [money ? "money" : "ratio"]);
  if (money) {
    if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) throw Error("invalid_external_declaration_currency");
    scale(input.amount_scale); choice(input.ratio_scale, [null]);
  } else { choice(input.currency, [null]); choice(input.amount_scale, [null]); scale(input.ratio_scale); }
  if (revenue) {
    const fx = input.fx, dated = fx && Object.hasOwn(fx, "rate_selection");
    closed(fx, ["target_currency", "target_scale", "conversion", "rounding_mode", "rates", ...(dated ? ["rate_selection", "cost_conversion"] : [])]);
    choice(fx.conversion, ["per_event_round_then_sum", "round_after_sum"]);
    choice(fx.rounding_mode, ["half_even", "half_up", "truncate"]);
    if (dated) {
      choice(fx.cost_conversion, ["per_cost_row_round_then_sum"]);
      // Validate the same dated-rate shape, without turning this declaration into execution evidence.
      if (!validDatedFxPolicy(datedPolicyShape(fx))) throw Error("invalid_external_declaration_fx");
    } else {
      // Keep the legacy single-rate validation and all its precision bounds in one place.
      legacyFx(fx);
    }
    if (money && (fx.target_currency !== input.currency || fx.target_scale !== input.amount_scale)) throw Error("invalid_external_declaration_units");
  } else choice(input.fx, [null]);
  return structuredClone(input) as ExternalCohortDeclaration;
}

function datedPolicyShape(fx: Record<string, any>) {
  return { policy_version: DATED_FX_POLICY_VERSION, target_currency: fx.target_currency, target_scale: fx.target_scale,
    rounding_mode: "half_even", rate_selection: fx.rate_selection, rates: fx.rates };
}

export function externalDeclarationMeaning(declaration: ExternalDeclaration): Record<string, any> {
  const { version: _version, profile: _profile, ...meaning } = declaration;
  const fx = meaning.fx;
  return { ...Object.fromEntries(nullablePolicies.map(key => [key, null])), currency: null, amount_scale: null,
    refund_policy: null, activity_events: [], event_names: [], ...meaning,
    ...(fx && "rate_selection" in fx ? { fx: { ...fx, rates: canonicalDatedFxPolicy(datedPolicyShape(fx)).rates } } : {}),
    grouping_dimensions: [...meaning.grouping_dimensions].sort() };
}
/** Fail closed when a saved implementation has semantics this external format cannot express. */
export function capturedExternalMeaning(context: MetricComparisonContext) {
  if (context.definition.acquisition_basis === "selected_imported_provider" || context.definition.engagement_credit_policy) return undefined;
  const meaning = comparisonMeaning(context);
  if (!meaning || Object.keys(meaning).some(key => !cohortFields.includes(key))) return undefined;
  const { profile: _profile, ...values } = meaning;
  try {
    return externalDeclarationMeaning(parseExternalDeclaration({ ...Object.fromEntries(nullablePolicies.map(key => [key, null])),
      ...values, version: 2, profile: "external-install-cohort-v2", currency: meaning.value_type === "money" ? meaning.currency : null,
      amount_scale: meaning.value_type === "money" ? meaning.amount_scale : null,
      refund_policy: ["purchase_net_revenue", "total_net_revenue"].includes(meaning.numerator) ? "settled_linked_refunds_own_window" : null,
      final_rounding: "half_even" }));
  } catch { return undefined; }
}

export function externalUnits(declaration: ExternalDeclaration) {
  return declaration.value_type === "money" ? { currency: declaration.currency!, scale: declaration.amount_scale! }
    : { currency: "none", scale: declaration.ratio_scale! };
}
export function externalWindowMaturity(declaration: ExternalDeclaration, cohortDate: string, watermark: string) {
  // This is elapsed time under the declaration, not evidence of actual provider delivery.
  if (declaration.window.type === "calendar_day") {
    return Date.parse(watermark) >= Date.parse(cohortDayStart(addCalendarDays(cohortDate, declaration.window.day + 1), declaration.time_zone)) ? "window_elapsed" : "unknown";
  }
  const offset = declaration.time_zone === "Asia/Tokyo" ? 9 * 3_600_000 : 0;
  const closesAt = Date.parse(cohortDate) - offset + (declaration.window.day + 2) * 86_400_000;
  return Date.parse(watermark) >= closesAt ? "window_elapsed" : "unknown";
}
