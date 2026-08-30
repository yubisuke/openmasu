import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSyntheticShadowDemo,
  buildSyntheticShadowDemo,
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
});
