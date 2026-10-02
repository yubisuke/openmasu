import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { captureMetricComparisonContext } from "@openmasu/runtime";
import { sha256, jcs } from "@openmasu/attribution-core";
import { M1B_METRIC_DEFINITIONS } from "@openmasu/contracts";
import { parseExternalDeclaration, externalWindowMaturity, type ExternalRoasDeclaration } from "../apps/api/src/external-calculation-declaration.js";
import { compareSnapshots, parseSnapshot } from "./compare-cohorts.js";
import { aggregateCsvToSnapshot, reportToSnapshot } from "./report-to-snapshot.js";
import { renderComparison } from "./cohort-comparison-html.js";

const fixture = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
const golden = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/expected_metric_runs.json", "utf8"))
  .find((run: any) => run.metric_name === "d3_roas");
const definition = M1B_METRIC_DEFINITIONS.find(d => d.metric_name === "d3_roas")!;
const context = captureMetricComparisonContext(golden, definition, fixture.fx_policy, "after", sha256);
const template = () => ({ source: "synthetic-captured-report", conditions: { date_from: "2026-08-01", date_to: "2026-08-02",
  time_zone: "UTC", maturity: "not_assumed", aggregation: "cumulative", attribution_scope: "non_organic",
  metric_definition: "d3_roas@0.3.0", source_cutoff: golden.input_received_at_watermark }, rows: [] });
const report = () => ({ data: [{ ...golden, value_state: golden.value_state ?? "present", grouping: golden.grouping.dimensions, superseded: false,
  comparison_context: context, policy_versions: [`rule_bundle:${golden.rule_bundle_version}`, `fx:${fixture.fx_policy.policy_version}`] }] });
const declaration = (): ExternalRoasDeclaration => ({ version: 1, profile: "external-elapsed-ad-roas-v1", anchor_event: "install",
  calculation: "revenue_over_cost", numerator: "revenue", denominator: "cost", aggregation: "cumulative", time_zone: "UTC",
  window: { type: "elapsed", day: 3, boundary: "half_open" }, population: "accepted_installation_cohort",
  acquisition_basis: "recorded_dimensions", cost_basis: "cohort_acquisition_day_current_snapshot",
  cost_selection_policy: "legacy_dimension_digest_latest", grouping_dimensions: [...definition.grouping_dimensions!],
  fraud_policy: "gross", privacy_state: "after", value_type: "ratio", ratio_scale: 6,
  fx: { target_currency: "USD", target_scale: 6, conversion: "per_event_round_then_sum", rounding_mode: "half_even",
    rates: [{ currency: "EUR", rate_unscaled: "5", rate_scale: 1, as_of: "2026-08-01T00:00:00.000Z" }] }, final_rounding: "half_even" });
const mapping = () => ({ version: 1, source: "synthetic-external-claim", conditions: { ...template().conditions, metric_definition: "external-d3-ad-roas" },
  grouping: { cohort_date: { column: "day" }, campaign_id: { constant: "provider-campaign-33" }, network: { constant: "synthetic-network" },
    country: { constant: "JP" }, attribution_status: { constant: "non_organic" } },
  value: { column: "roas", input: "decimal", scale: 6, currency: { constant: "none" }, undefined: { marker: "", reason: { constant: "no_attributed_cost" } } },
  external_calculation: declaration() });
const external = (d = declaration(), amount = "1.25") => aggregateCsvToSnapshot(Buffer.from(`day,roas\n2026-08-01,${amount}\n`), { ...mapping(), external_calculation: d });
const compare = (a: unknown, b: unknown) => compareSnapshots(a, b, { allowExternalDeclaration: true });

