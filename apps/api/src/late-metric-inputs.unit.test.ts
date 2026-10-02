import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { supportsLateMetric } from "./late-metric-inputs.js";

it("restricts late-input selection to saved install-cohort revenue LTV and ROAS definitions without rewriting their profiles", () => {
  for (const fixture of ["33-stage-b-cohort-metrics", "58-selected-native-acquisition", "59-disjoint-cost-grains", "60-selected-commerce"]) {
    const input = JSON.parse(readFileSync(`fixtures/v0.4/${fixture}/input.json`, "utf8"));
    for (const metric of input.metric_definitions) {
      const replay = { metric_definition: metric, evaluation: { grouping: { cohort_date: "2026-08-06" } } };
      assert.equal(supportsLateMetric(replay), ["revenue_sum", "revenue_over_cohort", "revenue_over_cost"].includes(metric.definition.calculation), metric.metric_name);
      assert.equal(supportsLateMetric({ ...replay, evaluation: { grouping: {} } }), false);
      assert.equal(supportsLateMetric({ ...replay, metric_definition: { ...metric, anchor_event: "deep_link_open" } }), false);
    }
  }
  assert.equal(supportsLateMetric({}), false);
});
