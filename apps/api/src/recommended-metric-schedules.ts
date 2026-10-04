import { ACQUISITION_KPI_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS,
  keyedCustomConversionMetricDefinitions } from "@openmasu/contracts/definitions";
import { sha256Jcs } from "@openmasu/fraud-rules";

type Json = Record<string, unknown>;
const fields = ["recommended_profile", "acquisition_basis", "target_currency", "cutoff_policy",
  "lag_days", "start_date", "include_retention", "custom_conversion_event_keys", "preview_digest"];

/** Select existing factories only. Profile labels never authorize a new calculation. */
export function expandRecommendedMetricSchedule(body: Json, observedKeys: readonly string[]): Json {
  if (Object.keys(body).some(key => !fields.includes(key))) throw new Error("recommended_schedule_field_forbidden");
  if (body.recommended_profile !== "native_d7_v1") throw new Error("recommended_metric_set_unsupported");
  if (body.acquisition_basis !== "selected_first_party_click") throw new Error("recommended_acquisition_basis_unsupported");
  if (body.target_currency !== "USD") throw new Error("recommended_currency_unsupported");
  if (body.cutoff_policy !== "utc_start_of_worker_day") throw new Error("recommended_cutoff_unsupported");
  const lag = body.lag_days;
  if (!Number.isSafeInteger(lag) || Number(lag) < 9 || Number(lag) > 365) throw new Error("recommended_lag_days_invalid");
  if (typeof body.include_retention !== "boolean") throw new Error("recommended_retention_invalid");
  const keys = body.custom_conversion_event_keys ?? [];
  if (!Array.isArray(keys) || keys.length > 20 || new Set(keys).size !== keys.length
      || keys.some(key => typeof key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(key))) {
    throw new Error("custom_conversion_event_keys_invalid");
  }
  if (keys.some(key => !observedKeys.includes(key))) throw new Error("custom_conversion_event_key_unknown");
  const definitions = [
    ...ACQUISITION_KPI_METRIC_DEFINITIONS,
    ...(body.include_retention ? SELECTED_ACQUISITION_METRIC_DEFINITIONS.filter(definition =>
      ["retention_d1", "retention_d7"].includes(definition.metric_name)) : []),
    ...[...keys].sort().flatMap(key => keyedCustomConversionMetricDefinitions(key)),
  ];
  return { lag_days: lag, ...(body.start_date !== undefined ? { start_date: body.start_date } : {}),
    // USD-only identity, not an FX feed; foreign money needs explicit advanced FX configuration.
    fx_policy: { policy_version: "recommended-usd-identity-v1", target_currency: "USD", target_scale: 6,
      rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
        source: "same-currency-identity-no-fx-feed", as_of: "1970-01-01T00:00:00.000Z" }] },
    metric_definitions: structuredClone(definitions), evaluations: [{
      metric_names: definitions.map(definition => definition.metric_name), date_dimension: "cohort_date",
      grouping: {}, campaign_discovery: { policy: "selected_acquisition_and_cost_v1", max_targets: 20 },
    }] };
}

/** Bind the confirmed definition, lag and resolved start date without storing preview state. */
export function recommendedSchedulePreviewDigest(normalized: {
  definitionDigest: string; lagDays: number; startDate: string;
}): string {
  return sha256Jcs({ definition_digest: normalized.definitionDigest, lag_days: normalized.lagDays,
    start_date: normalized.startDate });
}
