import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { encodeMetricReport, type MetricReportRow } from "../apps/api/src/reporting.js";
import { reportToSnapshot, aggregateCsvToSnapshot, AggregateCsvError } from "./report-to-snapshot.js";
import { compareSnapshots, parseSnapshot } from "./compare-cohorts.js";
import { captureMetricComparisonContext } from "@openmasu/runtime";
import { sha256 } from "@openmasu/attribution-core";
import { renderComparison } from "./cohort-comparison-html.js";
import { parseCsv } from "@openmasu/runtime/import-normalization";

const template = () => ({ source: "synthetic-report", conditions: { date_from: "2026-01-01", date_to: "2026-01-02", time_zone: "UTC", maturity: "fully_elapsed_d7", aggregation: "cumulative", attribution_scope: "organic", metric_definition: "revenue_d7@v1", source_cutoff: "2026-01-10T00:00:00.000Z" }, rows: [] });
const row = (): Record<string, any> => ({ metric_run_id: "synthetic-run", metric_name: "revenue_d7", metric_definition_version: "v1", input_snapshot_id: "a".repeat(64), input_received_at_watermark: "2026-01-10T00:00:00.000Z", aggregation_time_zone: "UTC", grouping: { cohort_date: "2026-01-01", attribution_status: "organic" }, value_type: "money", currency: "USD", amount_scale: 2, ratio_scale: null, value_state: "present", value_unscaled: "900719925474099301", undefined_reason: null, superseded: false, reproducibility_status: "fully_reproducible" });
const backedRow = () => {
  const r = row();
  const d = { metric_name: "revenue_d7", metric_definition_version: "v1", anchor_event: "install" as const,
    aggregation_time_zone: "UTC" as const, value_type: "money" as const, currency: "USD", amount_scale: 2,
    definition: { calculation: "revenue_sum" as const, numerator: "revenue" as const, window: { type: "elapsed" as const, day: 7 } },
    grouping_dimensions: ["cohort_date", "attribution_status"] as ("cohort_date" | "attribution_status")[],
    rule_bundle_id: "synthetic", rule_bundle_version: "v1", rule_bundle_hash: "b".repeat(64) };
  return { ...r, rule_bundle_id: d.rule_bundle_id, rule_bundle_hash: d.rule_bundle_hash, policy_versions: ["rule_bundle:v1", "fx:synthetic"],
    comparison_context: captureMetricComparisonContext(r as any, d, { policy_version: "synthetic", target_currency: "USD", target_scale: 2,
      rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, as_of: "2026-01-01T00:00:00.000Z" }] }, "after", sha256) };
};
it("dated_FX_report_snapshot_requires_the_same_saved_policy_and_exposes_changed_rate_meaning", () => {
  const fixture = JSON.parse(readFileSync("fixtures/v0.4/69-dated-fx-cohorts/input.json", "utf8"));
  const r = backedRow();
  const policy = { ...fixture.fx_policy, target_scale: 2 };
  r.comparison_context = captureMetricComparisonContext(r as any, r.comparison_context.definition, policy, "after", sha256);
  r.policy_versions = ["rule_bundle:v1", "fx:0.4.22"];
  const dated = { ...r, fx_conversion_snapshot: { policy, snapshot_id: sha256(policy) } };
  const saved = reportToSnapshot({ data: [dated] }, template());
  const csv = parseCsv(encodeMetricReport({ data: [dated as unknown as MetricReportRow] }, "csv").body)[0];
  // CSV embeds ordinary JSON; compare its decoded policy, not JCS key layout.
  assert.deepEqual(JSON.parse(csv.fx_conversion_snapshot), dated.fx_conversion_snapshot);
  assert.equal(compareSnapshots(saved, saved).status, "compared");
  assert.deepEqual(parseSnapshot(saved), saved);
  assert.throws(() => reportToSnapshot({ data: [r] }, template()), /fx_snapshot_binding_mismatch/);
  assert.throws(() => reportToSnapshot({ data: [{ ...dated, fx_conversion_snapshot: { policy, snapshot_id: "f".repeat(64) } }] }, template()), /fx_snapshot_binding_mismatch/);
  const changedPolicy = structuredClone(policy); changedPolicy.rates[0].rate_unscaled = "24";
  const changed = { ...dated, fx_conversion_snapshot: { policy: changedPolicy, snapshot_id: sha256(changedPolicy) },
    comparison_context: captureMetricComparisonContext(r as any, r.comparison_context.definition, changedPolicy, "after", sha256) };
  const comparison = compareSnapshots(saved, reportToSnapshot({ data: [changed] }, template()));
  assert.equal(comparison.status, "incomparable"); assert.ok(comparison.mismatches.includes("meaning.fx"));
  const reviewedRuns = JSON.parse(readFileSync("fixtures/v0.4/69-dated-fx-cohorts/expected_metric_runs.json", "utf8")) as Record<string, any>[];
  for (const run of reviewedRuns.filter(value => value.fx_conversion_snapshot)) {
    const definition = fixture.metric_definitions.find((value: Record<string, any>) => value.metric_name === run.metric_name);
    const reportRow = { ...run, grouping: run.grouping.dimensions, value_state: run.value_state ?? "present", superseded: false,
      undefined_reason: run.undefined_reason ?? null, currency: run.currency ?? null, amount_scale: run.amount_scale ?? null,
      ratio_scale: run.ratio_scale ?? null, policy_versions: [`rule_bundle:${run.rule_bundle_version}`, "fx:0.4.22"],
      comparison_context: captureMetricComparisonContext(run as any, definition, fixture.fx_policy, "before", sha256) };
    const datedTemplate = { source: "synthetic-fx69", conditions: { ...template().conditions,
      date_from: "2026-08-06", date_to: "2026-08-07", attribution_scope: "all", maturity: "unknown",
      metric_definition: `${run.metric_name}@${run.metric_definition_version}`, source_cutoff: run.input_received_at_watermark }, rows: [] };
    const current = reportToSnapshot({ data: [reportRow] }, datedTemplate);
    const result = compareSnapshots(current, current);
    if (run.metric_name === "d7_roas") {
      assert.equal(result.status, "incomparable", run.metric_run_id);
      assert.ok(result.assurance.left.missing.includes("window_maturity"));
    } else {
      assert.equal(result.status, "compared", run.metric_run_id);
      assert.equal(result.rows[0].status, run.undefined_reason ? "undefined" : "equal");
    }
  }
});
it("checks saved execution policy and displays definition-backed, declared and unknown bases distinctly", () => {
  const r = backedRow(), output = reportToSnapshot({ data: [r] }, template());
  assert.equal(output.conditions.maturity, "window_elapsed");
  const compared = compareSnapshots(output, output);
  assert.equal(compared.status, "compared"); assert.equal(compared.rows[0].status, "equal");
  const html = renderComparison(compared);
  assert.match(html, /definition_backed/); assert.match(html, /date_from \(declared\)/);
  const legacy = reportToSnapshot({ data: [row()] }, template());
  assert.match(renderComparison(compareSnapshots(legacy, legacy)), /Unknown: captured_definition/);
  assert.match(renderComparison(compareSnapshots(legacy, legacy)), /No numerical comparison/);
  for (const patch of [{ rule_bundle_hash: "c".repeat(64) }, { policy_versions: ["rule_bundle:v1", "fx:other"] },
    { policy_versions: ["rule_bundle:other"] }, { metric_run_id: "other" }]) {
    assert.throws(() => reportToSnapshot({ data: [{ ...r, ...patch }] }, template()), /execution_policy_mismatch/);
  }
});

