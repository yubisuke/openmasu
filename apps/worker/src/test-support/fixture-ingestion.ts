import type { Pool } from "pg";
import { jcs, sha256 } from "@openmasu/attribution-core/canonical";
import { compareCandidateAttempts, evaluate, IndexedCandidateProvider, type CandidateAttempt, type CandidateProvider } from "@openmasu/attribution-core";
import { uuidV7, withTenant } from "@openmasu/runtime";
import { retryDeadlockOnce } from "./seed-safety.js";
import { ensureSyntheticDefaultFraudBundle } from "./fraud-bundle-seed.js";
import { inputAttempts, defaultTimestamp, policyDigestForRecord, refundProjectionTargets } from "../ingestion/input.js";
import { storedArtifact, persistRawWithClient, persistDeliveryWithClient, persistLogicalWithClient, persistRejectionWithClient } from "../ingestion/record-repository.js";
import { persistProjectionWithClient } from "../ingestion/fact-projections.js";
import type { Any, Attribution, Correction, Delivery, FraudDecision, LogicalEvent, RawRecord, Rejection } from "../ingestion/model.js";
import { ensureApps, persistCorrection, persistAttribution, persistFraud, persistReconciliation } from "../ingestion/application.js";

export const parityKinds = [
  "raw_records",
  "deliveries",
  "logical_events",
  "corrections",
  "rejections",
  "privacy_requests",
  "privacy_tombstones",
  "attributions",
  "fraud_decisions",
  "metric_runs",
] as const;

export type ParityKind = typeof parityKinds[number];

export const parityLedgerTable: Record<ParityKind, string> = {
  raw_records: "raw_records",
  deliveries: "event_deliveries",
  logical_events: "logical_events",
  corrections: "corrections",
  rejections: "rejections",
  privacy_requests: "privacy_requests",
  privacy_tombstones: "privacy_tombstones",
  attributions: "attribution_results",
  fraud_decisions: "fraud_decisions",
  metric_runs: "metric_runs",
};

export const d0Metrics = new Set([
  "d0_install_to_24h_ad_revenue_usd",
  "d0_utc_install_calendar_ad_revenue_usd",
  "d0_jst_install_calendar_ad_revenue_usd",
]);

export class PostgresCandidateProvider implements CandidateProvider {
  private constructor(
    private readonly fixtureName: string,
    private readonly delegate: IndexedCandidateProvider,
    private readonly stored: readonly CandidateAttempt[],
  ) {}

