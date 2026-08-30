import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Jcs } from "@openmasu/fraud-rules";
import { buildScheduledMetricInput, scheduledMetricBoundary } from "./metric-schedule-worker.js";

const fxPolicy = {
  policy_version: "synthetic-scheduled-fx-v1",
  target_currency: "USD",
  target_scale: 6,
  rounding_mode: "half_even",
  rates: [{
    currency: "USD",
    rate_unscaled: "100000000",
    rate_scale: 8,
    source: "synthetic-scheduled-rate",
    as_of: "2026-08-01T00:00:00.000Z",
  }],
};

function schedule(dateDimension: "cohort_date" | "metric_date") {
  const definition = {
    fx_policy: fxPolicy,
    metric_definitions: [],
    evaluations: [{
      metric_names: ["cohort_install_count"],
      date_dimension: dateDimension,
      grouping: { country: "JP" },
    }],
  };
  return {
    metric_schedule_id: "metric-schedule:synthetic",
    tenant_id: "tenant-a",
    app_id: "app-a",
    lag_days: 2,
    start_date: "2026-08-01",
    definition,
    definition_digest: sha256Jcs(definition),
  };
}

describe("scheduled metric worker input", () => {
  it("fixes the target date and watermark at the UTC daily boundary", () => {
    assert.deepEqual(scheduledMetricBoundary(new Date("2026-08-10T23:59:59.999Z"), 2), {
      targetDate: "2026-08-08",
      watermark: "2026-08-10T00:00:00.000Z",
    });
  });

  it("injects exactly the selected date dimension and produces deterministic IDs", () => {
    const pending = {
      targetDate: "2026-08-01",
      watermark: "2026-08-10T00:00:00.000Z",
      definitionDigest: schedule("cohort_date").definition_digest,
    };
    const cohort = buildScheduledMetricInput(schedule("cohort_date"), pending);
    assert.deepEqual(cohort.metric_evaluations[0].grouping, { cohort_date: "2026-08-01", country: "JP" });
    assert.match(cohort.metric_evaluations[0].metric_run_id_prefix, /^scheduled:[a-f0-9]{48}$/);
    assert.deepEqual(buildScheduledMetricInput(schedule("cohort_date"), pending), cohort);

    const metricSchedule = schedule("metric_date");
    const metric = buildScheduledMetricInput(metricSchedule, {
      ...pending,
      definitionDigest: metricSchedule.definition_digest,
    });
    assert.deepEqual(metric.metric_evaluations[0].grouping, { country: "JP", metric_date: "2026-08-01" });
    assert.notEqual(metric.metric_evaluations[0].metric_run_id_prefix,
      cohort.metric_evaluations[0].metric_run_id_prefix);
  });

  it("rejects a definition whose immutable digest no longer matches", () => {
    const value = schedule("cohort_date");
    assert.throws(() => buildScheduledMetricInput(value, {
      targetDate: "2026-08-01",
      watermark: "2026-08-10T00:00:00.000Z",
      definitionDigest: "0".repeat(64),
    }), /definition_digest_mismatch/);
  });
});
