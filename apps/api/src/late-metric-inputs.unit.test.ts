import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import type { PoolClient } from "pg";
import { engagementMetricDefinitions, engagementPolicyMetricDefinitions } from "@openmasu/contracts/definitions";
import { engagementInputMatches, selectLateMetricInputs, supportsEngagementMetric, type EngagementCorrectionInput } from "@openmasu/runtime";
import { supportsLateMetric } from "./late-metric-inputs.js";

it("restricts late-input selection to saved install-cohort revenue LTV and ROAS definitions without rewriting their profiles", () => {
  for (const fixture of ["33-stage-b-cohort-metrics", "58-selected-native-acquisition", "59-disjoint-cost-grains", "60-selected-commerce", "62-explicit-refund-reversal"]) {
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

const scope = { tenantId: "tenant-synthetic-engagement", appId: "app-synthetic-engagement" };
const replayFor = (definition: unknown) => ({ version: 1, metric_definition: definition, fx_policy: {},
  evaluation: { grouping: { metric_date: "2026-08-10", campaign_id: "synthetic-campaign-a" } } });

it("admits only the two closed saved engagement profiles with an explicit open date and optional campaign", () => {
  const definitions = [...engagementMetricDefinitions("complete"),
    ...engagementPolicyMetricDefinitions({ windowDays: 3, minimumInactivityDays: 7, eventKey: "complete" })];
  for (const definition of definitions) {
    const replay = replayFor(definition);
    assert.equal(supportsEngagementMetric(replay), true); assert.equal(supportsLateMetric(replay), true);
    assert.equal(supportsEngagementMetric({ ...replay, evaluation: { grouping: { metric_date: "2026-08-10" } } }), true);
    for (const grouping of [{}, { cohort_date: "2026-08-10" }, { metric_date: "2026-02-30" },
      { metric_date: "2026-08-10", country: "US" }, { metric_date: "2026-08-10", campaign_id: "" }]) {
      assert.equal(supportsEngagementMetric({ ...replay, evaluation: { grouping } }), false);
    }
    for (const mutation of [{ rule_bundle_version: "0.4.99" }, { metric_definition_version: "0.4.99" },
      { rule_bundle_id: "metric-synthetic-unknown" }, { anchor_event: "install" }, { rule_bundle_hash: "0".repeat(64) }]) {
      assert.equal(supportsEngagementMetric({ ...replay, metric_definition: { ...definition, ...mutation } }), false);
    }
  }
});

it("selects bounded engagement influence across old and new campaigns without duplicating winner or inactivity calculations", async () => {
  const changes: EngagementCorrectionInput[] = ["session_start", "custom_event", "install", "deep_link_open", "ad_revenue"].map(event_name => ({
    record_id: `synthetic-${event_name}`, event_name, installation_id: "installation:synthetic", producer: "sdk-android",
    occurred_at: "2026-08-09T12:00:00.000Z", event_key: "different_activity_key" }));
  const calls: { text: string; values: any[] }[] = [];
  const client = { query: async (text: string, values: any[]) => {
    calls.push({ text, values }); return { rows: JSON.parse(values[3]).map((event: EngagementCorrectionInput) => ({ record_id: event.record_id })) };
  } } as unknown as PoolClient;
  const definition = engagementPolicyMetricDefinitions({ windowDays: 3, minimumInactivityDays: 7, eventKey: "complete" })[1];
  const ids = await engagementInputMatches(client, scope, replayFor(definition), changes, "2026-08-20T00:00:00.000Z");
  assert.deepEqual(ids, changes.map(row => row.record_id));
  assert.deepEqual(calls[0].values.slice(0, 3), [scope.tenantId, scope.appId, "2026-08-20T00:00:00.000Z"]);
  assert.deepEqual(calls[0].values.slice(4), ["2026-08-10", 3, "revenue", null, 7]);
  assert.doesNotMatch(calls[0].text, /campaign_id|ORDER BY .*opened|LATERAL/);
  assert.match(calls[0].text, /opened\.installation_id=changed\.installation_id/);
  assert.match(calls[0].text, /changed_raw\.received_at<=\$3/);
  assert.match(calls[0].text, /LIMIT 101/);
  assert.ok(!calls[0].text.includes(scope.tenantId));
  const legacy = engagementMetricDefinitions("complete")[1];
  assert.deepEqual(await engagementInputMatches(client, scope, replayFor(legacy), changes, "2026-08-20T00:00:00.000Z"),
    ["synthetic-deep_link_open", "synthetic-ad_revenue"]);
  await assert.rejects(engagementInputMatches(client, scope, replayFor(definition), Array(101).fill(changes[0]),
    "2026-08-20T00:00:00.000Z"), /metric_recalculation_input_limit/);
});

it("uses verified original purchase timing for refund reversals even when cancellation arrives outside the outcome window", async () => {
  const reversal: EngagementCorrectionInput = { record_id: "synthetic-reversal", event_name: "refund",
    installation_id: "installation:synthetic", occurred_at: "2026-09-01T00:00:00.000Z", producer: "adapter:synthetic",
    policy_digest: "verified-commerce-v1", target_producer: "adapter:synthetic", target_policy_digest: "verified-commerce-v1",
    target_occurred_at: "2026-08-10T01:00:00.000Z" };
  let calls = 0;
  const client = { query: async (text: string, values: any[]) => {
    calls++;
    assert.match(text, /CASE WHEN changed\.event_name='refund' THEN changed\.target_occurred_at ELSE changed\.occurred_at END/);
    assert.deepEqual(JSON.parse(values[3]), [reversal]);
    return { rows: [{ record_id: reversal.record_id }] };
  } } as unknown as PoolClient;
  const replay = replayFor(engagementPolicyMetricDefinitions({ windowDays: 3, minimumInactivityDays: 0, eventKey: "complete" })[2]);
  assert.deepEqual(await engagementInputMatches(client, scope, replay, [reversal], "2026-09-02T00:00:00.000Z"), [reversal.record_id]);
  for (const change of [{ producer: "sdk-android" }, { policy_digest: "unverified" },
    { target_producer: "sdk-ios" }, { target_policy_digest: "unverified" }, { target_occurred_at: null }]) {
    assert.deepEqual(await engagementInputMatches(client, scope, replay, [{ ...reversal, ...change }], "2026-09-02T00:00:00.000Z"), []);
  }
  assert.deepEqual(await engagementInputMatches(client, scope, replayFor(engagementMetricDefinitions("complete")[1]),
    [reversal], "2026-09-02T00:00:00.000Z"), []);
  assert.equal(calls, 1);
});

it("captures late SDK activity as protected receipt metadata and keeps source and candidate bounds and privacy refusal", async () => {
  const changes = ["session_start", "deep_link_open", "install"].map(event_name => ({ record_id: `synthetic-${event_name}`,
    event_name, installation_id: "installation:synthetic", occurred_at: "2026-08-09T12:00:00.000Z", producer: "sdk-android",
    payload_sha256: "a".repeat(64), received_at: "2026-08-16T00:00:00.000Z", lifecycle: "available",
    logical_event_id: `logical:synthetic-${event_name}`, target_available: true, financial_status: null, refund_reversal: false,
    event_key: null, policy_digest: "synthetic", target_policy_digest: null, target_producer: null, target_occurred_at: null }));
  const replay = replayFor(engagementPolicyMetricDefinitions({ windowDays: 3, minimumInactivityDays: 7, eventKey: "complete" })[1]);
  const request = { trigger_kind: "late_events" as const, source_record_ids: changes.map(row => row.record_id),
    date_from: "2026-08-10", date_to: "2026-08-10", watermark: "2026-08-20T00:00:00.000Z" };
  let pending = false, unavailable = false, overflow = false, influenceCalls = 0;
  const client = { query: async (text: string, values: any[]) => {
    if (text.includes("AS target_available")) return { rows: changes, rowCount: changes.length };
    if (text.includes("FROM ledger.metric_runs AS mr")) {
      assert.match(text, /THEN mr\.grouping->>'metric_date'/);
      assert.match(text, /ELSE \$8::boolean AND mr\.grouping->>'cohort_date'/);
      assert.equal(values[7], false, "new activity alone must not reinterpret install-cohort selectors");
      const row = { metric_run_id: "synthetic-saved-engagement", replay, watermark: "2026-08-15T00:00:00.000Z",
        pending, evidence_unavailable: unavailable };
      return { rows: overflow ? Array(101).fill(row) : [row] };
    }
    influenceCalls++; return { rows: changes.map(row => ({ record_id: row.record_id })) };
  } } as unknown as PoolClient;
  const selected = await selectLateMetricInputs(client, scope, request);
  assert.equal(selected.rows.length, 1); assert.equal(selected.rows[0].safe_reason, null);
  assert.equal(selected.counts.matched_to_supported_runs, 3);
  assert.deepEqual(selected.records, changes.map(({ record_id, payload_sha256, received_at, event_name }) =>
    ({ record_id, payload_sha256, received_at, event_name })));
  assert.doesNotMatch(JSON.stringify(selected.records), /installation|event_key|policy_digest/);
  pending = true;
  assert.equal((await selectLateMetricInputs(client, scope, request)).rows[0].safe_reason, "already_pending");
  unavailable = true;
  assert.equal((await selectLateMetricInputs(client, scope, request)).rows[0].safe_reason, "input_unavailable");
  assert.equal(influenceCalls, 2, "unavailable source evidence never reaches influence selection");
  overflow = true;
  await assert.rejects(selectLateMetricInputs(client, scope, request), /metric_recalculation_selection_limit/);
});