  static async stageAndLoad(pool: Pool, fixtureName: string, input: Any): Promise<PostgresCandidateProvider> {
    const source = inputAttempts(input);
    await pool.query("DELETE FROM testing.fixture_attempts WHERE fixture_name = $1", [fixtureName]);
    for (const [ordinal, attempt] of source.entries()) {
      await pool.query(
        `INSERT INTO testing.fixture_attempts (
          fixture_name, ordinal, batch_id, tenant_id, app_id, record_id,
          producer, event_id, click_id, server_context, record
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
        [
          fixtureName,
          ordinal,
          attempt.batch_id,
          attempt.server.tenant_id,
          attempt.server.app_id,
          attempt.record.record_id,
          attempt.record.producer,
          attempt.record.event_id,
          attempt.record.event_name === "click" ? attempt.record.payload.click_id : null,
          JSON.stringify(attempt.server),
          JSON.stringify(attempt.record),
        ],
      );
    }
    const rows = await pool.query<{ batch_id: string; server_context: Any; record: Any }>(
      `SELECT batch_id, server_context, record
       FROM testing.fixture_attempts
       WHERE fixture_name = $1
       ORDER BY ordinal`,
      [fixtureName],
    );
    const stored = rows.rows
      .map((row) => ({ server: row.server_context, record: row.record, batch_id: row.batch_id }))
      .sort(compareCandidateAttempts);
    const expected = [...source].sort(compareCandidateAttempts);
    if (jcs(stored) !== jcs(expected)) {
      throw new Error(`${fixtureName} candidate staging changed the canonical delivery input`);
    }
    return new PostgresCandidateProvider(fixtureName, new IndexedCandidateProvider(stored), stored);
  }

  assertEvaluationAttempts(values: readonly CandidateAttempt[]): void {
    if (jcs(values) !== jcs(this.stored)) {
      throw new Error(`${this.fixtureName} evaluator attempts differ from PostgreSQL candidates`);
    }
  }

  all(): readonly CandidateAttempt[] { return this.delegate.all(); }
  byRecordId(recordId: string): readonly CandidateAttempt[] { return this.delegate.byRecordId(recordId); }
  byLogicalScope(attempt: CandidateAttempt): readonly CandidateAttempt[] {
    return this.delegate.byLogicalScope(attempt);
  }
  clickCandidates(tenantId: string, appId: string, clickId: string): readonly CandidateAttempt[] {
    return this.delegate.clickCandidates(tenantId, appId, clickId);
  }
}

export function withoutLifecycleChanges(input: Any): Any {
  const base = structuredClone(input);
  base.privacy_requests = [];
  base.retention_expirations = [];
  return base;
}

export async function ensureFixtureFraudBundles(appPool: Pool, input: Any): Promise<void> {
  const values = inputAttempts(input).map(({ server }) => [server.tenant_id, server.app_id] as const);
  const unique = new Map(values.map(([tenantId, appId]) => [`${tenantId}\u0000${appId}`, [tenantId, appId] as const]));
  for (const [tenantId, appId] of unique.values()) {
    await ensureSyntheticDefaultFraudBundle(appPool, tenantId, appId, defaultTimestamp(input));
  }
}

export async function persistRaw(appPool: Pool, artifact: RawRecord, policyDigest: string): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistRawWithClient(client, artifact, policyDigest));
}

export async function persistDelivery(appPool: Pool, artifact: Delivery): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistDeliveryWithClient(client, artifact));
}

export async function persistLogical(appPool: Pool, artifact: LogicalEvent): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistLogicalWithClient(client, artifact));
}

export async function persistProjection(
  appPool: Pool,
  logical: LogicalEvent,
  input: Any,
  refundTargets: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  return withTenant(appPool, logical.tenant_id,
    (client) => persistProjectionWithClient(client, logical, input, refundTargets));
}

export async function persistFixtureCosts(appPool: Pool, input: Any): Promise<void> {
  const costs = input.cost_records ?? [];
  if (costs.length === 0) return;
  const scopes = new Map<string, Any[]>();
  for (const cost of costs) {
    const key = `${cost.tenant_id}\u0000${cost.app_id}`;
    const scoped = scopes.get(key) ?? [];
    scoped.push(cost);
    scopes.set(key, scoped);
  }
  for (const scoped of scopes.values()) {
    const first = scoped[0];
    const sourceDigest = sha256(scoped);
    const runId = uuidV7(Date.parse(first.as_of));
    await withTenant(appPool, first.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO control.import_runs (
          import_run_id, tenant_id, app_id, source_id, source_snapshot_digest,
          status, started_at, completed_at
        ) VALUES ($1,$2,$3,$4,$5,'completed',$6,$6)`,
        [runId, first.tenant_id, first.app_id, "fixture-metric-cost", sourceDigest, first.as_of],
      );
      for (const cost of scoped) {
        await client.query(
          `INSERT INTO ledger.cost_records (
            cost_record_id, tenant_id, app_id, network, campaign_id, ad_group_id,
            country, cost_date, spend_unscaled, spend_scale, currency, source,
            as_of, report_snapshot_digest, cost_key_digest, import_run_id, artifact
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
          ON CONFLICT (cost_record_id) DO NOTHING`,
          [
            cost.cost_record_id, cost.tenant_id, cost.app_id, cost.network,
            cost.campaign_id ?? null, cost.ad_group_id ?? null, cost.country ?? null,
            cost.date, cost.amount_unscaled, cost.amount_scale, cost.currency,
            cost.source, cost.as_of, cost.report_snapshot_digest,
            cost.dimension_digest, runId, JSON.stringify(cost),
          ],
        );
      }
    });
  }
}

export async function persistRejection(appPool: Pool, artifact: Rejection): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistRejectionWithClient(client, artifact));
}

