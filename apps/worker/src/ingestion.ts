import type { Pool, PoolClient } from "pg";
import {
  compareCandidateAttempts,
  evaluate,
  IndexedCandidateProvider,
  jcs,
  sha256,
  sortCandidateAttempts,
  type CandidateAttempt,
  type CandidateProvider,
} from "@openmasu/attribution-core";
import { validateEventPayload } from "@openmasu/contracts";
import {
  clickInjectionPolicyDigest,
  fraudBundleHash,
  fraudNumberParameter,
  sha256Jcs,
  type FraudBundle,
} from "@openmasu/fraud-rules";
import { uuidV7, withTenant } from "@openmasu/runtime";
import { retryDeadlockOnce } from "./seed-safety.js";
import {
  ensureSyntheticDefaultFraudBundle,
  resolveActiveFraudBundle,
  serverBundleContext,
} from "./fraud-bundle-runtime.js";
import { buildDeepLinkAuditEvidence } from "./deep-link-audit.js";
import {
  assertNonFraudArtifactBinding,
  nonFraudServerContext,
  resolveNonFraudBundle,
  type BoundNonFraudBundle,
} from "./non-fraud-bundle-runtime.js";

type Any = Record<string, any>;
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

const d0Metrics = new Set([
  "d0_install_to_24h_ad_revenue_usd",
  "d0_utc_install_calendar_ad_revenue_usd",
  "d0_jst_install_calendar_ad_revenue_usd",
]);

function inputAttempts(input: Any): CandidateAttempt[] {
  if (Array.isArray(input.batches)) {
    return input.batches.flatMap((batch: Any) =>
      batch.records.map((record: Any) => ({
        server: batch.server_context,
        record,
        batch_id: batch.batch_id,
      })),
    );
  }
  return (input.records ?? []).map((record: Any) => ({
    server: input.server_context,
    record,
    batch_id: "batch-default",
  }));
}

class PostgresCandidateProvider implements CandidateProvider {
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

function withoutLifecycleChanges(input: Any): Any {
  const base = structuredClone(input);
  base.privacy_requests = [];
  base.retention_expirations = [];
  return base;
}

function defaultTimestamp(input: Any): string {
  return input.server_context?.received_at ?? input.batches?.[0]?.server_context?.received_at ?? "2026-08-19T00:00:00.000Z";
}

async function ensureApps(appPool: Pool, input: Any): Promise<void> {
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

async function ensureFixtureFraudBundles(appPool: Pool, input: Any): Promise<void> {
  const values = inputAttempts(input).map(({ server }) => [server.tenant_id, server.app_id] as const);
  const unique = new Map(values.map(([tenantId, appId]) => [`${tenantId}\u0000${appId}`, [tenantId, appId] as const]));
  for (const [tenantId, appId] of unique.values()) {
    await ensureSyntheticDefaultFraudBundle(appPool, tenantId, appId, defaultTimestamp(input));
  }
}

async function storedArtifact(
  client: PoolClient,
  insert: string,
  insertValues: unknown[],
  select: string,
  selectValues: unknown[],
): Promise<Any> {
  const inserted = await client.query<{ artifact: Any }>(insert, insertValues);
  const artifact = inserted.rows[0]?.artifact ?? (await client.query<{ artifact: Any }>(select, selectValues)).rows[0]?.artifact;
  if (!artifact) throw new Error("ledger insert did not return an artifact");
  return artifact;
}

async function persistRawWithClient(client: PoolClient, artifact: Any, policyDigest: string): Promise<Any> {
  return storedArtifact(
    client,
    `INSERT INTO ledger.raw_records (
      record_id, tenant_id, app_id, producer, producer_version, event_id, delivery_id,
      event_name, schema_version, payload_sha256, occurred_at, occurred_at_source,
      received_at, raw_payload_ref, processing_purpose_id,
      consent_evaluation_policy_version, consent_decision_reason_code,
      withdrawal_recognized_at, alternative_legal_basis_id,
      alternative_legal_basis_policy_version, policy_digest, artifact
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb
    ) ON CONFLICT (record_id) DO NOTHING RETURNING artifact`,
    [
      artifact.record_id, artifact.tenant_id, artifact.app_id, artifact.producer,
      artifact.producer_version, artifact.event_id, artifact.delivery_id, artifact.event_name,
      artifact.schema_version, artifact.payload_sha256, artifact.occurred_at,
      artifact.occurred_at_source, artifact.received_at, artifact.raw_payload_ref,
      artifact.processing_purpose_id, artifact.consent_evaluation_policy_version,
      artifact.consent_decision_reason_code, artifact.withdrawal_recognized_at ?? null,
      artifact.alternative_legal_basis_id ?? null,
      artifact.alternative_legal_basis_policy_version ?? null, policyDigest, JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.raw_records WHERE record_id = $1",
    [artifact.record_id],
  );
}

async function persistRaw(appPool: Pool, artifact: Any, policyDigest: string): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistRawWithClient(client, artifact, policyDigest));
}

function policyDigestForRecord(input: Any, recordId: string): string {
  const attempt = inputAttempts(input).find(({ record }) => record.record_id === recordId);
  const digest = attempt?.server.policy_digest;
  if (typeof digest !== "string") throw new Error(`missing server policy digest for ${recordId}`);
  return digest;
}

async function persistDeliveryWithClient(client: PoolClient, artifact: Any): Promise<Any> {
  const result = await client.query<{ artifact: Any }>(
      `INSERT INTO ledger.event_deliveries (
        delivery_attempt_id, delivery_id, record_id, canonical_record_id, tenant_id, app_id,
        received_at, ingestion_status, duplicate_resolution, timeliness,
        clock_skew_suspected, payload_disposition, reason_code, processing_purpose_id,
        consent_evaluation_policy_version, consent_decision_reason_code,
        withdrawal_recognized_at, alternative_legal_basis_id,
        alternative_legal_basis_policy_version, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
      RETURNING artifact`,
      [
        uuidV7(), artifact.delivery_id, artifact.record_id, artifact.canonical_record_id ?? null,
        artifact.tenant_id, artifact.app_id, artifact.received_at, artifact.ingestion_status,
        artifact.duplicate_resolution, artifact.timeliness, artifact.clock_skew_suspected,
        artifact.payload_disposition, artifact.reason_code ?? null, artifact.processing_purpose_id,
        artifact.consent_evaluation_policy_version, artifact.consent_decision_reason_code,
        artifact.withdrawal_recognized_at ?? null, artifact.alternative_legal_basis_id ?? null,
        artifact.alternative_legal_basis_policy_version ?? null, JSON.stringify(artifact),
      ],
  );
  return result.rows[0].artifact;
}

async function persistDelivery(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistDeliveryWithClient(client, artifact));
}

