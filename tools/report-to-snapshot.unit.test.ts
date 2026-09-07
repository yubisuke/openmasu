import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { encodeMetricReport, type MetricReportRow } from "../apps/api/src/reporting.js";
import { reportToSnapshot } from "./report-to-snapshot.js";
import { compareSnapshots, parseSnapshot } from "./compare-cohorts.js";

const template = () => ({ source: "synthetic-report", conditions: { date_from: "2026-01-01", date_to: "2026-01-02", time_zone: "UTC", maturity: "fully_elapsed_d7", aggregation: "cumulative", attribution_scope: "organic", metric_definition: "revenue_d7@v1", source_cutoff: "2026-01-10T00:00:00.000Z" }, rows: [] });
const row = (): Record<string, any> => ({ metric_run_id: "synthetic-run", metric_name: "revenue_d7", metric_definition_version: "v1", input_snapshot_id: "a".repeat(64), input_received_at_watermark: "2026-01-10T00:00:00.000Z", aggregation_time_zone: "UTC", grouping: { cohort_date: "2026-01-01", attribution_status: "organic" }, value_type: "money", currency: "USD", amount_scale: 2, ratio_scale: null, value_state: "present", value_unscaled: "900719925474099301", undefined_reason: null, superseded: false, reproducibility_status: "fully_reproducible" });
it("converts exact saved values and binds run provenance for comparison", () => {
  const output = reportToSnapshot({ data: [row()] }, template());
  assert.equal(output.rows[0].state === "present" && output.rows[0].value, "900719925474099301");
  assert.equal(output.provenance?.runs[0].metric_run_id, "synthetic-run");
  assert.equal(compareSnapshots(output, output).rows[0].status, "equal");
});
it("rejects unfinished pages duplicate runs and duplicate groupings", () => {
  assert.throws(() => reportToSnapshot({ data: [row()], next_cursor: "next" }, template()));
  assert.throws(() => reportToSnapshot({ data: [row(), row()] }, template()));
  assert.throws(() => reportToSnapshot({ data: [row(), { ...row(), metric_run_id: "another" }] }, template()));
});
it("rejects mixed definitions time bounds units and historical rows", () => {
  for (const patch of [{ metric_definition_version: "other" }, { input_received_at_watermark: "2026-01-11T00:00:00.000Z" }, { aggregation_time_zone: "Asia/Tokyo" }, { superseded: true }, { reproducibility_status: "redaction_affected" }, { amount_scale: null }, { currency: "invalid" }, { grouping: { cohort_date: "2026-01-02", attribution_status: "organic" } }, { grouping: { cohort_date: "2026-01-01", attribution_status: "unattributed" } }]) {
    assert.throws(() => reportToSnapshot({ data: [{ ...row(), ...patch }] }, template()));
  }
});
it("preserves undefined values without inventing zero", () => {
  const r = row(); delete r.value_unscaled; r.value_state = "undefined"; r.undefined_reason = "empty_cohort";
  const output = reportToSnapshot({ data: [r] }, template());
  assert.equal(output.rows[0].state, "undefined"); assert.ok(!("value" in output.rows[0]));
});
it("normalizes row order while retaining source provenance", () => {
  const a = row(), b = { ...row(), metric_run_id: "second", grouping: { ...row().grouping, country: "JP" } };
  assert.deepEqual(reportToSnapshot({ data: [a, b] }, template()), reportToSnapshot({ data: [b, a] }, template()));
  const output = reportToSnapshot({ data: [a] }, template());
  output.provenance!.runs[0].key = "wrong"; assert.throws(() => parseSnapshot(output));
});
it("supports ratio and count units with no invented currency", () => {
  for (const type of ["ratio", "count"]) {
    const r = { ...row(), value_type: type, amount_scale: null, currency: null, ratio_scale: type === "ratio" ? 6 : null };
    const output = reportToSnapshot({ data: [r] }, template());
    assert.equal(output.rows[0].currency, "none"); assert.equal(output.rows[0].scale, type === "ratio" ? 6 : 0);
  }
});
it("converts the API encoder output through the CLI without a database", () => {
  const dir = mkdtempSync(join(tmpdir(), "openmasu-synthetic-report-"));
  try {
    const r: MetricReportRow = {
      metric_run_id: "synthetic-run", metric_name: "revenue_d7", metric_definition_version: "v1",
      input_snapshot_id: "a".repeat(64), input_received_at_watermark: "2026-01-10T00:00:00.000Z",
      aggregation_time_zone: "UTC", grouping: { cohort_date: "2026-01-01", attribution_status: "organic" },
      value_type: "money", currency: "USD", amount_scale: 2, ratio_scale: null,
      value_state: "present", value_unscaled: "100", undefined_reason: null,
      superseded: false, reproducibility_status: "fully_reproducible",
      policy_versions: ["rule_bundle:synthetic"], data_freshness: "complete",
      rule_bundle_id: "synthetic", rule_bundle_hash: "b".repeat(64), computed_at: "2026-01-10T01:00:00.000Z",
      supersedes_metric_run_id: null, input_ledger_position: "1", grouping_digest: "c".repeat(64),
    };
    const report = join(dir, "report.json"), config = join(dir, "template.json");
    writeFileSync(report, encodeMetricReport({ data: [r] }, "json").body);
    writeFileSync(config, JSON.stringify(template()));
    const run = spawnSync(process.execPath, ["--import", "tsx", "tools/report-to-snapshot.ts", report, config], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); assert.equal(parseSnapshot(JSON.parse(run.stdout)).rows.length, 1);
    writeFileSync(report, encodeMetricReport({ data: [r], next_cursor: "synthetic-next" }, "json").body);
    const bad = spawnSync(process.execPath, ["--import", "tsx", "tools/report-to-snapshot.ts", report, config], { encoding: "utf8" });
    assert.equal(bad.status, 1); assert.equal(bad.stdout, ""); assert.doesNotMatch(bad.stderr, /synthetic-run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
