import type { Pool } from "pg";
import { createHash, createHmac } from "node:crypto";
import { sha256 } from "@openmasu/attribution-core";
import {
  acquirePrivacyTenantXactFence,
  operatorWebhookReference,
  processPrivacyDeletionRequest,
  uuidV7,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

type Any = Record<string, any>;
function commerceInstallationDigest(tenantId: string, appId: string, installationId: string): string {
  return createHash("sha256").update(`${tenantId}\0${appId}\0${installationId}`).digest("hex");
}
export type PrivacyRequestBody = {
  tenant_id: string;
  app_id: string;
  requested_via: "tenant_admin_api" | "on_device_sdk";
  deletion_scope: "installation" | "app" | "tenant";
  deletion_subject_ref: string;
};

export type PrivacyIdentity = {
  tenantId: string;
  appId: string;
  actorType: "admin_key" | "sdk_installation";
  actorRef: string;
  requesterAuthRef: string;
  installationKeyId?: string;
  deletionSubjectDigest: string;
};

type AppPrivacyIdentity = AppAdminIdentity & { deletionSubjectDigest: string };

function currentTimestamp(now?: Date): string { return (now ?? new Date()).toISOString(); }

export function privacySubjectDigest(
  key: string,
  body: Pick<PrivacyRequestBody, "tenant_id" | "app_id" | "deletion_scope" | "deletion_subject_ref">,
): string {
  if (!key) throw new Error("privacy_subject_digest_key_required");
  const namespace = body.deletion_scope === "installation"
    ? `${body.tenant_id}\u0000${body.app_id}\u0000${body.deletion_subject_ref}`
    : `openmasu:privacy-subject:v1\u0000${body.tenant_id}\u0000${body.app_id}\u0000${body.deletion_scope}\u0000${body.deletion_subject_ref}`;
  return createHmac("sha256", key).update(namespace, "utf8").digest("hex");
}

async function affectedRecordIds(client: any, body: PrivacyRequestBody): Promise<string[]> {
  if (body.deletion_scope !== "installation") {
    const result = await client.query(
      `SELECT record_id FROM ledger.raw_records
       WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
       ORDER BY record_id`,
      [body.tenant_id, body.deletion_scope, body.app_id],
    );
    return result.rows.map((row: Any) => row.record_id);
  }
  const result = await client.query(
    `SELECT DISTINCT logical.record_id
     FROM ledger.logical_events AS logical
     LEFT JOIN ledger.install_facts AS install USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.session_facts AS session USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.purchase_facts AS purchase USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.refund_facts AS refund USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.logical_events AS refund_target
       ON refund_target.tenant_id=refund.tenant_id
      AND refund_target.app_id=refund.app_id
      AND refund_target.record_id=refund.correction_target_record_id
     LEFT JOIN ledger.purchase_facts AS target_purchase
       ON target_purchase.tenant_id=refund_target.tenant_id
      AND target_purchase.app_id=refund_target.app_id
      AND target_purchase.logical_event_id=refund_target.logical_event_id
     LEFT JOIN ledger.corrections AS legacy_refund_correction
       ON logical.event_name='refund'
      AND refund.logical_event_id IS NULL
      AND legacy_refund_correction.tenant_id=logical.tenant_id
      AND legacy_refund_correction.app_id=logical.app_id
      AND legacy_refund_correction.correction_id='correction:' || logical.record_id
      AND legacy_refund_correction.artifact->>'correction_reason'='refund'
     LEFT JOIN ledger.logical_events AS legacy_refund_target
       ON legacy_refund_target.tenant_id=legacy_refund_correction.tenant_id
      AND legacy_refund_target.app_id=legacy_refund_correction.app_id
      AND legacy_refund_target.record_id=legacy_refund_correction.corrects_record_id
     LEFT JOIN ledger.purchase_facts AS legacy_target_purchase
       ON legacy_target_purchase.tenant_id=legacy_refund_target.tenant_id
      AND legacy_target_purchase.app_id=legacy_refund_target.app_id
      AND legacy_target_purchase.logical_event_id=legacy_refund_target.logical_event_id
     LEFT JOIN ledger.ad_revenue_facts AS revenue
       ON revenue.logical_event_id=logical.logical_event_id
      AND revenue.tenant_id=logical.tenant_id
      AND revenue.app_id=logical.app_id
     LEFT JOIN ledger.custom_event_facts AS custom
       ON custom.logical_event_id=logical.logical_event_id
      AND custom.tenant_id=logical.tenant_id
      AND custom.app_id=logical.app_id
     LEFT JOIN ledger.deep_link_open_facts AS deep_link
       ON deep_link.logical_event_id=logical.logical_event_id
      AND deep_link.tenant_id=logical.tenant_id
      AND deep_link.app_id=logical.app_id
     WHERE logical.tenant_id=$1 AND logical.app_id=$2
       AND COALESCE(install.installation_id, session.installation_id, purchase.installation_id,
         refund.installation_id, target_purchase.installation_id,
         legacy_target_purchase.installation_id, revenue.installation_id, custom.installation_id,
         deep_link.installation_id)=$3
     ORDER BY logical.record_id`,
    [body.tenant_id, body.app_id, body.deletion_subject_ref],
  );
  return result.rows.map((row: Any) => row.record_id);
}

export async function executePrivacyRequest(
  pool: Pool,
  identity: AppPrivacyIdentity | PrivacyIdentity,
  body: PrivacyRequestBody,
  payloadStore: PayloadStore,
  now?: Date,
): Promise<Any> {
  if (body.requested_via === "on_device_sdk"
    && (!("actorType" in identity) || identity.actorType !== "sdk_installation")) {
    const error = new Error("on_device_path_not_implemented");
    (error as Any).statusCode = 501;
    throw error;
  }
  if (body.requested_via === "tenant_admin_api" && "actorType" in identity) {
    const error = new Error("tenant_admin_path_requires_admin_auth");
    (error as Any).statusCode = 403;
    throw error;
  }
  if (identity.tenantId !== body.tenant_id || identity.appId !== body.app_id) {
    const error = new Error("requester_scope_mismatch");
    (error as Any).statusCode = 403;
    throw error;
  }
  const completedAt = currentTimestamp(now);
  const requestId = `privacy:${uuidV7(now?.valueOf())}`;
  const subjectDigest = identity.deletionSubjectDigest;
  if (!/^[a-f0-9]{64}$/.test(subjectDigest)) throw new Error("privacy_subject_digest_invalid");
  const prepared = await withTenant(pool, body.tenant_id, async (client) => {
    await acquirePrivacyTenantXactFence(client, body.tenant_id, "exclusive");
    const records = await affectedRecordIds(client, body);
    // Serialize deletion recognition with operator-webhook discovery and delivery.
    // If deletion takes the lock first, no pending request can cross the boundary;
    // if delivery already owns it, that request necessarily precedes recognition.
    for (const recordId of records) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook:' || $1,0))",
        [recordId],
      );
    }
    const payloads = body.deletion_scope === "installation"
      ? await client.query<{ raw_query_ref: string }>(
          `SELECT DISTINCT inbox.raw_query_ref
           FROM ledger.ingest_inbox AS inbox
           JOIN ledger.raw_records AS raw
             ON raw.tenant_id=inbox.tenant_id AND raw.app_id=inbox.app_id
            AND raw.producer=inbox.producer AND raw.event_id=inbox.event_id
           WHERE inbox.tenant_id=$1 AND inbox.app_id=$2 AND raw.record_id=ANY($3::text[])
           ORDER BY inbox.raw_query_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ raw_query_ref: string }>(
          `SELECT raw_query_ref FROM ledger.ingest_inbox
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY inbox_id`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const rawPayloads = body.deletion_scope === "installation"
      ? await client.query<{ raw_payload_ref: string }>(
          `SELECT DISTINCT raw.raw_payload_ref
             FROM ledger.raw_records AS raw
            WHERE raw.tenant_id=$1 AND raw.app_id=$2
              AND raw.record_id=ANY($3::text[])
              AND raw.raw_payload_ref LIKE 'encrypted:%'
              AND NOT EXISTS (
                SELECT 1 FROM ledger.raw_records AS shared
                 WHERE shared.tenant_id=raw.tenant_id
                   AND shared.raw_payload_ref=raw.raw_payload_ref
                   AND NOT (shared.record_id=ANY($3::text[]))
              )
            ORDER BY raw.raw_payload_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ raw_payload_ref: string }>(
          `SELECT DISTINCT raw_payload_ref FROM ledger.raw_records
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
             AND raw_payload_ref LIKE 'encrypted:%'
           ORDER BY raw_payload_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const installationKeyId = "installationKeyId" in identity ? identity.installationKeyId : undefined;
    const batchPayloads = body.deletion_scope === "installation"
      ? await client.query<{ body_ref: string }>(
          `SELECT DISTINCT batch.body_ref
           FROM ledger.ingest_batches AS batch
           LEFT JOIN ledger.ingest_batch_records AS member
             ON member.ingest_batch_id=batch.ingest_batch_id
            AND member.tenant_id=batch.tenant_id AND member.app_id=batch.app_id
           WHERE batch.tenant_id=$1 AND batch.app_id=$2
             AND (member.record_id=ANY($3::text[]) OR batch.installation_key_id=$4
               OR batch.subject_digest=$5)
             AND NOT EXISTS (
               SELECT 1 FROM ledger.ingest_batch_records AS shared
                WHERE shared.ingest_batch_id=batch.ingest_batch_id
                  AND NOT (shared.record_id=ANY($3::text[]))
             )
           ORDER BY batch.body_ref`,
          [body.tenant_id, body.app_id, records, installationKeyId ?? null,
            "deletionSubjectDigest" in identity ? identity.deletionSubjectDigest ?? null : null],
        )
      : await client.query<{ body_ref: string }>(
          `SELECT body_ref FROM ledger.ingest_batches
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY inbox_seq`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const adServicesPayloads = body.deletion_scope === "installation"
      ? await client.query<{ response_ref: string }>(
          `SELECT response_ref FROM ledger.adservices_lookup_results
           WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=ANY($3::text[])
           ORDER BY response_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ response_ref: string }>(
          `SELECT response_ref FROM ledger.adservices_lookup_results
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY response_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const pendingAdServicesPayloads = body.deletion_scope === "installation"
      ? await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.adservices_lookups
           WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=ANY($3::text[])
           ORDER BY token_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.adservices_lookups
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY token_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const pendingIntegrityPayloads = body.deletion_scope === "installation"
      ? await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.integrity_verifications
           WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=ANY($3::text[])
           ORDER BY token_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.integrity_verifications
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY token_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const integrityResultPayloads = body.deletion_scope === "installation"
      ? await client.query<{ evidence_ref: string }>(
          `SELECT evidence_ref FROM ledger.integrity_verification_results
           WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=ANY($3::text[])
             AND evidence_ref IS NOT NULL ORDER BY evidence_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ evidence_ref: string }>(
          `SELECT evidence_ref FROM ledger.integrity_verification_results
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
             AND evidence_ref IS NOT NULL ORDER BY evidence_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const googlePlayResultPayloads = body.deletion_scope === "installation"
      ? await client.query<{ evidence_ref: string }>(
          `SELECT evidence_ref FROM ledger.google_play_purchase_verification_results
           WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=ANY($3::text[])
             AND evidence_ref IS NOT NULL ORDER BY evidence_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ evidence_ref: string }>(
          `SELECT evidence_ref FROM ledger.google_play_purchase_verification_results
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
             AND evidence_ref IS NOT NULL ORDER BY evidence_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const pendingGooglePlayPayloads = body.deletion_scope === "installation"
      ? await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.google_play_product_verifications
           WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=ANY($3::text[])
           ORDER BY token_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.google_play_product_verifications
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3) ORDER BY token_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const googlePlayRtdnPayloads = body.deletion_scope === "installation"
      ? await client.query<{ evidence_ref: string }>(
          `SELECT evidence_ref FROM control.google_play_rtdn_messages
           WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=ANY($3::text[])
           ORDER BY evidence_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ evidence_ref: string }>(
          `SELECT evidence_ref FROM control.google_play_rtdn_messages
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3) ORDER BY evidence_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const googleConversionPayloads = body.deletion_scope === "installation"
      ? await client.query<{ request_ref: string }>(
          `SELECT request_ref FROM ephemeral.google_conversion_deliveries
           WHERE tenant_id=$1 AND app_id=$2 AND verified_record_id=ANY($3::text[])
           ORDER BY request_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ request_ref: string }>(
          `SELECT request_ref FROM ephemeral.google_conversion_deliveries
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3) ORDER BY request_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const operatorWebhookPayloads = body.deletion_scope === "installation"
      ? await client.query<{
          delivery_id: string;
          destination_id: string;
          app_id: string;
          request_ref: string;
          request_digest: string;
          attempts: number;
        }>(
          `SELECT delivery_id::text,destination_id,app_id,request_ref,request_digest,attempts
             FROM ephemeral.operator_webhook_deliveries
            WHERE tenant_id=$1 AND app_id=$2 AND record_id=ANY($3::text[])
              AND state IN ('queued','retry')
            ORDER BY delivery_id FOR UPDATE`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{
          delivery_id: string;
          destination_id: string;
          app_id: string;
          request_ref: string;
          request_digest: string;
          attempts: number;
        }>(
          `SELECT delivery_id::text,destination_id,app_id,request_ref,request_digest,attempts
             FROM ephemeral.operator_webhook_deliveries
            WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
              AND state IN ('queued','retry')
            ORDER BY delivery_id FOR UPDATE`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const operatorBulkDestinations = await client.query<{
      destination_id: string;
      app_id: string;
      reference_secret_ref: string;
    }>(
      `SELECT destination_id,app_id,reference_secret_ref
         FROM control.operator_bulk_export_destinations_current
        WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3) AND status='active'
        ORDER BY app_id,destination_id`,
      [body.tenant_id, body.deletion_scope, body.app_id],
    );
    const operatorBulkPayloads: Array<{
      batch_id: string;
      destination_id: string;
      app_id: string;
      object_ref: string;
      object_key: string;
      object_digest: string;
      attempts: number;
    }> = [];
    for (const destination of operatorBulkDestinations.rows) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-bulk-destination:' || $1 || ':' || $2 || ':' || $3,0))",
        [body.tenant_id, destination.app_id, destination.destination_id],
      );
      const secret = await payloadStore.read(destination.reference_secret_ref);
      const subjectRef = operatorWebhookReference(secret, "subject_ref", body.deletion_subject_ref);
      const deletionArtifact = {
        destination_id: destination.destination_id,
        tenant_id: body.tenant_id,
        app_id: destination.app_id,
        privacy_request_id: requestId,
        subject_ref: subjectRef,
        recognized_at: completedAt,
      };
      await client.query(
        `INSERT INTO ledger.operator_bulk_export_deletions (
           destination_id,tenant_id,app_id,privacy_request_id,subject_ref,recognized_at,artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (tenant_id,app_id,destination_id,privacy_request_id) DO NOTHING`,
        [destination.destination_id, body.tenant_id, destination.app_id, requestId,
          subjectRef, completedAt, JSON.stringify(deletionArtifact)],
      );
      const pending = await client.query<{
        batch_id: string;
        destination_id: string;
        app_id: string;
        object_ref: string;
        object_key: string;
        object_digest: string;
        attempts: number;
      }>(
        `SELECT batch_id::text,destination_id,app_id,object_ref,object_key,object_digest,attempts
           FROM ephemeral.operator_bulk_export_batches
          WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state IN ('queued','retry')
          ORDER BY batch_id FOR UPDATE`,
        [body.tenant_id, destination.app_id, destination.destination_id],
      );
      operatorBulkPayloads.push(...pending.rows);
    }
    const commercePayloads = body.deletion_scope === "installation"
      ? await client.query<{ reference: string }>(
          `WITH protected_notifications AS (
             SELECT notification.provider,notification.notification_digest,notification.evidence_ref
               FROM control.commerce_provider_notifications AS notification
              WHERE notification.tenant_id=$1 AND notification.app_id=$2
                AND notification.subject_digest IN (
                SELECT token.token_digest
                  FROM control.google_play_purchase_tokens AS token
                  JOIN ledger.google_play_purchase_verification_results AS result
                    ON result.tenant_id=token.tenant_id AND result.app_id=token.app_id
                   AND result.verification_id=token.verification_id
                  JOIN ledger.purchase_facts AS purchase
                    ON purchase.tenant_id=result.tenant_id AND purchase.app_id=result.app_id
                   AND purchase.record_id=result.verified_record_id
                 WHERE purchase.installation_id=$3
                UNION
                SELECT binding.transaction_digest
                  FROM control.commerce_purchase_bindings AS binding
                 WHERE binding.tenant_id=$1 AND binding.app_id=$2 AND binding.installation_digest=$4
                UNION
                SELECT binding.original_transaction_digest
                  FROM control.commerce_purchase_bindings AS binding
                 WHERE binding.tenant_id=$1 AND binding.app_id=$2 AND binding.installation_digest=$4
                   AND binding.original_transaction_digest IS NOT NULL
                )
           )
           SELECT DISTINCT evidence_ref AS reference FROM protected_notifications
           UNION
           SELECT DISTINCT readback.cursor_ref AS reference
             FROM ephemeral.commerce_provider_readbacks AS readback
             JOIN protected_notifications AS notification
               ON notification.provider=readback.provider
              AND notification.notification_digest=readback.notification_digest
            WHERE readback.cursor_ref IS NOT NULL`,
          [body.tenant_id, body.app_id, body.deletion_subject_ref,
            commerceInstallationDigest(body.tenant_id, body.app_id, body.deletion_subject_ref)],
        )
      : await client.query<{ reference: string }>(
          `SELECT evidence_ref AS reference FROM control.commerce_provider_notifications
            WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
          UNION
          SELECT cursor_ref AS reference FROM ephemeral.commerce_provider_readbacks
            WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3) AND cursor_ref IS NOT NULL`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const credentialPayloads = body.deletion_scope === "installation"
      ? await client.query<{ installation_key_id: string; secret_ref: string }>(
          `SELECT installation_key_id,secret_ref
             FROM control.installation_credentials_current
            WHERE tenant_id=$1 AND app_id=$2 AND installation_id_digest=$3 AND status='active'
            ORDER BY installation_key_id`,
          [body.tenant_id, body.app_id, subjectDigest],
        )
      : { rows: [] as Array<{ installation_key_id: string; secret_ref: string }> };
    for (const credential of credentialPayloads.rows) {
      await client.query(
        `INSERT INTO control.installation_credential_states (
          installation_key_id,tenant_id,app_id,status,changed_at,reason_code,artifact
        ) VALUES ($1,$2,$3,'deleted',$4,'privacy_deletion',$5::jsonb)`,
        [credential.installation_key_id, body.tenant_id, body.app_id, completedAt,
          JSON.stringify({
            installation_key_id: credential.installation_key_id,
            status: "deleted",
            changed_at: completedAt,
            reason_code: "privacy_deletion",
          })],
      );
    }
    const protectedReferences = [...new Set([
      ...rawPayloads.rows.map((payload) => payload.raw_payload_ref),
      ...payloads.rows.map((payload) => payload.raw_query_ref),
      ...batchPayloads.rows.map((payload) => payload.body_ref),
      ...adServicesPayloads.rows.map((payload) => payload.response_ref),
      ...pendingAdServicesPayloads.rows.map((payload) => payload.token_ref),
      ...pendingIntegrityPayloads.rows.map((payload) => payload.token_ref),
      ...integrityResultPayloads.rows.map((payload) => payload.evidence_ref),
      ...googlePlayResultPayloads.rows.map((payload) => payload.evidence_ref),
      ...pendingGooglePlayPayloads.rows.map((payload) => payload.token_ref),
      ...googlePlayRtdnPayloads.rows.map((payload) => payload.evidence_ref),
      ...googleConversionPayloads.rows.map((payload) => payload.request_ref),
      ...operatorWebhookPayloads.rows.map((payload) => payload.request_ref),
      ...operatorBulkPayloads.map((payload) => payload.object_ref),
      ...commercePayloads.rows.map((payload) => payload.reference),
      ...credentialPayloads.rows.map((payload) => payload.secret_ref),
    ])].filter((reference) => reference.startsWith("encrypted:")).sort();
    for (const delivery of operatorWebhookPayloads.rows) {
      await client.query(
        `UPDATE ephemeral.operator_webhook_deliveries
            SET state='suppressed',safe_reason='privacy_suppressed',updated_at=$4
          WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3`,
        [body.tenant_id, delivery.app_id, delivery.delivery_id, completedAt],
      );
      const deliveryArtifact = {
        delivery_id: delivery.delivery_id,
        destination_id: delivery.destination_id,
        tenant_id: body.tenant_id,
        app_id: delivery.app_id,
        state: "suppressed",
        attempt: delivery.attempts,
        occurred_at: completedAt,
        request_digest: delivery.request_digest,
        reason_code: "privacy_suppressed",
      };
      await client.query(
        `INSERT INTO ledger.operator_webhook_delivery_results (
           delivery_result_id,delivery_id,tenant_id,app_id,destination_id,state,attempt,
           occurred_at,request_digest,reason_code,artifact
         ) VALUES ($1,$2,$3,$4,$5,'suppressed',$6,$7,$8,'privacy_suppressed',$9::jsonb)`,
        [uuidV7(Date.parse(completedAt) + delivery.attempts), delivery.delivery_id,
          body.tenant_id, delivery.app_id, delivery.destination_id, delivery.attempts,
          completedAt, delivery.request_digest, JSON.stringify(deliveryArtifact)],
      );
    }
    for (const batch of operatorBulkPayloads) {
      await client.query(
        `UPDATE ephemeral.operator_bulk_export_batches
            SET state='suppressed',safe_reason='privacy_suppressed',updated_at=$4
          WHERE tenant_id=$1 AND app_id=$2 AND batch_id=$3`,
        [body.tenant_id, batch.app_id, batch.batch_id, completedAt],
      );
      const exportArtifact = {
        batch_id: batch.batch_id,
        destination_id: batch.destination_id,
        tenant_id: body.tenant_id,
        app_id: batch.app_id,
        object_key: batch.object_key,
        object_digest: batch.object_digest,
        state: "suppressed",
        attempt: batch.attempts,
        occurred_at: completedAt,
        reason_code: "privacy_suppressed",
      };
      await client.query(
        `INSERT INTO ledger.operator_bulk_export_results (
           export_result_id,batch_id,tenant_id,app_id,destination_id,object_key,object_digest,
           state,attempt,occurred_at,reason_code,artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'suppressed',$8,$9,'privacy_suppressed',$10::jsonb)`,
        [uuidV7(Date.parse(completedAt) + batch.attempts), batch.batch_id, body.tenant_id,
          batch.app_id, batch.destination_id, batch.object_key, batch.object_digest,
          batch.attempts, completedAt, JSON.stringify(exportArtifact)],
      );
    }
    if (body.deletion_scope === "installation") {
      await client.query(
        `DELETE FROM ephemeral.adservices_lookups
         WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=ANY($3::text[])`,
        [body.tenant_id, body.app_id, records],
      );
    } else {
      await client.query(
        `DELETE FROM ephemeral.adservices_lookups
         WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)`,
        [body.tenant_id, body.deletion_scope, body.app_id],
      );
    }
    if (body.deletion_scope === "installation") {
      await client.query(
        `DELETE FROM ephemeral.integrity_verifications
         WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=ANY($3::text[])`,
        [body.tenant_id, body.app_id, records],
      );
    } else {
      await client.query(
        `DELETE FROM ephemeral.integrity_verifications
         WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)`,
        [body.tenant_id, body.deletion_scope, body.app_id],
      );
    }
    if (body.deletion_scope === "installation") {
      await client.query(
        `DELETE FROM ephemeral.google_conversion_deliveries
         WHERE tenant_id=$1 AND app_id=$2 AND verified_record_id=ANY($3::text[])`,
        [body.tenant_id, body.app_id, records],
      );
    } else {
      await client.query(
        `DELETE FROM ephemeral.google_conversion_deliveries
         WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)`,
        [body.tenant_id, body.deletion_scope, body.app_id],
      );
    }
    if (body.deletion_scope === "installation") {
      await client.query(
        `DELETE FROM ephemeral.google_play_product_verifications
         WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=ANY($3::text[])`,
        [body.tenant_id, body.app_id, records],
      );
    } else {
      await client.query(
        `DELETE FROM ephemeral.google_play_product_verifications
         WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)`,
        [body.tenant_id, body.deletion_scope, body.app_id],
      );
    }
    if (body.deletion_scope === "installation") {
      await client.query(
        `DELETE FROM ephemeral.commerce_provider_readbacks AS readback
          USING control.commerce_provider_notifications AS notification
          WHERE readback.provider=notification.provider
            AND readback.notification_digest=notification.notification_digest
            AND readback.tenant_id=$1 AND readback.app_id=$2
            AND notification.subject_digest IN (
              SELECT token.token_digest
                FROM control.google_play_purchase_tokens AS token
                JOIN ledger.google_play_purchase_verification_results AS result
                  ON result.tenant_id=token.tenant_id AND result.app_id=token.app_id
                 AND result.verification_id=token.verification_id
                JOIN ledger.purchase_facts AS purchase
                  ON purchase.tenant_id=result.tenant_id AND purchase.app_id=result.app_id
                 AND purchase.record_id=result.verified_record_id
               WHERE purchase.installation_id=$3
              UNION
              SELECT binding.transaction_digest FROM control.commerce_purchase_bindings AS binding
               WHERE binding.tenant_id=$1 AND binding.app_id=$2 AND binding.installation_digest=$4
              UNION
              SELECT binding.original_transaction_digest FROM control.commerce_purchase_bindings AS binding
               WHERE binding.tenant_id=$1 AND binding.app_id=$2 AND binding.installation_digest=$4
                 AND binding.original_transaction_digest IS NOT NULL
            )`,
        [body.tenant_id, body.app_id, body.deletion_subject_ref,
          commerceInstallationDigest(body.tenant_id, body.app_id, body.deletion_subject_ref)],
      );
    } else {
      await client.query(
        `DELETE FROM ephemeral.commerce_provider_readbacks
          WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)`,
        [body.tenant_id, body.deletion_scope, body.app_id],
      );
    }
    const artifactTemplate = {
      contract_version: "0.4.0",
      tenant_id: body.tenant_id,
      app_id: body.app_id,
      privacy_request_id: requestId,
      deletion_subject_digest: subjectDigest,
      deletion_scope: body.deletion_scope,
      requested_via: body.requested_via,
      requester_auth_ref: "requesterAuthRef" in identity ? identity.requesterAuthRef : `admin_key:${identity.keyId}`,
      requested_at: completedAt,
      reason_code: "privacy_deletion",
      policy_version: "privacy-v0.3",
      affected_records: records.map((record_id) => ({ record_id, lifecycle_status: "purged" })),
    };
    await client.query(
      `INSERT INTO control.privacy_deletion_jobs (
        privacy_request_id,tenant_id,app_id,status,requested_at,artifact_template,
        actor_type,actor_ref,request_digest,updated_at
      ) VALUES ($1,$2,$3,'processing',$4,$5::jsonb,$6,$7,$8,$4)`,
      [requestId, body.tenant_id, body.app_id, completedAt, JSON.stringify(artifactTemplate),
        "actorType" in identity ? identity.actorType : "admin_key",
        "actorRef" in identity ? identity.actorRef : `admin_key:${identity.keyId}`,
        sha256(body)],
    );
    for (const reference of protectedReferences) {
      await client.query(
        `INSERT INTO control.privacy_payload_purges (
          privacy_request_id,tenant_id,app_id,reference_digest,payload_ref,status,updated_at
        ) VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
        [requestId, body.tenant_id, body.app_id, sha256(reference), reference, completedAt],
      );
    }
    for (const recordId of records) {
      const tombstone = {
        contract_version: "0.4.0", tenant_id: body.tenant_id, app_id: body.app_id,
        privacy_request_id: requestId, record_id: recordId, lifecycle_status: "purged",
        reason_code: "privacy_deletion", policy_version: "privacy-v0.3",
        provenance_digest: sha256([requestId, recordId, completedAt]), created_at: completedAt,
      };
      await client.query(
        `INSERT INTO ledger.raw_payload_states (
          tenant_id, app_id, record_id, lifecycle_status, changed_at, privacy_request_id,
          privacy_tombstone_id
        ) VALUES ($1,$2,$3,'purged',$4,$5,$6)
        ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
        [body.tenant_id, body.app_id, recordId, completedAt, requestId,
          `tombstone:${sha256([requestId, recordId]).slice(0, 48)}`],
      );
      await client.query(
        `INSERT INTO ledger.privacy_tombstones (
          tenant_id, app_id, privacy_request_id, record_id, lifecycle_status, created_at, artifact
        ) VALUES ($1,$2,$3,$4,'purged',$5,$6::jsonb)
        ON CONFLICT DO NOTHING`,
        [body.tenant_id, body.app_id, requestId, recordId, completedAt, JSON.stringify(tombstone)],
      );
      const correction = {
        contract_version: "0.4.0", tenant_id: body.tenant_id, app_id: body.app_id,
        correction_id: `correction:${sha256([requestId, recordId]).slice(0, 48)}`,
        corrects_record_id: recordId, correction_type: "redaction",
        correction_reason: "privacy_deletion", effective_at: completedAt,
      };
      await client.query(
        `INSERT INTO ledger.corrections (
          correction_id, tenant_id, app_id, corrects_record_id, effective_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
        [correction.correction_id, body.tenant_id, body.app_id, recordId, completedAt, JSON.stringify(correction)],
      );
    }
    const previousRuns = await client.query<Any>(
      `SELECT artifact FROM ledger.metric_runs
       WHERE tenant_id=$1 AND app_id=$2 AND metric_name IN (
         'd0_install_to_24h_ad_revenue_usd',
         'd0_utc_install_calendar_ad_revenue_usd',
         'd0_jst_install_calendar_ad_revenue_usd',
         'cohort_purchase_net_revenue_d0_usd',
         'cohort_purchase_net_revenue_d1_usd',
         'cohort_purchase_net_revenue_d3_usd',
         'cohort_purchase_net_revenue_d7_usd',
         'cohort_purchase_net_revenue_d30_usd',
         'cohort_purchase_net_revenue_d90_usd',
         'cohort_total_net_revenue_d30_usd',
         'cohort_total_net_revenue_d90_usd',
         'd30_total_net_roas',
         'd90_total_net_roas',
         'cohort_total_net_ltv_d30_usd',
         'cohort_total_net_ltv_d90_usd'
       ) ORDER BY metric_name, computed_at DESC`,
      [body.tenant_id, body.app_id],
    );
    const seen = new Set<string>();
    for (const row of previousRuns.rows) {
      const prior = row.artifact;
      if (seen.has(prior.metric_name)) continue;
      seen.add(prior.metric_name);
      const replacement = {
        ...prior,
        metric_run_id: `metric:${sha256([requestId, prior.metric_run_id]).slice(0, 48)}`,
        input_snapshot_id: sha256([prior.input_snapshot_id, requestId, records]),
        computed_at: completedAt,
        data_freshness: "recalculated",
        reproducibility_status: "redaction_affected",
        supersedes_metric_run_id: prior.metric_run_id,
      };
      await client.query(
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
        ) ON CONFLICT DO NOTHING`,
        [replacement.metric_run_id, body.tenant_id, body.app_id, replacement.metric_name,
          replacement.metric_definition_version, JSON.stringify(replacement.grouping?.dimensions ?? {}),
          replacement.grouping?.dimension_digest ?? sha256({}), replacement.input_snapshot_id,
          replacement.input_received_at_watermark, replacement.input_ledger_position,
          replacement.computed_at, replacement.data_freshness, replacement.aggregation_time_zone,
          replacement.rule_bundle_id, replacement.rule_bundle_version, replacement.rule_bundle_hash,
          replacement.fx_rate_unscaled ?? null, replacement.fx_rate_scale ?? null,
          replacement.fx_rate_source ?? null, replacement.fx_rate_as_of ?? null,
          replacement.fx_rate_snapshot_id ?? null, replacement.fx_policy_version ?? null,
          replacement.rounding_mode, replacement.reproducibility_status, replacement.value_type,
          replacement.value_state ?? "present", replacement.undefined_reason ?? null,
          replacement.value_unscaled ?? null, replacement.amount_scale ?? null, replacement.currency ?? null,
          replacement.supersedes_metric_run_id, JSON.stringify(replacement)],
      );
    }
    const { deletion_subject_digest: _completedDigest, ...processingTemplate } = artifactTemplate;
    return {
      processingArtifact: {
        ...processingTemplate,
        deletion_subject_ref: body.deletion_subject_ref,
        status: "processing",
      },
    };
  });
  try {
    const purge = await processPrivacyDeletionRequest({
      pool,
      payloadStore,
      tenantId: body.tenant_id,
      privacyRequestId: requestId,
      now: now ? () => now : undefined,
    });
    return purge.artifact ?? prepared.processingArtifact;
  } catch {
    // Recognition is already durable and fail closed. A synchronous worker
    // failure must not turn an accepted deletion into a client-visible 5xx;
    // the scheduled worker resumes the same request from PostgreSQL.
    return prepared.processingArtifact;
  }
}

export function privacyResponseStatus(artifact: Any): 201 | 202 {
  return artifact.status === "completed" ? 201 : 202;
}
