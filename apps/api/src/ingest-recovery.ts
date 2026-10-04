import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { validateEventPayload } from "@openmasu/contracts/validation";
import { acquirePrivacyTenantXactFence, privacyProjectionIsBlocked, SDK_POST_PROCESSING_PENDING_REASON, SDK_OPERATOR_RETRY_REASON,
  withTenant, workerJobLockKey, type PayloadStore, type ScheduledWorkerJob } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { assertRoleAllows } from "./authorization.js";
import { recordDashboardAuditWithClient } from "./session.js";

const auxiliary = {
  adservices: { table: "ephemeral.adservices_lookups", key: "lookup_id", record: "install_record_id", job: "adservices_lookup" },
  integrity: { table: "ephemeral.integrity_verifications", key: "verification_id", record: "subject_record_id", job: "integrity_verification" },
  google_play: { table: "ephemeral.google_play_product_verifications", key: "verification_id", record: "subject_record_id", job: "google_play_verification" },
} as const;
type RecoveryKind = "sdk_batch" | keyof typeof auxiliary;
type RecoveryReason = "invalid_input" | "worker_failure_review_configuration" | "post_processing_automatic"
  | "rate_limited" | "request_timeout" | "network_failure" | "not_found"
  | "provider_retry_or_pending" | "verification_pending";
export type RecoveryItem = {
  kind: RecoveryKind; job_id: string; revision: string; state: string; reason: RecoveryReason;
  attempts: number; next_attempt_at: string | null; active_claim: boolean; source_available: boolean | null;
  recovery: "validate_before_retry" | "expedite_existing_retry" | "automatic_only" | "blocked";
};
export class IngestRecoveryError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const invalidReasons = new Set(["payload_schema_invalid","ingest_batch_digest_mismatch","ingest_batch_records_invalid",
  "ingest_batch_scope_mismatch","adservices_token_scope_invalid","integrity_token_scope_invalid",
  "google_play_product_verification_scope_invalid","sdk_processing_sequence_out_of_range"]);
export function recoveryReason(reason: string | null, state = "failed"): RecoveryReason {
  if (state === "processed" && reason === SDK_POST_PROCESSING_PENDING_REASON) return "post_processing_automatic";
  return invalidReasons.has(reason ?? "") ? "invalid_input" : "worker_failure_review_configuration";
}
export function parseRecoveryRequest(value: unknown): { kind: RecoveryKind; job_id: string; revision: string } {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)
      || Object.keys(v).some(key => !["kind","job_id","revision","confirmation"].includes(key))
      || v.confirmation !== "retry_once" || typeof v.kind !== "string" || !["sdk_batch",...Object.keys(auxiliary)].includes(v.kind)
      || typeof v.job_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.job_id)
      || typeof v.revision !== "string"
      || !(v.kind === "sdk_batch" ? /^[1-9][0-9]{0,18}$/ : /^[0-9a-f]{32}$/).test(v.revision)) {
    throw new IngestRecoveryError("invalid_recovery_request",400);
  }
  return { kind: v.kind as RecoveryKind, job_id: v.job_id, revision: v.revision };
}

