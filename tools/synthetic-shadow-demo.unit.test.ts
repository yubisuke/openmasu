import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertSyntheticShadowDemo,
  buildSyntheticShadowDemo,
  buildSyntheticCohortWalkthrough,
  summarizeAttribution,
  summarizeReconciliation,
} from "./synthetic-shadow-demo.js";

describe("offline synthetic Shadow MMP comparison demo", () => {
  it("extracts window mismatch with candidate, window, and join explanation", () => {
    const value = buildSyntheticShadowDemo();
    const comparison = value.comparisons[0];
    assert.equal(comparison.reason_code, "window_mismatch");
    assert.deepEqual(comparison.explanation.candidates, ["install-21"]);
    assert.deepEqual(comparison.explanation.windows, ["install-21:out_of_window"]);
    assert.equal(comparison.explanation.joins.length, 1);
  });

  it("extracts provider-modeled conversion with empty candidate evidence", () => {
    const comparison = buildSyntheticShadowDemo().comparisons[1];
    assert.equal(comparison.reason_code, "provider_modeled_conversion");
    assert.deepEqual(comparison.explanation.candidates, []);
    assert.deepEqual(comparison.explanation.joins, []);
  });

  it("keeps crowd-anonymity suppression as attribution-only evidence", () => {
    const comparison = buildSyntheticShadowDemo().comparisons[2];
    assert.equal(comparison.domain, "attribution");
    assert.equal(comparison.reason_code, "crowd_anonymity_suppressed");
    assert.equal(comparison.explanation.status, "unattributed");
    assert.equal(comparison.runtime_boundary.api_route, null);
  });

  it("marks external inputs and runtime persistence as not run", () => {
    const value = buildSyntheticShadowDemo();
    assertSyntheticShadowDemo(value);
    assert.equal(value.stored_runtime_claim, "not_run");
    assert.ok(Object.values(value.environment).every((entry) => entry === false));
  });

  it("emits byte-identical JSON for repeated evaluation", () => {
    assert.equal(JSON.stringify(buildSyntheticShadowDemo()), JSON.stringify(buildSyntheticShadowDemo()));
  });

  it("rejects missing target artifacts or reviewed-golden drift", () => {
    assert.throws(
      () => summarizeReconciliation([], [], "synthetic-reconciliation", "window_mismatch"),
      /exactly one window_mismatch artifact/,
    );
    const attribution = [{ reason_code: "crowd_anonymity_suppressed" }];
    assert.throws(
      () => summarizeAttribution(attribution, [{ reason_code: "reason_drift" }], "synthetic-attribution", "crowd_anonymity_suppressed"),
      /evaluator output differs from its reviewed golden/,
    );
  });

  it("derives exact equal, cost-correction and incompatible-window scenarios without inventing runtime evidence", () => {
    const demo = buildSyntheticCohortWalkthrough();
    assert.equal(JSON.stringify(demo), JSON.stringify(buildSyntheticCohortWalkthrough()));
    assert.equal(demo.baseline_golden_check, "passed"); assert.equal(demo.runtime_boundary, "not_run");
    assert.equal(demo.samples.baseline.snapshot.rows[0].state === "present" && demo.samples.baseline.snapshot.rows[0].value, "1500000");
    assert.equal(demo.samples.different.snapshot.rows[0].state === "present" && demo.samples.different.snapshot.rows[0].value, "750000");
    assert.equal(demo.comparisons.equal.status, "declared_comparison");
    assert.equal(demo.comparisons.equal.rows[0].status, "equal");
    assert.equal(demo.comparisons.different.rows[0].status, "different");
    assert.equal(demo.comparisons.different.rows[0].delta_right_minus_left, "-750000");
    assert.equal(demo.comparisons.incomparable.status, "incomparable");
    assert.ok(demo.comparisons.incomparable.mismatches.includes("maturity"));
    assert.equal(demo.comparisons.incomparable.rows.length, 0);
    assert.equal(demo.comparisons.unknown.status, "incomparable");
    for (const sample of Object.values(demo.samples)) {
      assert.equal(sample.snapshot.comparison_contexts, undefined); assert.equal(sample.snapshot.acquisition, undefined);
      assert.equal(sample.snapshot.mapping_provenance?.interpretation, "operator_declared");
    }
  });

  it("connects demo files to the ordinary converter and comparison CLI and refuses to overwrite them", () => {
    const temporary = mkdtempSync(join(tmpdir(), "openmasu-shadow-"));
    const directory = join(temporary, "new-parent", "comparison");
    const command = (tool: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", `tools/${tool}.ts`, ...args], { encoding: "utf8" });
    try {
      const run = command("synthetic-shadow-demo", [`--comparison-dir=${directory}`]);
      assert.equal(run.status, 0, run.stderr);
      const output = JSON.parse(run.stdout);
      assert.equal(output.stored_runtime_claim, "not_run");
      assert.equal(output.cohort_walkthrough.files.length, 20);
      const convert = command("report-to-snapshot", ["--csv", join(directory, "baseline.csv"), join(directory, "baseline-mapping.json")]);
      assert.equal(convert.status, 0, convert.stderr);
      assert.equal(convert.stdout, readFileSync(join(directory, "baseline.json"), "utf8"));
      const compare = command("compare-cohorts", ["--declared", "--html", join(directory, "baseline.json"), join(directory, "different.json")]);
      assert.equal(compare.status, 0, compare.stderr);
      assert.equal(compare.stdout, readFileSync(join(directory, "different.html"), "utf8"));
      assert.match(compare.stdout, /DECLARED ONLY/); assert.match(compare.stdout, /-0\.750000 none/);
      assert.doesNotMatch(compare.stdout, /<script|javascript:/i);
      const repeat = command("synthetic-shadow-demo", [`--comparison-dir=${directory}`]);
      assert.equal(repeat.status, 1); assert.equal(repeat.stdout, "");
      assert.ok(!repeat.stderr.includes(temporary));
      assert.equal(convert.stdout, readFileSync(join(directory, "baseline.json"), "utf8"));
      assert.equal(command("synthetic-shadow-demo", ["--unknown"]).status, 1);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
