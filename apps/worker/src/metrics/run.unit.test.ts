import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildMetricDefinitionsInput } from "./run.js";
import { engagementMetricDefinitions, SELECTED_DAILY_ACQUISITION_METRIC_DEFINITIONS } from "@openmasu/contracts";

const config = (grouping: Record<string, string> = {}) => ({
  tenant_id: "tenant-synthetic",
  app_id: "app-synthetic",
  fx_policy: {
    policy_version: "synthetic-no-fx", target_currency: "USD", target_scale: 6,
    rounding_mode: "half_even", rates: [],
  },
  metric_definitions: [],
  evaluations: [{ metric_names: ["cohort_size"], grouping }],
});

describe("WO16 metric backfill CLI", () => {
  it("daily_acquisition_CLI_defaults_to_occurrence_day_and_preserves_explicit_backfill_dates", () => {
    const source = { ...config(), metric_definitions: SELECTED_DAILY_ACQUISITION_METRIC_DEFINITIONS,
      evaluations: [{ metric_names: ["daily_selected_install_count"], grouping: { acquisition_campaign_state: "known" } }] };
    const input = buildMetricDefinitionsInput(source, "2026-08-06", "2026-08-12T00:00:00.000Z");
    assert.deepEqual(input.metric_evaluations[0].grouping, { metric_date: "2026-08-06", acquisition_campaign_state: "known" });
    assert.equal(input.metric_evaluations[0].privacy_state, "after");
    const explicit = { ...source, evaluations: [{ ...source.evaluations[0], grouping: { metric_date: "2026-08-05", cohort_date: "2026-08-05" } }] };
    assert.deepEqual(buildMetricDefinitionsInput(explicit, "2026-08-06").metric_evaluations[0].grouping,
      { metric_date: "2026-08-05", cohort_date: "2026-08-05" });
    assert.throws(() => buildMetricDefinitionsInput({ ...source, evaluations: [{ ...source.evaluations[0],
      metric_names: ["daily_selected_install_count", "daily_install_count"] }] }, "2026-08-06"), /separate_anchor_evaluation/);
  });
  it("uses the engagement open date and current privacy state without injecting an install cohort", () => {
    const definitions = engagementMetricDefinitions("tutorial_complete");
    const source = { ...config(), metric_definitions: definitions,
      evaluations: [{ metric_names: definitions.map(d => d.metric_name), grouping: { campaign_id: "synthetic-engagement" } }] };
    const first = buildMetricDefinitionsInput(source, "2026-08-21").metric_evaluations[0];
    assert.deepEqual(first.grouping, { campaign_id: "synthetic-engagement", metric_date: "2026-08-21" });
    assert.equal(first.privacy_state, "after");
    assert.equal(first.input_received_at_watermark, "2026-08-23T00:00:00.000Z");
    const declared = { ...source, evaluations: [{ ...source.evaluations[0], grouping: { metric_date: "2026-08-20" } }] };
    const backfill = buildMetricDefinitionsInput(declared, "2026-08-21", "2026-08-25T00:00:00.000Z").metric_evaluations[0];
    assert.equal(backfill.grouping.metric_date, "2026-08-20");
    assert.equal(backfill.input_received_at_watermark, "2026-08-25T00:00:00.000Z");
    assert.throws(() => buildMetricDefinitionsInput({ ...source, evaluations: [{ ...source.evaluations[0], grouping: { cohort_date: "2026-08-21" } }] }, "2026-08-21"), /separate_anchor_evaluation/);
    assert.throws(() => buildMetricDefinitionsInput({ ...source, evaluations: [{ ...source.evaluations[0], metric_names: [...source.evaluations[0].metric_names, "d7_roas"] }] }, "2026-08-21"), /separate_anchor_evaluation/);
  });
  it("keeps the legacy next-day watermark and date default", () => {
    const input = buildMetricDefinitionsInput(config(), "2026-08-01");
    assert.equal(input.metric_evaluations[0].input_received_at_watermark, "2026-08-02T00:00:00.000Z");
    assert.equal(input.metric_evaluations[0].computed_at, "2026-08-02T00:00:00.000Z");
    assert.equal(input.metric_evaluations[0].grouping.cohort_date, "2026-08-01");
    assert.equal(input.metric_evaluations[0].privacy_state, "before");
  });

  it("uses current privacy state for operational selected-acquisition definitions", () => {
    for (const name of ["synthetic-selected-acquisition", "synthetic-selected-commerce"]) {
      const example = JSON.parse(readFileSync(`examples/metrics/${name}.json`, "utf8"));
      const input = buildMetricDefinitionsInput(example, "2026-08-06", "2026-08-12T00:00:00.000Z");
      assert.equal(input.metric_evaluations[0].privacy_state, "after");
      assert.deepEqual(input.metric_definitions, example.metric_definitions);
    }
  });

  it("uses an explicit watermark and preserves a declared cohort date", () => {
    const input = buildMetricDefinitionsInput(
      config({ cohort_date: "2026-07-01" }),
      "2026-08-01",
      "2026-08-21T12:00:00.000Z",
    );
    assert.equal(input.metric_evaluations[0].input_received_at_watermark, "2026-08-21T12:00:00.000Z");
    assert.equal(input.metric_evaluations[0].grouping.cohort_date, "2026-07-01");
  });

  it("rejects a non-canonical watermark", () => {
    assert.throws(
      () => buildMetricDefinitionsInput(config(), "2026-08-01", "2026-08-21T12:00:00Z"),
      /--watermark must be a canonical UTC ISO8601 timestamp/,
    );
  });
});