export async function persistPrivacyRequest(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => storedArtifact(
    client,
    `INSERT INTO ledger.privacy_requests (
      privacy_request_id, tenant_id, app_id, requested_at, completed_at, status, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT (privacy_request_id) DO NOTHING RETURNING artifact`,
    [artifact.privacy_request_id, artifact.tenant_id, artifact.app_id, artifact.requested_at, artifact.completed_at ?? null, artifact.status, JSON.stringify(artifact)],
    "SELECT artifact FROM ledger.privacy_requests WHERE privacy_request_id = $1",
    [artifact.privacy_request_id],
  ));
}

export async function persistPrivacyTombstone(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => storedArtifact(
    client,
    `INSERT INTO ledger.privacy_tombstones (
      tenant_id, app_id, privacy_request_id, record_id, lifecycle_status, created_at, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT (tenant_id, app_id, privacy_request_id, record_id, lifecycle_status)
    DO NOTHING RETURNING artifact`,
    [artifact.tenant_id, artifact.app_id, artifact.privacy_request_id ?? null, artifact.record_id, artifact.lifecycle_status, artifact.created_at, JSON.stringify(artifact)],
    `SELECT artifact FROM ledger.privacy_tombstones
     WHERE tenant_id=$1 AND app_id=$2 AND privacy_request_id IS NOT DISTINCT FROM $3
       AND record_id=$4 AND lifecycle_status=$5`,
    [artifact.tenant_id, artifact.app_id, artifact.privacy_request_id ?? null, artifact.record_id, artifact.lifecycle_status],
  ));
}

