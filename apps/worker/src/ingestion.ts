import type { Pool, PoolClient } from "pg";
import { jcs, sha256 } from "@openmasu/attribution-core/canonical";
import { compareCandidateAttempts, evaluate, IndexedCandidateProvider, sortCandidateAttempts, type CandidateAttempt, type CandidateProvider } from "@openmasu/attribution-core";
import { validateEventPayload } from "@openmasu/contracts/validation";
import { clickInjectionPolicyDigest, fraudNumberParameter } from "@openmasu/fraud-rules";
import { uuidV7, withTenant } from "@openmasu/runtime";
import { retryDeadlockOnce } from "./seed-safety.js";
import { ensureSyntheticDefaultFraudBundle, resolveActiveFraudBundle, serverBundleContext } from "./fraud-bundle-runtime.js";
import { assertNonFraudArtifactBinding, nonFraudServerContext, resolveNonFraudBundle, type BoundNonFraudBundle } from "./non-fraud-bundle-runtime.js";
import { inputAttempts, defaultTimestamp, policyDigestForRecord, refundProjectionTargets } from "./ingestion/input.js";
import { storedArtifact, persistRawWithClient, persistDeliveryWithClient, persistLogicalWithClient, persistCorrectionWithClient, persistRejectionWithClient } from "./ingestion/record-repository.js";
import { persistProjectionWithClient } from "./ingestion/fact-projections.js";
import { type Any, type RuntimeIngestionResult } from "./ingestion/model.js";
import { persistAttributionWithClient, persistFraudWithClient, persistReconciliationWithClient } from "./ingestion/derived-repository.js";
import { prepareRuntimeBulk, persistPreparedRuntimeBulkWithClient } from "./ingestion/bulk-repository.js";

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

export async function ensureApps(appPool: Pool, input: Any): Promise<void> {
  const values = inputAttempts(input).map(({ server }) => [server.tenant_id, server.app_id] as const);
  const unique = new Map(values.map(([tenantId, appId]) => [`${tenantId}\u0000${appId}`, [tenantId, appId] as const]));
  for (const [tenantId, appId] of unique.values()) {
    await withTenant(appPool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO control.apps (tenant_id, app_id, created_at)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
        [tenantId, appId, defaultTimestamp(input)],
      );
    });
  }
}

export async function ensureFixtureFraudBundles(appPool: Pool, input: Any): Promise<void> {
  const values = inputAttempts(input).map(({ server }) => [server.tenant_id, server.app_id] as const);
  const unique = new Map(values.map(([tenantId, appId]) => [`${tenantId}\u0000${appId}`, [tenantId, appId] as const]));
  for (const [tenantId, appId] of unique.values()) {
    await ensureSyntheticDefaultFraudBundle(appPool, tenantId, appId, defaultTimestamp(input));
  }
}

export async function persistRaw(appPool: Pool, artifact: Any, policyDigest: string): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistRawWithClient(client, artifact, policyDigest));
}

export async function persistDelivery(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistDeliveryWithClient(client, artifact));
}

export async function persistLogical(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistLogicalWithClient(client, artifact));
}

export async function persistProjection(
  appPool: Pool,
  logical: Any,
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

export async function persistCorrection(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistCorrectionWithClient(client, artifact));
}

