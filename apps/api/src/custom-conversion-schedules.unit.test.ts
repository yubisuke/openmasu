import assert from "node:assert/strict";
import { it } from "node:test";
import { customConversionMetricDefinitions, keyedCustomConversionMetricDefinitions } from "@openmasu/contracts/definitions";
import { validateMetricDefinition } from "@openmasu/contracts/validation";
import { conversionCalculationKey, expandConversionScheduleRequest } from "./custom-conversion-schedules.js";
import { normalizeMetricScheduleRequest } from "./metric-schedules.js";
import { normalizeEventCatalogRevision, parseEventCatalogQuery } from "./event-catalog.js";
import { eventCatalogFormRequest, renderEventCatalog } from "./dashboard/event-catalog.js";

it("event_catalog_preserves_exact_keys_and_keeps_unobserved_plans_separate_from_measurements", () => {
  const revision = { event_key: "planned_outcome", expected_revision: 0, display_name: "Synthetic <outcome>",
    meaning: "Finish the synthetic step", firing_condition: "After explicit synthetic confirmation", lifecycle: "planned" as const };
  assert.deepEqual(normalizeEventCatalogRevision(revision), revision);
  for (const patch of [{ event_key: "Planned_outcome" }, { event_key: "openmasu.conversion_value_updated" },
    { expected_revision: -1 }, { expected_revision: "0" }, { lifecycle: "observed" }, { lifecycle: ["planned"] }, { meaning: " " },
    { display_name: "x".repeat(121) }, { firing_condition: "line\nfeed" }, { alias: "different_key" }]) {
    assert.throws(() => normalizeEventCatalogRevision({ ...revision, ...patch }), /event_catalog_revision_invalid/);
  }
  const query = parseEventCatalogQuery(new URLSearchParams("prefix=planned_&after=planned_099&limit=100"));
  assert.deepEqual(query, { prefix: "planned_", after: "planned_099", limit: 100 });
  for (const params of ["prefix=Upper", "prefix=a%25", "limit=101", "limit=0", "after=bad%3B", "alias=x", "limit=1&limit=2"]) {
    assert.throws(() => parseEventCatalogQuery(new URLSearchParams(params)), /event_catalog_query_invalid/);
  }
  const form = new URLSearchParams(Object.fromEntries(Object.entries(revision).map(([key,value]) => [key,String(value)])));
  assert.deepEqual(eventCatalogFormRequest(form), revision);
  form.append("expected_revision", "0"); assert.throws(() => eventCatalogFormRequest(form), /revision_invalid/);
  const html = renderEventCatalog("app-synthetic", { data: [{ ...revision, revision: 1, observation_state: "not_observed",
    observed_count: null, last_received_at: null }], next_cursor: "planned_outcome" }, query, "csrf<&");
  assert.match(html, /Not observed — count and last receipt unknown/);
  assert.match(html, /Synthetic &lt;outcome&gt;/); assert.match(html, /after=planned_outcome/);
  assert.match(html, /unavailable on persistent databases/);
  assert.match(html, /name="custom_conversion_event_keys" value="planned_outcome"/);
  assert.doesNotMatch(html, /<script\b|javascript:|\son[a-z]+=/i);
});

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
