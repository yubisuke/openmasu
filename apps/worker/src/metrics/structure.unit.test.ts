import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Pool, PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { replayPrivacyMetricItem } from "@openmasu/runtime";
import { buildScheduledMetricInput } from "../metric-schedule-worker.js";
import { buildMetricDefinitionsInput } from "./run.js";
import { computeSqlMetricRuns, computeSqlMetricRunsWithClient } from "./cohort.js";
import { metricScopeForInput, prepareMetricCalculation } from "./input.js";
import { metricReplayArtifact } from "./persistence.js";
import { scanSnapshotRecords, snapshotRecordFromRow } from "./snapshot.js";
import type { MetricCalculationInput, MetricClient, MetricEvaluation, MetricScope } from "./model.js";

const fixture: MetricCalculationInput = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
const scope: MetricScope = { tenant_id: "tenant-synthetic", app_id: "app-synthetic" };
const evaluation = fixture.metric_evaluations![0];
const definition = fixture.metric_definitions!.find(value => value.metric_name === "cohort_install_count")!;
const watermark = "2026-08-09T00:00:00.000Z";
const day = "2026-08-01";

function queryDouble(answer: (text: string, values: readonly unknown[]) => unknown = () => ({ rows: [], rowCount: 0 })) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return answer(text, values);
    },
  } as unknown as MetricClient;
  return { client, calls };
}

