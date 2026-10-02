import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REFUND_REVERSAL_METRIC_DEFINITIONS, validateEventPayload, validateMetricDefinition } from "@openmasu/contracts";
import { evaluate, jcs } from "./evaluator.js";
import { syntheticRefundReversalCases } from "../../../tools/synthetic-refund-reversal-cases.js";

type Any = Record<string, any>;
const baseline: Any = JSON.parse(readFileSync("fixtures/v0.4/62-explicit-refund-reversal/input.json", "utf8"));

describe("explicit refund cancellation", () => {
  for (const entry of syntheticRefundReversalCases(baseline)) it(entry.name, () => {
    const output = evaluate(entry.input);
    const values = entry.input.metric_evaluations.map((ev: Any) => output.metric_runs.find(run =>
      run.metric_run_id === `${ev.metric_run_id_prefix}:cohort_purchase_net_revenue_d30_usd`)?.value_unscaled);
    assert.deepEqual(values, entry.expectedNet);
    assert.equal(output.rejections.length > 0, entry.rejected);
    assert.equal(output.logical_events.filter(row => row.event_name === "purchase").length,
      entry.name === "privacy-removes-purchase-60" ? 0 : 1);
    const reordered = structuredClone(entry.input); reordered.batches.reverse();
    for (const batch of reordered.batches) batch.records.reverse();
    assert.equal(jcs(evaluate(reordered)), jcs(output));
  });
  it("requires an explicit versioned profile and a reversed installation-anchored payload", () => {
    for (const definition of REFUND_REVERSAL_METRIC_DEFINITIONS) assert.equal(validateMetricDefinition(definition), true);
    const d = structuredClone(REFUND_REVERSAL_METRIC_DEFINITIONS[0]);
    for (const change of [{ refund_reversal_policy: undefined }, { refund_reversal_policy: "guess" },
      { rule_bundle_hash: "0".repeat(64) }, { metric_definition_version: "0.4.13" }]) {
      const mutated = JSON.parse(JSON.stringify({ ...d, ...change }));
      assert.equal(validateMetricDefinition(mutated), false);
      assert.throws(() => evaluate({ ...baseline, metric_definitions: [mutated] }), /metric_definition_series_mismatch/);
    }
    const payload = baseline.batches[2].records[0].payload;
    assert.equal(validateEventPayload("refund", payload).valid, true);
    for (const change of [{ financial_status: "settled" }, { installation_id: undefined }, { reverses_refund_record_id: "" }]) {
      assert.equal(validateEventPayload("refund", JSON.parse(JSON.stringify({ ...payload, correction_target_record_id: "purchase-60", ...change }))).valid, false);
    }
  });
});