it("bridges a fixture-derived saved ROAS and declared external CSV with exact delta and distinct provenance", () => {
  const left = reportToSnapshot(report(), template()), right = external();
  const result = compare(left, right);
  assert.equal(result.status, "external_declared_comparison"); assert.equal(result.rows[0].delta_right_minus_left, "250000");
  assert.equal(result.assurance.left.meaning, "definition_backed"); assert.equal(result.assurance.right.meaning, "external_declared");
  assert.equal(result.assurance.right.conditions.maturity.state, "external_declared");
  assert.equal(result.assurance.right.acquisition.upstream_completeness, "unknown"); assert.deepEqual(result.assurance.right.execution, []);
  assert.equal(result.provenance.left.saved_report?.runs[0].metric_run_id, golden.metric_run_id);
  assert.equal(result.provenance.right.mapping_provenance?.input_sha256, right.mapping_provenance?.input_sha256);
  assert.deepEqual(result.provenance.right.external_calculation, right.external_calculation);
  assert.equal(compare(right, left).rows[0].delta_right_minus_left, "-250000");
  assert.deepEqual(parseSnapshot(right), right); assert.deepEqual(compare(left, right), result);
  const html = renderComparison(result);
  assert.match(html, /EXTERNAL DECLARED COMPARISON/); assert.match(html, /0\.250000 none/);
  assert.ok(html.includes(right.mapping_provenance!.mapping_sha256)); assert.ok(html.includes(right.external_calculation!.declaration_sha256));
  assert.match(html, /external implementation and completeness remain unverified/); assert.doesNotMatch(html, /<script|<iframe/);
});
it("requires the external opt-in without weakening either existing comparison mode", () => {
  const left = reportToSnapshot(report(), template()), right = external();
  for (const options of [{}, { declaredOnly: true }]) {
    const result = compareSnapshots(left, right, options);
    assert.equal(result.status, "incomparable"); assert.deepEqual(result.rows, []);
    assert.ok(result.mismatches.includes("external_declaration_opt_in_required"));
  }
  assert.equal(compare(right, right).status, "incomparable");
  assert.equal(compareSnapshots(left, left).status, "compared");
  assert.throws(() => compareSnapshots(left, right, { declaredOnly: true, allowExternalDeclaration: true }), /conflicting/);
  const partial = structuredClone(left); partial.comparison_contexts = [];
  assert.ok(compare(partial, right).mismatches.includes("supported_captured_ad_roas_required"));
  const unknown = structuredClone(left); unknown.rows[0].key = "unknown"; unknown.provenance!.runs[0].key = "unknown"; unknown.comparison_contexts![0].key = "unknown";
  assert.equal(compare(unknown, right).status, "incomparable");
});
it("refuses incompatible external window FX fraud precision acquisition cost and rounding meanings", () => {
  const left = reportToSnapshot(report(), template());
  const mutations: [string, (d: ExternalRoasDeclaration) => void][] = [
    ["window", d => { d.window.day = 1; }], ["fraud_policy", d => { d.fraud_policy = "net"; }],
    ["privacy_state", d => { d.privacy_state = "before"; }], ["acquisition_basis", d => { d.acquisition_basis = "selected_first_party_click"; }],
    ["cost_selection_policy", d => { d.cost_selection_policy = "reject_overlapping_grains"; }],
    ["fx", d => { d.fx.rates[0].rate_unscaled = "6"; }], ["fx", d => { d.fx.rates[0].as_of = "2026-08-01T00:00:00.000001Z"; }],
    ["fx", d => { d.fx.target_scale = 3; }], ["fx", d => { d.fx.conversion = "round_after_sum"; }],
    ["fx", d => { d.fx.rounding_mode = "half_up"; }], ["final_rounding", d => { d.final_rounding = "half_up"; }],
  ];
  for (const [field, mutate] of mutations) {
    const d = declaration(); mutate(d); const result = compare(left, external(d));
    assert.equal(result.status, "incomparable", field); assert.deepEqual(result.rows, []);
    assert.ok(result.mismatches.includes(`meaning.${field}`), JSON.stringify(result.mismatches));
  }
  const m = mapping(); m.external_calculation.ratio_scale = 3; m.value.scale = 3;
  assert.ok(compare(left, aggregateCsvToSnapshot(Buffer.from("day,roas\n2026-08-01,1.25\n"), m)).mismatches.includes("meaning.ratio_scale"));
  const tooEarly = declaration(); tooEarly.window.day = 7;
  assert.ok(compare(left, external(tooEarly)).mismatches.includes("external_window_maturity_unknown"));
});
it("requires closed complete declarations, canonical grouping, explicit ratio units and untampered digest", () => {
  for (const patch of [{ unknown: true }, { final_rounding: undefined }, { anchor_event: "click" }, { grouping_dimensions: ["cohort_date", "cohort_date"] },
    { grouping_dimensions: ["cohort_date", "installation_id"] }, { ratio_scale: 19 }, { window: { type: "elapsed", day: -1, boundary: "half_open" } }]) {
    assert.throws(() => parseExternalDeclaration({ ...declaration(), ...patch }));
  }
  const missing = declaration() as any; delete missing.fx;
  assert.throws(() => parseExternalDeclaration(missing), /fields/);
  const badFx = declaration(); badFx.fx.rates[0].as_of = "2026-02-30T00:00:00Z";
  assert.throws(() => parseExternalDeclaration(badFx), /fx/);
  const right = external(), digest = structuredClone(right); digest.external_calculation!.declaration.fraud_policy = "net";
  assert.throws(() => parseSnapshot(digest), /digest_mismatch/);
  for (const patch of [{ currency: "USD" }, { scale: 3 }, { key: '{ "cohort_date":"2026-08-01" }' },
    { key: jcs({ cohort_date: "2026-08-01", installation_id: "synthetic" }) }]) {
    assert.throws(() => parseSnapshot({ ...right, rows: [{ ...right.rows[0], ...patch }] }));
  }
  const left = reportToSnapshot(report(), template());
  assert.throws(() => parseSnapshot({ ...left, external_calculation: right.external_calculation }), /external_cannot/);
  assert.throws(() => reportToSnapshot(report(), { ...template(), external_calculation: right.external_calculation }), /template_must_be_empty/);
  const forgedMapping = mapping(); forgedMapping.value.currency.constant = "USD";
  assert.throws(() => aggregateCsvToSnapshot(Buffer.from("day,roas\n2026-08-01,1\n"), forgedMapping), /external_units_mismatch/);
});
it("keeps undefined zero and absent external rows separate and derives only temporal maturity", () => {
  const left = reportToSnapshot(report(), template());
  assert.equal(compare(left, external(declaration(), "")).rows[0].status, "undefined");
  assert.equal(compare(left, external(declaration(), "0")).rows[0].delta_right_minus_left, "-1000000");
  const right = external(); const second = { ...right.rows[0], key: jcs({ ...golden.grouping.dimensions, country: "GB" }) };
  const expanded = { ...right, rows: [...right.rows, second], mapping_provenance: { ...right.mapping_provenance!, row_count: 2 } };
  assert.ok(compare(left, expanded).rows.some(row => row.status === "missing_left"));
  assert.equal(compare(left, { ...right, rows: [], mapping_provenance: { ...right.mapping_provenance!, row_count: 0 } }).status, "incomparable");
  const d = declaration(); d.window.day = 7;
  assert.equal(externalWindowMaturity(d, "2026-08-01", "2026-08-09T23:59:59.999999Z"), "unknown");
  assert.equal(externalWindowMaturity(d, "2026-08-01", "2026-08-10T00:00:00Z"), "window_elapsed");
  d.time_zone = "Asia/Tokyo";
  assert.equal(externalWindowMaturity(d, "2026-08-01", "2026-08-09T15:00:00Z"), "window_elapsed");
});
it("connects ordinary saved-report and external CSV conversion CLIs to JSON and HTML comparison", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmasu-synthetic-declaration-"));
  try {
    const file = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); return path; };
    const run = (tool: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", `tools/${tool}.ts`, ...args], { encoding: "utf8" });
    const converted = run("report-to-snapshot", [file("report.json", report()), file("template.json", template())]);
    assert.equal(converted.status, 0, converted.stderr);
    const csv = run("report-to-snapshot", ["--csv", file("external.csv", "day,roas\n2026-08-01,1.25\n"), file("mapping.json", mapping())]);
    assert.equal(csv.status, 0, csv.stderr);
    const paths = [file("left.json", converted.stdout), file("right.json", csv.stdout)];
    const output = run("compare-cohorts", ["--external-declared", ...paths]); assert.equal(output.status, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).rows[0].delta_right_minus_left, "250000");
    assert.equal(output.stdout.trim(), jcs(compare(JSON.parse(converted.stdout), JSON.parse(csv.stdout))));
    const html = run("compare-cohorts", ["--external-declared", "--html", ...paths]); assert.equal(html.status, 0, html.stderr);
    assert.equal(html.stdout, renderComparison(JSON.parse(output.stdout)));
    const noConsent = run("compare-cohorts", paths); assert.equal(JSON.parse(noConsent.stdout).status, "incomparable");
    const conflicting = run("compare-cohorts", ["--external-declared", "--declared", ...paths]); assert.equal(conflicting.status, 1); assert.equal(conflicting.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
