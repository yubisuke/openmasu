import type { OpenMasuMetricDefinitionV04 as Definition } from "./generated/contract-types.js";
import { canonicalize } from "json-canonicalize";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

export const CALENDAR_ACTIVITY_BUNDLE = "metric-calendar-activity";
export const CALENDAR_ACTIVITY_VERSION = "0.4.25";
export const CALENDAR_ACTIVITY_METRIC_NAMES = [
  "daily_session_starts", "daily_custom_events", "daily_active_installations",
] as const;

/** Recorded UTC-day activity, independent of installation/acquisition cohorts. */
export const CALENDAR_ACTIVITY_METRIC_DEFINITIONS: readonly Definition[] =
  CALENDAR_ACTIVITY_METRIC_NAMES.map(metricName => ({
    metric_name: metricName, metric_definition_version: CALENDAR_ACTIVITY_VERSION,
    anchor_event: "calendar_day", aggregation_time_zone: "UTC", value_type: "count",
    definition: { calculation: metricName === "daily_active_installations" ? "active_installations_count" : "event_count",
      numerator: metricName === "daily_active_installations" ? "active_installations" : "events",
      window: { type: "calendar_day", day: 0 } },
    event_names: metricName === "daily_session_starts" ? ["session_start"]
      : metricName === "daily_custom_events" ? ["custom_event"] : ["session_start", "custom_event"],
    grouping_dimensions: ["metric_date"], fraud_policy: "gross",
    rule_bundle_id: CALENDAR_ACTIVITY_BUNDLE, rule_bundle_version: CALENDAR_ACTIVITY_VERSION,
    rule_bundle_hash: nonFraudBundleHash(CALENDAR_ACTIVITY_BUNDLE),
  }));

export function calendarActivityMetricDefinitions(): Definition[] {
  return structuredClone([...CALENDAR_ACTIVITY_METRIC_DEFINITIONS]);
}

/** Profile routing only; schema admission separately validates the complete binding and shape. */
export function isCalendarActivityMetric(definition: { rule_bundle_id?: unknown; metric_name?: unknown;
  definition?: { calculation?: unknown } }): boolean {
  return definition.rule_bundle_id === CALENDAR_ACTIVITY_BUNDLE
    || CALENDAR_ACTIVITY_METRIC_NAMES.some(name => name === definition.metric_name)
    || definition.definition?.calculation === "active_installations_count";
}

/** Pure closed-declaration recognition for captured comparison/presentation contexts. */
export function isCalendarActivityMetricDefinition(value: unknown): value is Definition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = CALENDAR_ACTIVITY_METRIC_DEFINITIONS.find(definition =>
    definition.metric_name === (value as Record<string, unknown>).metric_name);
  if (!expected) return false;
  try { return canonicalize(value) === canonicalize(expected); } catch { return false; }
}
