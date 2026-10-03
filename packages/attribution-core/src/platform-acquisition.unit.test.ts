import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluate, jcs } from "@openmasu/attribution-core";
import { VERIFIED_PLATFORM_METRIC_DEFINITIONS, metricProfileMetadata } from "@openmasu/contracts/definitions";
import { validateScheduledMetricDefinition, assertMetricDefinitionSeries } from "@openmasu/contracts/validation";
import { syntheticPlatformAcquisitionCases } from "../../../tools/synthetic-platform-acquisition-cases.js";

type Any = Record<string, any>;
const directory = "fixtures/v0.4/66-verified-platform-acquisition/";
const input: Any = JSON.parse(readFileSync(directory + "input.json", "utf8"));
describe("verified platform acquisition reference profile", () => {
  for (const entry of syntheticPlatformAcquisitionCases(input)) it(entry.name, () => {
    const runs = evaluate(entry.input).metric_runs;
    assert.deepEqual(runs.map(run => run.value_unscaled ?? run.undefined_reason), entry.expected);
    if (entry.name.includes("redaction")) assert.equal(runs.find(run => run.metric_name.startsWith("platform_"))?.reproducibility_status,"redaction_affected");
    if (entry.name.includes("retention expiry")) assert.equal(runs.find(run => run.metric_name.startsWith("platform_"))?.reproducibility_status,"retention_affected");
    if (entry.name.includes("permutations")) assert.equal(jcs(evaluate(entry.input)), jcs(evaluate(input)));
    const old = structuredClone(entry.input); old.platform_acquisition_inputs = [];
    const oldRuns = evaluate(old).metric_runs.filter(run => !run.metric_name.startsWith("platform_"));
    const actualOld = runs.filter(run => !run.metric_name.startsWith("platform_"));
    assert.deepEqual(actualOld.map(run => run.value_unscaled), oldRuns.map(run => run.value_unscaled));
    // A real superseding revision changes the old snapshot, not its click-only dimension rules.
    if (!entry.name.includes("exclusion")) assert.equal(jcs(actualOld),jcs(oldRuns));
  });
  it("matches every independently constructed golden family", () => {
    for (const [key,actual] of Object.entries(evaluate(input))) {
      assert.equal(jcs(actual),jcs(JSON.parse(readFileSync(directory + `expected_${key}.json`,"utf8"))));
    }
  });
  it("admits only the closed opt-in profile and never relabels old definitions", () => {
    for (const definition of VERIFIED_PLATFORM_METRIC_DEFINITIONS) {
      assert.equal(validateScheduledMetricDefinition(definition), true);
      assertMetricDefinitionSeries(definition);
      assert.equal(metricProfileMetadata(definition)?.key,"platform");
      const wrong = structuredClone(definition); wrong.acquisition_basis = "selected_first_party_click";
      assert.equal(validateScheduledMetricDefinition(wrong),false);
      assert.throws(() => assertMetricDefinitionSeries(wrong),/metric_definition_series_mismatch/);
    }
    const ambiguous = structuredClone(input); delete ambiguous.metric_evaluations[0].grouping.network;
    assert.throws(() => evaluate(ambiguous),/platform_acquisition_source_required/);
  });
});
