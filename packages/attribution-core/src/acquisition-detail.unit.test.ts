import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ACQUISITION_DETAIL_METRIC_DEFINITIONS, validateMetricDefinition } from "@openmasu/contracts";
import { evaluate, jcs } from "./evaluator.js";
import { syntheticAcquisitionDetailCases } from "../../../tools/synthetic-acquisition-detail-cases.js";

const baseline = JSON.parse(readFileSync("fixtures/v0.4/63-selected-acquisition-detail/input.json", "utf8"));
describe("selected acquisition detail", () => {
  for (const entry of syntheticAcquisitionDetailCases(baseline)) it(entry.name, () => {
    const output = evaluate(entry.input);
    assert.deepEqual(output.metric_runs.map(run => run.value_unscaled ?? run.undefined_reason), entry.expected);
    assert.equal(output.rejections.length, 0);
    const reordered = structuredClone(entry.input); reordered.records.reverse(); reordered.cost_records.reverse();
    assert.equal(jcs(evaluate(reordered)), jcs(output));
  });
  it("requires an explicit bounded profile instead of silently reinterpreting old grouping", () => {
    for (const definition of ACQUISITION_DETAIL_METRIC_DEFINITIONS) assert.equal(validateMetricDefinition(definition), true);
    const definition = structuredClone(ACQUISITION_DETAIL_METRIC_DEFINITIONS[0]);
    for (const change of [{ acquisition_dimension_policy: undefined }, { acquisition_basis: undefined },
      { rule_bundle_hash: "0".repeat(64) }, { metric_definition_version: "0.4.11" }, { cost_selection_policy: undefined },
      { definition: { ...definition.definition, window: { type: "elapsed", day: 91 } } }]) {
      const invalid = JSON.parse(JSON.stringify({ ...definition, ...change }));
      assert.equal(validateMetricDefinition(invalid), false);
      assert.throws(() => evaluate({ ...baseline, metric_definitions: [invalid] }), /metric_definition_series_mismatch/);
    }
  });
});
