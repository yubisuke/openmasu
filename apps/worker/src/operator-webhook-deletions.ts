import { buildOperatorWebhookDeletionRequest, recognizedWebhookDeletion } from "@openmasu/runtime/operator-webhook-envelope";
export { buildOperatorWebhookDeletionRequest, recognizedWebhookDeletion } from "@openmasu/runtime/operator-webhook-envelope";
import type { Pool, PoolClient } from "pg";
import { operatorWebhookReference, uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import { webhookSigningRevision } from "@openmasu/runtime/operator-webhook-signing";

type Scope = Readonly<{ tenantId: string; appId: string }>;
type Candidate = { app_id: string; destination_id: string; privacy_request_id: string; subject_ref: string; recognized_at: string };

async function lockDestination(client: PoolClient, scope: Scope, destinationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook-destination:' || $1 || ':' || $2 || ':' || $3,0))",
    [scope.tenantId, scope.appId, destinationId]);
}

const installation = "COALESCE(session.installation_id,custom.installation_id,purchase.installation_id,refund.installation_id,revenue.installation_id)";
const legacySource = `FROM ephemeral.operator_webhook_deliveries q
  JOIN control.operator_webhook_destinations_current d USING(tenant_id,app_id,destination_id)
  LEFT JOIN ledger.session_facts session ON session.tenant_id=q.tenant_id AND session.app_id=q.app_id AND session.logical_event_id=q.logical_event_id AND q.event_name='session_start'
  LEFT JOIN ledger.custom_event_facts custom ON custom.tenant_id=q.tenant_id AND custom.app_id=q.app_id AND custom.logical_event_id=q.logical_event_id AND q.event_name='custom_event'
  LEFT JOIN ledger.purchase_facts purchase ON purchase.tenant_id=q.tenant_id AND purchase.app_id=q.app_id AND purchase.logical_event_id=q.logical_event_id AND q.event_name='purchase'
  LEFT JOIN ledger.refund_facts refund ON refund.tenant_id=q.tenant_id AND refund.app_id=q.app_id AND refund.logical_event_id=q.logical_event_id AND q.event_name='refund'
  LEFT JOIN ledger.ad_revenue_facts revenue ON revenue.tenant_id=q.tenant_id AND revenue.app_id=q.app_id AND revenue.logical_event_id=q.logical_event_id AND q.event_name='ad_revenue'
  WHERE q.tenant_id=$1 AND q.state='succeeded' AND q.subject_ref IS NULL AND q.record_id IS NOT NULL
    AND q.logical_event_id IS NOT NULL AND d.status='active' AND d.deletion_notifications
    AND ${installation} IS NOT NULL
    AND EXISTS (SELECT 1 FROM ledger.privacy_tombstones t JOIN control.privacy_deletion_jobs job
      ON job.tenant_id=t.tenant_id AND job.privacy_request_id=t.privacy_request_id
      WHERE t.tenant_id=q.tenant_id AND t.app_id=q.app_id AND t.record_id=q.record_id)`;

/** Only legacy, successful, recognized deliveries need a bounded identity backfill. */
async function backfillRecognizedSubjects(pool: Pool, payloadStore: PayloadStore, tenantId: string): Promise<void> {
  const candidates = await withTenant(pool, tenantId, client => client.query<{
    delivery_id: string; app_id: string; destination_id: string; record_id: string;
  }>(`SELECT q.delivery_id::text,q.app_id,q.destination_id,q.record_id ${legacySource}
    ORDER BY q.destination_id,q.delivery_id LIMIT 500`, [tenantId]));
  for (const candidate of candidates.rows) await withTenant(pool, tenantId, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook:' || $1,0))", [candidate.record_id]);
    await lockDestination(client, { tenantId, appId: candidate.app_id }, candidate.destination_id);
    const row = (await client.query<{ installation_id: string; secret_ref: string }>(
      `SELECT ${installation} AS installation_id,d.secret_ref ${legacySource} AND q.delivery_id=$2`,
      [tenantId, candidate.delivery_id])).rows[0];
    if (!row) return;
    // The original immutable reference key, never a rotated transport signer.
    const secret = await payloadStore.read(row.secret_ref);
    const subjectRef = operatorWebhookReference(secret, "subject_ref", row.installation_id);
    await client.query(`UPDATE ephemeral.operator_webhook_deliveries SET subject_ref=$3
      WHERE tenant_id=$1 AND delivery_id=$2 AND subject_ref IS NULL AND state='succeeded'`,
    [tenantId, candidate.delivery_id, subjectRef]);
  });
}

