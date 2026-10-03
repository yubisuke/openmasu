import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { sha256 } from "@openmasu/attribution-core";
import { captureMetricComparisonContext } from "@openmasu/runtime";
import { metricFreshness, parseMetricFreshness, freshnessFields, type ImportReceiptObservation } from "./metric-freshness.js";
import { metricFreshnessLabels } from "./dashboard/metric-freshness.js";
import { renderDashboard } from "./dashboard/render.js";
import { buildDashboardView } from "./dashboard/view.js";
import { encodeMetricReport, type MetricReportRow } from "./reporting.js";
import { parseCsv } from "@openmasu/runtime/import-normalization";

function savedZero(watermark = "2026-08-09T00:00:00.000Z"): MetricReportRow {
  const input = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
  const definition = input.metric_definitions.find((d: { metric_name: string }) => d.metric_name === "cohort_install_count");
  const run: MetricReportRow = {
    metric_run_id: "synthetic-freshness-zero", metric_name: definition.metric_name,
    metric_definition_version: definition.metric_definition_version,
    policy_versions: [`rule_bundle:${definition.rule_bundle_version}`],
    input_received_at_watermark: watermark, input_snapshot_id: "a".repeat(64), data_freshness: "complete",
    value_state: "present", value_unscaled: "0", undefined_reason: null, value_type: "count",
    currency: null, amount_scale: null, ratio_scale: null, grouping: { cohort_date: "2026-08-08" },
    rule_bundle_id: definition.rule_bundle_id, rule_bundle_hash: definition.rule_bundle_hash,
    aggregation_time_zone: "UTC", computed_at: watermark, reproducibility_status: "fully_reproducible",
    supersedes_metric_run_id: null, input_ledger_position: "empty", grouping_digest: "b".repeat(64), superseded: false,
    cost_update_state: "no_recorded_revision", late_input_update_state: "no_recorded_request", privacy_update_state: "not_affected",
  };
  return { ...run, comparison_context: captureMetricComparisonContext(run, definition, input.fx_policy, "after", sha256) };
}
const receipt = (overrides: Partial<ImportReceiptObservation> = {}): ImportReceiptObservation => ({
  receipts: "1", completed: "1", running: "0", failed: "0", with_row_rejections: "0",
  empty_receipts: "1", nonempty_receipts: "0", latest_receipt_at: "2026-08-10T00:00:00.000Z", ...overrides,
});

it("distinguishes identical zero values across missing, empty, partial, immature and pending observations in CSV and SSR", () => {
  const zero = savedZero();
  const cases = [
    { run: zero, receipt: receipt({ receipts: "0", completed: "0", empty_receipts: "0", latest_receipt_at: null }), source: "not_observed", completion: "not_observed", window: "window_elapsed", recalculation: "no_recorded_request" },
    { run: zero, receipt: receipt(), source: "known_empty", completion: "completed", window: "window_elapsed", recalculation: "no_recorded_request" },
    { run: zero, receipt: receipt({ nonempty_receipts: "1", empty_receipts: "0", with_row_rejections: "1" }), source: "observed", completion: "partial_failure", window: "window_elapsed", recalculation: "no_recorded_request" },
    { run: savedZero("2026-08-08T12:00:00.000Z"), receipt: receipt(), source: "known_empty", completion: "completed", window: "window_not_elapsed", recalculation: "no_recorded_request" },
    { run: { ...zero, late_input_update_state: "recalculation_pending" as const }, receipt: receipt(), source: "known_empty", completion: "completed", window: "window_elapsed", recalculation: "pending" },
  ];
  for (const expected of cases) {
    const freshness = metricFreshness(expected.run, expected.receipt, 0), row = { ...expected.run, ...freshness };
    assert.equal(row.value_unscaled, "0"); assert.equal(row.data_freshness, "complete");
    assert.equal(freshness.source_observation.state, expected.source);
    assert.equal(freshness.import_completion.state, expected.completion);
    assert.equal(freshness.time_window_maturity.state, expected.window);
    assert.equal(freshness.recalculation_state.state, expected.recalculation);
    assert.equal(freshness.source_observation.input_snapshot, "empty");
    assert.equal(freshness.source_observation.upstream_freshness, "unknown");
    const csv = parseCsv(encodeMetricReport({ data: [row] }, "csv").body)[0];
    const html = renderDashboard(buildDashboardView({ apps: [], metrics: { data: [row] }, csrfToken: "synthetic" }));
    for (const field of freshnessFields) {
      assert.deepEqual(JSON.parse(String(csv[field])), freshness[field]);
      assert.ok(html.includes(metricFreshnessLabels(freshness)[field]));
      assert.ok(html.includes(`data-freshness-field="${field}"`));
    }
    assert.match(html, /data-value-unscaled="0"/);
  }
});

it("keeps absent or unsupported evidence unknown and never treats complete labels as upstream arrival", () => {
  const zero = savedZero(), legacy = metricFreshness({ ...zero, comparison_context: null });
  assert.equal(legacy.time_window_maturity.state, "unknown");
  assert.equal(legacy.source_observation.state, "unknown");
  assert.equal(legacy.source_observation.input_snapshot, "unknown");
  assert.equal(legacy.import_completion.state, "unknown");
  const changed = structuredClone(zero.comparison_context!); changed.definition.definition.window.day = 30;
  assert.equal(metricFreshness({ ...zero, comparison_context: changed }).time_window_maturity.state, "unknown");
  assert.equal(metricFreshness(zero, receipt({ completed: "0", running: "1" })).import_completion.state, "in_progress");
  assert.equal(metricFreshness(zero, receipt({ completed: "0", failed: "1" })).import_completion.state, "failed");
  assert.equal(metricFreshness({}).recalculation_state.state, "unknown");
  assert.deepEqual(parseMetricFreshness(legacy), legacy);
});

it("accepts only closed aggregate freshness metadata without provider promises or protected values", () => {
  const valid = metricFreshness(savedZero(), receipt(), 0);
  for (const change of [
    { ...valid, payload: "not permitted" },
    { ...valid, source_observation: { ...valid.source_observation, upstream_freshness: "complete" } },
    { ...valid, source_observation: { ...valid.source_observation, source_id: "not permitted" } },
    { ...valid, import_completion: { ...valid.import_completion, completed: "-1" } },
    { ...valid, source_observation: { ...valid.source_observation, latest_receipt_at: "2026-02-30T00:00:00Z" } },
  ]) assert.throws(() => parseMetricFreshness(change), /invalid_metric_freshness/);
});