async function persistLogicalWithClient(client: PoolClient, artifact: Any): Promise<Any> {
  return storedArtifact(
    client,
    `INSERT INTO ledger.logical_events (
      logical_event_id, record_id, tenant_id, app_id, producer, event_id,
      event_name, record_lifecycle, timeliness, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (logical_event_id) DO NOTHING RETURNING artifact`,
    [
      artifact.logical_event_id, artifact.record_id, artifact.tenant_id, artifact.app_id,
      artifact.producer, artifact.event_id, artifact.event_name, artifact.record_lifecycle,
      artifact.timeliness, JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.logical_events WHERE logical_event_id = $1",
    [artifact.logical_event_id],
  );
}

async function persistLogical(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistLogicalWithClient(client, artifact));
}

function refundCorrectionTargets(corrections: readonly Any[]): Map<string, string> {
  const prefix = "correction:";
  return new Map(corrections
    .filter((correction) => correction.correction_reason === "refund"
      && typeof correction.correction_id === "string"
      && correction.correction_id.startsWith(prefix)
      && typeof correction.corrects_record_id === "string")
    .map((correction) => [correction.correction_id.slice(prefix.length), correction.corrects_record_id]));
}

function isLegacyExplicitRefundPayload(payload: Any): boolean {
  return typeof payload.installation_id !== "string"
    && typeof payload.correction_target_record_id === "string";
}