export async function listIngestRecovery(pool: Pool, identity: AppAdminIdentity): Promise<{ items: RecoveryItem[]; limits: { sdk_batches: 50; auxiliary_items: 50 }; dependency_configuration: "check_worker_deployment" }> {
  return withTenant(pool, identity.tenantId, async client => {
    await client.query("SET LOCAL statement_timeout='5000'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const sdk = await client.query<{
      job_id: string; revision: string; status: string; reason_code: string | null; attempts: number; active_claim: boolean;
    }>(`SELECT batch.ingest_batch_id::text AS job_id,state.ingest_batch_state_seq::text AS revision,
        state.status,state.reason_code,
        (SELECT count(*)::int FROM ledger.ingest_batch_states AS receipt
          WHERE receipt.tenant_id=batch.tenant_id AND receipt.app_id=batch.app_id
            AND receipt.ingest_batch_id=batch.ingest_batch_id AND receipt.reason_code='operator_retry_requested') AS attempts,
        EXISTS(SELECT 1 FROM control.worker_job_schedules AS schedule
          WHERE schedule.tenant_id=batch.tenant_id AND schedule.job_name='sdk_inbox'
            AND schedule.lease_expires_at>clock_timestamp()) AS active_claim
       FROM ledger.ingest_batches AS batch
       JOIN LATERAL (SELECT * FROM ledger.ingest_batch_states AS history
         WHERE history.tenant_id=batch.tenant_id AND history.app_id=batch.app_id AND history.ingest_batch_id=batch.ingest_batch_id
         ORDER BY history.ingest_batch_state_seq DESC LIMIT 1) AS state ON true
       WHERE batch.tenant_id=$1 AND batch.app_id=$2
         AND (state.status='failed' OR (state.status='processed' AND state.reason_code=$3))
       ORDER BY batch.received_at DESC,batch.ingest_batch_id LIMIT 50`,
    [identity.tenantId,identity.appId,SDK_POST_PROCESSING_PENDING_REASON]);
    const queued = await client.query<{ kind: keyof typeof auxiliary; job_id: string; revision: string; attempts: number;
      next_attempt_at: Date; claimed: boolean; source_available: boolean; safe_reason: RecoveryReason }>(
      "SELECT * FROM control.ingest_recovery_auxiliary_items($1)",[identity.appId]);
    const jobs = await client.query<{ job_name: string; active: boolean; failed: boolean }>(
      `SELECT job_name,COALESCE(lease_expires_at>clock_timestamp(),false) AS active,last_outcome='failed' AS failed
         FROM control.worker_job_schedules WHERE tenant_id=$1 AND job_name=ANY($2::text[])`,
      [identity.tenantId,Object.values(auxiliary).map(value => value.job)]);
    const items: RecoveryItem[] = sdk.rows.map(row => ({ kind: "sdk_batch",job_id: row.job_id,revision: row.revision,
      state: row.status,reason: recoveryReason(row.reason_code,row.status),attempts: row.attempts,next_attempt_at: null,
      active_claim: row.active_claim,source_available: null,
      recovery: row.active_claim || row.attempts >= 3 || invalidReasons.has(row.reason_code ?? "") ? "blocked"
        : row.status === "processed" ? "automatic_only" : "validate_before_retry" }));
    items.push(...queued.rows.map(row => {
      const job = jobs.rows.find(job => job.job_name === auxiliary[row.kind].job);
      const claimed = row.claimed || !!job?.active;
      return { kind: row.kind,job_id: row.job_id,revision: row.revision,state: "queued",reason: row.safe_reason,
        attempts: row.attempts,next_attempt_at: row.next_attempt_at.toISOString(),active_claim: claimed,
        source_available: row.source_available,
        recovery: !row.source_available || claimed ? "blocked" : row.attempts > 0 || job?.failed ? "expedite_existing_retry" : "automatic_only" } as RecoveryItem;
    }));
    return { items, limits: { sdk_batches: 50, auxiliary_items: 50 }, dependency_configuration: "check_worker_deployment" };
  });
}

async function guardWorker(client: PoolClient, identity: AppAdminIdentity, job: ScheduledWorkerJob): Promise<void> {
  const locked = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",[workerJobLockKey(identity.tenantId,job)]);
  if (!locked.rows[0]?.acquired) throw new IngestRecoveryError("worker_claim_active");
  const schedule = await client.query(`SELECT 1 FROM control.worker_job_schedules
    WHERE tenant_id=$1 AND job_name=$2 AND lease_expires_at>clock_timestamp()`,[identity.tenantId,job]);
  if (schedule.rowCount) throw new IngestRecoveryError("worker_claim_active");
}
async function privacyGuard(client: PoolClient, identity: AppAdminIdentity, id: string, receivedAt: string, digest?: string | null): Promise<void> {
  if (await privacyProjectionIsBlocked(client,{entryId:id,tenantId:identity.tenantId,appId:identity.appId,
    subjectDigest:digest ?? undefined,receivedAt})) throw new IngestRecoveryError("privacy_subject_inactive");
}