const aggregateMapping = () => ({ version: 1, source: 'synthetic-aggregate <&"label>', conditions: template().conditions,
  grouping: { cohort_date: { column: "day" }, attribution_status: { constant: "organic" }, country: { column: "country" } },
  value: { column: "amount", input: "decimal", scale: 2, currency: { constant: "USD" },
    undefined: { marker: "", reason: { constant: "empty_cohort" } } } });
const csvBytes = (value: string) => Buffer.from(value, "utf8");
const safeCsvFailure = (csv: string, mapping: unknown, code: string, row: number | null) => {
  assert.throws(() => aggregateCsvToSnapshot(csvBytes(csv), mapping), error => error instanceof AggregateCsvError
    && error.code === code && error.row_number === row && error.message === code);
};
it("maps aggregate CSV into canonical comparison keys without guessing money, undefined or completeness", () => {
  const csv = 'day,country,amount,note\r\n2026-01-01,JP,1.23,"comma, quote "" and\nnewline"\r\n2026-01-01,GB,,unused\r\n2026-01-01,US,0,unused\r\n';
  const output = aggregateCsvToSnapshot(csvBytes(csv), aggregateMapping());
  const jp = output.rows.find(row => JSON.parse(row.key).country === "JP")!;
  assert.equal(jp.state === "present" && jp.value, "123");
  assert.equal(output.rows.find(row => JSON.parse(row.key).country === "GB")!.state, "undefined");
  assert.equal(output.rows.find(row => JSON.parse(row.key).country === "US")!.state, "present");
  assert.equal(output.mapping_provenance?.interpretation, "operator_declared");
  assert.equal(output.mapping_provenance?.row_count, 3);
  assert.equal(output.acquisition, undefined); assert.equal(output.comparison_contexts, undefined);
  assert.deepEqual(parseSnapshot(output), output);
  assert.equal(compareSnapshots(output, output).status, "incomparable");
  const comparison = compareSnapshots(output, output, { declaredOnly: true });
  assert.equal(comparison.status, "declared_comparison"); assert.equal(comparison.rows.filter(row => row.status === "equal").length, 2);
  const html = renderComparison(comparison);
  assert.match(html, /DECLARED ONLY/); assert.match(html, /1\.23 USD/); assert.match(html, /&lt;&amp;&quot;label&gt;/);
  assert.doesNotMatch(html, /<script|newline/);
  const missing = aggregateCsvToSnapshot(csvBytes("day,country,amount\n2026-01-01,JP,1.23\n"), aggregateMapping());
  assert.ok(compareSnapshots(output, missing, { declaredOnly: true }).rows.some(row => row.status === "missing_right"));
  const forged = structuredClone(output); forged.mapping_provenance!.row_count += 1;
  assert.throws(() => parseSnapshot(forged), /invalid_mapping_provenance/);
});
it("aligns explicit CSV scales, preserves huge and signed integers, and binds the mapping digest", () => {
  const left = aggregateCsvToSnapshot(csvBytes("day,country,amount\n2026-01-01,JP,1.23\n"), aggregateMapping());
  const mapping = { ...aggregateMapping(), value: { ...aggregateMapping().value, input: "integer", scale: 3 } };
  const right = aggregateCsvToSnapshot(csvBytes("day,country,amount\n2026-01-01,JP,1230\n"), mapping);
  assert.equal(compareSnapshots(left, right, { declaredOnly: true }).rows[0].status, "equal");
  assert.notEqual(left.mapping_provenance!.mapping_sha256, right.mapping_provenance!.mapping_sha256);
  for (const value of ["900719925474099301", "-900719925474099301"]) {
    const result = aggregateCsvToSnapshot(csvBytes(`day,country,amount\n2026-01-01,JP,${value}\n`), mapping);
    assert.equal(result.rows[0].state === "present" && result.rows[0].value, value);
  }
  const changed = aggregateCsvToSnapshot(csvBytes("day,country,amount\n2026-01-01,JP,1240\n"), mapping);
  assert.equal(compareSnapshots(left, changed, { declaredOnly: true }).rows[0].delta_right_minus_left, "10");
  const reordered = aggregateCsvToSnapshot(csvBytes("amount,day,country\n1.23,2026-01-01,JP\n"), aggregateMapping());
  assert.deepEqual(left.rows, reordered.rows);
  assert.equal(left.mapping_provenance!.mapping_sha256, reordered.mapping_provenance!.mapping_sha256);
  const withoutBlankMarker = structuredClone(mapping); delete (withoutBlankMarker.value as any).undefined;
  safeCsvFailure("day,country,amount\n2026-01-01,JP,\n", withoutBlankMarker, "number_invalid", 2);
  safeCsvFailure("day,country,amount\n2026-01-01,JP,1.234\n", aggregateMapping(), "precision_exceeded", 2);
  safeCsvFailure("day,country,amount\n2026-01-01,JP,1e3\n", aggregateMapping(), "number_invalid", 2);
});
it("rejects duplicate groupings, mismatched dates/status and malformed CSV with safe record numbers", () => {
  const mapping = aggregateMapping();
  safeCsvFailure("day,country,amount\n2026-01-01,JP,1\n2026-01-01,JP,2\n", mapping, "duplicate_grouping", 3);
  safeCsvFailure("day,country,amount\n2026-01-02,JP,1\n", mapping, "date_outside_range", 2);
  safeCsvFailure("day,country,amount\n2026-02-30,JP,1\n", mapping, "grouping_invalid", 2);
  safeCsvFailure("day,country,amount\n2026-01-01,JP\n", mapping, "csv_width_invalid", 2);
  safeCsvFailure('day,country,amount\n2026-01-01,JP,"1"garbage\n', mapping, "csv_quotes_invalid", 2);
  safeCsvFailure('day,country,amount\n2026-01-01,JP,"unterminated\n', mapping, "csv_quotes_invalid", 2);
  safeCsvFailure("day,country,country\n", mapping, "csv_header_invalid", 1);
  safeCsvFailure("day,country,private-column\n2026-01-01,JP,private-value\n", mapping, "column_missing", 2);
  safeCsvFailure("day,country,amount\n", mapping, "csv_empty", null);
  safeCsvFailure("day,country,amount\n2026-01-01,JP,1\n", { ...mapping, grouping: { ...mapping.grouping, attribution_status: { constant: "unattributed" } } }, "attribution_scope_mismatch", 2);
});
it("bounds CSV acquisition and requires an explicit closed non-identifying mapping", () => {
  const mapping = aggregateMapping();
  assert.throws(() => aggregateCsvToSnapshot(new Uint8Array(4 * 1024 * 1024 + 1), mapping), /input_byte_limit/);
  safeCsvFailure(`day,country,amount\n${"2026-01-01,JP,1\n".repeat(10001)}`, mapping, "input_row_limit", null);
  safeCsvFailure(`day,country,amount\n2026-01-01,JP,${"9".repeat(101)}\n`, mapping, "integer_too_large", 2);
  for (const altered of [{ ...mapping, inferred: true }, { ...mapping, version: 2 },
    { ...mapping, grouping: { ...mapping.grouping, installation_id: { column: "id" } } },
    { ...mapping, grouping: { ...mapping.grouping, cohort_date: { column: "day", omit_if_empty: true } } },
    { ...mapping, value: { ...mapping.value, scale: 19 } }]) {
    assert.throws(() => aggregateCsvToSnapshot(csvBytes("day,country,amount\n2026-01-01,JP,1\n"), altered), AggregateCsvError);
  }
});
it("runs the CSV converter and existing JSON/HTML comparison CLI without DB, raw import or value-bearing errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmasu-synthetic-aggregate-"));
  try {
    const csv = join(directory, "synthetic.csv"), map = join(directory, "mapping.json"), snapshot = join(directory, "snapshot.json");
    writeFileSync(csv, "day,country,amount\n2026-01-01,JP,1.23\n"); writeFileSync(map, JSON.stringify(aggregateMapping()));
    const convert = () => spawnSync(process.execPath, ["--import", "tsx", "tools/report-to-snapshot.ts", "--csv", csv, map], { encoding: "utf8" });
    const converted = convert(); assert.equal(converted.status, 0, converted.stderr);
    assert.equal(JSON.parse(converted.stdout).rows[0].value, "123"); writeFileSync(snapshot, converted.stdout);
    for (const format of [[], ["--html"]]) {
      const comparison = spawnSync(process.execPath, ["--import", "tsx", "tools/compare-cohorts.ts", "--declared", ...format, snapshot, snapshot], { encoding: "utf8" });
      assert.equal(comparison.status, 0, comparison.stderr);
      if (format.length) assert.match(comparison.stdout, /DECLARED ONLY/);
      else assert.equal(JSON.parse(comparison.stdout).rows[0].status, "equal");
    }
    writeFileSync(csv, "day,country,amount\n2026-01-01,JP,private-value\n");
    const bad = convert(); assert.equal(bad.status, 1); assert.equal(bad.stdout, "");
    assert.deepEqual(JSON.parse(bad.stderr), { error: { code: "number_invalid", row_number: 2 } });
    assert.doesNotMatch(bad.stderr, /private-value|country|amount|synthetic\.csv/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("takes undefined money units only from a captured definition, not a guessed metric name", () => {
  const r: Record<string, any> = backedRow(); delete r.value_unscaled;
  r.value_state = "undefined"; r.undefined_reason = "empty_cohort"; r.currency = null; r.amount_scale = null;
  const output = reportToSnapshot({ data: [r] }, template());
  assert.equal(output.rows[0].currency, "USD"); assert.equal(output.rows[0].scale, 2);
  assert.equal(output.rows[0].state, "undefined");
  delete r.comparison_context;
  assert.throws(() => reportToSnapshot({ data: [r] }, template()), /invalid_/);
});
it("converts exact saved values and binds run provenance for comparison", () => {
  const output = reportToSnapshot({ data: [row()] }, template());
  assert.equal(output.rows[0].state === "present" && output.rows[0].value, "900719925474099301");
  assert.equal(output.provenance?.runs[0].metric_run_id, "synthetic-run");
  assert.equal(compareSnapshots(output, output).status, "incomparable");
  assert.equal(compareSnapshots(output, output, { declaredOnly: true }).rows[0].status, "equal");
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