function refundProjectionTargets(
  logicals: readonly Any[],
  input: Any,
  corrections: readonly Any[],
  acceptedLogicals: readonly Any[] = logicals,
): Map<string, string> {
  const targets = refundCorrectionTargets(corrections);
  const attempts = sortCandidateAttempts(inputAttempts(input));
  const acceptedLogicalRecords = new Set(acceptedLogicals.map((logical) => [
    logical.tenant_id, logical.app_id, logical.record_id,
  ].join("\u0000")));
  const recordCounts = new Map<string, number>();
  const firstByLogicalScope = new Map<string, CandidateAttempt>();
  for (const attempt of attempts) {
    recordCounts.set(attempt.record.record_id, (recordCounts.get(attempt.record.record_id) ?? 0) + 1);
    const key = [
      attempt.server.tenant_id, attempt.server.app_id,
      attempt.record.producer, attempt.record.event_id,
    ].join("\u0000");
    if (!firstByLogicalScope.has(key)) firstByLogicalScope.set(key, attempt);
  }
  const purchases = attempts.filter((attempt) => {
    if (attempt.record.event_name !== "purchase"
        || typeof attempt.record.payload.installation_id !== "string"
        || attempt.record.payload.financial_status !== "settled"
        || attempt.record.tenant_id !== attempt.server.tenant_id
        || attempt.record.app_id !== attempt.server.app_id
        || !acceptedLogicalRecords.has([
          attempt.server.tenant_id, attempt.server.app_id, attempt.record.record_id,
        ].join("\u0000"))
        || recordCounts.get(attempt.record.record_id) !== 1) return false;
    const key = [
      attempt.server.tenant_id, attempt.server.app_id,
      attempt.record.producer, attempt.record.event_id,
    ].join("\u0000");
    return firstByLogicalScope.get(key) === attempt;
  });
  const attemptsByRecord = new Map(attempts.map((attempt) => [
    `${attempt.server.tenant_id}\u0000${attempt.server.app_id}\u0000${attempt.record.record_id}`,
    attempt,
  ]));
  for (const logical of logicals.filter((entry) => entry.event_name === "refund")) {
    const refund = attemptsByRecord.get(
      `${logical.tenant_id}\u0000${logical.app_id}\u0000${logical.record_id}`,
    );
    if (!refund) {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    const payload = refund.record.payload;
    if (isLegacyExplicitRefundPayload(payload)) {
      // Legacy (v0.4.0) explicit corrections remain logical corrections only.
      // They deliberately do not enter the v0.4.8 financial fact projection.
      targets.delete(logical.record_id);
      continue;
    }
    const explicitTarget = payload.correction_target_record_id;
    if (explicitTarget === undefined && typeof payload.installation_id !== "string") {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    const existing = targets.get(logical.record_id);
    if (existing !== undefined && !attemptsByRecord.has(
      `${logical.tenant_id}\u0000${logical.app_id}\u0000${existing}`,
    )) {
      // The evaluator resolved this target from a ledger-backed historical
      // candidate. The deferred database constraints and refund invariant
      // validate the same-scope persisted target during insertion.
      continue;
    }
    const matches = purchases.filter((purchase) =>
      purchase.server.tenant_id === refund.server.tenant_id
      && purchase.server.app_id === refund.server.app_id
      && typeof payload.installation_id === "string"
      && purchase.record.payload.installation_id === payload.installation_id
      && !(refund.server.refund_target_ineligible_record_ids ?? [])
        .includes(purchase.record.record_id)
      && (purchase.record.payload.original_transaction_id ?? purchase.record.payload.transaction_id)
        === payload.original_transaction_id
      && purchase.record.payload.currency === payload.currency
      && purchase.record.occurred_at <= refund.record.occurred_at
      && purchase.record.received_at <= refund.record.received_at);
    if (matches.length !== 1) {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    if (explicitTarget !== undefined && matches[0].record.record_id !== explicitTarget) {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    if (existing !== undefined && existing !== matches[0].record.record_id) {
      throw new Error(`refund_target_resolution_mismatch:${logical.record_id}`);
    }
    targets.set(logical.record_id, matches[0].record.record_id);
  }
  return targets;
}

async function persistProjectionWithClient(
  client: PoolClient,
  logical: Any,
  input: Any,
  refundTargets: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const attempt = inputAttempts(input).find(({ server, record }) =>
    server.tenant_id === logical.tenant_id && server.app_id === logical.app_id && record.record_id === logical.record_id,
  );
  if (!attempt) throw new Error(`missing input record for logical event ${logical.logical_event_id}`);
  const payload = attempt.record.payload;
  const projected = (value: Any) => JSON.stringify(value);
  if (logical.event_name === "click") {
      const importContext = payload.import_context ?? {};
      const campaignId = payload.campaign_id ?? importContext.provider_campaign_ref ?? null;
      const network = payload.network ?? importContext.provider_network ?? null;
      const country = payload.country ?? importContext.provider_country ?? null;
      const trackingLinkId = attempt.record.producer === "redirector" && typeof payload.tracking_link_id === "string"
        ? (await client.query<{ tracking_link_id: string }>(
          `SELECT tracking_link_id FROM control.tracking_links
            WHERE tenant_id=$1 AND app_id=$2 AND tracking_link_id=$3`,
          [logical.tenant_id, logical.app_id, payload.tracking_link_id],
        )).rows[0]?.tracking_link_id ?? null
        : null;
      await client.query(
        `INSERT INTO ledger.click_facts (
          logical_event_id, tenant_id, app_id, click_id, redirector_click_at,
          campaign_id, network, country, site_id, remote_click_ref, tracking_link_id, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
        [
          logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.click_id ?? null, payload.redirector_click_at ?? null,
          campaignId, network, country, payload.site_id ?? null, payload.remote_click_ref ?? null,
          trackingLinkId,
          projected({
            ...(payload.click_id ? { click_id: payload.click_id } : {}),
            redirector_click_at: payload.redirector_click_at ?? null,
            campaign_id: campaignId,
            network,
            country,
            site_id: payload.site_id ?? null,
            remote_click_ref: payload.remote_click_ref ?? null,
            tracking_link_id: trackingLinkId,
            bot_prefetch: payload.bot_prefetch === true,
            source_rate_class: payload.source_rate_class ?? null,
            client_class: payload.client_class ?? null,
          }),
        ],
      );
    } else if (logical.event_name === "install") {
      const importContext = payload.import_context ?? {};
      const campaignId = payload.campaign_id ?? importContext.provider_campaign_ref ?? null;
      const network = payload.network ?? importContext.provider_network ?? null;
      const country = payload.country ?? importContext.provider_country ?? null;
      await client.query(
        `INSERT INTO ledger.install_facts (
          logical_event_id, tenant_id, app_id, installation_id, prior_installation_id,
          install_type, click_id, install_begin_at_server, occurred_at, campaign_id,
          network, country, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [
          logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.installation_id, payload.prior_installation_id ?? null,
          payload.install_type, payload.click_id ?? null,
          payload.install_begin_at_server ?? null, attempt.record.occurred_at,
          campaignId, network, country,
          projected({
            installation_id: payload.installation_id,
            prior_installation_id: payload.prior_installation_id ?? null,
            install_type: payload.install_type,
            occurred_at: attempt.record.occurred_at,
            campaign_id: campaignId,
            network,
            country,
          }),
        ],
      );
    } else if (logical.event_name === "session_start") {
      await client.query(
        `INSERT INTO ledger.session_facts (
          logical_event_id, tenant_id, app_id, installation_id, session_id, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id, payload.installation_id, payload.session_id, attempt.record.occurred_at, projected({ installation_id: payload.installation_id, session_id: payload.session_id })],
      );
    } else if (logical.event_name === "deep_link_open") {
      const resolution = attempt.server.deep_link_resolution ?? { status: "unknown" };
      const previous = await client.query<{ occurred_at_ts: string }>(
        `SELECT occurred_at_ts::text FROM ledger.session_facts
          WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
            AND occurred_at_ts <= $4::timestamptz
          ORDER BY occurred_at_ts DESC LIMIT 1`,
        [logical.tenant_id, logical.app_id, payload.installation_id, attempt.record.occurred_at],
      );
      const daysSinceLastSession = previous.rows[0]
        ? Math.floor((Date.parse(attempt.record.occurred_at) - Date.parse(previous.rows[0].occurred_at_ts)) / 86_400_000)
        : null;
      const inserted = await client.query(
        `INSERT INTO ledger.deep_link_open_facts (
          logical_event_id, tenant_id, app_id, installation_id, tracking_link_id,
          campaign_id, open_source, occurred_at, days_since_last_session, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id, payload.installation_id,
          resolution.status === "active" ? resolution.tracking_link_id ?? null : null,
          resolution.status === "active" ? resolution.campaign_id ?? null : null,
          payload.open_source, attempt.record.occurred_at, daysSinceLastSession,
          projected({
            installation_id: payload.installation_id,
            tracking_link_id: resolution.status === "active" ? resolution.tracking_link_id ?? null : null,
            campaign_id: resolution.status === "active" ? resolution.campaign_id ?? null : null,
            open_source: payload.open_source,
            occurred_at: attempt.record.occurred_at,
            days_since_last_session: daysSinceLastSession,
          })],
      );
      if (inserted.rowCount === 1) {
        const { reasonCode, digest } = buildDeepLinkAuditEvidence({
          openSource: payload.open_source,
          resolutionStatus: resolution.status,
          claimedClickId: payload.click_id,
          installAttributionClickId: resolution.install_attribution_click_id,
        });
        await client.query(
          `INSERT INTO ledger.audit_logs (
            audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,action,
            target_scope,target_ref,policy_version,request_digest,outcome,reason_code
          ) VALUES ($1,$2,$3,$4,'system_job','worker:deep-link-audit',
            'deep_link_device_claim_observed','record',$5,'deep-link-audit-v1',$6,'succeeded',$7)`,
          [uuidV7(), logical.tenant_id, logical.app_id, attempt.record.received_at,
            `record-digest:${sha256([logical.tenant_id, logical.app_id, logical.record_id]).slice(0, 64)}`,
            digest, reasonCode],
        );
      }
    } else if (logical.event_name === "purchase") {
      await client.query(
        `INSERT INTO ledger.purchase_facts (
          logical_event_id, record_id, tenant_id, app_id, installation_id, transaction_id,
          original_transaction_id, amount_unscaled, amount_scale, currency,
          financial_status, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.record_id, logical.tenant_id, logical.app_id,
          payload.installation_id ?? null, payload.transaction_id,
          payload.original_transaction_id ?? null, payload.amount_unscaled,
          payload.amount_scale, payload.currency, payload.financial_status,
          attempt.record.occurred_at, projected({
            installation_id: payload.installation_id ?? null,
            transaction_id: payload.transaction_id,
            original_transaction_id: payload.original_transaction_id ?? null,
            amount_unscaled: payload.amount_unscaled,
            amount_scale: payload.amount_scale,
            currency: payload.currency,
            financial_status: payload.financial_status,
          })],
      );
    } else if (logical.event_name === "refund") {
      if (typeof payload.installation_id !== "string") return;
      const correctionTargetRecordId = refundTargets.get(logical.record_id);
      if (!correctionTargetRecordId) throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
      await client.query(
        `INSERT INTO ledger.refund_facts (
          logical_event_id, tenant_id, app_id, installation_id, transaction_id,
          original_transaction_id, correction_target_record_id, amount_unscaled,
          amount_scale, currency, financial_status, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.installation_id ?? null, payload.transaction_id,
          payload.original_transaction_id, correctionTargetRecordId,
          payload.amount_unscaled, payload.amount_scale, payload.currency,
          payload.financial_status, attempt.record.occurred_at, projected({
            installation_id: payload.installation_id ?? null,
            transaction_id: payload.transaction_id,
            original_transaction_id: payload.original_transaction_id,
            correction_target_record_id: correctionTargetRecordId,
            amount_unscaled: payload.amount_unscaled,
            amount_scale: payload.amount_scale,
            currency: payload.currency,
            financial_status: payload.financial_status,
          })],
      );
    } else if (logical.event_name === "ad_revenue") {
      await client.query(
        `INSERT INTO ledger.ad_revenue_facts (
          logical_event_id, tenant_id, app_id, installation_id, anchor_source,
          impression_id, ad_unit_id, ad_network, amount_unscaled, amount_scale,
          currency, revenue_source, country, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id, payload.installation_id ?? null, payload.anchor_source ?? null, payload.impression_id ?? null, payload.ad_unit_id ?? null, payload.ad_network ?? null, payload.amount_unscaled, payload.amount_scale, payload.currency, payload.revenue_source, payload.country ?? null, attempt.record.occurred_at, projected({ installation_id: payload.installation_id ?? null, anchor_source: payload.anchor_source ?? null, impression_id: payload.impression_id ?? null, amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale, currency: payload.currency, revenue_source: payload.revenue_source })],
      );
    } else if (logical.event_name === "custom_event") {
      await client.query(
        `INSERT INTO ledger.custom_event_facts (
          logical_event_id, tenant_id, app_id, installation_id, event_key, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.installation_id, payload.event_key,
          projected({ installation_id: payload.installation_id, event_key: payload.event_key })],
      );
    } else if (["skan_postback", "adattributionkit_postback"].includes(logical.event_name)) {
      const conversionBucket = payload.conversion_value !== undefined
        ? `fine:${payload.conversion_value}`
        : payload.coarse_conversion_value !== undefined
          ? `coarse:${payload.coarse_conversion_value}`
          : null;
      const aggregateFact = {
        event_name: logical.event_name,
        conversion_type: payload.conversion_type ?? null,
        signature_verified: payload.signature_verified === true,
        did_win: payload.did_win === true,
        source_identifier_present: payload.source_identifier !== undefined,
        conversion_bucket: conversionBucket,
        received_at: attempt.record.received_at,
      };
      await client.query(
        `INSERT INTO ledger.apple_postback_facts (
          logical_event_id, tenant_id, app_id, event_name, conversion_type,
          signature_verified, did_win, source_identifier_present, conversion_bucket,
          received_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [
          logical.logical_event_id, logical.tenant_id, logical.app_id,
          logical.event_name, aggregateFact.conversion_type, aggregateFact.signature_verified, aggregateFact.did_win,
          aggregateFact.source_identifier_present, conversionBucket,
          attempt.record.received_at, projected(aggregateFact),
        ],
      );
  }
}

async function persistProjection(
  appPool: Pool,
  logical: Any,
  input: Any,
  refundTargets: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  return withTenant(appPool, logical.tenant_id,
    (client) => persistProjectionWithClient(client, logical, input, refundTargets));
}

async function persistFixtureCosts(appPool: Pool, input: Any): Promise<void> {
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

async function persistCorrection(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => storedArtifact(
    client,
    `INSERT INTO ledger.corrections (
      correction_id, tenant_id, app_id, corrects_record_id, effective_at, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT (correction_id) DO NOTHING RETURNING artifact`,
    [artifact.correction_id, artifact.tenant_id, artifact.app_id, artifact.corrects_record_id, artifact.effective_at, JSON.stringify(artifact)],
    "SELECT artifact FROM ledger.corrections WHERE correction_id = $1",
    [artifact.correction_id],
  ));
}

async function persistRejectionWithClient(client: PoolClient, artifact: Any): Promise<Any> {
  const result = await client.query<{ artifact: Any }>(
      `INSERT INTO ledger.rejections (
        tenant_id, app_id, delivery_id, record_id, reason_code, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING artifact`,
      [artifact.tenant_id, artifact.app_id, artifact.delivery_id, artifact.record_id, artifact.reason_code, JSON.stringify(artifact)],
  );
  return result.rows[0].artifact;
}

async function persistRejection(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistRejectionWithClient(client, artifact));
}

async function persistPrivacyRequest(appPool: Pool, artifact: Any): Promise<Any> {
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

async function persistPrivacyTombstone(appPool: Pool, artifact: Any): Promise<Any> {
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

async function persistAttribution(
  appPool: Pool,
  artifact: Any,
  expectedBinding?: BoundNonFraudBundle,
): Promise<Any> {
  if (expectedBinding) assertNonFraudArtifactBinding(artifact, expectedBinding);
  return withTenant(appPool, artifact.tenant_id, (client) => storedArtifact(
    client,
    `INSERT INTO ledger.attribution_results (
      attribution_id, tenant_id, app_id, subject_scope, subject_ref, effective_at,
      decided_at, status, method, model, reason_code, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    ON CONFLICT (attribution_id) DO NOTHING RETURNING artifact`,
    [
      artifact.attribution_id, artifact.tenant_id, artifact.app_id, artifact.subject_scope,
      artifact.subject_ref ?? null, artifact.effective_at, artifact.decided_at, artifact.status,
      artifact.method, artifact.model, artifact.reason_code, JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.attribution_results WHERE attribution_id = $1",
    [artifact.attribution_id],
  ));
}

async function persistFraud(
  appPool: Pool,
  artifact: Any,
  scope: { tenant_id: string; app_id: string },
  expectedRevisionId?: string,
): Promise<Any> {
  return withTenant(appPool, scope.tenant_id, async (client) => {
    const revision = await client.query<{
      rule_bundle_revision_id: string;
      rule_bundle_id: string;
      rule_bundle_version: string;
      rule_bundle_hash: string;
      definition: FraudBundle | null;
      definition_digest: string | null;
    }>(
      `SELECT rule_bundle_revision_id,rule_bundle_id,rule_bundle_version,rule_bundle_hash,
              definition,definition_digest
         FROM control.rule_bundle_revisions
        WHERE tenant_id=$1 AND app_id=$2
          AND ($3::text IS NULL OR rule_bundle_revision_id=$3)
          AND rule_bundle_id=$4 AND rule_bundle_version=$5 AND rule_bundle_hash=$6
        ORDER BY activated_at DESC,rule_bundle_revision_id DESC
        LIMIT 2`,
      [scope.tenant_id, scope.app_id, expectedRevisionId ?? null,
        artifact.rule_bundle_id, artifact.rule_bundle_version, artifact.rule_bundle_hash],
    );
    if (revision.rows.length !== 1) throw new Error("fraud_rule_bundle_revision_mismatch");
    const bound = revision.rows[0];
    if (!bound.definition || !bound.definition_digest
      || sha256Jcs(bound.definition) !== bound.definition_digest
      || fraudBundleHash(bound.definition) !== bound.rule_bundle_hash) {
      throw new Error("fraud_rule_bundle_definition_mismatch");
    }
    const stored = await storedArtifact(
      client,
      `INSERT INTO ledger.fraud_decisions (
      fraud_decision_id, tenant_id, app_id, subject_ref, subject_scope, rule_id,
      decision, action, reason_code, evaluated_at, resolution_deadline_at,
      supersedes_fraud_decision_id, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT (fraud_decision_id) DO NOTHING RETURNING artifact`,
      [artifact.fraud_decision_id, scope.tenant_id, scope.app_id, artifact.subject_ref,
        artifact.subject_scope ?? "record", artifact.rule_id ?? null, artifact.decision,
        artifact.action, artifact.reason_code, artifact.evaluated_at,
        artifact.resolution_deadline_at ?? null, artifact.supersedes_fraud_decision_id ?? null,
        JSON.stringify(artifact)],
      "SELECT artifact FROM ledger.fraud_decisions WHERE fraud_decision_id = $1",
      [artifact.fraud_decision_id],
    );
    if (artifact.action === "quarantine") {
      await client.query(
        `INSERT INTO ephemeral.fraud_quarantines (
          fraud_decision_id,tenant_id,app_id,subject_ref,resolve_after
        ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (fraud_decision_id) DO NOTHING`,
        [artifact.fraud_decision_id, scope.tenant_id, scope.app_id,
          artifact.subject_ref, artifact.resolution_deadline_at],
      );
    }
    return stored;
  });
}

async function persistMetric(appPool: Pool, artifact: Any, scope: { tenant_id: string; app_id: string }): Promise<Any> {
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

async function persistReconciliation(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => storedArtifact(
    client,
    `INSERT INTO ledger.reconciliation_results (
      reconciliation_id, tenant_id, app_id, input_snapshot_id, external_snapshot_id,
      difference_reason_code, difference_reason_version, freshness,
      supersedes_reconciliation_id, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (reconciliation_id) DO NOTHING RETURNING artifact`,
    [
      artifact.reconciliation_id, artifact.tenant_id, artifact.app_id,
      artifact.input_snapshot_id, artifact.external_snapshot_id,
      artifact.difference_reason_code, artifact.difference_reason_version,
      artifact.freshness, artifact.supersedes_reconciliation_id ?? null,
      JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.reconciliation_results WHERE reconciliation_id=$1",
    [artifact.reconciliation_id],
  ));
}

async function persistLifecycle(appPool: Pool, input: Any): Promise<void> {
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

function scopeForDerived(artifact: Any, baseOutput: Any, input: Any): { tenant_id: string; app_id: string } {
  if (artifact.tenant_id && artifact.app_id) return { tenant_id: artifact.tenant_id, app_id: artifact.app_id };
  const evidence = artifact.evidence_refs?.[0];
  if (evidence?.tenant_id && evidence?.app_id) return { tenant_id: evidence.tenant_id, app_id: evidence.app_id };
  const raw = baseOutput.raw_records.find((record: Any) => record.record_id === artifact.subject_ref);
  if (raw) return { tenant_id: raw.tenant_id, app_id: raw.app_id };
  const server = input.server_context ?? input.batches?.[0]?.server_context;
  if (!server) throw new Error("cannot infer derived artifact scope");
  return { tenant_id: server.tenant_id, app_id: server.app_id };
}

async function resetLedger(seedPool: Pool): Promise<void> {
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

async function capture(seedPool: Pool, fixtureName: string, kind: ParityKind, ordinal: number, artifact: Any): Promise<void> {
  await seedPool.query(
    `INSERT INTO testing.fixture_artifacts (
      fixture_name, artifact_kind, ordinal, source_table, artifact_digest, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [fixtureName, kind, ordinal, parityLedgerTable[kind], sha256(artifact), JSON.stringify(artifact)],
  );
}

function assertRoundTrip(expected: Any, stored: Any, label: string): void {
  if (jcs(expected) !== jcs(stored)) throw new Error(`database artifact round-trip changed ${label}`);
}

async function readLedgerArtifact(
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

export type RuntimeIngestionResult = {
  raw_records: Any[];
  deliveries: Any[];
  logical_events: Any[];
  corrections: Any[];
  rejections: Any[];
  attributions: Any[];
  fraud_decisions: Any[];
  reconciliation: Any[];
  validation_failures: Array<{ record_id: string; delivery_id: string; fields: readonly string[] }>;
};

function schemaInvalidArtifacts(attempt: CandidateAttempt): {
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

function runtimeInput(attempts: readonly CandidateAttempt[]): Any {
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

async function resolveDeepLinkAttempts(pool: Pool, attempts: readonly CandidateAttempt[]): Promise<CandidateAttempt[]> {
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

const runtimeBulkChunkSize = 1_000;

async function insertJsonRows(
  client: PoolClient,
  rows: readonly Any[],
  statement: string,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += runtimeBulkChunkSize) {
    await client.query(statement, [JSON.stringify(rows.slice(offset, offset + runtimeBulkChunkSize))]);
  }
}

function bulkProjectionRows(
  logicals: readonly Any[],
  input: Any,
  refundTargets: ReadonlyMap<string, string>,
): {
  byTable: Map<string, Any[]>;
  fallback: Any[];
} {
  const attempts = new Map(inputAttempts(input).map((attempt) => [
    `${attempt.server.tenant_id}\u0000${attempt.server.app_id}\u0000${attempt.record.record_id}`,
    attempt,
  ]));
  const byTable = new Map<string, Any[]>();
  const fallback: Any[] = [];
  const append = (table: string, row: Any): void => {
    const rows = byTable.get(table) ?? [];
    rows.push(row);
    byTable.set(table, rows);
  };
  for (const logical of logicals) {
    const attempt = attempts.get(`${logical.tenant_id}\u0000${logical.app_id}\u0000${logical.record_id}`);
    if (!attempt) throw new Error(`missing input record for logical event ${logical.logical_event_id}`);
    const payload = attempt.record.payload;
    if (logical.event_name === "click") {
      if (attempt.record.producer === "redirector") { fallback.push(logical); continue; }
      const context = payload.import_context ?? {};
      const campaignId = payload.campaign_id ?? context.provider_campaign_ref ?? null;
      const network = payload.network ?? context.provider_network ?? null;
      const country = payload.country ?? context.provider_country ?? null;
      const artifact = {
        ...(payload.click_id ? { click_id: payload.click_id } : {}),
        redirector_click_at: payload.redirector_click_at ?? null,
        campaign_id: campaignId, network, country,
        site_id: payload.site_id ?? null, remote_click_ref: payload.remote_click_ref ?? null,
        tracking_link_id: null, bot_prefetch: payload.bot_prefetch === true,
        source_rate_class: payload.source_rate_class ?? null, client_class: payload.client_class ?? null,
      };
      append("click", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        click_id: payload.click_id ?? null, redirector_click_at: payload.redirector_click_at ?? null,
        campaign_id: campaignId, network, country, site_id: payload.site_id ?? null,
        remote_click_ref: payload.remote_click_ref ?? null, tracking_link_id: null, artifact,
      });
    } else if (logical.event_name === "install") {
      const context = payload.import_context ?? {};
      const campaignId = payload.campaign_id ?? context.provider_campaign_ref ?? null;
      const network = payload.network ?? context.provider_network ?? null;
      const country = payload.country ?? context.provider_country ?? null;
      append("install", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id, prior_installation_id: payload.prior_installation_id ?? null,
        install_type: payload.install_type, click_id: payload.click_id ?? null,
        install_begin_at_server: payload.install_begin_at_server ?? null, occurred_at: attempt.record.occurred_at,
        campaign_id: campaignId, network, country,
        artifact: {
          installation_id: payload.installation_id, prior_installation_id: payload.prior_installation_id ?? null,
          install_type: payload.install_type, occurred_at: attempt.record.occurred_at,
          campaign_id: campaignId, network, country,
        },
      });
    } else if (logical.event_name === "session_start") {
      append("session", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id, session_id: payload.session_id,
        occurred_at: attempt.record.occurred_at,
        artifact: { installation_id: payload.installation_id, session_id: payload.session_id },
      });
    } else if (logical.event_name === "purchase") {
      append("purchase", {
        logical_event_id: logical.logical_event_id, record_id: logical.record_id,
        tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
        original_transaction_id: payload.original_transaction_id ?? null,
        amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale, currency: payload.currency,
        financial_status: payload.financial_status,
        occurred_at: attempt.record.occurred_at,
        artifact: {
          installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
          original_transaction_id: payload.original_transaction_id ?? null,
          amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale, currency: payload.currency,
          financial_status: payload.financial_status,
        },
      });
    } else if (logical.event_name === "refund") {
      if (typeof payload.installation_id !== "string") continue;
      const correctionTargetRecordId = refundTargets.get(logical.record_id);
      if (!correctionTargetRecordId) throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
      append("refund", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
        original_transaction_id: payload.original_transaction_id,
        correction_target_record_id: correctionTargetRecordId,
        amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale,
        currency: payload.currency, financial_status: payload.financial_status,
        occurred_at: attempt.record.occurred_at,
        artifact: {
          installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
          original_transaction_id: payload.original_transaction_id,
          correction_target_record_id: correctionTargetRecordId,
          amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale,
          currency: payload.currency, financial_status: payload.financial_status,
        },
      });
    } else if (logical.event_name === "ad_revenue") {
      append("ad_revenue", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id ?? null, anchor_source: payload.anchor_source ?? null,
        impression_id: payload.impression_id ?? null, ad_unit_id: payload.ad_unit_id ?? null,
        ad_network: payload.ad_network ?? null, amount_unscaled: payload.amount_unscaled,
        amount_scale: payload.amount_scale, currency: payload.currency, revenue_source: payload.revenue_source,
        country: payload.country ?? null, occurred_at: attempt.record.occurred_at,
        artifact: {
          installation_id: payload.installation_id ?? null, anchor_source: payload.anchor_source ?? null,
          impression_id: payload.impression_id ?? null, amount_unscaled: payload.amount_unscaled,
          amount_scale: payload.amount_scale, currency: payload.currency, revenue_source: payload.revenue_source,
        },
      });
    } else if (logical.event_name === "custom_event") {
      append("custom_event", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id, event_key: payload.event_key,
        artifact: { installation_id: payload.installation_id, event_key: payload.event_key },
      });
    } else if (["skan_postback", "adattributionkit_postback"].includes(logical.event_name)) {
      const conversionBucket = payload.conversion_value !== undefined
        ? `fine:${payload.conversion_value}`
        : payload.coarse_conversion_value !== undefined ? `coarse:${payload.coarse_conversion_value}` : null;
      const artifact = {
        event_name: logical.event_name, conversion_type: payload.conversion_type ?? null,
        signature_verified: payload.signature_verified === true,
        did_win: payload.did_win === true, source_identifier_present: payload.source_identifier !== undefined,
        conversion_bucket: conversionBucket, received_at: attempt.record.received_at,
      };
      append("apple_postback", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        event_name: logical.event_name, conversion_type: artifact.conversion_type,
        signature_verified: artifact.signature_verified,
        did_win: artifact.did_win, source_identifier_present: artifact.source_identifier_present,
        conversion_bucket: conversionBucket, received_at: attempt.record.received_at, artifact,
      });
    } else if (logical.event_name === "deep_link_open") {
      fallback.push(logical);
    }
  }
  return { byTable, fallback };
}

async function persistRuntimeBulk(
  appPool: Pool,
  attempts: readonly CandidateAttempt[],
  selected: RuntimeIngestionResult,
  input: Any,
  activeRevision: Awaited<ReturnType<typeof resolveActiveFraudBundle>>,
  nonFraudBindings: ReadonlyMap<string, BoundNonFraudBundle>,
  acceptedLogicals: readonly Any[],
): Promise<void> {
  const tenantId = attempts[0].server.tenant_id;
  const rawRows: Any[] = selected.raw_records.map((artifact) => ({
    ...artifact, policy_digest: policyDigestForRecord(input, artifact.record_id), artifact,
  }));
  const deliveryRows = selected.deliveries.map((artifact) => ({ ...artifact, delivery_attempt_id: uuidV7(), artifact }));
  const logicalRows = selected.logical_events.map((artifact) => ({ ...artifact, artifact }));
  const rejectionRows = selected.rejections.map((artifact) => ({ ...artifact, artifact }));
  const correctionRows = selected.corrections.map((artifact) => ({ ...artifact, artifact }));
  const attributionRows = selected.attributions.map((artifact) => ({ ...artifact, artifact }));
  for (const artifact of selected.attributions) {
    const binding = nonFraudBindings.get(artifact.rule_bundle_id);
    if (!binding) throw new Error("non_fraud_rule_bundle_binding_missing");
    assertNonFraudArtifactBinding(artifact, binding);
  }
  const reconciliationRows = selected.reconciliation.map((artifact) => ({ ...artifact, artifact }));
  const projections = bulkProjectionRows(
    selected.logical_events,
    input,
    refundProjectionTargets(selected.logical_events, input, selected.corrections, acceptedLogicals),
  );

  await withTenant(appPool, tenantId, async (client) => {
    await insertJsonRows(client, rawRows, `INSERT INTO ledger.raw_records (
      record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,schema_version,
      payload_sha256,occurred_at,occurred_at_source,received_at,raw_payload_ref,processing_purpose_id,
      consent_evaluation_policy_version,consent_decision_reason_code,withdrawal_recognized_at,
      alternative_legal_basis_id,alternative_legal_basis_policy_version,policy_digest,artifact)
      SELECT record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,schema_version,
      payload_sha256,occurred_at,occurred_at_source,received_at,raw_payload_ref,processing_purpose_id,
      consent_evaluation_policy_version,consent_decision_reason_code,withdrawal_recognized_at,
      alternative_legal_basis_id,alternative_legal_basis_policy_version,policy_digest,artifact
      FROM jsonb_populate_recordset(NULL::ledger.raw_records,$1::jsonb)
      ON CONFLICT (record_id) DO NOTHING`);
    await insertJsonRows(client, rawRows.map((row) => ({
      tenant_id: row.tenant_id, app_id: row.app_id, record_id: row.record_id,
      lifecycle_status: "available", changed_at: row.received_at,
    })), `INSERT INTO ledger.raw_payload_states (tenant_id,app_id,record_id,lifecycle_status,changed_at)
      SELECT tenant_id,app_id,record_id,lifecycle_status,changed_at
      FROM jsonb_populate_recordset(NULL::ledger.raw_payload_states,$1::jsonb)
      ON CONFLICT (record_id,lifecycle_status) DO NOTHING`);
    await insertJsonRows(client, deliveryRows, `INSERT INTO ledger.event_deliveries (
      delivery_attempt_id,delivery_id,record_id,canonical_record_id,tenant_id,app_id,received_at,
      ingestion_status,duplicate_resolution,timeliness,clock_skew_suspected,payload_disposition,reason_code,
      processing_purpose_id,consent_evaluation_policy_version,consent_decision_reason_code,
      withdrawal_recognized_at,alternative_legal_basis_id,alternative_legal_basis_policy_version,artifact)
      SELECT delivery_attempt_id,delivery_id,record_id,canonical_record_id,tenant_id,app_id,received_at,
      ingestion_status,duplicate_resolution,timeliness,clock_skew_suspected,payload_disposition,reason_code,
      processing_purpose_id,consent_evaluation_policy_version,consent_decision_reason_code,
      withdrawal_recognized_at,alternative_legal_basis_id,alternative_legal_basis_policy_version,artifact
      FROM jsonb_populate_recordset(NULL::ledger.event_deliveries,$1::jsonb)`);
    await insertJsonRows(client, logicalRows, `INSERT INTO ledger.logical_events (
      logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,record_lifecycle,timeliness,artifact)
      SELECT logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,record_lifecycle,timeliness,artifact
      FROM jsonb_populate_recordset(NULL::ledger.logical_events,$1::jsonb)
      ON CONFLICT (logical_event_id) DO NOTHING`);

    const projectionStatements: Record<string, string> = {
      click: `INSERT INTO ledger.click_facts (logical_event_id,tenant_id,app_id,click_id,redirector_click_at,campaign_id,network,country,site_id,remote_click_ref,tracking_link_id,artifact)
        SELECT logical_event_id,tenant_id,app_id,click_id,redirector_click_at,campaign_id,network,country,site_id,remote_click_ref,tracking_link_id,artifact FROM jsonb_populate_recordset(NULL::ledger.click_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      install: `INSERT INTO ledger.install_facts (logical_event_id,tenant_id,app_id,installation_id,prior_installation_id,install_type,click_id,install_begin_at_server,occurred_at,campaign_id,network,country,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,prior_installation_id,install_type,click_id,install_begin_at_server,occurred_at,campaign_id,network,country,artifact FROM jsonb_populate_recordset(NULL::ledger.install_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      session: `INSERT INTO ledger.session_facts (logical_event_id,tenant_id,app_id,installation_id,session_id,occurred_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,session_id,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.session_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      purchase: `INSERT INTO ledger.purchase_facts (logical_event_id,record_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact)
        SELECT logical_event_id,record_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.purchase_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      refund: `INSERT INTO ledger.refund_facts (logical_event_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,correction_target_record_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,correction_target_record_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.refund_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      ad_revenue: `INSERT INTO ledger.ad_revenue_facts (logical_event_id,tenant_id,app_id,installation_id,anchor_source,impression_id,ad_unit_id,ad_network,amount_unscaled,amount_scale,currency,revenue_source,country,occurred_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,anchor_source,impression_id,ad_unit_id,ad_network,amount_unscaled,amount_scale,currency,revenue_source,country,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.ad_revenue_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      custom_event: `INSERT INTO ledger.custom_event_facts (logical_event_id,tenant_id,app_id,installation_id,event_key,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,event_key,artifact FROM jsonb_populate_recordset(NULL::ledger.custom_event_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      apple_postback: `INSERT INTO ledger.apple_postback_facts (logical_event_id,tenant_id,app_id,event_name,conversion_type,signature_verified,did_win,source_identifier_present,conversion_bucket,received_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,event_name,conversion_type,signature_verified,did_win,source_identifier_present,conversion_bucket,received_at,artifact FROM jsonb_populate_recordset(NULL::ledger.apple_postback_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
    };
    const projectionOrder = [...projections.byTable.keys()].sort((left, right) => {
      const priority = (table: string) => table === "purchase" ? 0 : table === "refund" ? 2 : 1;
      return priority(left) - priority(right) || left.localeCompare(right);
    });
    for (const table of projectionOrder) {
      await insertJsonRows(client, projections.byTable.get(table) ?? [], projectionStatements[table]);
    }
    for (const logical of projections.fallback) await persistProjectionWithClient(client, logical, input);

    await insertJsonRows(client, correctionRows, `INSERT INTO ledger.corrections (correction_id,tenant_id,app_id,corrects_record_id,effective_at,artifact)
      SELECT correction_id,tenant_id,app_id,corrects_record_id,effective_at,artifact FROM jsonb_populate_recordset(NULL::ledger.corrections,$1::jsonb)
      ON CONFLICT (correction_id) DO NOTHING`);

    await insertJsonRows(client, rejectionRows, `INSERT INTO ledger.rejections (tenant_id,app_id,delivery_id,record_id,reason_code,artifact)
      SELECT tenant_id,app_id,delivery_id,record_id,reason_code,artifact FROM jsonb_populate_recordset(NULL::ledger.rejections,$1::jsonb)`);
    await insertJsonRows(client, attributionRows, `INSERT INTO ledger.attribution_results (attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,decided_at,status,method,model,reason_code,artifact)
      SELECT attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,decided_at,status,method,model,reason_code,artifact FROM jsonb_populate_recordset(NULL::ledger.attribution_results,$1::jsonb) ON CONFLICT (attribution_id) DO NOTHING`);

    if (selected.fraud_decisions.length > 0) {
      if (!activeRevision) throw new Error("fraud_rule_bundle_revision_mismatch");
      for (const artifact of selected.fraud_decisions) {
        if (artifact.rule_bundle_id !== activeRevision.ruleBundleId
            || artifact.rule_bundle_version !== activeRevision.ruleBundleVersion
            || artifact.rule_bundle_hash !== activeRevision.ruleBundleHash) {
          throw new Error("fraud_rule_bundle_revision_mismatch");
        }
      }
      const fraudRows: Any[] = selected.fraud_decisions.map((artifact) => ({
        ...artifact, tenant_id: attempts[0].server.tenant_id, app_id: attempts[0].server.app_id, artifact,
      }));
      await insertJsonRows(client, fraudRows, `INSERT INTO ledger.fraud_decisions (fraud_decision_id,tenant_id,app_id,subject_ref,subject_scope,rule_id,decision,action,reason_code,evaluated_at,resolution_deadline_at,supersedes_fraud_decision_id,artifact)
        SELECT fraud_decision_id,tenant_id,app_id,subject_ref,subject_scope,rule_id,decision,action,reason_code,evaluated_at,resolution_deadline_at,supersedes_fraud_decision_id,artifact FROM jsonb_populate_recordset(NULL::ledger.fraud_decisions,$1::jsonb) ON CONFLICT (fraud_decision_id) DO NOTHING`);
      await insertJsonRows(client, fraudRows.filter((row) => row.action === "quarantine").map((row) => ({
        fraud_decision_id: row.fraud_decision_id, tenant_id: row.tenant_id, app_id: row.app_id,
        subject_ref: row.subject_ref, resolve_after: row.resolution_deadline_at,
      })), `INSERT INTO ephemeral.fraud_quarantines (fraud_decision_id,tenant_id,app_id,subject_ref,resolve_after)
        SELECT fraud_decision_id,tenant_id,app_id,subject_ref,resolve_after FROM jsonb_populate_recordset(NULL::ephemeral.fraud_quarantines,$1::jsonb) ON CONFLICT (fraud_decision_id) DO NOTHING`);
    }
    await insertJsonRows(client, reconciliationRows, `INSERT INTO ledger.reconciliation_results (reconciliation_id,tenant_id,app_id,input_snapshot_id,external_snapshot_id,difference_reason_code,difference_reason_version,freshness,supersedes_reconciliation_id,artifact)
      SELECT reconciliation_id,tenant_id,app_id,input_snapshot_id,external_snapshot_id,difference_reason_code,difference_reason_version,freshness,supersedes_reconciliation_id,artifact FROM jsonb_populate_recordset(NULL::ledger.reconciliation_results,$1::jsonb) ON CONFLICT (reconciliation_id) DO NOTHING`);
  });
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
  options: { bulkPersistence?: boolean } = {},
): Promise<RuntimeIngestionResult> {
  if (attempts.length === 0) {
    return { raw_records: [], deliveries: [], logical_events: [], corrections: [], rejections: [], attributions: [], fraud_decisions: [], reconciliation: [], validation_failures: [] };
  }
  const scopes = [...new Set(attempts.map((attempt) =>
    `${attempt.server.tenant_id}\u0000${attempt.server.app_id}`))];
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
  await ensureApps(appPool, runtimeInput(attempts));
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
  const providerAttempts = sortCandidateAttempts([...boundHistory, ...currentAttempts]);
  // Non-SDK importers still supply fully decoded historical attempts. Keep
  // those in the evaluator input until their own ledger-backed projection is
  // introduced; SDK history is explicitly marked and remains provider-only.
  const decodedHistory = boundHistory.filter((attempt) => attempt.history_state === undefined);
  const input = runtimeInput([...decodedHistory, ...currentAttempts]);
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
  if (options.bulkPersistence) {
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
    await withTenant(appPool, attempt.server.tenant_id, async (client) => {
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
    });
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
