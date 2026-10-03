import assert from "node:assert/strict";
import { it } from "node:test";
import type { PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { requestPrivacyMetricRecalculations, replayPrivacyMetricItem, reapplyPrivacyMetricsWithClient, privacyMetricInvalidationSql } from "./privacy-metrics.js";

const replay = { version: 1, source_metric_run_id: "synthetic-original", metric_definition: { metric_name: "cohort_install_count" },
  fx_policy: { policy_version: "synthetic-fixed-fx" }, evaluation: { grouping: { campaign_id: "synthetic-a", cohort_date: "2026-06-01" },
    input_received_at_watermark: "2026-08-02T00:00:00.000Z", metric_run_id_prefix: "synthetic-old", privacy_state: "before" } };
const request = { tenant_id: "tenant-synthetic", app_id: "app-synthetic", privacy_request_id: "privacy:synthetic",
  deletion_scope: "app" as const, requested_at: "2026-08-25T00:00:00.000Z", affected_record_ids: ["synthetic-record"] };

it("privacy_metric_selection_preserves_each_run_identity_without_a_metric_name_list_or_operator_range_cap", async () => {
  const calls: { text: string; values: any[] }[] = [];
  const rows = ["a", "b", "c", "d"].map((id, index) => ({ app_id: request.app_id, metric_run_id: `synthetic-${id}`,
    cohort_date: index < 2 ? "2026-06-01" : "2026-08-21", watermark: replay.evaluation.input_received_at_watermark,
    replay: { ...replay, source_metric_run_id: `synthetic-${id}` } }));
  const client = { query: async (text: string, values: any[]) => {
    calls.push({ text, values }); return { rows: text.startsWith("SELECT run.app_id") ? rows : [], rowCount: 0 };
  } } as unknown as PoolClient;
  await requestPrivacyMetricRecalculations(client, request);
  const selected = calls[0];
  assert.doesNotMatch(selected.text, /metric_name IN|LIMIT|computed_at.*<=/);
  const job = calls.find(call => call.text.includes("INSERT INTO control.metric_recalculation_jobs"))!;
  assert.equal(job.values[4], "2026-06-01"); assert.equal(job.values[5], "2026-08-21");
  assert.deepEqual(calls.filter(call => call.text.includes("INSERT INTO control.metric_recalculation_items")).map(call => call.values[3]),
    ["synthetic-a", "synthetic-b", "synthetic-c", "synthetic-d"]);
});

it("privacy_metric_replay_keeps_saved_grouping_watermark_and_fx_and_requires_an_actual_successor", async () => {
  const client = { query: async (text: string) => ({ rows: text.includes("metric_replay_manifests") ? [{ artifact: replay }] : [], rowCount: 0 }) } as unknown as PoolClient;
  const item = { ...request, recalculation_id: "privacy-recalculation:synthetic", source_metric_run_id: replay.source_metric_run_id,
    replay_digest: sha256(replay), completed_at: "2026-08-25T00:01:00.000Z" };
  const replacement = await replayPrivacyMetricItem(client, item, async (_client, calculation) => {
    assert.equal(_client, client); assert.deepEqual(calculation.scope, { tenant_id: request.tenant_id, app_id: request.app_id });
    const evaluation = calculation.input.metric_evaluations[0];
    assert.deepEqual(evaluation.grouping, replay.evaluation.grouping);
    assert.equal(evaluation.input_received_at_watermark, replay.evaluation.input_received_at_watermark);
    assert.equal(evaluation.privacy_state, "after"); assert.equal(evaluation.data_freshness, "recalculated");
    assert.deepEqual(calculation.input.fx_policy, replay.fx_policy);
    return [{ metric_run_id: `${evaluation.metric_run_id_prefix}:cohort_install_count`, supersedes_metric_run_id: item.source_metric_run_id,
      data_freshness: "recalculated", input_received_at_watermark: evaluation.input_received_at_watermark }];
  });
  assert.match(replacement!, /^privacy-recalc:/);
  await assert.rejects(replayPrivacyMetricItem(client, item, async () => []), /definition_changed/);
  await assert.rejects(replayPrivacyMetricItem(client, { ...item, replay_digest: "0".repeat(64) }, async () => []), /definition_changed/);
});

it("privacy_metric_withdrawal_is_scoped_to_available_saved_evidence_and_never_a_historical_watermark", () => {
  const sql = privacyMetricInvalidationSql("mr");
  assert.match(sql, /privacy_state\.tenant_id=mr\.tenant_id/);
  assert.match(sql, /privacy_state\.app_id=mr\.app_id/);
  assert.match(sql, /lifecycle_status','available'\)='available'/);
  assert.match(sql, /privacy_request_id IS NOT NULL/);
  assert.doesNotMatch(sql, /watermark|now\(/);
});

it("privacy_metric_restore_does_not_mislabel_already_superseded_items_as_unsupported", async () => {
  const client = { query: async (text: string) => ({ rows: text.startsWith("SELECT item.*")
    ? [{ ...request, state: "skipped" }, { ...request, state: "completed" }, { ...request, state: "unavailable" }]
    : [], rowCount: 0 }) } as unknown as PoolClient;
  const result = await reapplyPrivacyMetricsWithClient(client, { ...request, completed_at: request.requested_at },
    async () => { throw new Error("settled items must not be recalculated again"); });
  assert.deepEqual(result, { recalculated: 1, unsupported: 1 });
});
