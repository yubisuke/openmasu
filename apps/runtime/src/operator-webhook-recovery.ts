import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant, uuidV7, type PayloadStore } from "./index.js";
import { acquirePrivacyTenantXactFence } from "./privacy-fence.js";
import { webhookSigningRevision } from "./operator-webhook-signing.js";
import { buildOperatorWebhookRequest, buildOperatorWebhookDeletionRequest, recognizedWebhookDeletion, webhookCandidateSelect, type OperatorWebhookCandidate } from "./operator-webhook-envelope.js";
import { comparisonNotificationBody, comparisonNotificationEligible, type ComparisonNotificationState } from "./comparison-notifications.js";

type Scope = { tenantId: string; appId: string; keyId: string };
type Row = { delivery_id: string; destination_id: string; logical_event_id: string | null; record_id: string | null;
  comparison_id: string | null; event_name: string; privacy_request_id: string | null; subject_ref: string | null;
  state: string; attempts: number; request_digest: string; request_ref: string; signing_revision: string;
  policy_revision: string | null; created_at: string };
type Options = { pool: Pool; payloadStore: PayloadStore; scope: Scope; deliveryId: string; now?: Date };
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class WebhookRecoveryError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}
function refuse(reason: string): never { throw new WebhookRecoveryError(`webhook_recovery_${reason}`); }
async function tryLock(client: PoolClient, key: string) {
  if (!(await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [key])).rows[0].locked) refuse("busy");
}
async function lockedRow(client: PoolClient, options: Options): Promise<Row> {
  const { scope, deliveryId } = options;
  if (!uuid.test(deliveryId)) throw new WebhookRecoveryError("webhook_recovery_not_found", 404);
  await client.query("SET LOCAL statement_timeout='10s'");
  await acquirePrivacyTenantXactFence(client, scope.tenantId, "shared");
  const values = [scope.tenantId, scope.appId, deliveryId];
  const candidate = (await client.query<Row>(`SELECT * FROM ephemeral.operator_webhook_deliveries
    WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3`, values)).rows[0];
  if (!candidate) throw new WebhookRecoveryError("webhook_recovery_not_found", 404);
  // Same order as dispatch/privacy: tenant -> comparison/record -> destination -> delivery.
  if (candidate.comparison_id) await tryLock(client, `comparison:${scope.tenantId}`);
  else if (candidate.record_id) await tryLock(client, `openmasu:operator-webhook:${candidate.record_id}`);
  await tryLock(client, `openmasu:operator-webhook-destination:${scope.tenantId}:${scope.appId}:${candidate.destination_id}`);
  try {
    const row = (await client.query<Row>(`SELECT * FROM ephemeral.operator_webhook_deliveries
      WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3 FOR UPDATE NOWAIT`, values)).rows[0];
    if (!row) throw new WebhookRecoveryError("webhook_recovery_not_found",404);
    return row;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") refuse("busy");
    throw error;
  }
}
async function originalBody(client: PoolClient, options: Options, row: Row, now: Date): Promise<Buffer> {
  const { scope, payloadStore } = options;
  if (row.state !== "failed") refuse("not_failed");
  if (row.attempts >= 32) refuse("attempt_limit");
  const destination = (await client.query<{ status: string; secret_ref: string; deletion_notifications: boolean }>(
    `SELECT status,secret_ref,deletion_notifications FROM control.operator_webhook_destinations_current
      WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`, [scope.tenantId,scope.appId,row.destination_id])).rows[0];
  if (!destination || destination.status !== "active") refuse("destination_inactive");
  const signing = await webhookSigningRevision(client, scope, row.destination_id, Number(row.signing_revision), now);
  if (!signing || !["current","overlap"].includes(signing.state)) refuse("signing_unavailable");
  try { await payloadStore.read(signing.secret_ref); } catch { refuse("signing_unavailable"); }
  let body: Buffer;
  if (row.comparison_id) {
    if (!await comparisonNotificationEligible(client, scope, row.delivery_id, now)) refuse("evidence_unavailable");
    const evidence = (await client.query<{ run_id: string; target_date: string; state: ComparisonNotificationState; previous: ComparisonNotificationState | null }>(
      `SELECT run.run_id,run.target_date::text,q.comparison_state AS state,
        (SELECT prior.comparison_state FROM ephemeral.operator_webhook_deliveries prior
          WHERE prior.tenant_id=q.tenant_id AND prior.app_id=q.app_id AND prior.comparison_id=q.comparison_id
            AND prior.destination_id=q.destination_id AND prior.comparison_sequence=q.comparison_sequence-1 LIMIT 1) AS previous
       FROM ephemeral.operator_webhook_deliveries q JOIN control.comparison_runs run
         ON run.tenant_id=q.tenant_id AND run.app_id=q.app_id AND run.run_id=q.comparison_run_id
       WHERE q.tenant_id=$1 AND q.app_id=$2 AND q.delivery_id=$3`, [scope.tenantId,scope.appId,row.delivery_id])).rows[0];
    if (!evidence) refuse("evidence_unavailable");
    body = comparisonNotificationBody({ deliveryId: row.delivery_id, appId: scope.appId, comparisonId: row.comparison_id,
      runId: evidence.run_id, date: evidence.target_date, state: evidence.state, previous: evidence.previous,
      transition: evidence.state === "within_threshold" ? "recovered" : "attention", now: new Date(row.created_at) }, await payloadStore.read(destination.secret_ref));
  } else if (row.event_name === "subject_deletion") {
    if (!destination.deletion_notifications || !row.subject_ref || !row.privacy_request_id) refuse("evidence_unavailable");
    const recognized = await recognizedWebhookDeletion(client,scope,row.destination_id,row.privacy_request_id,row.subject_ref);
    if (!recognized) refuse("evidence_unavailable");
    body = buildOperatorWebhookDeletionRequest({ deliveryId: row.delivery_id, appId: scope.appId,
      subjectRef: row.subject_ref, recognizedAt: recognized, endpointUrl: "" }).body;
  } else {
    const raw = (await client.query<{ payload_ref: string | null }>(`SELECT CASE WHEN raw.raw_payload_ref LIKE 'encrypted:%'
        THEN raw.raw_payload_ref ELSE (
          SELECT batch.body_ref FROM ledger.ingest_batch_records member
          JOIN ledger.ingest_batches_current batch USING (tenant_id,app_id,ingest_batch_id)
          WHERE member.tenant_id=raw.tenant_id AND member.app_id=raw.app_id AND member.record_id=raw.record_id
            AND batch.status='processed' ORDER BY batch.received_at,batch.ingest_batch_id LIMIT 1
        ) END AS payload_ref FROM ledger.raw_records_current raw
      JOIN ledger.logical_events logical ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id AND logical.record_id=raw.record_id
      WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=$3 AND logical.logical_event_id=$4
        AND logical.record_lifecycle='active' AND raw.payload_lifecycle_status='available'
        AND raw.withdrawal_recognized_at IS NULL AND raw.consent_decision_reason_code<>'consent_withdrawn'
        AND NOT EXISTS(SELECT 1 FROM ledger.privacy_tombstones t WHERE t.tenant_id=raw.tenant_id AND t.app_id=raw.app_id AND t.record_id=raw.record_id)`,
      [scope.tenantId,scope.appId,row.record_id,row.logical_event_id])).rows[0];
    if (!raw?.payload_ref) refuse("evidence_unavailable");
    // Do not reconstruct from facts after the protected source has expired/disappeared.
    try { await payloadStore.read(raw.payload_ref); } catch { refuse("evidence_unavailable"); }
    const candidate = (await client.query<OperatorWebhookCandidate>(`${webhookCandidateSelect}
      WHERE destination.tenant_id=$1 AND destination.app_id=$3 AND destination.destination_id=$4 AND logical.logical_event_id=$5`,
      [scope.tenantId,row.policy_revision ?? 0,scope.appId,row.destination_id,row.logical_event_id])).rows[0];
    if (!candidate || (candidate.policy_revision ?? null) !== (row.policy_revision === null ? null : Number(row.policy_revision))) refuse("evidence_unavailable");
    body = buildOperatorWebhookRequest({ candidate, deliveryId: row.delivery_id, emittedAt: row.created_at,
      secret: await payloadStore.read(destination.secret_ref) }).body;
  }
  if (digest(body) !== row.request_digest) refuse("digest_mismatch");
  return body;
}
function receipt(row: Row, scope: Scope) {
  return digest(JSON.stringify([scope.tenantId,scope.appId,row.delivery_id,row.request_digest,row.attempts,row.signing_revision,row.policy_revision]));
}
async function audit(client: PoolClient, scope: Scope, row: Row, action: string, requestDigest: string, now: Date) {
  const id = uuidV7();
  await client.query(`INSERT INTO ledger.audit_logs(audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,
    action,target_scope,target_ref,policy_version,request_digest,outcome)
    VALUES($1,$2,$3,$4,'admin_key',$5,$6,'app',$7,'webhook-recovery-v1',$8,'succeeded')`,
    [id,scope.tenantId,scope.appId,now.toISOString(),`admin_key:${scope.keyId}`,action,row.delivery_id,requestDigest]);
  return id;
}
/** Audited preview: uses the writer role for protected evidence, never sends or retains a reconstructed body. */
export async function previewWebhookRecovery(options: Options) {
  return withTenant(options.pool, options.scope.tenantId, async client => {
    const row = await lockedRow(client, options), now = options.now ?? new Date();
    await originalBody(client, options, row, now);
    const value = receipt(row,options.scope);
    const previewId = await audit(client,options.scope,row,"operator_webhook_recovery_previewed",value,now);
    return { delivery_id: row.delivery_id, destination_id: row.destination_id, request_digest: row.request_digest,
      previous_attempt: row.attempts, signing_revision: Number(row.signing_revision), preview_id: previewId, receipt: value,
      expires_at: new Date(now.valueOf()+600_000).toISOString(), sends: false };
  });
}
export async function confirmWebhookRecovery(options: Options & { previewId: string; receipt: string }) {
  if (!uuid.test(options.previewId) || !/^[a-f0-9]{64}$/.test(options.receipt)) throw new WebhookRecoveryError("webhook_recovery_confirmation_invalid",400);
  let written: string | undefined;
  try {
    return await withTenant(options.pool,options.scope.tenantId,async client => {
      const row = await lockedRow(client,options), now = options.now ?? new Date(), scope = options.scope;
      const preview = (await client.query<{ occurred_at: string }>(`SELECT occurred_at FROM ledger.audit_logs
        WHERE tenant_id=$1 AND app_id=$2 AND target_ref=$3 AND audit_log_id=$4 AND request_digest=$5
          AND action='operator_webhook_recovery_previewed' AND outcome='succeeded'`,
        [scope.tenantId,scope.appId,row.delivery_id,options.previewId,options.receipt])).rows[0];
      if (!preview) refuse("preview_required");
      const confirmed = await client.query(`SELECT 1 FROM ledger.audit_logs WHERE tenant_id=$1 AND app_id=$2 AND target_ref=$3
        AND request_digest=$4 AND action='operator_webhook_recovery_confirmed' AND outcome='succeeded' LIMIT 1`,
        [scope.tenantId,scope.appId,row.delivery_id,options.receipt]);
      if (confirmed.rowCount) return { delivery_id: row.delivery_id, status: "already_requested" };
      if (now.valueOf() >= Date.parse(preview.occurred_at)+600_000 || now.valueOf()<Date.parse(preview.occurred_at)) refuse("preview_expired");
      if (receipt(row,scope)!==options.receipt) refuse("preview_stale");
      const body = await originalBody(client,options,row,now);
      // Finish any interrupted terminal cleanup before replacing its reference.
      // A late dispatch cleanup still targets only the old object, never this new one.
      await options.payloadStore.purge(row.request_ref);
      written = await options.payloadStore.write({ ...scope, objectId: `webhook-recovery-${row.delivery_id}` },body);
      await client.query(`UPDATE ephemeral.operator_webhook_deliveries SET request_ref=$4,state='retry',next_attempt_at=$5::text::timestamptz,
        updated_at=$5::text,safe_reason='operator_recovery_requested' WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3`,
        [scope.tenantId,scope.appId,row.delivery_id,written,now.toISOString()]);
      await audit(client,scope,row,"operator_webhook_recovery_confirmed",options.receipt,now);
      return { delivery_id: row.delivery_id, status: "requested" };
    });
  } catch (error) {
    if (written) await options.payloadStore.purge(written);
    throw error;
  }
}
