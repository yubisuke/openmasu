import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { engagementMetricDefinitions, validateMetricDefinition } from "@openmasu/contracts";
import { evaluate, jcs } from "./evaluator.js";
import { syntheticEngagementCases } from "../../../tools/synthetic-engagement-cases.js";

const baseline = JSON.parse(readFileSync("fixtures/v0.4/64-first-party-engagement/input.json", "utf8"));
describe("first-party engagement outcomes", () => {
  for (const entry of syntheticEngagementCases(baseline)) it(entry.name, () => {
    const output = evaluate(entry.input);
    assert.deepEqual(output.metric_runs.map(run => run.value_unscaled ?? run.undefined_reason), entry.expected);
    assert.equal(output.rejections.length, 0);
    const reordered = structuredClone(entry.input); reordered.batches.reverse();
    assert.equal(jcs(evaluate(reordered)), jcs(output));
  });
  it("requires a bounded explicit engagement profile and matching FX target", () => {
    const definitions = engagementMetricDefinitions("tutorial_complete");
    for (const definition of definitions) assert.equal(validateMetricDefinition(definition), true);
    const d = definitions[0];
    for (const change of [{ engagement_credit_policy: undefined }, { anchor_event: "install" },
      { rule_bundle_hash: "0".repeat(64) }, { metric_definition_version: "0.4.14" }, { conversion_event_key: "" },
      { definition: { ...d.definition, window: { type: "elapsed", day: 7 } } }, { grouping_dimensions: ["campaign_id", "cohort_date"] }]) {
      const invalid = JSON.parse(JSON.stringify({ ...d, ...change }));
      assert.equal(validateMetricDefinition(invalid), false);
      assert.throws(() => evaluate({ ...baseline, metric_definitions: [invalid] }));
    }
    assert.throws(() => evaluate({ ...baseline, fx_policy: { ...baseline.fx_policy, target_scale: 3 } }), /fx_target_mismatch/);
    assert.throws(() => engagementMetricDefinitions("reserved.invalid"), /conversion_event_key_invalid/);
  });
  it("never rewrites original install attribution or its metrics", () => {
    const acquisition = JSON.parse(readFileSync("fixtures/v0.4/63-selected-acquisition-detail/input.json", "utf8"));
    const before = evaluate(acquisition);
    acquisition.batches = [{ batch_id: "acquisition", server_context: acquisition.server_context, records: acquisition.records }, ...baseline.batches];
    delete acquisition.records; delete acquisition.server_context;
    const after = evaluate(acquisition);
    assert.equal(jcs(after.attributions.filter(a => a.subject_scope === "installation_level")), jcs(before.attributions));
    assert.deepEqual(after.metric_runs.map(r => r.value_unscaled), before.metric_runs.map(r => r.value_unscaled));
  });
});
