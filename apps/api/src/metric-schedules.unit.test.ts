import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ACQUISITION_DETAIL_METRIC_DEFINITIONS, DISJOINT_COST_METRIC_DEFINITIONS, SELECTED_COMMERCE_METRIC_DEFINITIONS, REFUND_REVERSAL_METRIC_DEFINITIONS, customConversionMetricDefinitions } from "@openmasu/contracts";
import { metricScheduleTargetDate, normalizeMetricScheduleRequest } from "./metric-schedules.js";
import { engagementMetricDefinitions } from "@openmasu/contracts";

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
  it("requires explicit engagement definitions open-date grouping and a complete-window lag", () => {
    const request = { ...body, metric_definitions: engagementMetricDefinitions("tutorial_complete"),
      evaluations: [{ metric_names: ["engagement_custom_event_converters_24h", "engagement_ad_revenue_24h_usd"], date_dimension: "metric_date", grouping: {} }] };
    const normalize = (value: any) => normalizeMetricScheduleRequest(value, new Date("2026-08-23T12:00:00.000Z"));
    assert.deepEqual(normalize(request).definition.metric_definitions, request.metric_definitions);
    assert.throws(() => normalize({ ...request, lag_days: 1 }), /engagement_profile_required/);
    assert.throws(() => normalize({ ...request, metric_definitions: [] }), /engagement_profile_required/);
    assert.throws(() => normalize({ ...request, fx_policy: { ...request.fx_policy, target_scale: 3 } }), /engagement_profile_required/);
    for (const change of [{ date_dimension: "cohort_date" }, { grouping: { country: "JP" } },
      { metric_names: ["engagement_ad_revenue_24h_usd", "d7_roas"] },
      { campaign_discovery: { policy: "selected_acquisition_and_cost_v1", max_targets: 10 } }]) {
      assert.throws(() => normalize({ ...request, evaluations: [{ ...request.evaluations[0], ...change }] }), /engagement_profile_required/);
    }
    assert.throws(() => normalize({ ...request, metric_definitions: request.metric_definitions.map(d => ({ ...d, engagement_credit_policy: undefined })) }), /definitions_invalid/);
  });
  it("captures explicit detail definitions and groupings without implicit discovery or legacy upgrade", () => {
    const request = { ...body, metric_definitions: structuredClone(ACQUISITION_DETAIL_METRIC_DEFINITIONS),
      evaluations: [{ metric_names: ["d30_total_net_roas"], date_dimension: "cohort_date",
        grouping: { ad_group_id: "synthetic-group", creative_id: "synthetic-creative" } }] };
    const normalize = (value: any) => normalizeMetricScheduleRequest(value, new Date("2026-08-10T12:00:00.000Z"));
    assert.deepEqual(normalize(request).definition.metric_definitions, request.metric_definitions);
    assert.deepEqual(normalize(request).definition.evaluations[0].grouping, request.evaluations[0].grouping);
    for (const change of [{ acquisition_dimension_policy: undefined }, { rule_bundle_hash: "0".repeat(64) },
      { metric_definition_version: "0.4.15" }]) {
      assert.throws(() => normalize({ ...request, metric_definitions: request.metric_definitions.map(d => ({ ...d, ...change })) }), /definitions_invalid/);
    }
    assert.throws(() => normalize({ ...request, metric_definitions: [] }), /detail_profile_required/);
    assert.throws(() => normalize({ ...request, metric_definitions: REFUND_REVERSAL_METRIC_DEFINITIONS }), /detail_profile_required/);
    assert.throws(() => normalize({ ...request, evaluations: [{ ...request.evaluations[0],
      campaign_discovery: { policy: "selected_acquisition_and_cost_v1", max_targets: 10 } }] }), /discovery_invalid/);
    assert.throws(() => normalize({ ...request, evaluations: [{ ...request.evaluations[0], grouping: { creative_id: "bad identifier" } }] }), /grouping_value_invalid/);
  });
  it("preserves explicit refund cancellation definitions and rejects partial opt-ins", () => {
    const request = { ...body, metric_definitions: structuredClone(REFUND_REVERSAL_METRIC_DEFINITIONS),
      evaluations: [{ metric_names: ["d30_total_net_roas"], date_dimension: "cohort_date", grouping: {} }] };
    const normalize = (value: any) => normalizeMetricScheduleRequest(value, new Date("2026-08-10T12:00:00.000Z"));
    assert.deepEqual(normalize(request).definition.metric_definitions, request.metric_definitions);
    for (const change of [{ refund_reversal_policy: undefined }, { refund_reversal_policy: "guess" },
      { rule_bundle_hash: "0".repeat(64) }, { metric_definition_version: "0.4.13" }]) {
      assert.throws(() => normalize({ ...request, metric_definitions: request.metric_definitions.map(d => ({ ...d, ...change })) }), /definitions_invalid/);
    }
  });
  it("binds a custom outcome key to a complete scheduled definition and refuses partial profiles", () => {
    const request = { ...body, metric_definitions: customConversionMetricDefinitions("tutorial_complete"),
      evaluations: [{ metric_names: ["cohort_custom_event_conversion_rate_d7"], date_dimension: "cohort_date", grouping: {} }] };
    const normalize = (value: any) => normalizeMetricScheduleRequest(value, new Date("2026-08-10T12:00:00.000Z"));
    const original = normalize(request);
    assert.deepEqual(original.definition.metric_definitions, request.metric_definitions);
    assert.notEqual(original.definitionDigest, normalize({ ...request,
      metric_definitions: customConversionMetricDefinitions("different_outcome") }).definitionDigest);
    for (const change of [{ conversion_event_key: undefined }, { conversion_event_key: "" },
      { rule_bundle_hash: "0".repeat(64) }, { acquisition_basis: undefined }, { activity_events: ["custom_event"] },
      { definition: { calculation: "cohort_size", numerator: "cohort_size", window: { type: "elapsed", day: 0 } } }]) {
      assert.throws(() => normalize({ ...request, metric_definitions: request.metric_definitions.map(definition => ({ ...definition, ...change })) }), /definitions_invalid/);
    }
    assert.throws(() => normalize({ ...request, metric_definitions: DISJOINT_COST_METRIC_DEFINITIONS.map(definition => ({
      ...definition, conversion_event_key: "tutorial_complete" })) }), /definitions_invalid/);
  });
  it("opts into bounded campaign discovery without changing manual schedule definitions", () => {
    const manual = normalizeMetricScheduleRequest(body, new Date("2026-08-10T12:00:00.000Z"));
    assert.equal(Object.hasOwn(manual.definition.evaluations[0], "campaign_discovery"), false);
    const request = { ...body, metric_definitions: structuredClone(DISJOINT_COST_METRIC_DEFINITIONS),
      evaluations: [{ metric_names: ["d0_roas"], date_dimension: "cohort_date", grouping: {},
        campaign_discovery: { policy: "selected_acquisition_and_cost_v1", max_targets: 30 } }] };
    const normalize = (value: any) => normalizeMetricScheduleRequest(value, new Date("2026-08-10T12:00:00.000Z"));
    assert.deepEqual(normalize(request), normalize(structuredClone(request)));
    for (const max_targets of [0, 101, 1.5]) assert.throws(() => normalize({ ...request, evaluations: [{
      ...request.evaluations[0], campaign_discovery: { ...request.evaluations[0].campaign_discovery, max_targets } }] }), /discovery_invalid/);
    for (const change of [{ grouping: { campaign_id: "synthetic-fixed" } }, { date_dimension: "metric_date" }, { metric_names: ["unknown_metric"] }]) {
      assert.throws(() => normalize({ ...request, evaluations: [{ ...request.evaluations[0], ...change }] }), /discovery_invalid/);
    }
    assert.throws(() => normalize({ ...request, evaluations: [...request.evaluations, ...request.evaluations] }), /discovery_overlap/);
    assert.throws(() => normalize({ ...request, metric_definitions: [] }), /discovery_invalid/);
  });
  it("preserves selected commerce and its safe cost policy in scheduled definitions", () => {
    const request = { ...body, metric_definitions: structuredClone(SELECTED_COMMERCE_METRIC_DEFINITIONS),
      evaluations: [{ metric_names: ["d30_total_net_roas"], date_dimension: "cohort_date", grouping: {} }] };
    const normalized = normalizeMetricScheduleRequest(request, new Date("2026-08-10T12:00:00.000Z"));
    assert.deepEqual(normalized.definition.metric_definitions, request.metric_definitions);
    request.metric_definitions.find(d => d.metric_name === "d30_total_net_roas")!.rule_bundle_hash = "0".repeat(64);
    assert.throws(() => normalizeMetricScheduleRequest(request, new Date("2026-08-10T12:00:00.000Z")), /definitions_invalid/);
  });
  it("preserves the explicit selected-acquisition basis and rejects mismatched versions", () => {
    const example = JSON.parse(readFileSync("examples/metrics/synthetic-selected-acquisition.json", "utf8"));
    const request = { ...body, metric_definitions: example.metric_definitions };
    const normalized = normalizeMetricScheduleRequest(request, new Date("2026-08-10T12:00:00.000Z"));
    assert.deepEqual(normalized.definition.metric_definitions, example.metric_definitions);
    const mismatch = structuredClone(request);
    mismatch.metric_definitions[0].metric_definition_version = "0.3.0";
    assert.throws(() => normalizeMetricScheduleRequest(mismatch, new Date("2026-08-10T12:00:00.000Z")), /definitions_invalid/);
    const wrongPolicy = structuredClone(request);
    wrongPolicy.metric_definitions[0].rule_bundle_hash = "0".repeat(64);
    assert.throws(() => normalizeMetricScheduleRequest(wrongPolicy, new Date("2026-08-10T12:00:00.000Z")), /definitions_invalid/);
  });

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
