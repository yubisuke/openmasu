import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DISJOINT_COST_METRIC_DEFINITIONS, validateMetricDefinition } from "@openmasu/contracts";
import { evaluate, sha256 } from "./evaluator.js";

type Any = Record<string, any>;
function input(): Any {
  const value = JSON.parse(readFileSync(new URL("../../../fixtures/v0.4/58-selected-native-acquisition/input.json", import.meta.url), "utf8"));
  value.metric_definitions = [structuredClone(DISJOINT_COST_METRIC_DEFINITIONS[0])];
  value.metric_evaluations[0].metric_names = ["d0_roas"];
  return value;
}
function costs(value: Any, entries: Array<{ id: string; amount: string; group?: string; country?: string; date?: string; asOf?: string }>) {
  const original = value.cost_records[0];
  value.cost_records = entries.map((entry) => {
    const dimensions = { network: original.network, campaign_id: original.campaign_id,
      ...(entry.group ? { ad_group_id: entry.group } : {}), ...(entry.country ? { country: entry.country } : {}) };
    return { ...original, ...dimensions, cost_record_id: entry.id, amount_unscaled: entry.amount,
      date: entry.date ?? original.date, as_of: entry.asOf ?? original.as_of, dimension_digest: sha256(dimensions) };
  });
}
describe("explicit disjoint-cost cohorts", () => {
  it("leaves parent/detail overlap undefined with all candidate evidence rather than inventing a denominator", () => {
    const value = input();
    costs(value, [{ id: "parent", amount: "100000000" }, { id: "a", group: "a", amount: "40000000" }, { id: "b", group: "b", amount: "60000000" }]);
    const run = evaluate(value).metric_runs[0];
    assert.equal(run.value_state, "undefined");
    assert.equal(run.undefined_reason, "overlapping_cost_grains");
    assert.equal(Object.hasOwn(run, "value_unscaled"), false);
    for (const id of ["parent", "a", "b"]) assert.ok(run.evidence_refs.some(e => e.ref === id));
    value.cost_records.reverse();
    assert.deepEqual(evaluate(value).metric_runs[0], run);
  });
  it("uses disjoint siblings and only the latest visible dated revision without changing old runs", () => {
    const value = input();
    costs(value, [{ id: "a", group: "a", amount: "40000000" }, { id: "b", group: "b", amount: "60000000" }]);
    const original = evaluate(value).metric_runs[0];
    assert.equal(original.value_unscaled, "200000"); // USD20 / USD100
    const correction = { ...value.cost_records[0], cost_record_id: "a-revised", amount_unscaled: "50000000", as_of: "2026-08-13T00:00:00.000Z" };
    value.cost_records.push(correction);
    assert.deepEqual(evaluate(value).metric_runs[0], original);
    value.metric_evaluations[0].input_received_at_watermark = correction.as_of;
    const revised = evaluate(value).metric_runs[0];
    assert.equal(revised.value_unscaled, "181818"); // half-even 20/110
    assert.notEqual(revised.input_snapshot_id, original.input_snapshot_id);
    assert.ok(!revised.evidence_refs.some(e => e.ref === "a"));
  });
  it("does not collapse the same dimension digest across acquisition dates", () => {
    const value = input();
    delete value.metric_evaluations[0].grouping.cohort_date;
    costs(value, [{ id: "day6", amount: "100000000" }, { id: "day7", amount: "100000000", date: "2026-08-07" }]);
    assert.equal(value.cost_records[0].dimension_digest, value.cost_records[1].dimension_digest);
    assert.equal(evaluate(value).metric_runs[0].value_unscaled, "100000"); // 20 / (100+100)
  });
  it("protects total-net ROAS too, without adding selected acquisition to commerce before its own connection", () => {
    const value = input();
    value.metric_definitions = [structuredClone(DISJOINT_COST_METRIC_DEFINITIONS.find(d => d.metric_name === "d30_total_net_roas")!)];
    value.metric_evaluations[0].metric_names = ["d30_total_net_roas"];
    delete value.metric_evaluations[0].grouping;
    costs(value, [{ id: "parent", amount: "100000000" }, { id: "a", group: "a", amount: "100000000" }]);
    assert.equal(evaluate(value).metric_runs[0].undefined_reason, "overlapping_cost_grains");
    value.cost_records.pop();
    assert.equal(evaluate(value).metric_runs[0].value_unscaled, "200000");
  });
  it("binds the optional cost policy to a new version/hash and retains all historical definitions", () => {
    for (const definition of DISJOINT_COST_METRIC_DEFINITIONS) assert.equal(validateMetricDefinition(definition), true);
    const value = input();
    assert.equal(validateMetricDefinition({ ...value.metric_definitions[0], metric_definition_version: "0.4.11" }), false);
    assert.equal(validateMetricDefinition({ ...value.metric_definitions[0], rule_bundle_hash: "0".repeat(64) }), false);
    const wrong = structuredClone(value.metric_definitions[0]);
    delete wrong.cost_selection_policy;
    assert.equal(validateMetricDefinition(wrong), false);
    assert.throws(() => evaluate({ ...value, metric_definitions: [wrong] }), /metric_definition_series_mismatch/);
  });
});
