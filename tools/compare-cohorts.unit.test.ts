import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { compareSnapshots, parseSnapshot, canonicalComparisonCutoff } from "./compare-cohorts.js";
import { M1B_METRIC_DEFINITIONS } from "@openmasu/contracts";
import { captureMetricComparisonContext } from "@openmasu/runtime";
import { sha256, jcs } from "@openmasu/attribution-core";

const declared = (left: unknown, right: unknown) => compareSnapshots(left, right, { declaredOnly: true });

it("runs the synthetic CLI and rejects invalid arguments without printing inputs", () => {
  const path = "examples/synthetic/cohort-snapshot.json";
  const run = spawnSync(process.execPath, ["--import", "tsx", "tools/compare-cohorts.ts", "--declared", path, path], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).rows[0].status, "equal");
  const bad = spawnSync(process.execPath, ["--import", "tsx", "tools/compare-cohorts.ts"], { encoding: "utf8" });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, "");
});

const snapshot = () => ({ source: "synthetic", conditions: { date_from: "2026-01-01", date_to: "2026-01-02", time_zone: "UTC", maturity: "fully_elapsed_d7", aggregation: "cumulative", attribution_scope: "organic", metric_definition: "revenue_d7_v1", source_cutoff: "2026-01-10T00:00:00.000Z" }, rows: [{ key: "total", currency: "USD", scale: 2, state: "present", value: "100" }] });
it("compares equal scaled values and exact large integers", () => {
  const a = snapshot(), b = snapshot(); b.rows[0].scale = 3; b.rows[0].value = "1000";
  assert.equal(declared(a, b).rows[0].status, "equal");
  a.rows[0].value = "900719925474099300"; b.rows[0].scale = 2; b.rows[0].value = "900719925474099301";
  assert.equal(declared(a, b).rows[0].delta_right_minus_left, "1");
});
it("refuses each incompatible comparison condition", () => {
  for (const [key, value] of Object.entries({ date_from: "2025-12-31", date_to: "2026-01-03", time_zone: "Asia/Tokyo", maturity: "partial", aggregation: "on_day", attribution_scope: "unattributed", metric_definition: "other", source_cutoff: "2026-01-11T00:00:00.000Z" })) {
    const b = snapshot(); Object.assign(b.conditions, { [key]: value });
    assert.equal(declared(snapshot(), b).status, "incomparable");
  }
});
it("distinguishes missing undefined zero and currency mismatch", () => {
  const a = snapshot(), b = snapshot(); b.rows = [];
  assert.equal(declared(a, b).rows[0].status, "missing_right");
  const undefinedInput = { ...a, rows: [{ key: "total", currency: "USD", scale: 2, state: "undefined", reason: "no_cost" }] };
  assert.equal(declared(a, undefinedInput).rows[0].status, "undefined");
  b.rows = [{ ...a.rows[0], value: "0" }];
  assert.equal(declared(a, b).rows[0].status, "different");
  b.rows[0].currency = "EUR"; assert.equal(declared(a, b).rows[0].status, "currency_mismatch");
});
it("rejects duplicate keys and malformed inputs", () => {
  const a = snapshot(); a.rows.push(a.rows[0]); assert.throws(() => parseSnapshot(a), /duplicate_key/);
  const b = snapshot(); b.rows[0].value = "1.2"; assert.throws(() => parseSnapshot(b));
  const c = snapshot(); c.conditions.date_from = "2026-02-30"; assert.throws(() => parseSnapshot(c));
  assert.throws(() => parseSnapshot({ ...snapshot(), extra: true }));
});
it("is deterministic across row order and repeated evaluation", () => {
  const a = snapshot(); a.rows.push({ ...a.rows[0], key: "another" });
  const b = { ...a, rows: [...a.rows].reverse() };
  assert.deepEqual(declared(a, b), declared(b, a));
  assert.deepEqual(declared(a, b), declared(a, b));
});

