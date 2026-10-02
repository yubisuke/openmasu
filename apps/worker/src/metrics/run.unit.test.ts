import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildMetricDefinitionsInput } from "./run.js";

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
