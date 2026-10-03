import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { M1B_METRIC_DEFINITIONS, M3_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS, DISJOINT_COST_METRIC_DEFINITIONS, SELECTED_COMMERCE_METRIC_DEFINITIONS, REFUND_REVERSAL_METRIC_DEFINITIONS, customConversionMetricDefinitions } from "@openmasu/contracts";
import { sha256 } from "@openmasu/attribution-core";
import { captureMetricComparisonContext, comparisonMeaning, comparisonMaturity } from "./metric-comparison.js";
import { engagementMetricDefinitions } from "@openmasu/contracts";
import { importedAcquisitionMetricDefinitions } from "@openmasu/contracts/definitions";
import { calendarAcquisitionMetricDefinitions } from "@openmasu/contracts/definitions";

const fx = { policy_version: "synthetic", target_currency: "USD", target_scale: 6, rounding_mode: "half_even" as const,
  rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, as_of: "2026-01-01T00:00:00.000Z", source: "not-in-reader-projection" }] };
const run = { metric_run_id: "synthetic", input_snapshot_id: "a".repeat(64) };
it("dated_FX_comparison_freezes_currency_date_source_as_of_and_digest_without_legacy_reinterpretation", () => {
  const fixture = JSON.parse(readFileSync("fixtures/v0.4/69-dated-fx-cohorts/input.json", "utf8"));
  const definition = DISJOINT_COST_METRIC_DEFINITIONS.find(d => d.metric_name === "d7_roas")!;
  const context = captureMetricComparisonContext(run, definition, fixture.fx_policy, "before", sha256);
  assert.equal(context.fx_digest, sha256(fixture.fx_policy));
  assert.deepEqual(context.fx, fixture.fx_policy);
  const shuffled = structuredClone(fixture.fx_policy); shuffled.rates.reverse();
  assert.deepEqual(captureMetricComparisonContext(run, definition, shuffled, "before", sha256), context);
  const later = structuredClone(fixture.fx_policy); later.rates[0].source = "synthetic-revised-source";
  const changed = captureMetricComparisonContext(run, definition, later, "before", sha256);
  assert.notEqual(changed.fx_digest, context.fx_digest);
  assert.notDeepEqual(comparisonMeaning(changed), comparisonMeaning(context));
  assert.notDeepEqual(comparisonMeaning(captureMetricComparisonContext(run, definition, fx, "before", sha256)), comparisonMeaning(context));
  fixture.fx_policy.rates[0].rate_unscaled = "999";
  assert.notDeepEqual(context.fx, fixture.fx_policy);
});
it("calendar_comparison_freezes_local_day_meaning_and_DST_maturity_separately_from_elapsed", () => {
  const definition = calendarAcquisitionMetricDefinitions("America/New_York").find(d=>d.metric_name === "calendar_ny_cohort_ltv_d1_usd")!;
  const context = captureMetricComparisonContext(run,definition,fx,"after",sha256);
  const elapsed = captureMetricComparisonContext(run,SELECTED_ACQUISITION_METRIC_DEFINITIONS.find(d=>d.metric_name === "cohort_ltv_d1_usd")!,fx,"after",sha256);
  assert.notDeepEqual(comparisonMeaning(context),comparisonMeaning(elapsed));
  const meaning = comparisonMeaning(context);
  assert.ok(meaning && "calendar_cohort_policy" in meaning);
  assert.equal(meaning.calendar_cohort_policy,"cumulative_revenue_on_day_activity");
  assert.deepEqual(comparisonMaturity(context,{cohort_date:"2026-03-07"},"2026-03-09T03:59:59.999Z"),
    {state:"unknown",closes_at:"2026-03-09T04:00:00.000Z"});
  assert.equal(comparisonMaturity(context,{cohort_date:"2026-03-07"},"2026-03-09T04:00:00.000Z").state,"window_elapsed");
  assert.equal(comparisonMaturity(context,{cohort_date:"2026-10-31"},"2026-11-02T05:00:00.000Z").closes_at,"2026-11-02T05:00:00.000Z");
});
it("keeps import provider revision outcome binding and native meaning incomparable", () => {
  const first = captureMetricComparisonContext(run,importedAcquisitionMetricDefinitions("synthetic-export")[0],fx,"after",sha256);
  const second = captureMetricComparisonContext(run,importedAcquisitionMetricDefinitions("synthetic-second")[0],fx,"after",sha256);
  const native = captureMetricComparisonContext(run,DISJOINT_COST_METRIC_DEFINITIONS[0],fx,"after",sha256);
  assert.equal(first.definition.import_provider,"synthetic-export");
  assert.equal(first.definition_digest,sha256(first.definition));
  const meaning = comparisonMeaning(first)!;
  assert.ok("outcome_binding" in meaning && "attribution_revision" in meaning);
  assert.equal(meaning.outcome_binding,"same_import_producer_explicit_installation");
  assert.equal(meaning.attribution_revision,"selected_provider_reported_at_watermark");
  assert.notDeepEqual(comparisonMeaning(first),comparisonMeaning(second));
  assert.notDeepEqual(comparisonMeaning(first),comparisonMeaning(native));
  assert.notEqual(first.definition_digest,second.definition_digest);
});
it("binds re-engagement comparison to open date credit and a conservative 24h maturity", () => {
  const context = captureMetricComparisonContext(run, engagementMetricDefinitions("tutorial_complete")[0], fx, "after", sha256);
  assert.equal(context.definition.engagement_credit_policy, "latest_eligible_open_before_outcome");
  assert.equal(context.definition_digest, sha256(context.definition));
  assert.equal(comparisonMeaning(context)?.population, "server_resolved_non_organic_engagement");
  assert.equal(comparisonMeaning(context)?.fx, null);
  assert.deepEqual(comparisonMaturity(context, { metric_date: "2026-08-21" }, "2026-08-22T23:59:59.999Z"),
    { state: "unknown", closes_at: "2026-08-23T00:00:00.000Z" });
  assert.equal(comparisonMaturity(context, { metric_date: "2026-08-21" }, "2026-08-23T00:00:00.000Z").state, "window_elapsed");
  assert.equal(comparisonMaturity(context, { cohort_date: "2026-08-21" }, "2026-08-23T00:00:00.000Z").state, "unknown");
});
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
