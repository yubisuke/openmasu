import assert from "node:assert/strict";
import { it } from "node:test";
import { M1B_METRIC_DEFINITIONS, M3_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS } from "@openmasu/contracts";
import { sha256 } from "@openmasu/attribution-core";
import { captureMetricComparisonContext, comparisonMeaning, comparisonMaturity } from "./metric-comparison.js";

const fx = { policy_version: "synthetic", target_currency: "USD", target_scale: 6, rounding_mode: "half_even" as const,
  rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, as_of: "2026-01-01T00:00:00.000Z", source: "not-in-reader-projection" }] };
const run = { metric_run_id: "synthetic", input_snapshot_id: "a".repeat(64) };
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
