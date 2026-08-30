import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { metricScheduleTargetDate, normalizeMetricScheduleRequest } from "./metric-schedules.js";

const body = {
  lag_days: 2,
  start_date: "2026-08-01",
  fx_policy: {
    policy_version: "synthetic-scheduled-fx-v1",
    target_currency: "USD",
    target_scale: 6,
    rounding_mode: "half_even",
    rates: [{
      currency: "USD", rate_unscaled: "100000000", rate_scale: 8,
      source: "synthetic-scheduled-rate", as_of: "2026-08-01T00:00:00.000Z",
    }],
  },
  evaluations: [{
    metric_names: ["retention_d1", "d0_roas"],
    date_dimension: "cohort_date",
    grouping: { campaign_id: "synthetic-campaign", country: "JP", attribution_status: "non_organic" },
  }],
};

describe("scheduled metric configuration", () => {
  it("normalizes a daily UTC schedule and hashes the normalized definition", () => {
    const normalized = normalizeMetricScheduleRequest(body, new Date("2026-08-10T12:34:56.000Z"));
    assert.equal(normalized.lagDays, 2);
    assert.equal(normalized.startDate, "2026-08-01");
    assert.deepEqual(normalized.definition.evaluations[0].metric_names, ["d0_roas", "retention_d1"]);
    assert.match(normalized.definitionDigest, /^[a-f0-9]{64}$/);
    assert.equal(metricScheduleTargetDate(new Date("2026-08-10T23:59:59.999Z"), 2), "2026-08-08");
  });

  it("rejects static dates, identifying dimensions, malformed groupings, and future starts", () => {
    assert.throws(() => normalizeMetricScheduleRequest({
      ...body,
      evaluations: [{ ...body.evaluations[0], grouping: { cohort_date: "2026-08-01" } }],
    }, new Date("2026-08-10T00:00:00.000Z")), /grouping_dimension_invalid/);
    assert.throws(() => normalizeMetricScheduleRequest({
      ...body,
      evaluations: [{ ...body.evaluations[0], grouping: { installation_id: "synthetic-installation" } }],
    }, new Date("2026-08-10T00:00:00.000Z")), /grouping_dimension_invalid/);
    assert.throws(() => normalizeMetricScheduleRequest({ ...body, start_date: "2026-08-09" },
      new Date("2026-08-10T00:00:00.000Z")), /start_date_in_future/);
    assert.throws(() => normalizeMetricScheduleRequest({ ...body, lag_days: 0 },
      new Date("2026-08-10T00:00:00.000Z")), /lag_days_invalid/);
    assert.throws(() => normalizeMetricScheduleRequest({ ...body, lag_days: "2" },
      new Date("2026-08-10T00:00:00.000Z")), /lag_days_invalid/);
    assert.throws(() => normalizeMetricScheduleRequest({
      ...body,
      fx_policy: { ...body.fx_policy, rounding_mode: "half_up" },
    }, new Date("2026-08-10T00:00:00.000Z")), /fx_policy_invalid/);
    assert.throws(() => normalizeMetricScheduleRequest({
      ...body,
      metric_definitions: [{ metric_name: "bad name" }],
    }, new Date("2026-08-10T00:00:00.000Z")), /definitions_invalid/);
    assert.throws(() => normalizeMetricScheduleRequest({
      ...body,
      metric_definitions: [{ metric_name: "synthetic_metric" }],
    }, new Date("2026-08-10T00:00:00.000Z")), /definitions_invalid/);
    assert.throws(() => normalizeMetricScheduleRequest({
      ...body,
      fx_policy: { ...body.fx_policy, unexpected: true },
    }, new Date("2026-08-10T00:00:00.000Z")), /fx_policy_invalid/);
  });
});
