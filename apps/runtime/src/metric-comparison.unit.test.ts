import assert from "node:assert/strict";
import { it } from "node:test";
import { M1B_METRIC_DEFINITIONS, M3_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS, DISJOINT_COST_METRIC_DEFINITIONS, SELECTED_COMMERCE_METRIC_DEFINITIONS, REFUND_REVERSAL_METRIC_DEFINITIONS, customConversionMetricDefinitions } from "@openmasu/contracts";
import { sha256 } from "@openmasu/attribution-core";
import { captureMetricComparisonContext, comparisonMeaning, comparisonMaturity } from "./metric-comparison.js";

const fx = { policy_version: "synthetic", target_currency: "USD", target_scale: 6, rounding_mode: "half_even" as const,
  rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, as_of: "2026-01-01T00:00:00.000Z", source: "not-in-reader-projection" }] };
const run = { metric_run_id: "synthetic", input_snapshot_id: "a".repeat(64) };
it("records explicit refund cancellation meaning without equating historical commerce definitions", () => {
  const capture = (d: typeof REFUND_REVERSAL_METRIC_DEFINITIONS[number]) => captureMetricComparisonContext(run, d, fx, "after", sha256);
  const current = capture(REFUND_REVERSAL_METRIC_DEFINITIONS[0]);
  const legacy = capture(SELECTED_COMMERCE_METRIC_DEFINITIONS[0]);
  assert.equal(current.definition.refund_reversal_policy, "cancel_target_refund_at_watermark");
  assert.notEqual(current.definition_digest, legacy.definition_digest);
  assert.notDeepEqual(comparisonMeaning(current), comparisonMeaning(legacy));
  assert.equal(Object.hasOwn(legacy.definition, "refund_reversal_policy"), false);
});
it("keeps different custom outcomes incomparable and derives cumulative D7 maturity without FX meaning", () => {
  const first = captureMetricComparisonContext(run, customConversionMetricDefinitions("tutorial_complete")[1], fx, "after", sha256);
  const second = captureMetricComparisonContext(run, customConversionMetricDefinitions("different_outcome")[1], fx, "after", sha256);
  assert.equal(first.definition.conversion_event_key, "tutorial_complete");
  assert.notEqual(first.definition_digest, second.definition_digest);
  assert.equal(comparisonMeaning(first)?.conversion_event_key, "tutorial_complete");
  assert.notDeepEqual(comparisonMeaning(first), comparisonMeaning(second));
  assert.equal(comparisonMeaning(first)?.aggregation, "cumulative");
  assert.equal(comparisonMeaning(first)?.fx, null);
  assert.deepEqual(comparisonMaturity(first, { cohort_date: "2026-08-06" }, "2026-08-14T23:59:59.999Z"),
    { state: "unknown", closes_at: "2026-08-15T00:00:00.000Z" });
  assert.equal(comparisonMaturity(first, { cohort_date: "2026-08-06" }, "2026-08-15T00:00:00.000Z").state, "window_elapsed");
});
it("preserves safe-cost selection in comparison context and refuses equivalence with legacy denominators", () => {
  const legacy = captureMetricComparisonContext(run, SELECTED_ACQUISITION_METRIC_DEFINITIONS[0], fx, "after", sha256);
  const safe = captureMetricComparisonContext(run, DISJOINT_COST_METRIC_DEFINITIONS[0], fx, "after", sha256);
  assert.equal(safe.definition.cost_selection_policy, "reject_overlapping_grains");
  assert.equal(safe.definition_digest, sha256(safe.definition));
  assert.equal(comparisonMeaning(safe)?.cost_selection_policy, "reject_overlapping_grains");
  assert.notDeepEqual(comparisonMeaning(legacy), comparisonMeaning(safe));
});
it("binds selected acquisition to saved comparison meaning instead of equating legacy grouping", () => {
  const legacy = captureMetricComparisonContext(run, M1B_METRIC_DEFINITIONS[0], fx, "after", sha256);
  const selected = captureMetricComparisonContext(run, SELECTED_ACQUISITION_METRIC_DEFINITIONS[0], fx, "after", sha256);
  assert.equal(selected.definition.acquisition_basis, "selected_first_party_click");
  assert.equal(selected.definition_digest, sha256(selected.definition));
  assert.equal(comparisonMeaning(legacy)?.acquisition_basis, "recorded_dimensions");
  assert.equal(comparisonMeaning(selected)?.acquisition_basis, "selected_first_party_click");
  assert.notDeepEqual(comparisonMeaning(legacy), comparisonMeaning(selected));
});
it("captures only closed definition and FX fields, independent of later configuration mutation", () => {
  const definition = { ...structuredClone(M1B_METRIC_DEFINITIONS.find(d => d.metric_name === "d7_roas")!), installation_id: "must-not-copy" };
  const context = captureMetricComparisonContext(run, definition, fx, "after", sha256);
  const before = JSON.stringify(context);
  assert.doesNotMatch(before, /installation_id|must-not-copy|not-in-reader-projection/);
  definition.definition.window.day = 1;
  assert.equal(JSON.stringify(context), before);
  assert.equal(context.definition_digest, sha256(context.definition));
});
it("derives conservative cohort maturity from the declared window and time zone, never freshness", () => {
  const context = captureMetricComparisonContext(run, M1B_METRIC_DEFINITIONS.find(d => d.metric_name === "d7_roas")!, fx, "after", sha256);
  const grouping = { cohort_date: "2026-01-01" };
  assert.deepEqual(comparisonMaturity(context, grouping, "2026-01-09T23:59:59.999Z"), { state: "unknown", closes_at: "2026-01-10T00:00:00.000Z" });
  assert.equal(comparisonMaturity(context, grouping, "2026-01-10T00:00:00.000Z").state, "window_elapsed");
  context.definition.aggregation_time_zone = "Asia/Tokyo";
  assert.equal(comparisonMaturity(context, grouping, "2026-01-09T15:00:00.000Z").state, "window_elapsed");
  assert.equal(comparisonMaturity(context, {}, "2026-01-10T00:00:00.000Z").state, "unknown");
});
it("derives on-day event-count meaning and refuses unsupported calendar-revenue equivalence", () => {
  const definition = M3_METRIC_DEFINITIONS.find(d => d.metric_name === "daily_click_count")!;
  const context = captureMetricComparisonContext(run, definition as any, fx, "after", sha256);
  assert.equal(comparisonMeaning(context)?.aggregation, "on_day");
  assert.equal(comparisonMeaning(context)?.fx, null);
  assert.equal(comparisonMaturity(context, { metric_date: "2026-01-01" }, "2026-01-02T00:00:00.000Z").state, "window_elapsed");
  const unsupported = captureMetricComparisonContext(run, { ...M1B_METRIC_DEFINITIONS[0],
    definition: { ...M1B_METRIC_DEFINITIONS[0].definition, window: { type: "calendar_day", day: 0 } } }, fx, "after", sha256);
  assert.equal(comparisonMeaning(unsupported), undefined);
});
