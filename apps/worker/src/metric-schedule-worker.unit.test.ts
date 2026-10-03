import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Jcs } from "@openmasu/fraud-rules";
import { buildScheduledMetricInput, scheduledMetricBoundary } from "./metric-schedule-worker.js";
import { metricReplayArtifact } from "./metrics/persistence.js";
import { M1B_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";

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
  it("keeps discovered campaign identities stable under retry and distinct from manual totals", () => {
    const value = schedule("cohort_date") as any;
    value.definition.evaluations[0].campaign_discovery = { policy: "selected_acquisition_and_cost_v1", max_targets: 10 };
    value.definition_digest = sha256Jcs(value.definition);
    const targets = ["synthetic-a", "synthetic-b"].map(campaign_id => ({ evaluation: 0,
      grouping: { campaign_id, network: "synthetic-network", attribution_status: "non_organic" } }));
    const pending = { targetDate: "2026-08-01", watermark: "2026-08-10T00:00:00.000Z", definitionDigest: value.definition_digest,
      targetSet: { targets, target_digest: sha256Jcs(targets), privacy_epoch: "0", counts: {}, selection_state: "ready" as const } };
    const input = buildScheduledMetricInput(value, pending);
    assert.equal(input.metric_evaluations.length, 2);
    assert.notEqual(input.metric_evaluations[0].metric_run_id_prefix, input.metric_evaluations[1].metric_run_id_prefix);
    assert.deepEqual(buildScheduledMetricInput(value, pending), input);
    assert.throws(() => buildScheduledMetricInput(value, { ...pending, targetSet: undefined }), /target_mismatch/);
    assert.throws(() => buildScheduledMetricInput(value, { ...pending, targetSet: { ...pending.targetSet, target_digest: "0".repeat(64) } }), /target_mismatch/);
  });
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
    assert.equal(cohort.metric_evaluations[0].metric_run_id_prefix, `scheduled:${sha256Jcs({
      metric_schedule_id: schedule("cohort_date").metric_schedule_id, target_date: pending.targetDate,
      watermark: pending.watermark, definition_digest: pending.definitionDigest, evaluation: 0,
    }).slice(0, 48)}`, "the pre-series scheduled identity remains byte-identical");
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

  it("binds handoffs to the exact target and grouping and strips them from later replay manifests", () => {
    const value = schedule("cohort_date");
    const source = { metric_schedule_id: "metric-schedule:old", target_date: "2026-08-01", evaluation: 0,
      definition_digest: value.definition_digest, source_metric_run_id: "scheduled:old:cohort_install_count",
      calculation_key_digest: "a".repeat(64), metric_name: "cohort_install_count",
      grouping: { cohort_date: "2026-08-01", country: "JP" } };
    const replacement = { source_metric_schedule_id: "metric-schedule:old", mode: "same_meaning" as const,
      request_digest: "b".repeat(64), preview_digest: "c".repeat(64), in_flight_policy: "wait_for_claimed_date" as const,
      supersessions: [source] };
    const pending = { targetDate: "2026-08-01", watermark: "2026-08-10T00:00:00.000Z", definitionDigest: value.definition_digest };
    const evaluation = buildScheduledMetricInput({ ...value, replacement }, pending).metric_evaluations[0];
    assert.deepEqual(evaluation.schedule_supersessions, { cohort_install_count: source });
    const manifest = metricReplayArtifact({ metric_run_id: "scheduled:new:cohort_install_count", metric_name: "cohort_install_count" },
      M1B_METRIC_DEFINITIONS.find(row => row.metric_name === "cohort_install_count")!, evaluation, fxPolicy as any);
    assert.equal(manifest.evaluation.schedule_supersessions, undefined);
    assert.equal(manifest.evaluation.metric_schedule?.metric_schedule_id, value.metric_schedule_id);
    assert.throws(() => buildScheduledMetricInput({ ...value, replacement: { ...replacement, supersessions: [{ ...source, grouping: { country: "US" } }] } }, pending), /target_mismatch/);
  });
});