/** Existing immutable batch evidence is reused, never repaired or replaced by this endpoint. */
export async function requestIngestRecovery(pool: Pool, payloadStore: PayloadStore, identity: AppAdminIdentity, body: unknown) {
  assertRoleAllows(identity.role,"operate");
  const request = parseRecoveryRequest(body);
  const now = new Date();
  return withTenant(pool,identity.tenantId,async client => {
    await client.query("SET LOCAL statement_timeout='15000'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await acquirePrivacyTenantXactFence(client,identity.tenantId,"shared");
    await guardWorker(client,identity,request.kind === "sdk_batch" ? "sdk_inbox" : auxiliary[request.kind].job);
    // The audit and state transition commit together. A refused operation rolls
    // this receipt back; the HTTP controller records its closed failure reason.
    const receiptId = await recordDashboardAuditWithClient(client,{tenantId:identity.tenantId,appId:identity.appId,actorRef:`admin_key:${identity.keyId}`,
      action:"ingest_recovery_requested",targetScope:"app",targetRef:request.job_id,outcome:"succeeded",reasonCode:request.kind,now});
    if (request.kind === "sdk_batch") {
      // The worker advisory lock serializes retries. Immutable ledger rows have
      // no UPDATE privilege, including the privilege required by FOR UPDATE.
      const found = await client.query<Record<string,any>>(`SELECT batch.*,state.status,state.reason_code,state.ingest_batch_state_seq::text AS revision
        FROM ledger.ingest_batches AS batch JOIN LATERAL (SELECT * FROM ledger.ingest_batch_states AS history
          WHERE history.tenant_id=batch.tenant_id AND history.app_id=batch.app_id AND history.ingest_batch_id=batch.ingest_batch_id
          ORDER BY history.ingest_batch_state_seq DESC LIMIT 1) AS state ON true
        WHERE batch.tenant_id=$1 AND batch.app_id=$2 AND batch.ingest_batch_id=$3::uuid`,
      [identity.tenantId,identity.appId,request.job_id]);
      const row = found.rows[0];
      if (!row) throw new IngestRecoveryError("recovery_job_not_found",404);
      if (row.status !== "failed" || row.revision !== request.revision) throw new IngestRecoveryError("recovery_state_changed");
      if (invalidReasons.has(row.reason_code ?? "")) throw new IngestRecoveryError("recovery_input_invalid");
      await privacyGuard(client,identity,request.job_id,row.received_at,row.subject_digest);
      const unavailable = await client.query(`SELECT 1 FROM ledger.ingest_batch_records AS link
        JOIN ledger.raw_records_current AS raw USING (tenant_id,app_id,record_id)
        WHERE link.tenant_id=$1 AND link.app_id=$2 AND link.ingest_batch_id=$3::uuid
          AND raw.payload_lifecycle_status<>'available' LIMIT 1`,[identity.tenantId,identity.appId,request.job_id]);
      if (unavailable.rowCount) throw new IngestRecoveryError("recovery_evidence_unavailable");
      if (row.installation_key_id) {
        const active = await client.query(`SELECT 1 FROM control.installation_credentials_current
          WHERE tenant_id=$1 AND app_id=$2 AND installation_key_id=$3 AND status='active'`,[identity.tenantId,identity.appId,row.installation_key_id]);
        if (!active.rowCount) throw new IngestRecoveryError("privacy_subject_inactive");
      }
      const previous = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM ledger.ingest_batch_states
        WHERE tenant_id=$1 AND app_id=$2 AND ingest_batch_id=$3::uuid AND reason_code='operator_retry_requested'`,[identity.tenantId,identity.appId,request.job_id]);
      if (previous.rows[0].count >= 3) throw new IngestRecoveryError("recovery_attempt_limit");
      let evidence: Buffer;
      try { evidence = await payloadStore.read(row.body_ref); }
      catch { throw new IngestRecoveryError("recovery_evidence_unavailable"); }
      if (createHash("sha256").update(evidence).digest("hex") !== row.body_digest) throw new IngestRecoveryError("recovery_input_invalid");
      let decoded: Record<string,any>;
      try { decoded = JSON.parse(evidence.toString("utf8")); }
      catch { throw new IngestRecoveryError("recovery_input_invalid"); }
      if (!decoded || !Array.isArray(decoded.records) || decoded.records.length !== row.event_count
          || decoded.records.length < 1 || decoded.records.length > 100
          || decoded.records.some((record: any) => !record || record.tenant_id !== identity.tenantId || record.app_id !== identity.appId
            || record.producer !== row.producer || record.schema_version !== "0.4.0"
            || ["record_id","event_id","delivery_id","producer_version"].some(key => typeof record[key] !== "string" || !record[key].length)
            || !Number.isFinite(Date.parse(record.occurred_at)) || record.received_at !== row.received_at
            || !validateEventPayload(record.event_name,record.payload).valid)) {
        throw new IngestRecoveryError("recovery_input_invalid");
      }
      // This receipt is the compare-and-set token for double clicks. The old
      // failure and any admitted records remain untouched; ingestion stays idempotent.
      await client.query(`INSERT INTO ledger.ingest_batch_states (ingest_batch_id,tenant_id,app_id,status,changed_at,reason_code,artifact)
        VALUES ($1::uuid,$2,$3,'pending',$4,$5,$6::jsonb)`,
      [request.job_id,identity.tenantId,identity.appId,now.toISOString(),SDK_OPERATOR_RETRY_REASON,JSON.stringify({receipt_id:receiptId,previous_state_sequence:request.revision,attempt:previous.rows[0].count+1})]);
    } else {
      const config = auxiliary[request.kind]; // Table and column names come only from this closed server-owned map.
      const found = await client.query<Record<string,any>>(`SELECT queue.*,raw.received_at,raw.payload_lifecycle_status,
          member.subject_digest,md5(concat(queue.attempts,':',queue.next_attempt_at::text,':',queue.claimed_until::text)) AS revision
        FROM ${config.table} AS queue LEFT JOIN ledger.raw_records_current AS raw
          ON raw.tenant_id=queue.tenant_id AND raw.app_id=queue.app_id AND raw.record_id=queue.${config.record}
        LEFT JOIN LATERAL (SELECT batch.subject_digest FROM ledger.ingest_batch_records AS link
          JOIN ledger.ingest_batches AS batch USING (tenant_id,app_id,ingest_batch_id)
          WHERE link.tenant_id=queue.tenant_id AND link.app_id=queue.app_id AND link.record_id=queue.${config.record}
          ORDER BY batch.inbox_seq DESC LIMIT 1) AS member ON true
        WHERE queue.tenant_id=$1 AND queue.app_id=$2 AND queue.${config.key}=$3::uuid FOR UPDATE OF queue`,
      [identity.tenantId,identity.appId,request.job_id]);
      const row = found.rows[0];
      if (!row) throw new IngestRecoveryError("recovery_job_not_found",404);
      if (row.revision !== request.revision) throw new IngestRecoveryError("recovery_state_changed");
      if (row.claimed_until && row.claimed_until > now) throw new IngestRecoveryError("worker_claim_active");
      if (row.payload_lifecycle_status !== "available") throw new IngestRecoveryError("recovery_evidence_unavailable");
      await privacyGuard(client,identity,request.job_id,row.received_at,row.subject_digest);
      const failed = await client.query(`SELECT 1 FROM control.worker_job_schedules
        WHERE tenant_id=$1 AND job_name=$2 AND last_outcome='failed'`,[identity.tenantId,config.job]);
      if (row.attempts < 1 && !failed.rowCount) throw new IngestRecoveryError("recovery_not_needed");
      // No lease stealing, token lifetime extension or immutable verdict overwrite.
      await client.query(`UPDATE ${config.table} SET next_attempt_at=$4::timestamptz,claim_token=NULL,claimed_until=NULL
        WHERE tenant_id=$1 AND app_id=$2 AND ${config.key}=$3::uuid`,[identity.tenantId,identity.appId,request.job_id,now]);
    }
    return { receipt_id:receiptId,kind:request.kind,job_id:request.job_id,status:"queued" as const };
  });
}
