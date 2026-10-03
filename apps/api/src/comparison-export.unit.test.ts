import assert from "node:assert/strict";
import { it } from "node:test";
import { captureMetricComparisonContext } from "@openmasu/runtime";
import { sha256 } from "@openmasu/attribution-core";
import { comparisonExport, ComparisonExportError } from "./comparison-export.js";
import { compareSnapshots, parseSnapshot } from "./cohort-comparison.js";
import { renderComparison } from "./dashboard/comparison-report.js";
import { renderComparisonExport } from "./dashboard/comparison-export.js";
import { buildDashboardView } from "./dashboard/view.js";
import type { MetricQuery } from "./report-query.js";
import type { MetricReportRow } from "./reporting.js";
import { metricFreshness } from "./metric-freshness.js";

const query: MetricQuery = { tenantId: "tenant-synthetic", appId: "app-synthetic", metricNames: ["revenue_d1"],
  dateFrom: "2026-01-01", dateTo: "2026-01-02", watermarkAtMost: "2026-01-10T00:00:00Z",
  grouping: { attribution_status: "organic" }, supersession: "latest", limit: 200 };
function row(): MetricReportRow {
  const definition = { metric_name: "revenue_d1", metric_definition_version: "v1", anchor_event: "install" as const,
    aggregation_time_zone: "UTC" as const, value_type: "money" as const, currency: "USD", amount_scale: 2,
    definition: { calculation: "revenue_sum" as const, numerator: "revenue" as const, window: { type: "elapsed" as const, day: 1 } },
    grouping_dimensions: ["cohort_date", "attribution_status"] as ("cohort_date" | "attribution_status")[],
    rule_bundle_id: "synthetic", rule_bundle_version: "v1", rule_bundle_hash: "b".repeat(64) };
  const result: MetricReportRow = { metric_run_id: "synthetic-run", metric_name: "revenue_d1", metric_definition_version: "v1",
    input_snapshot_id: "a".repeat(64), input_received_at_watermark: "2026-01-10T00:00:00.000Z",
    aggregation_time_zone: "UTC", grouping: { cohort_date: "2026-01-01", attribution_status: "organic" },
    value_type: "money", currency: "USD", amount_scale: 2, ratio_scale: null, value_state: "present",
    value_unscaled: "900719925474099301", undefined_reason: null, superseded: false, reproducibility_status: "fully_reproducible",
    policy_versions: ["rule_bundle:v1", "fx:synthetic"], data_freshness: "complete", rule_bundle_id: "synthetic",
    rule_bundle_hash: "b".repeat(64), computed_at: "2026-01-10T01:00:00.000Z", supersedes_metric_run_id: null,
    input_ledger_position: "1", grouping_digest: "c".repeat(64) };
  return { ...result, comparison_context: captureMetricComparisonContext(result as any, definition,
    { policy_version: "synthetic", target_currency: "USD", target_scale: 2, rounding_mode: "half_even",
      rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, as_of: "2026-01-01T00:00:00Z" }] }, "after", sha256) };
}
it("exports a complete selection through the shared exact comparison and HTML pipeline", () => {
  const page = { data: [row()] }, body = comparisonExport(page, query);
  assert.equal(body, comparisonExport(page, query));
  const snapshot = parseSnapshot(JSON.parse(body)), result = compareSnapshots(snapshot, snapshot);
  assert.equal(snapshot.conditions.source_cutoff, "2026-01-10T00:00:00.000000Z");
  assert.equal(snapshot.conditions.maturity, "window_elapsed");
  assert.equal(result.status, "compared"); assert.equal(result.rows[0].status, "equal");
  assert.match(renderComparison(result), /9007199254740993\.01/);
});
it("retains aggregate freshness observations without promoting completeness or changing old snapshot shape", () => {
  const legacy = parseSnapshot(JSON.parse(comparisonExport({ data: [row()] }, query)));
  assert.equal("freshness_observations" in legacy, false);
  assert.deepEqual(parseSnapshot(legacy), legacy);
  const observations = metricFreshness({ ...row(), late_input_update_state: "recalculation_pending" }, {
    receipts: "1", completed: "1", running: "0", failed: "0", with_row_rejections: "0",
    empty_receipts: "1", nonempty_receipts: "0", latest_receipt_at: "2026-01-11T00:00:00.000Z",
  }, 0);
  const observed = { ...row(), ...observations };
  const snapshot = parseSnapshot(JSON.parse(comparisonExport({ data: [observed] }, query)));
  assert.deepEqual(snapshot.freshness_observations?.[0].observations, observations);
  const result = compareSnapshots(snapshot, legacy);
  assert.equal(result.status, "compared"); assert.equal(result.rows[0].status, "equal");
  const html = renderComparison(result);
  assert.match(html, /Known-empty local receipt recorded; not a zero cohort/);
  assert.match(html, /Recalculation pending; saved value remains unchanged/);
  assert.match(html, /upstream|Upstream/);
  assert.throws(() => parseSnapshot({ ...snapshot, freshness_observations: [{ ...snapshot.freshness_observations![0], key: "not-a-row" }] }));
  assert.throws(() => parseSnapshot({ ...snapshot, freshness_observations: Array(2).fill(snapshot.freshness_observations![0]) }));
});
it("refuses incomplete, historical, missing-condition and mismatched selections without partial output", () => {
  const page = { data: [row()] };
  for (const [data, selection] of [
    [{ ...page, next_cursor: "synthetic-next" }, query],
    [page, { ...query, metricNames: undefined }], [page, { ...query, dateFrom: undefined }],
    [page, { ...query, watermarkAtMost: undefined }], [page, { ...query, supersession: "all" as const }],
    [page, { ...query, after: { metricName: "revenue_d1", metricRunId: "run", groupingDigest: "a".repeat(64) } }],
    [{ data: [] }, query], [{ data: [{ ...row(), superseded: true }] }, query],
    [{ data: [{ ...row(), reproducibility_status: "redaction_affected" }] }, query],
    [page, { ...query, watermarkAtMost: "2026-01-10T00:00:00.000001Z" }],
    [{ data: Array(10001).fill(row()) }, query],
  ] as const) assert.throws(() => comparisonExport(data, selection), ComparisonExportError);
});
it("requires a legacy aggregation declaration without promoting it to comparable meaning", () => {
  const legacy = { data: [{ ...row(), comparison_context: null }] };
  assert.throws(() => comparisonExport(legacy, query), /comparison_aggregation_declaration_required/);
  const snapshot = parseSnapshot(JSON.parse(comparisonExport(legacy, query, "cumulative")));
  assert.equal(snapshot.conditions.maturity, "unknown");
  assert.equal(compareSnapshots(snapshot, snapshot).status, "incomparable");
});
it("preserves selection and watermark in a zero-JavaScript GET form", () => {
  const html = renderComparisonExport(buildDashboardView({ selectedAppId: query.appId, apps: [], query, csrfToken: "synthetic" }));
  assert.match(html, /method="get" action="\/dashboard\/apps\/app-synthetic\/comparison\.json"/);
  for (const key of ["metric_name", "date_from", "date_to", "watermark_at_most", "grouping_attribution_status", "limit"]) {
    assert.match(html, new RegExp(`name="${key}"`));
  }
  assert.match(html, /2026-01-10T00:00:00Z/);
  assert.doesNotMatch(html, /<script|javascript:|\son\w+=/i);
});