const backed = (patch: Record<string, any> = {}, fxPatch: Record<string, any> = {}) => {
  const definition = { ...structuredClone(M1B_METRIC_DEFINITIONS.find(d => d.metric_name === "d7_roas")!), ...patch };
  const fx = { policy_version: "synthetic-fx", target_currency: "USD", target_scale: 6, rounding_mode: "half_even" as const,
    rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, as_of: "2026-01-01T00:00:00.000Z" }], ...fxPatch };
  const key = jcs({ cohort_date: "2026-01-01", attribution_status: "organic" });
  const run = { metric_run_id: "synthetic-run", input_snapshot_id: "a".repeat(64) };
  const context = captureMetricComparisonContext(run, definition, fx, "after", sha256);
  return { source: "synthetic-definition", conditions: { ...snapshot().conditions, metric_definition: `${definition.metric_name}@${definition.metric_definition_version}` },
    rows: [{ key, currency: "none", scale: 6, state: "present", value: "1500000" }],
    provenance: { report_sha256: "b".repeat(64), runs: [{ key, ...run }] }, comparison_contexts: [{ key, context }] };
};
it("never promotes declaration-only input to definition-backed comparison", () => {
  const result = compareSnapshots(snapshot(), snapshot());
  assert.equal(result.status, "incomparable"); assert.deepEqual(result.rows, []);
  assert.equal(result.assurance.left.meaning, "unknown");
  assert.equal(result.assurance.left.conditions.date_from.state, "declared");
  assert.equal(declared(snapshot(), snapshot()).status, "declared_comparison");
});
it("accepts contract timestamp spellings without truncating microseconds or mutating input", () => {
  const a = snapshot(); a.conditions.source_cutoff = "2026-01-10T00:00:00Z";
  assert.equal(declared(a, snapshot()).status, "declared_comparison");
  assert.equal(a.conditions.source_cutoff, "2026-01-10T00:00:00Z");
  assert.equal(canonicalComparisonCutoff("2026-01-10T00:00:00.000001Z"), "2026-01-10T00:00:00.000001Z");
  const b = snapshot(); b.conditions.source_cutoff = "2026-01-10T00:00:00.000001Z";
  assert.equal(declared(a, b).status, "incomparable");
  assert.throws(() => canonicalComparisonCutoff("2026-02-30T00:00:00Z"));
});
it("detects same-name differences in gross/net, window, FX and rounding precision", () => {
  const a = backed();
  for (const [b, reason] of [
    [backed({ fraud_policy: "net" }), "meaning.fraud_policy"],
    [backed({ definition: { ...a.comparison_contexts[0].context.definition.definition, window: { type: "elapsed", day: 1 } } }), "meaning.window"],
    [backed({}, { rates: [{ currency: "USD", rate_unscaled: "2", rate_scale: 0, as_of: "2026-01-01T00:00:00.000Z" }] }), "meaning.fx"],
    [backed({}, { target_scale: 3 }), "meaning.fx"],
  ] as const) {
    const result = compareSnapshots(a, b);
    assert.equal(result.status, "incomparable"); assert.ok(result.mismatches.includes(reason), JSON.stringify(result)); assert.deepEqual(result.rows, []);
  }
});
it("makes absent and explicit default fraud policies semantically identical", () => {
  const a = backed(), b = backed({ fraud_policy: "gross" });
  assert.equal(compareSnapshots(a, b).status, "compared");
  const incomplete = structuredClone(a); incomplete.comparison_contexts = [];
  assert.equal(compareSnapshots(a, incomplete).status, "incomparable");
  assert.equal(compareSnapshots(a, incomplete, { declaredOnly: true }).status, "incomparable");
});
it("compares explicit equivalent meaning across distinct internal definition/bundle/FX references", () => {
  const a = backed(), b = backed({ metric_name: "equivalent_elsewhere", metric_definition_version: "different-version",
    rule_bundle_id: "different-id", rule_bundle_version: "different-version", rule_bundle_hash: "c".repeat(64) }, { policy_version: "different-fx-reference" });
  const result = compareSnapshots(a, b);
  assert.equal(result.status, "compared"); assert.equal(result.rows[0].status, "equal");
  assert.equal(result.assurance.left.meaning, "definition_backed");
  assert.notEqual(result.assurance.left.execution[0].definition_digest, result.assurance.right.execution[0].definition_digest);
  assert.deepEqual(result, compareSnapshots(a, b));
});
it("keeps unsupported implementation or missing maturity unknown and checks digest/run binding", () => {
  const a = backed();
  const bad = structuredClone(a); bad.comparison_contexts[0].context.definition.fraud_policy = "net";
  assert.throws(() => parseSnapshot(bad), /invalid_definition_context/);
  const wrong = structuredClone(a); wrong.comparison_contexts[0].context.metric_run_id = "other";
  assert.throws(() => parseSnapshot(wrong), /context_binding/);
  const unsupported = backed({ definition: { ...a.comparison_contexts[0].context.definition.definition, window: { type: "calendar_day", day: 7 } } });
  assert.equal(compareSnapshots(unsupported, unsupported).assurance.left.meaning, "unknown");
  const missing = structuredClone(a); missing.rows[0].key = "unknown"; missing.provenance.runs[0].key = "unknown"; missing.comparison_contexts[0].key = "unknown";
  assert.equal(compareSnapshots(missing, missing).status, "incomparable");
  assert.ok(compareSnapshots(missing, missing).assurance.left.missing.includes("window_maturity"));
});