export async function persistRejection(appPool: Pool, artifact: Any): Promise<Any> {
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

export async function persistAttribution(
  appPool: Pool,
  artifact: Any,
  expectedBinding?: BoundNonFraudBundle,
): Promise<Any> {
  if (expectedBinding) assertNonFraudArtifactBinding(artifact, expectedBinding);
  return withTenant(appPool, artifact.tenant_id, (client) => persistAttributionWithClient(client, artifact));
}

export async function persistFraud(
  appPool: Pool,
  artifact: Any,
  scope: { tenant_id: string; app_id: string },
  expectedRevisionId?: string,
): Promise<Any> {
  return withTenant(appPool, scope.tenant_id, (client) => persistFraudWithClient(client, artifact, scope, expectedRevisionId));
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

export async function persistReconciliation(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistReconciliationWithClient(client, artifact));
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
      if (kind === "raw_records") stored = await persistRaw(appPool, artifact, policyDigestForRecord(input, (artifact as Any).record_id));
      else if (kind === "deliveries") stored = await persistDelivery(appPool, artifact);
      else if (kind === "logical_events") stored = await persistLogical(appPool, artifact);
      else if (kind === "corrections") stored = await persistCorrection(appPool, artifact);
      else if (kind === "rejections") stored = await persistRejection(appPool, artifact);
      else if (kind === "privacy_requests") stored = await persistPrivacyRequest(appPool, artifact);
      else if (kind === "privacy_tombstones") stored = await persistPrivacyTombstone(appPool, artifact);
      else if (kind === "attributions") stored = await persistAttribution(appPool, artifact);
      else if (kind === "fraud_decisions") stored = await persistFraud(appPool, artifact, scope);
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

export function schemaInvalidArtifacts(attempt: CandidateAttempt): {
  delivery: Any;
  rejection: Any;
  failure: RuntimeIngestionResult["validation_failures"][number];
} | undefined {
  const validation = validateEventPayload(attempt.record.event_name, attempt.record.payload);
  if (validation.valid) return undefined;
  const purpose = (attempt.server.processing_purposes ?? []).find(
    (entry: Any) => entry.processing_purpose_id === attempt.record.processing_purpose_id,
  );
  const withdrawal = (attempt.server.withdrawals ?? []).find(
    (entry: Any) => entry.processing_purpose_id === attempt.record.processing_purpose_id,
  );
  const consentReason = !purpose?.consent_required
    ? "consent_not_required"
    : !withdrawal || Number(attempt.record.processing_sequence) < Number(withdrawal.withdrawal_recognized_sequence)
      ? "consent_valid_before_withdrawal"
      : "consent_withdrawn";
  const common = {
    contract_version: "0.4.0",
    delivery_id: attempt.record.delivery_id,
    record_id: attempt.record.record_id,
    tenant_id: attempt.server.tenant_id,
    app_id: attempt.server.app_id,
    payload_disposition: "discarded",
    ...(attempt.record.processing_purpose_id ? { processing_purpose_id: attempt.record.processing_purpose_id } : {}),
    consent_evaluation_policy_version: purpose?.policy_version ?? "not-applicable",
    consent_decision_reason_code: consentReason,
    ...(withdrawal?.withdrawal_recognized_at ? { withdrawal_recognized_at: withdrawal.withdrawal_recognized_at } : {}),
    reason_code: "payload_schema_invalid",
  };
  return {
    delivery: {
      ...common,
      received_at: attempt.record.received_at,
      ingestion_status: "rejected",
      duplicate_resolution: "unique",
      timeliness: attempt.record.late ? "late" : "on_time",
      clock_skew_suspected: false,
    },
    rejection: {
      ...common,
      reason_code_version: "0.4.0",
      retained: "non_identifying_metadata",
    },
    failure: {
      record_id: attempt.record.record_id,
      delivery_id: attempt.record.delivery_id,
      fields: validation.fields,
    },
  };
}

export function runtimeInput(attempts: readonly CandidateAttempt[]): Any {
  return {
    contract_version: "0.4.0",
    batches: attempts.map((attempt, index) => ({
      batch_id: attempt.batch_id || `runtime-batch-${index}`,
      server_context: attempt.server,
      records: [attempt.record],
    })),
    fx_policy: {
      policy_version: "runtime-no-fx-v0.2",
      target_currency: "USD",
      target_scale: 6,
      rounding_mode: "half_even",
      rates: [],
    },
    metric_evaluations: [],
    reconciliation_inputs: [],
    privacy_requests: [],
  };
}

export async function resolveDeepLinkAttempts(pool: Pool, attempts: readonly CandidateAttempt[]): Promise<CandidateAttempt[]> {
  const resolved: CandidateAttempt[] = [];
  for (const attempt of attempts) {
    if (attempt.record.event_name !== "deep_link_open") { resolved.push(attempt); continue; }
    const payload = attempt.record.payload;
    const resolution = await withTenant(pool, attempt.server.tenant_id, async (client) => {
      const link = payload.open_source === "android_deferred_referrer"
        ? await client.query<{ tracking_link_id: string; campaign_id: string | null; status: string }>(
            `SELECT link.tracking_link_id, link.campaign_id, link.status
               FROM ledger.click_facts AS click
               JOIN control.tracking_links_current AS link
                 ON link.tenant_id=click.tenant_id AND link.app_id=click.app_id
                AND link.tracking_link_id=click.tracking_link_id
              WHERE click.tenant_id=$1 AND click.app_id=$2 AND click.click_id=$3
              ORDER BY control.canonical_timestamp_value(click.redirector_click_at) DESC LIMIT 1`,
            [attempt.server.tenant_id, attempt.server.app_id, payload.click_id],
          )
        : await client.query<{ tracking_link_id: string; campaign_id: string | null; status: string }>(
            `SELECT tracking_link_id, campaign_id, status FROM control.tracking_links_current
              WHERE tenant_id=$1 AND app_id=$2 AND slug=$3 LIMIT 1`,
            [attempt.server.tenant_id, attempt.server.app_id, payload.link_slug],
          );
      const install = payload.open_source === "android_deferred_referrer"
        ? await client.query<{ click_id: string | null }>(
            `SELECT click_id FROM ledger.install_facts
              WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
              ORDER BY occurred_at_ts DESC LIMIT 1`,
            [attempt.server.tenant_id, attempt.server.app_id, payload.installation_id],
          )
        : undefined;
      const row = link.rows[0];
      if (!row) return { status: "unknown" as const, ...(install?.rows[0]?.click_id ? { install_attribution_click_id: install.rows[0].click_id } : {}) };
      return {
        status: row.status === "active" ? "active" as const : "inactive" as const,
        tracking_link_id: row.tracking_link_id,
        ...(row.campaign_id ? { campaign_id: row.campaign_id } : {}),
        ...(install?.rows[0]?.click_id ? { install_attribution_click_id: install.rows[0].click_id } : {}),
      };
    });
    resolved.push({ ...attempt, server: { ...attempt.server, deep_link_resolution: resolution } });
  }
  return resolved;
}

export async function ineligibleHistoricalPurchaseTargetIds(
  pool: Pool,
  attempts: readonly CandidateAttempt[],
  persistenceClient?: PoolClient,
): Promise<string[]> {
  const purchases = attempts.filter((attempt) =>
    attempt.record.event_name === "purchase"
    && attempt.record.payload.financial_status === "settled"
    && typeof attempt.record.payload.installation_id === "string");
  if (purchases.length === 0) return [];
  const first = purchases[0];
  const read = (client: PoolClient) => client.query<{
    record_id: string;
    installation_id: string | null;
    transaction_id: string;
    original_transaction_id: string | null;
    amount_unscaled: string;
    amount_scale: number;
    currency: string;
    financial_status: string | null;
    occurred_at_ts: string;
  }>(
    `SELECT record_id::text, installation_id, transaction_id, original_transaction_id,
            amount_unscaled, amount_scale, currency, financial_status, occurred_at_ts::text
       FROM ledger.purchase_facts
      WHERE tenant_id=$1 AND app_id=$2 AND record_id::text = ANY($3::text[])`,
    [first.server.tenant_id, first.server.app_id,
      [...new Set(purchases.map((attempt) => attempt.record.record_id))]],
  );
  const rows = persistenceClient ? await read(persistenceClient) : await withTenant(pool, first.server.tenant_id, read);
  const purchaseByRecord = new Map(purchases.map((attempt) => [attempt.record.record_id, attempt]));
  const eligible = new Set(rows.rows.filter((row) => {
    const purchase = purchaseByRecord.get(row.record_id);
    if (!purchase) return false;
    const payload = purchase.record.payload;
    return row.financial_status === "settled"
      && row.installation_id === payload.installation_id
      && (row.original_transaction_id ?? row.transaction_id)
        === (payload.original_transaction_id ?? payload.transaction_id)
      && row.amount_unscaled === payload.amount_unscaled
      && row.amount_scale === payload.amount_scale
      && row.currency === payload.currency
      && Date.parse(row.occurred_at_ts) === Date.parse(purchase.record.occurred_at);
  }).map((row) => row.record_id));
  return [...purchaseByRecord.keys()].filter((recordId) => !eligible.has(recordId)).sort();
}

export async function persistRuntimeBulk(
  appPool: Pool,
  attempts: readonly CandidateAttempt[],
  selected: RuntimeIngestionResult,
  input: Any,
  activeRevision: Awaited<ReturnType<typeof resolveActiveFraudBundle>>,
  nonFraudBindings: ReadonlyMap<string, BoundNonFraudBundle>,
  acceptedLogicals: readonly Any[],
): Promise<void> {
  const prepared = prepareRuntimeBulk(attempts, selected, input, activeRevision, nonFraudBindings, acceptedLogicals);
  await withTenant(appPool, prepared.tenantId, (client) => persistPreparedRuntimeBulkWithClient(client, prepared));
}

/**
 * Persist a production import batch through the same evaluator and ledger writers used by
 * golden parity. Historical import attempts participate in candidate selection so retries are
 * classified deterministically, while only the current deliveries are appended.
 */
export async function ingestRuntimeBatch(
  attempts: readonly CandidateAttempt[],
  appPool: Pool,
  historicalAttempts: readonly CandidateAttempt[] = [],
  options: { bulkPersistence?: boolean; persistenceClient?: PoolClient } = {},
): Promise<RuntimeIngestionResult> {
  if (attempts.length === 0) {
    return { raw_records: [], deliveries: [], logical_events: [], corrections: [], rejections: [], attributions: [], fraud_decisions: [], reconciliation: [], validation_failures: [] };
  }
  const scopes = [...new Set(attempts.map((attempt) =>
    `${attempt.server.tenant_id}\u0000${attempt.server.app_id}`))];
  if (options.persistenceClient && scopes.length !== 1) {
    throw new Error("runtime_transaction_requires_one_scope");
  }
  if (scopes.length > 1) {
    const combined: RuntimeIngestionResult = {
      raw_records: [], deliveries: [], logical_events: [], corrections: [], rejections: [], attributions: [],
      fraud_decisions: [], reconciliation: [], validation_failures: [],
    };
    for (const scope of scopes.sort()) {
      const [tenantId, appId] = scope.split("\u0000");
      const scopedAttempts = attempts.filter((attempt) =>
        attempt.server.tenant_id === tenantId && attempt.server.app_id === appId);
      const scopedHistory = historicalAttempts.filter((attempt) =>
        attempt.server.tenant_id === tenantId && attempt.server.app_id === appId);
      const result = await ingestRuntimeBatch(scopedAttempts, appPool, scopedHistory, options);
      for (const key of Object.keys(combined) as Array<keyof RuntimeIngestionResult>) {
        (combined[key] as Any[]).push(...result[key]);
      }
    }
    return combined;
  }
  if (options.persistenceClient) {
    const [scopeTenantId, scopeAppId] = scopes[0].split("\u0000");
    await options.persistenceClient.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [scopeTenantId, scopeAppId, defaultTimestamp(runtimeInput(attempts))],
    );
  } else {
    await ensureApps(appPool, runtimeInput(attempts));
  }
  const [tenantId, appId] = scopes[0].split("\u0000");
  const activeRevision = await resolveActiveFraudBundle(appPool, tenantId, appId);
  const attributionBinding = await resolveNonFraudBundle(appPool, tenantId, appId, "attribution-default");
  const applePostbackBinding = await resolveNonFraudBundle(appPool, tenantId, appId, "apple-postback-default");
  const nonFraudBindings = new Map<string, BoundNonFraudBundle>([
    [attributionBinding.ruleBundleId, attributionBinding],
    [applePostbackBinding.ruleBundleId, applePostbackBinding],
  ]);
  const bind = (attempt: CandidateAttempt): CandidateAttempt => {
    const enabled = attempt.server.fraud_enabled !== false && activeRevision !== undefined;
    const nonFraudRuleBundles = {
      "attribution-default": nonFraudServerContext(attributionBinding),
      "apple-postback-default": nonFraudServerContext(applePostbackBinding),
    };
    if (!enabled) return { ...attempt, server: {
      ...attempt.server, fraud_enabled: false, non_fraud_rule_bundles: nonFraudRuleBundles,
    } };
    const thresholdSeconds = fraudNumberParameter(activeRevision.definition, "ctit_lower_bound_seconds", 10);
    const policy = {
      threshold_seconds: thresholdSeconds,
      authority: "server" as const,
      policy_version: `${activeRevision.ruleBundleId}:${activeRevision.ruleBundleVersion}`,
    };
    return {
      ...attempt,
      server: {
        ...attempt.server,
        non_fraud_rule_bundles: nonFraudRuleBundles,
        fraud_enabled: true,
        fraud_rule_bundle: serverBundleContext(activeRevision),
        click_injection_policy: { ...policy, policy_digest: clickInjectionPolicyDigest(policy) },
      },
    };
  };
  const boundAttempts = attempts.map(bind);
  const boundHistory = historicalAttempts.map(bind);
  const invalid = boundAttempts.map(schemaInvalidArtifacts).filter((value): value is NonNullable<typeof value> => value !== undefined);
  const invalidAttempts = new Set(invalid.map(({ failure }) => `${failure.record_id}\u0000${failure.delivery_id}`));
  const validAttempts = boundAttempts.filter((attempt) => !invalidAttempts.has(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`));
  // Historical runtime candidates are reconstructed from accepted ledger rows.
  // They have already passed contract validation and must not require protected
  // payload access merely to process a new delivery.
  const currentAttempts = sortCandidateAttempts(await resolveDeepLinkAttempts(appPool, validAttempts));
  // Non-SDK importers still supply fully decoded historical attempts. Keep
  // those in the evaluator input until their own ledger-backed projection is
  // introduced; SDK history is explicitly marked and remains provider-only.
  const decodedHistory = boundHistory.filter((attempt) => attempt.history_state === undefined);
  const ineligiblePurchaseTargets = await ineligibleHistoricalPurchaseTargetIds(appPool, decodedHistory, options.persistenceClient);
  const applyPurchaseEligibility = (attempt: CandidateAttempt): CandidateAttempt =>
    ineligiblePurchaseTargets.length === 0 ? attempt : {
      ...attempt,
      server: {
        ...attempt.server,
        refund_target_ineligible_record_ids: ineligiblePurchaseTargets,
      },
    };
  const evaluationHistory = boundHistory.map(applyPurchaseEligibility);
  const evaluationCurrent = currentAttempts.map(applyPurchaseEligibility);
  const providerAttempts = sortCandidateAttempts([...evaluationHistory, ...evaluationCurrent]);
  const input = runtimeInput([
    ...evaluationHistory.filter((attempt) => attempt.history_state === undefined),
    ...evaluationCurrent,
  ]);
  const output = evaluate(input, () => new IndexedCandidateProvider(providerAttempts));
  const recordIds = new Set(validAttempts.map((attempt) => attempt.record.record_id));
  const deliveryIds = new Set(validAttempts.map((attempt) => attempt.record.delivery_id));
  const refundCorrectionIds = new Set(validAttempts
    .filter((attempt) => attempt.record.event_name === "refund")
    .map((attempt) => `correction:${attempt.record.record_id}`));
  const belongsToCurrent = (artifact: Any): boolean =>
    recordIds.has(artifact.record_id)
    || recordIds.has(artifact.subject_ref)
    || deliveryIds.has(artifact.delivery_id)
    || (artifact.evidence_refs ?? []).some((ref: Any) => recordIds.has(ref.record_id ?? ref.ref));

  const selected: RuntimeIngestionResult = {
    raw_records: output.raw_records.filter(belongsToCurrent),
    deliveries: [...output.deliveries.filter(belongsToCurrent), ...invalid.map(({ delivery }) => delivery)],
    logical_events: output.logical_events.filter(belongsToCurrent),
    corrections: output.corrections.filter((artifact: Any) =>
      refundCorrectionIds.has(artifact.correction_id) || belongsToCurrent(artifact)),
    rejections: [...output.rejections.filter(belongsToCurrent), ...invalid.map(({ rejection }) => rejection)],
    attributions: output.attributions.filter(belongsToCurrent),
    fraud_decisions: output.fraud_decisions.filter(belongsToCurrent),
    reconciliation: (output.reconciliation ?? []).filter((artifact: Any) =>
      artifact.tenant_id === attempts[0].server.tenant_id && artifact.app_id === attempts[0].server.app_id),
    validation_failures: invalid.map(({ failure }) => failure),
  };
  if (options.persistenceClient && (
    selected.attributions.length > 0
    || selected.fraud_decisions.length > 0
    || selected.reconciliation.length > 0
  )) {
    throw new Error("runtime_transaction_auxiliary_artifacts_unsupported");
  }
  if (options.bulkPersistence) {
    if (options.persistenceClient) throw new Error("runtime_transaction_bulk_persistence_unsupported");
    await persistRuntimeBulk(appPool, attempts, selected, input, activeRevision, nonFraudBindings, output.logical_events);
    return selected;
  }
  const rawByRecord = new Map(selected.raw_records.map((artifact) => [artifact.record_id, artifact]));
  const deliveryByRecord = new Map(selected.deliveries.map((artifact) => [`${artifact.record_id}\u0000${artifact.delivery_id}`, artifact]));
  const logicalByRecord = new Map(selected.logical_events.map((artifact) => [artifact.record_id, artifact]));
  const refundTargets = refundProjectionTargets(
    selected.logical_events,
    input,
    selected.corrections,
    output.logical_events,
  );
  const rejectionByRecord = new Map(selected.rejections.map((artifact) => [`${artifact.record_id}\u0000${artifact.delivery_id}`, artifact]));
  const persistenceAttempts = [...attempts].sort((left, right) => {
    const priority = (attempt: CandidateAttempt) =>
      attempt.record.event_name === "purchase" ? 0 : attempt.record.event_name === "refund" ? 2 : 1;
    return priority(left) - priority(right) || compareCandidateAttempts(left, right);
  });
  for (const attempt of persistenceAttempts) {
    const raw = rawByRecord.get(attempt.record.record_id);
    const delivery = deliveryByRecord.get(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`);
    const logical = logicalByRecord.get(attempt.record.record_id);
    const rejection = rejectionByRecord.get(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`);
    const persistAttempt = async (client: PoolClient): Promise<void> => {
      if (raw) {
        await persistRawWithClient(client, raw, policyDigestForRecord(input, raw.record_id));
        await client.query(
          `INSERT INTO ledger.raw_payload_states (
            tenant_id, app_id, record_id, lifecycle_status, changed_at
          ) VALUES ($1,$2,$3,'available',$4)
          ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
          [raw.tenant_id, raw.app_id, raw.record_id, raw.received_at],
        );
      }
      if (delivery) await persistDeliveryWithClient(client, delivery);
      if (logical) {
        await persistLogicalWithClient(client, logical);
        await persistProjectionWithClient(client, logical, input, refundTargets);
      }
      if (rejection) await persistRejectionWithClient(client, rejection);
    };
    if (options.persistenceClient) await persistAttempt(options.persistenceClient);
    else await withTenant(appPool, attempt.server.tenant_id, persistAttempt);
  }
  if (options.persistenceClient) {
    for (const correction of selected.corrections) {
      await persistCorrectionWithClient(options.persistenceClient, correction);
    }
    return selected;
  }
  for (const attribution of selected.attributions) {
    const binding = nonFraudBindings.get(attribution.rule_bundle_id);
    if (!binding) throw new Error("non_fraud_rule_bundle_binding_missing");
    await persistAttribution(appPool, attribution, binding);
  }
  for (const correction of selected.corrections) await persistCorrection(appPool, correction);
  for (const fraud of selected.fraud_decisions) {
    const matchingScopes = attempts.filter((attempt) => {
      const payload = attempt.record.payload ?? {};
      return [attempt.record.record_id, attempt.record.event_id, payload.installation_id, payload.click_id]
        .includes(fraud.subject_ref)
        || (fraud.evidence ?? []).some((evidence: Any) =>
          [attempt.record.record_id, attempt.record.event_id].includes(evidence.record_id ?? evidence.ref));
    }).map((attempt) => ({ tenant_id: attempt.server.tenant_id, app_id: attempt.server.app_id }));
    const uniqueScopes = [...new Map(matchingScopes.map((scope) => [
      `${scope.tenant_id}\u0000${scope.app_id}`, scope,
    ])).values()];
    if (uniqueScopes.length !== 1) throw new Error(`fraud_scope_ambiguous:${fraud.fraud_decision_id}`);
    await persistFraud(appPool, fraud, uniqueScopes[0], activeRevision?.ruleBundleRevisionId);
  }
  for (const reconciliation of selected.reconciliation) await persistReconciliation(appPool, reconciliation);
  return selected;
}

export type { RuntimeIngestionResult } from "./ingestion/model.js";
