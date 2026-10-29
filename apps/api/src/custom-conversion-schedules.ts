import { keyedCustomConversionMetricDefinitions } from "@openmasu/contracts/definitions";
import type { ScheduledMetricDefinition } from "@openmasu/contracts/validation";

const keyPattern = /^[a-z][a-z0-9_]{0,63}$/;
type JsonObject = Record<string, unknown>;

/** Non-financial identity policy required by the existing schedule envelope; no money is converted. */
const countOnlyFx = {
  policy_version: "custom-conversion-no-money-v1", target_currency: "USD", target_scale: 6,
  rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
    source: "identity-not-used-for-count-or-rate", as_of: "1970-01-01T00:00:00.000Z" }],
};

export function expandConversionScheduleRequest(body: JsonObject, selectableKeys: readonly string[]): JsonObject {
  if (Object.keys(body).some(key => !["custom_conversion_event_keys", "lag_days", "start_date"].includes(key))) {
    throw new Error("custom_conversion_schedule_field_forbidden");
  }
  const keys = body.custom_conversion_event_keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 50 || new Set(keys).size !== keys.length
      || keys.some(key => typeof key !== "string" || !keyPattern.test(key))) {
    throw new Error("custom_conversion_event_keys_invalid");
  }
  if (keys.some(key => !selectableKeys.includes(key))) throw new Error("custom_conversion_event_key_unknown");
  const lag = body.lag_days ?? 9;
  if (!Number.isSafeInteger(lag) || Number(lag) < 9 || Number(lag) > 365) {
    throw new Error("custom_conversion_lag_days_invalid");
  }
  const definitions = [...keys].sort().flatMap(key => keyedCustomConversionMetricDefinitions(key));
  return { lag_days: lag, ...(body.start_date !== undefined ? { start_date: body.start_date } : {}),
    fx_policy: structuredClone(countOnlyFx), metric_definitions: definitions,
    evaluations: [{ metric_names: definitions.map(definition => definition.metric_name),
      date_dimension: "cohort_date", grouping: {} }] };
}

/** Meaning ownership ignores aliases, but preserves explicit profile/window/fraud/grouping differences. */
export function conversionCalculationKey(definition: ScheduledMetricDefinition): string | undefined {
  if (definition.rule_bundle_id !== "metric-custom-conversion") return undefined;
  return JSON.stringify([definition.conversion_event_key, definition.rule_bundle_id,
    definition.metric_definition_version, definition.rule_bundle_version, definition.rule_bundle_hash,
    definition.definition.calculation, definition.definition.numerator, definition.definition.denominator ?? null,
    (definition.definition.window as JsonObject).type, (definition.definition.window as JsonObject).day,
    definition.anchor_event, definition.aggregation_time_zone, definition.acquisition_basis,
    definition.fraud_policy ?? "gross", definition.value_type, definition.ratio_scale ?? null,
    [...(definition.grouping_dimensions as string[] ?? [])].sort()]);
}