export async function persistMetric(appPool: Pool, artifact: Any, scope: { tenant_id: string; app_id: string }): Promise<Any> {
  const grouping = artifact.grouping?.dimensions ?? {};
  return withTenant(appPool, scope.tenant_id, (client) => storedArtifact(
    client,
    `INSERT INTO ledger.metric_runs (
      metric_run_id, tenant_id, app_id, metric_name, metric_definition_version,
      grouping, grouping_digest, input_snapshot_id, input_received_at_watermark,
      input_ledger_position, computed_at, data_freshness, aggregation_time_zone,
      rule_bundle_id, rule_bundle_version, rule_bundle_hash, fx_rate_unscaled,
      fx_rate_scale, fx_rate_source, fx_rate_as_of, fx_rate_snapshot_id,
      fx_policy_version, rounding_mode, reproducibility_status, value_type,
      value_state, undefined_reason, value_unscaled, amount_scale, currency,
      supersedes_metric_run_id, artifact
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32::jsonb
    ) ON CONFLICT (metric_run_id) DO NOTHING RETURNING artifact`,
    [
      artifact.metric_run_id, scope.tenant_id, scope.app_id, artifact.metric_name,
      artifact.metric_definition_version, JSON.stringify(grouping), artifact.grouping?.dimension_digest ?? sha256(grouping),
      artifact.input_snapshot_id, artifact.input_received_at_watermark, artifact.input_ledger_position,
      artifact.computed_at, artifact.data_freshness, artifact.aggregation_time_zone,
      artifact.rule_bundle_id, artifact.rule_bundle_version, artifact.rule_bundle_hash,
      artifact.fx_rate_unscaled ?? null, artifact.fx_rate_scale ?? null, artifact.fx_rate_source ?? null,
      artifact.fx_rate_as_of ?? null, artifact.fx_rate_snapshot_id ?? null,
      artifact.fx_policy_version ?? null, artifact.rounding_mode, artifact.reproducibility_status,
      artifact.value_type, artifact.value_state ?? "present", artifact.undefined_reason ?? null,
      artifact.value_unscaled ?? null, artifact.amount_scale ?? null,
      artifact.currency ?? null, artifact.supersedes_metric_run_id ?? null, JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.metric_runs WHERE metric_run_id = $1",
    [artifact.metric_run_id],
  ));
}

export async function persistLifecycle(appPool: Pool, input: Any): Promise<void> {
  for (const request of input.privacy_requests ?? []) {
    if (request.status !== "completed") continue;
    for (const affected of request.affected_records ?? []) {
      await withTenant(appPool, request.tenant_id, async (client) => {
        await client.query(
          `INSERT INTO ledger.raw_payload_states (
            tenant_id, app_id, record_id, lifecycle_status, changed_at,
            privacy_request_id, privacy_tombstone_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
          [request.tenant_id, request.app_id, affected.record_id, affected.lifecycle_status,
            request.completed_at, request.privacy_request_id,
            `tombstone:${sha256([request.privacy_request_id, affected.record_id]).slice(0, 48)}`],
        );
      });
    }
  }
  for (const expiration of input.retention_expirations ?? []) {
    await withTenant(appPool, expiration.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO ledger.raw_payload_states (
          tenant_id, app_id, record_id, lifecycle_status, changed_at
        ) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
        [expiration.tenant_id, expiration.app_id, expiration.record_id, expiration.lifecycle_status, expiration.expired_at],
      );
    });
  }
}

export function scopeForDerived(artifact: Any, baseOutput: Any, input: Any): { tenant_id: string; app_id: string } {
  if (artifact.tenant_id && artifact.app_id) return { tenant_id: artifact.tenant_id, app_id: artifact.app_id };
  const evidence = artifact.evidence_refs?.[0];
  if (evidence?.tenant_id && evidence?.app_id) return { tenant_id: evidence.tenant_id, app_id: evidence.app_id };
  const raw = baseOutput.raw_records.find((record: Any) => record.record_id === artifact.subject_ref);
  if (raw) return { tenant_id: raw.tenant_id, app_id: raw.app_id };
  const server = input.server_context ?? input.batches?.[0]?.server_context;
  if (!server) throw new Error("cannot infer derived artifact scope");
  return { tenant_id: server.tenant_id, app_id: server.app_id };
}

export async function resetLedger(seedPool: Pool): Promise<void> {
  await retryDeadlockOnce(async () => {
    const client = await seedPool.connect();
    try {
      await client.query("BEGIN");
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'ledger' AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      );
      if (tables.rowCount === 0) throw new Error("ledger schema contains no base tables");
      const quoted = tables.rows.map(({ table_name }) => `ledger."${table_name.replaceAll('"', '""')}"`);
      // Synthetic reseeding also resets derived metric work; stale items must not
      // withdraw newly seeded artifacts that intentionally reuse fixture IDs.
      quoted.push("control.metric_recalculation_jobs", "control.metric_recalculation_items");
      await client.query(`TRUNCATE TABLE ${quoted.join(", ")} CASCADE`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function capture(seedPool: Pool, fixtureName: string, kind: ParityKind, ordinal: number, artifact: Any): Promise<void> {
  await seedPool.query(
    `INSERT INTO testing.fixture_artifacts (
      fixture_name, artifact_kind, ordinal, source_table, artifact_digest, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [fixtureName, kind, ordinal, parityLedgerTable[kind], sha256(artifact), JSON.stringify(artifact)],
  );
}

export function assertRoundTrip(expected: Any, stored: Any, label: string): void {
  if (jcs(expected) !== jcs(stored)) throw new Error(`database artifact round-trip changed ${label}`);
}

export async function readLedgerArtifact(
  appPool: Pool,
  kind: ParityKind,
  scope: { tenant_id: string; app_id: string },
  expected: Any,
): Promise<Any> {
  return withTenant(appPool, scope.tenant_id, async (client) => {
    const result = await client.query<{ artifact: Any }>(
      `SELECT artifact FROM ledger.${parityLedgerTable[kind]}
       WHERE tenant_id = $1 AND app_id = $2 AND artifact = $3::jsonb
       LIMIT 2`,
      [scope.tenant_id, scope.app_id, JSON.stringify(expected)],
    );
    if (result.rowCount === 0) throw new Error(`${kind} artifact is missing from its ledger table`);
    return result.rows[0].artifact;
  });
}

export async function ingestFixture(
  fixtureName: string,
  input: Any,
  appPool: Pool,
  seedPool: Pool,
): Promise<number> {
  await resetLedger(seedPool);
  await ensureApps(appPool, input);
  await ensureFixtureFraudBundles(appPool, input);
  await seedPool.query(
    `INSERT INTO testing.fixture_inputs (fixture_name, input_digest, input)
     VALUES ($1,$2,$3::jsonb) ON CONFLICT (fixture_name)
     DO UPDATE SET input_digest=EXCLUDED.input_digest, input=EXCLUDED.input, loaded_at=clock_timestamp()`,
    [fixtureName, sha256(input), JSON.stringify(input)],
  );
  await seedPool.query(
    `INSERT INTO testing.fixture_runs (fixture_name, input_digest)
     VALUES ($1,$2) ON CONFLICT (fixture_name)
     DO UPDATE SET input_digest=EXCLUDED.input_digest, evaluated_at=clock_timestamp()`,
    [fixtureName, sha256(input)],
  );
  const candidates = await PostgresCandidateProvider.stageAndLoad(seedPool, fixtureName, input);
  const providerFactory = (values: readonly CandidateAttempt[]): CandidateProvider => {
    candidates.assertEvaluationAttempts(values);
    return candidates;
  };
  const baseOutput = evaluate(withoutLifecycleChanges(input), providerFactory);
  const output = evaluate(input, providerFactory);
  const baseRefundTargets = refundProjectionTargets(
    baseOutput.logical_events,
    input,
    baseOutput.corrections,
  );

  await seedPool.query("DELETE FROM testing.fixture_artifacts WHERE fixture_name = $1", [fixtureName]);
  for (const raw of baseOutput.raw_records) {
    const stored = await persistRaw(appPool, raw, policyDigestForRecord(input, raw.record_id));
    assertRoundTrip(raw, stored, `${fixtureName}/base raw/${raw.record_id}`);
    await withTenant(appPool, raw.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO ledger.raw_payload_states (
          tenant_id, app_id, record_id, lifecycle_status, changed_at
        ) VALUES ($1,$2,$3,'available',$4)
        ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
        [raw.tenant_id, raw.app_id, raw.record_id, raw.received_at],
      );
    });
  }
  for (const logical of baseOutput.logical_events) {
    const stored = await persistLogical(appPool, logical);
    assertRoundTrip(logical, stored, `${fixtureName}/base logical/${logical.logical_event_id}`);
  }
  const projectionPriority = (logical: Any) =>
    logical.event_name === "purchase" ? 0 : logical.event_name === "refund" ? 2 : 1;
  for (const logical of [...baseOutput.logical_events].sort((left, right) =>
    projectionPriority(left) - projectionPriority(right))) {
    await persistProjection(appPool, logical, input, baseRefundTargets);
  }
  await persistFixtureCosts(appPool, input);
  await persistLifecycle(appPool, input);
  for (const reconciliation of output.reconciliation ?? []) {
    await persistReconciliation(appPool, reconciliation);
  }

  let count = 0;
  for (const kind of parityKinds) {
    const values = kind === "metric_runs"
      ? output.metric_runs.filter((run: Any) => d0Metrics.has(run.metric_name) && run.grouping === undefined)
      : output[kind];
    for (const [ordinal, artifact] of values.entries()) {
      const scope = scopeForDerived(artifact, baseOutput, input);
      let stored: Any;
      // The indexed evaluator family fixes this artifact's shape; TypeScript
      // cannot correlate an indexed union with the separate family variable.
      if (kind === "raw_records") stored = await persistRaw(appPool, artifact as RawRecord, policyDigestForRecord(input, (artifact as Any).record_id));
      else if (kind === "deliveries") stored = await persistDelivery(appPool, artifact as Delivery);
      else if (kind === "logical_events") stored = await persistLogical(appPool, artifact as LogicalEvent);
      else if (kind === "corrections") stored = await persistCorrection(appPool, artifact as Correction);
      else if (kind === "rejections") stored = await persistRejection(appPool, artifact as Rejection);
      else if (kind === "privacy_requests") stored = await persistPrivacyRequest(appPool, artifact);
      else if (kind === "privacy_tombstones") stored = await persistPrivacyTombstone(appPool, artifact);
      else if (kind === "attributions") stored = await persistAttribution(appPool, artifact as Attribution);
      else if (kind === "fraud_decisions") stored = await persistFraud(appPool, artifact as FraudDecision, scope);
      else stored = await persistMetric(appPool, artifact, scope);
      assertRoundTrip(artifact, stored, `${fixtureName}/${kind}/${ordinal}`);
      const ledgerArtifact = await readLedgerArtifact(appPool, kind, scope, stored);
      assertRoundTrip(stored, ledgerArtifact, `${fixtureName}/${kind}/${ordinal} ledger read`);
      await capture(seedPool, fixtureName, kind, ordinal, ledgerArtifact);
      count += 1;
    }
  }
  return count;
}