/** Notifications are independent of local deletion completion and use the existing encrypted outbox. */
export async function discoverOperatorWebhookDeletionNotifications(
  pool: Pool, payloadStore: PayloadStore, tenantId: string, now = new Date(),
): Promise<number> {
  await backfillRecognizedSubjects(pool, payloadStore, tenantId);
  const candidates = await withTenant(pool, tenantId, client => client.query<Candidate>(
    `SELECT source.app_id,source.destination_id,t.privacy_request_id,source.subject_ref,MIN(t.created_at)::text AS recognized_at
      FROM ephemeral.operator_webhook_deliveries source
      JOIN control.operator_webhook_destinations_current d USING(tenant_id,app_id,destination_id)
      JOIN ledger.privacy_tombstones t ON t.tenant_id=source.tenant_id AND t.app_id=source.app_id AND t.record_id=source.record_id
      JOIN control.privacy_deletion_jobs job ON job.tenant_id=t.tenant_id AND job.privacy_request_id=t.privacy_request_id
      WHERE source.tenant_id=$1 AND source.state='succeeded' AND source.subject_ref IS NOT NULL
        AND source.logical_event_id IS NOT NULL AND source.record_id IS NOT NULL
        AND d.status='active' AND d.deletion_notifications
        AND NOT EXISTS (SELECT 1 FROM ephemeral.operator_webhook_deliveries sent WHERE sent.tenant_id=source.tenant_id
          AND sent.app_id=source.app_id AND sent.destination_id=source.destination_id
          AND sent.privacy_request_id=t.privacy_request_id AND sent.subject_ref=source.subject_ref AND sent.event_name='subject_deletion')
      GROUP BY source.app_id,source.destination_id,t.privacy_request_id,source.subject_ref
      ORDER BY MIN(t.created_at),source.destination_id,t.privacy_request_id,source.subject_ref LIMIT 500`, [tenantId]));
  let created = 0;
  for (const candidate of candidates.rows) {
    let written: string | undefined;
    try {
      const inserted = await withTenant(pool, tenantId, async client => {
        const scope = { tenantId, appId: candidate.app_id };
        await lockDestination(client, scope, candidate.destination_id);
        const destination = (await client.query<{ endpoint_url: string }>(
          `SELECT endpoint_url FROM control.operator_webhook_destinations_current
            WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND status='active' AND deletion_notifications`,
          [tenantId, scope.appId, candidate.destination_id])).rows[0];
        if (!destination) return false;
        const recognizedAt = await recognizedWebhookDeletion(client, scope, candidate.destination_id,
          candidate.privacy_request_id, candidate.subject_ref);
        if (!recognizedAt) return false;
        const signing = await webhookSigningRevision(client, scope, candidate.destination_id, undefined, now);
        if (!signing) return false;
        const deliveryId = uuidV7(now.valueOf() + created);
        const prepared = buildOperatorWebhookDeletionRequest({ deliveryId, appId: scope.appId, subjectRef: candidate.subject_ref,
          recognizedAt, endpointUrl: destination.endpoint_url });
        written = await payloadStore.write({ ...scope, objectId: `operator-webhook-deletion-${deliveryId}` }, prepared.body);
        const result = await client.query(`INSERT INTO ephemeral.operator_webhook_deliveries
          (delivery_id,tenant_id,app_id,destination_id,event_name,request_ref,request_digest,state,attempts,next_attempt_at,
           created_at,updated_at,signing_revision,subject_ref,privacy_request_id)
          VALUES ($1,$2,$3,$4,'subject_deletion',$5,$6,'queued',0,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [deliveryId, tenantId, scope.appId, candidate.destination_id, written, prepared.requestDigest,
          now.toISOString(), now.toISOString(), now.toISOString(), signing.signing_revision, candidate.subject_ref, candidate.privacy_request_id]);
        return result.rowCount === 1;
      });
      if (inserted) created++;
      else if (written) await payloadStore.purge(written);
    } catch {
      if (written) await payloadStore.purge(written);
      throw Error("operator_webhook_deletion_enqueue_failed");
    }
  }
  return created;
}