describe("SQL metric application boundaries", () => {
  it("metric_entrypoints_share_replay_contract", async () => {
    const config = { ...scope, fx_policy: fixture.fx_policy, metric_definitions: [definition],
      evaluations: [{ metric_names: [definition.metric_name], grouping: evaluation.grouping }] };
    const cli = prepareMetricCalculation(buildMetricDefinitionsInput(config, day, watermark));
    const scheduledDefinition = { ...config,
      evaluations: [{ ...config.evaluations[0], date_dimension: "cohort_date" }] };
    const digest = sha256(scheduledDefinition);
    const schedule = prepareMetricCalculation(buildScheduledMetricInput({
      ...scope, metric_schedule_id: "schedule-synthetic", lag_days: 1, start_date: day,
      definition: scheduledDefinition, definition_digest: digest,
    }, { targetDate: day, watermark, definitionDigest: digest }));
    const savedEvaluation: MetricEvaluation = { ...cli.evaluations[0], preserved_metadata: "synthetic-extra" };
    const replay = metricReplayArtifact({ metric_run_id: "source-synthetic", metric_name: definition.metric_name },
      definition, savedEvaluation, fixture.fx_policy);
    const saved = prepareMetricCalculation({ fx_policy: replay.fx_policy, metric_definitions: [replay.metric_definition],
      metric_evaluations: [replay.evaluation] });

    const meaning = (input: ReturnType<typeof prepareMetricCalculation>) => ({
      definition: input.definitions.get(definition.metric_name), fx: input.fxPolicy,
      grouping: input.evaluations[0].grouping, watermark: input.evaluations[0].input_received_at_watermark,
    });
    assert.deepEqual(meaning(schedule), meaning(cli));
    assert.deepEqual(meaning(saved), meaning(cli));
    assert.equal(saved.evaluations[0].preserved_metadata, "synthetic-extra");
    assert.notEqual(schedule.evaluations[0].metric_run_id_prefix, cli.evaluations[0].metric_run_id_prefix);

    const { client, calls } = queryDouble(text => ({
      rows: text.includes("FROM control.metric_replay_manifests") ? [{ artifact: replay }] : [], rowCount: 0,
    }));
    const result = await replayPrivacyMetricItem(client as PoolClient, {
      ...scope, recalculation_id: "recalculation-synthetic", source_metric_run_id: replay.source_metric_run_id,
      replay_digest: sha256(replay), privacy_request_id: "privacy-synthetic", completed_at: "2026-08-25T00:00:00.000Z",
    }, async (sameClient, calculation) => {
      assert.equal(sameClient, client);
      assert.deepEqual(calculation.scope, scope);
      const corrected = prepareMetricCalculation(calculation.input);
      assert.deepEqual(meaning(corrected), meaning(cli));
      assert.equal(corrected.evaluations[0].privacy_state, "after");
      assert.equal(corrected.evaluations[0].data_freshness, "recalculated");
      assert.equal(corrected.evaluations[0].preserved_metadata, "synthetic-extra");
      return [{ metric_run_id: `${corrected.evaluations[0].metric_run_id_prefix}:${definition.metric_name}`,
        supersedes_metric_run_id: replay.source_metric_run_id, data_freshness: "recalculated",
        input_received_at_watermark: watermark }];
    });
    assert.match(result!, /^privacy-recalc:/);
    assert.ok(calls.every(call => !/BEGIN|COMMIT|ROLLBACK/.test(call.text)));
  });

  it("keeps legacy input admission and exact tenant/app scope inference", () => {
    assert.deepEqual(metricScopeForInput({ server_context: scope, records: [{}] }), scope);
    assert.deepEqual(metricScopeForInput({ batches: [{ server_context: scope, records: [{}, {}] }] }), scope);
    assert.throws(() => metricScopeForInput({ records: [] }), /exactly one tenant\/app scope/);
    assert.throws(() => metricScopeForInput({ batches: [
      { server_context: scope, records: [{}] },
      { server_context: { ...scope, app_id: "other-synthetic" }, records: [{}] },
    ] }), /exactly one tenant\/app scope/);
    assert.equal(prepareMetricCalculation(fixture).evaluations, fixture.metric_evaluations);
    assert.throws(() => prepareMetricCalculation({ ...fixture, fx_policy: { ...fixture.fx_policy, rates: [] } }),
      /exactly one structured FX rate/);
  });

  it("uses one caller-owned client without a nested transaction", async () => {
    const { client, calls } = queryDouble();
    assert.deepEqual(await computeSqlMetricRunsWithClient(client, { ...fixture, metric_evaluations: [] }, false, scope), []);
    assert.deepEqual(calls, []);
  });

  it("commits once and releases the pool client through the compatibility facade", async () => {
    const { client, calls } = queryDouble();
    let released = 0, connected = 0;
    const pool = { connect: async () => { connected += 1; return { ...client, release: () => { released += 1; } }; } } as unknown as Pool;
    assert.deepEqual(await computeSqlMetricRuns(pool, { ...fixture, metric_evaluations: [] }, false, scope), []);
    assert.equal(connected, 1); assert.equal(released, 1);
    assert.deepEqual(calls.map(call => call.text), [
      "BEGIN ISOLATION LEVEL REPEATABLE READ", "SELECT set_config('openmasu.tenant_id', $1, true)", "COMMIT",
    ]);
    assert.deepEqual(calls[1].values, [scope.tenant_id]);
  });

  it("closes a failed snapshot cursor and rolls back without publishing an artifact", async () => {
    const failure = new Error("synthetic snapshot failure");
    const { client, calls } = queryDouble(text => {
      if (text.startsWith("FETCH")) throw failure;
      return { rows: [], rowCount: 0 };
    });
    let released = 0;
    const pool = { connect: async () => ({ ...client, release: () => { released += 1; } }) } as unknown as Pool;
    await assert.rejects(computeSqlMetricRuns(pool, fixture, true, scope), error => error === failure);
    assert.equal(released, 1);
    assert.ok(calls.some(call => call.text === "CLOSE m1b_snapshot_records"));
    assert.equal(calls.at(-1)?.text, "ROLLBACK");
    assert.ok(calls.every(call => !/INSERT INTO|COMMIT/.test(call.text)));
  });

  it("maps snapshot rows explicitly while hashing policy evidence in the original order", async () => {
    const row = { ...scope, record_id: "record-synthetic", received_at: watermark,
      lifecycle_status: "redacted" as const, privacy_request_id: "privacy-synthetic", policy_digest: "a".repeat(64) };
    assert.deepEqual(snapshotRecordFromRow(row), {
      ...scope, record_id: row.record_id, received_at: watermark,
      lifecycle_status: "redacted", privacy_request_id: row.privacy_request_id,
    });
    let fetches = 0;
    const { client } = queryDouble(text => ({
      rows: text.startsWith("FETCH") && fetches++ === 0 ? [row] : [], rowCount: 0,
    }));
    const snapshot = await scanSnapshotRecords(client, scope, watermark, "after");
    assert.equal(snapshot.finish([]), sha256([[watermark, row.record_id, "redacted", row.policy_digest]]));
    const cost = ["cost", watermark, "cost-synthetic", "b".repeat(64), "c".repeat(64)];
    assert.equal(snapshot.finish([cost]), sha256([[watermark, row.record_id, "redacted", row.policy_digest], cost]));
    assert.equal(fetches, 2);
    assert.ok(!("policy_digest" in snapshot.records[0]));
  });
});
