import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { DISJOINT_COST_METRIC_DEFINITIONS } from "@openmasu/contracts";
import { jcs, type CandidateAttempt } from "@openmasu/attribution-core";
import { createAppPool, createReaderPool, createSeedPool, withTenant } from "@openmasu/runtime";
import { ingestFixture, ingestRuntimeBatch } from "./ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { requestMetricRecalculation, listMetricRecalculations } from "../../api/src/metric-recalculations.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { metricReport } from "../../api/src/reporting.js";

type Any = Record<string, any>;
describe("bounded late revenue and commerce recalculation", { concurrency: false }, () => {
  const app = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
  let input: Any, initial: Any, old: Any[], identity: { tenantId: string; appId: string; keyId: string; role: "admin" };
  let history: CandidateAttempt[];
  const first = "2026-08-13T00:00:00.000Z", second = "2026-08-14T00:00:00.000Z";
  beforeEach(async () => {
    const tenantId = `tenant-late-${randomBytes(5).toString("hex")}`;
    identity = { tenantId, appId: "app-a", keyId: "synthetic-late", role: "admin" };
    input = JSON.parse(readFileSync("fixtures/v0.4/60-selected-commerce/input.json", "utf8").replaceAll('"tenant-a"', JSON.stringify(tenantId)));
    input.metric_definitions.push(structuredClone(DISJOINT_COST_METRIC_DEFINITIONS[0]));
    input.metric_evaluations[0].metric_names = ["d30_total_net_roas", "d0_roas"];
    input.metric_evaluations[0].metric_run_id_prefix = "synthetic-late-original";
    input.metric_evaluations[0].privacy_state = "after";
    initial = structuredClone(input);
    initial.records = [initial.records[0], initial.records[1], initial.records[3]];
    initial.metric_evaluations = [];
    await ingestFixture(`synthetic-late-${tenantId}`, initial, app, seed);
    old = await computeSqlMetricRuns(app, { ...initial, metric_evaluations: input.metric_evaluations }, true);
    await computeSqlMetricRuns(app, { ...initial, metric_evaluations: [{ ...input.metric_evaluations[0],
      metric_run_id_prefix: "synthetic-late-unrelated", grouping: { ...input.metric_evaluations[0].grouping, campaign_id: "synthetic-unrelated" } }] }, true);
    history = initial.records.map((record: Any) => ({ server: initial.server_context, record, batch_id: "synthetic-initial" }));
  });
  after(async () => { await Promise.all([app.end(), reader.end(), seed.end()]); });
  async function admit(record: Any, receivedAt: string) {
    const attempt: CandidateAttempt = { server: { ...input.server_context, received_at: receivedAt },
      record: { ...structuredClone(record), received_at: receivedAt }, batch_id: `synthetic-late-${record.record_id}` };
    const result = await ingestRuntimeBatch([attempt], app, history);
    assert.equal(result.rejections.length, 0);
    history.push(attempt);
    return attempt;
  }
  function request(ids: string[], watermark = first) {
    return { trigger_kind: "late_events", source_record_ids: ids, date_from: "2026-08-06", date_to: "2026-08-06", watermark };
  }
  const statuses = () => listMetricRecalculations(reader, identity);
  const saved = () => withTenant(app, identity.tenantId, async client => (await client.query<{ artifact: Any }>(
    "SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id", [identity.tenantId, identity.appId],
  )).rows.map(row => row.artifact));

  it("connects late ad revenue then refund to selected campaign ROAS with immutable history and the saved definitions", async () => {
    assert.equal(old.find(r => r.metric_name === "d30_total_net_roas")?.value_unscaled, "1000000");
    await admit(input.records[2], first);
    const { source_record_ids: _ids, ...range } = request([]);
    const firstJob = await requestMetricRecalculation(app, identity, { ...range,
      source_received_from: input.metric_evaluations[0].input_received_at_watermark, source_received_to: first });
    assert.equal(firstJob.selected_runs, 2);
    const pending = await metricReport(reader, identity, { tenantId: identity.tenantId, appId: identity.appId, limit: 100, supersession: "all" });
    assert.equal(pending.data.find(r => r.metric_run_id === old[0].metric_run_id)?.late_input_update_state, "recalculation_pending");
    assert.notEqual(pending.data.find(r => r.metric_run_id === old[0].metric_run_id)?.cost_update_state, "recalculation_pending");
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 2);
    const firstRuns = (await saved()).filter(r => r.supersedes_metric_run_id);
    assert.equal(firstRuns.find(r => r.metric_name === "d30_total_net_roas")?.value_unscaled, "3000000");
    assert.equal(firstRuns.find(r => r.metric_name === "d0_roas")?.value_unscaled, "2000000");
    await admit(input.records[4], second);
    const secondJob = await requestMetricRecalculation(app, identity, request([input.records[4].record_id], second));
    assert.equal(secondJob.selected_runs, 1);
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 1);
    const all = await saved(), final = all.find(r => r.supersedes_metric_run_id === firstRuns.find(r => r.metric_name === "d30_total_net_roas")!.metric_run_id)!;
    assert.equal(final.value_unscaled, "2600000");
    for (const original of old) assert.equal(jcs(all.find(r => r.metric_run_id === original.metric_run_id)), jcs(original));
    assert.notEqual(final.input_snapshot_id, old[0].input_snapshot_id);
    assert.equal(final.rule_bundle_hash, old.find(r => r.metric_name === "d30_total_net_roas")?.rule_bundle_hash);
    assert.doesNotMatch(JSON.stringify(await statuses()), /transaction_id|installation_id|source_record_ids|source_records|payload_sha256|raw_payload|replay_digest|lease_token/);
  });

  it("excludes future receipt, outside-window and unrelated inputs and deduplicates retry and concurrent workers", async () => {
    const revenue = await admit(input.records[2], first);
    const outside = { ...input.records[2], record_id: "synthetic-outside", delivery_id: "synthetic-outside",
      event_id: "synthetic-outside", occurred_at: "2026-09-07T00:00:00.000Z",
      payload: { ...input.records[2].payload, impression_id: "synthetic-outside" } };
    await admit(outside, first);
    const future = { ...input.records[2], record_id: "synthetic-future", delivery_id: "synthetic-future",
      event_id: "synthetic-future", payload: { ...input.records[2].payload, impression_id: "synthetic-future" } };
    await admit(future, second);
    const ignored = await requestMetricRecalculation(app, identity, request([outside.record_id, future.record_id]));
    assert.equal(ignored.selected_runs, 0); assert.equal(ignored.selection_status, "no_matching_runs");
    assert.equal(ignored.input_status_counts?.after_watermark, 1);
    await ingestRuntimeBatch([{ ...revenue, record: { ...revenue.record, delivery_id: "synthetic-retry" } }], app, history);
    const body = request([revenue.record.record_id, revenue.record.record_id]);
    const job = await requestMetricRecalculation(app, identity, body);
    assert.equal((await requestMetricRecalculation(app, identity, request([revenue.record.record_id]))).recalculation_id, job.recalculation_id);
    await withTenant(app, identity.tenantId, client => client.query(`UPDATE control.metric_recalculation_items SET state='processing',attempts=1,
      lease_token='01800000-0000-7000-8000-000000000000',lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE recalculation_id=$1`, [job.recalculation_id]));
    const outcomes = await Promise.all([processMetricRecalculations(app, identity.tenantId), processMetricRecalculations(app, identity.tenantId)]);
    assert.equal(outcomes.reduce((count, row) => count + row.completed, 0), 2);
    assert.equal((await saved()).find(r => r.supersedes_metric_run_id && r.metric_name === "d30_total_net_roas")?.value_unscaled, "3000000");
    assert.equal((await requestMetricRecalculation(app, identity, body)).replayed, true);
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 0);
  });

  it("refuses cross-scope sources and reports privacy removal before selection or publication without resurrection", async () => {
    await admit(input.records[2], first);
    const body = request([input.records[2].record_id]);
    await assert.rejects(requestMetricRecalculation(app, { ...identity, tenantId: "tenant-unrelated" }, body), /metric_revision_not_found/);
    await assert.rejects(requestMetricRecalculation(app, { ...identity, appId: "app-unrelated" }, body), /metric_revision_not_found/);
    await requestMetricRecalculation(app, identity, body);
    await withTenant(app, identity.tenantId, client => client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id)
      VALUES ($1,$2,$3,'redacted',$4,'privacy:synthetic-late')`, [identity.tenantId, identity.appId, input.records[2].record_id, second]));
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 0);
    assert.ok((await statuses()).every(row => row.state === "unavailable" && row.safe_reason === "input_unavailable"));
    const afterPrivacy = await requestMetricRecalculation(app, identity, request([input.records[2].record_id], second));
    assert.equal(afterPrivacy.selected_runs, 0); assert.equal(afterPrivacy.selection_status, "no_eligible_inputs");
    assert.equal(afterPrivacy.input_status_counts?.unavailable, 1);
    assert.equal((await saved()).filter(row => row.supersedes_metric_run_id).length, 0);
  });

  it("selects late settled purchases but not pending amounts or advertising-only ROAS", async () => {
    const purchase = { ...input.records[3], record_id: "synthetic-late-purchase", delivery_id: "synthetic-late-purchase",
      event_id: "synthetic-late-purchase", payload: { ...input.records[3].payload,
        transaction_id: "synthetic-late-purchase", original_transaction_id: "synthetic-late-original", amount_unscaled: "5000000" } };
    const pending = { ...purchase, record_id: "synthetic-pending", delivery_id: "synthetic-pending", event_id: "synthetic-pending",
      payload: { ...purchase.payload, transaction_id: "synthetic-pending", financial_status: "pending" } };
    await admit(purchase, first); await admit(pending, first);
    const job = await requestMetricRecalculation(app, identity, request([purchase.record_id, pending.record_id]));
    assert.equal(job.selected_runs, 1); assert.equal(job.input_status_counts?.non_contributing, 1);
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 1);
    const replacement = (await saved()).find(row => row.supersedes_metric_run_id)!;
    assert.equal(replacement.metric_name, "d30_total_net_roas"); assert.equal(replacement.value_unscaled, "1500000");
  });

  it("makes concurrent revision conflicts, missing replay and candidate overflow explicit without partial jobs", async () => {
    await admit(input.records[2], first);
    await requestMetricRecalculation(app, identity, request([input.records[2].record_id]));
    const conflict = await requestMetricRecalculation(app, identity, request([input.records[2].record_id], second));
    assert.equal(conflict.selected_runs, 2);
    assert.ok((await statuses()).filter(row => row.recalculation_id === conflict.recalculation_id).every(row => row.safe_reason === "already_pending"));
    // Seed an old saved run with no private replay, without mutating any original run.
    await withTenant(app, identity.tenantId, async client => {
      const source = old.find(row => row.metric_name === "d0_roas")!;
      const { persistMetricRun } = await import("./metrics/cohort.js");
      await persistMetricRun(client, { tenant_id: identity.tenantId, app_id: identity.appId }, { ...source, metric_run_id: "synthetic-no-replay" });
      await persistMetricRun(client, { tenant_id: identity.tenantId, app_id: identity.appId }, { ...source, metric_run_id: "synthetic-unsupported" });
      const replay = { version: 1, source_metric_run_id: "synthetic-unsupported",
        metric_definition: input.metric_definitions.find((row: Any) => row.definition.numerator === "purchase_net_revenue"),
        evaluation: input.metric_evaluations[0], fx_policy: input.fx_policy };
      await client.query(`INSERT INTO control.metric_replay_manifests
        (metric_replay_manifest_id,tenant_id,app_id,source_metric_run_id,created_at,artifact)
        VALUES ('synthetic-unsupported-manifest',$1,$2,'synthetic-unsupported',$3,$4::jsonb)`,
      [identity.tenantId, identity.appId, first, JSON.stringify(replay)]);
    });
    const missing = await requestMetricRecalculation(app, identity, request([input.records[2].record_id], "2026-08-15T00:00:00.000Z"));
    assert.equal((await statuses()).find(row => row.recalculation_id === missing.recalculation_id && row.source_metric_run_id === "synthetic-no-replay")?.safe_reason, "replay_unavailable");
    assert.equal((await statuses()).find(row => row.recalculation_id === missing.recalculation_id && row.source_metric_run_id === "synthetic-unsupported")?.safe_reason, "unsupported_definition");
    await withTenant(app, identity.tenantId, async client => {
      const { persistMetricRun } = await import("./metrics/cohort.js");
      for (let index = 0; index < 101; index++) await persistMetricRun(client, { tenant_id: identity.tenantId, app_id: identity.appId },
        { ...old[0], metric_run_id: `synthetic-overflow-${index}` });
    });
    const before = jcs(await statuses());
    await assert.rejects(requestMetricRecalculation(app, identity, request([input.records[2].record_id], "2026-08-16T00:00:00.000Z")), /metric_recalculation_selection_limit/);
    assert.equal(jcs(await statuses()), before);
  });

  it("does not reinterpret removed historical acquisition evidence as a valid empty cohort", async () => {
    await admit(input.records[2], first);
    await withTenant(app, identity.tenantId, client => client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id)
      VALUES ($1,$2,'click-1','redacted',$3,'privacy:synthetic-history')`, [identity.tenantId, identity.appId, first]));
    await requestMetricRecalculation(app, identity, request([input.records[2].record_id]));
    assert.ok((await statuses()).every(row => row.state === "unavailable" && row.safe_reason === "input_unavailable"));
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 0);
    assert.equal((await saved()).filter(row => row.supersedes_metric_run_id).length, 0);
  });
});
