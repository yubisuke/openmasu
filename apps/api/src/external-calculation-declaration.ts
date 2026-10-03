import { comparisonMeaning, type MetricComparisonContext } from "@openmasu/runtime/metric-comparison";
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
export type ExternalCalculation = { declaration: ExternalRoasDeclaration; declaration_sha256: string };
const dimensions = ["cohort_date", "campaign_id", "network", "country", "attribution_status", "ad_group_id"];
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
export function parseExternalDeclaration(input: unknown): ExternalRoasDeclaration {
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
  closed(input.fx, ["target_currency", "target_scale", "conversion", "rounding_mode", "rates"]);
  choice(input.fx.conversion, ["per_event_round_then_sum", "round_after_sum"]);
  choice(input.fx.rounding_mode, ["half_even", "half_up", "truncate"]); scale(input.fx.target_scale);
  if (typeof input.fx.target_currency !== "string" || !/^[A-Z]{3}$/.test(input.fx.target_currency)
      || !Array.isArray(input.fx.rates) || input.fx.rates.length !== 1) throw Error("invalid_external_declaration_fx");
  for (const rate of input.fx.rates) {
    closed(rate, ["currency", "rate_unscaled", "rate_scale", "as_of"]); scale(rate.rate_scale);
    if (typeof rate.currency !== "string" || !/^[A-Z]{3}$/.test(rate.currency) || typeof rate.rate_unscaled !== "string"
        || !/^(?:0|[1-9]\d{0,99})$/.test(rate.rate_unscaled) || typeof rate.as_of !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(rate.as_of)
        || !Number.isFinite(Date.parse(rate.as_of)) || new Date(rate.as_of).toISOString().slice(0, 19) !== rate.as_of.slice(0, 19)) throw Error("invalid_external_declaration_fx");
  }
  return structuredClone(input) as ExternalRoasDeclaration;
}

export function externalDeclarationMeaning(declaration: ExternalRoasDeclaration) {
  const { version: _version, profile: _profile, ...meaning } = declaration;
  return { ...meaning, grouping_dimensions: [...meaning.grouping_dimensions].sort() };
}
/** Only this narrow implemented profile can be compared to an external claim. */
export function capturedRoasMeaning(context: MetricComparisonContext) {
  // The legacy external declaration cannot express a provider-specific binding.
  // Keep it unsupported rather than dropping the saved provider meaning.
  if (context.definition.acquisition_basis === "selected_imported_provider") return undefined;
  const meaning = comparisonMeaning(context);
  if (!meaning || meaning.anchor_event !== "install" || meaning.window.type !== "elapsed"
      || meaning.calculation !== "revenue_over_cost" || meaning.numerator !== "revenue"
      || meaning.value_type !== "ratio" || !meaning.fx || meaning.ratio_scale === null
      || !meaning.grouping_dimensions.includes("cohort_date") || meaning.grouping_dimensions.some(key => !dimensions.includes(key))) return undefined;
  return externalDeclarationMeaning({ version: 1, profile: "external-elapsed-ad-roas-v1", anchor_event: "install",
    calculation: "revenue_over_cost", numerator: "revenue", denominator: "cost", aggregation: "cumulative",
    time_zone: meaning.time_zone, window: { type: "elapsed", day: meaning.window.day, boundary: "half_open" },
    population: "accepted_installation_cohort", acquisition_basis: context.definition.acquisition_basis ?? "recorded_dimensions",
    cost_basis: "cohort_acquisition_day_current_snapshot", cost_selection_policy: context.definition.cost_selection_policy ?? "legacy_dimension_digest_latest",
    grouping_dimensions: meaning.grouping_dimensions, fraud_policy: meaning.fraud_policy, privacy_state: meaning.privacy_state,
    value_type: "ratio", ratio_scale: meaning.ratio_scale, fx: { ...meaning.fx, conversion: "per_event_round_then_sum" }, final_rounding: "half_even" });
}

export function externalWindowMaturity(declaration: ExternalRoasDeclaration, cohortDate: string, watermark: string) {
  // This is elapsed time under the declaration, not evidence of actual provider delivery.
  const offset = declaration.time_zone === "Asia/Tokyo" ? 9 * 3_600_000 : 0;
  const closesAt = Date.parse(cohortDate) - offset + (declaration.window.day + 2) * 86_400_000;
  return Date.parse(watermark) >= closesAt ? "window_elapsed" : "unknown";
}
