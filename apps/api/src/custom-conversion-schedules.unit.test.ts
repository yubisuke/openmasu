import assert from "node:assert/strict";
import { it } from "node:test";
import { customConversionMetricDefinitions, keyedCustomConversionMetricDefinitions } from "@openmasu/contracts/definitions";
import { validateMetricDefinition } from "@openmasu/contracts/validation";
import { conversionCalculationKey, expandConversionScheduleRequest } from "./custom-conversion-schedules.js";
import { normalizeMetricScheduleRequest } from "./metric-schedules.js";

it("keyed_conversion_schedules_reuse_the_legacy_meaning_and_reject_aliases_unknown_keys_and_ambiguous_fields", () => {
  const old = customConversionMetricDefinitions("tutorial_complete");
  const keyed = keyedCustomConversionMetricDefinitions("tutorial_complete");
  for (const [index, definition] of keyed.entries()) {
    assert.ok(validateMetricDefinition(definition));
    assert.deepEqual({ ...definition, metric_name: old[index].metric_name }, old[index]);
    assert.equal(conversionCalculationKey(definition), conversionCalculationKey(old[index]));
    const reordered = { ...definition, definition: { window: { day: 7, type: "elapsed" },
      numerator: definition.definition.numerator, calculation: definition.definition.calculation,
      ...(definition.definition.denominator ? { denominator: definition.definition.denominator } : {}) } };
    assert.equal(conversionCalculationKey(reordered), conversionCalculationKey(definition));
  }
  const keys = ["signup_complete", "tutorial_complete"], now = new Date("2026-08-15T00:00:00.000Z");
  const request = expandConversionScheduleRequest({ custom_conversion_event_keys: [...keys].reverse() }, keys);
  assert.deepEqual(request, expandConversionScheduleRequest({ custom_conversion_event_keys: keys }, keys));
  const normalized = normalizeMetricScheduleRequest(request, now);
  assert.equal(normalized.lagDays, 9); assert.equal(normalized.definition.metric_definitions.length, 4);
  for (const body of [{ custom_conversion_event_keys: ["unknown_outcome"] },
    { custom_conversion_event_keys: ["tutorial_complete", "tutorial_complete"] },
    { custom_conversion_event_keys: ["tutorial_complete"], tenant_id: "elsewhere" },
    { custom_conversion_event_keys: ["tutorial_complete"], lag_days: 8 },
    { custom_conversion_event_keys: ["tutorial_complete"], metric_definitions: [] }]) {
    assert.throws(() => expandConversionScheduleRequest(body, keys), /custom_conversion/);
  }
  const aliases = [...keyed, ...old];
  assert.throws(() => normalizeMetricScheduleRequest({ ...request, metric_definitions: aliases,
    evaluations: [{ metric_names: aliases.map(definition => definition.metric_name), date_dimension: "cohort_date", grouping: {} }] }, now), /conversion_overlap/);
});
