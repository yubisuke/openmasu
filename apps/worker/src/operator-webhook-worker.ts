import { buildOperatorWebhookRequest, webhookCandidateSelect, type OperatorWebhookCandidate, type PreparedOperatorWebhook } from "@openmasu/runtime/operator-webhook-envelope";
export { buildOperatorEvent, buildOperatorWebhookRequest, type OperatorWebhookCandidate, type OperatorEvent, type OperatorWebhookEnvelope, type PreparedOperatorWebhook } from "@openmasu/runtime/operator-webhook-envelope";
import { createHash } from "node:crypto";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Pool, PoolClient } from "pg";
import { comparisonNotificationEligible, lockComparisonNotifications } from "@openmasu/runtime/recurring-comparisons";
import { webhookSigningRevision } from "@openmasu/runtime/operator-webhook-signing";
import { recognizedWebhookDeletion } from "./operator-webhook-deletions.js";
import {
  operatorWebhookSignature,
  recordJobOutcome,
  resolveWebhookEndpoint,
  uuidV7,
  withTenant,
  type OperatorWebhookEventName,
  type PayloadStore,
  type WebhookLookup,
} from "@openmasu/runtime";

type DeliveryRow = {
  policy_revision: string | null;
  delivery_id: string;
  destination_id: string;
  endpoint_url: string;
  signing_revision: string;
  app_id: string;
  record_id: string | null;
  comparison_id: string | null;
  event_name: string;
  subject_ref: string | null;
  privacy_request_id: string | null;
  request_ref: string;
  request_digest: string;
  state: "queued" | "retry";
  attempts: number;
  created_at: string;
  destination_status: "active" | "disabled";
  deletion_notifications: boolean;
  payload_lifecycle_status: "available" | "redacted" | "purged";
  withdrawal_recognized_at: string | null;
  tombstoned: boolean;
};

export type OperatorWebhookDeliveryResult =
  | Readonly<{ outcome: "accepted"; httpStatus: number }>
  | Readonly<{ outcome: "retry"; reason: string; httpStatus?: number }>
  | Readonly<{ outcome: "suppressed"; reason: "signing_key_expired" }>
  | Readonly<{ outcome: "terminal"; reason: string; httpStatus?: number }>;

export type OperatorWebhookTransportOptions = Readonly<{
  destinationAllowlist: readonly string[];
  attempt: number;
  signingRevision?: number;
  signingValidUntil?: string | null;
  now?: () => Date;
  allowSyntheticLoopback?: boolean;
  timeoutMilliseconds?: number;
  maximumRequestBytes?: number;
  lookup?: WebhookLookup;
}>;

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export async function sendOperatorWebhook(
  prepared: Pick<PreparedOperatorWebhook, "deliveryId" | "endpointUrl" | "body" | "requestDigest">,
  secret: Buffer,
  options: OperatorWebhookTransportOptions,
): Promise<OperatorWebhookDeliveryResult> {
  const maximumRequestBytes = options.maximumRequestBytes ?? 64 * 1024;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
  if (!Number.isSafeInteger(maximumRequestBytes) || maximumRequestBytes < 1 || maximumRequestBytes > 1024 * 1024
    || prepared.body.length > maximumRequestBytes) {
    return { outcome: "terminal", reason: "request_too_large" };
  }
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 30_000) {
    throw new Error("operator_webhook_timeout_invalid");
  }
  let resolved;
  try {
    resolved = await resolveWebhookEndpoint(prepared.endpointUrl, options.destinationAllowlist, {
      allowSyntheticLoopback: options.allowSyntheticLoopback,
      lookup: options.lookup,
      resolutionTimeoutMilliseconds: timeoutMilliseconds,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "operator_webhook_endpoint_rejected";
    if (reason === "operator_webhook_dns_empty" || reason === "operator_webhook_dns_timeout") {
      return { outcome: "retry", reason: "dns_unavailable" };
    }
    return { outcome: "terminal", reason: "endpoint_rejected" };
  }
  // DNS and protected-payload reads may outlast an overlap deadline. Check at
  // the request boundary, not only when the worker's batch was selected.
  if (options.signingValidUntil && (options.now?.() ?? new Date()).valueOf() >= Date.parse(options.signingValidUntil)) {
    return { outcome: "suppressed", reason: "signing_key_expired" };
  }
  const signature = operatorWebhookSignature(secret, prepared.body);
  const requestFactory = resolved.url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, resolved.address, resolved.family);
  };
  const requestOptions: RequestOptions = {
    protocol: resolved.url.protocol,
    hostname: resolved.url.hostname,
    port: resolved.url.port || undefined,
    path: `${resolved.url.pathname}`,
    method: "POST",
    agent: false,
    lookup,
    headers: {
      "content-type": "application/json",
      "content-length": String(prepared.body.length),
      "user-agent": "OpenMasu-Operator-Webhook/1",
      "x-openmasu-delivery-id": prepared.deliveryId,
      "x-openmasu-attempt": String(options.attempt),
      "x-openmasu-key-revision": String(options.signingRevision ?? 1),
      "x-openmasu-signature": signature,
    },
  };
  return new Promise((resolve) => {
    const request = requestFactory(requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      if (status >= 200 && status < 300) resolve({ outcome: "accepted", httpStatus: status });
      else if ([408, 425, 429].includes(status) || status >= 500) {
        resolve({ outcome: "retry", reason: status === 429 ? "rate_limited" : "receiver_unavailable", httpStatus: status });
      } else if (status >= 300 && status < 400) {
        resolve({ outcome: "terminal", reason: "redirect_rejected", httpStatus: status });
      } else resolve({ outcome: "terminal", reason: "receiver_rejected", httpStatus: status || undefined });
    });
    request.setTimeout(timeoutMilliseconds, () => request.destroy(new Error("operator_webhook_timeout")));
    request.once("error", (error) => resolve({
      outcome: "retry",
      reason: error instanceof Error && error.message === "operator_webhook_timeout" ? "timeout" : "transport_error",
    }));
    request.end(prepared.body);
  });
}

async function lockRecord(client: PoolClient, recordId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook:' || $1,0))",
    [recordId],
  );
}

async function lockDestination(
  client: PoolClient,
  tenantId: string,
  appId: string,
  destinationId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook-destination:' || $1 || ':' || $2 || ':' || $3,0))",
    [tenantId, appId, destinationId],
  );
}

async function appendResult(
  client: PoolClient,
  row: Pick<DeliveryRow, "delivery_id" | "destination_id" | "app_id" | "request_digest" | "signing_revision" | "policy_revision">,
  tenantId: string,
  state: "retry" | "succeeded" | "failed" | "suppressed",
  attempt: number,
  occurredAt: string,
  reason?: string,
  httpStatus?: number,
): Promise<void> {
  const artifact = {
    delivery_id: row.delivery_id,
    destination_id: row.destination_id,
    tenant_id: tenantId,
    app_id: row.app_id,
    state,
    attempt,
    occurred_at: occurredAt,
    request_digest: row.request_digest,
    signing_revision: Number(row.signing_revision),
    ...(row.policy_revision ? { policy_revision: Number(row.policy_revision) } : {}),
    ...(httpStatus ? { http_status: httpStatus } : {}),
    ...(reason ? { reason_code: reason } : {}),
  };
  await client.query(
    `INSERT INTO ledger.operator_webhook_delivery_results (
       delivery_result_id,delivery_id,tenant_id,app_id,destination_id,state,attempt,
       occurred_at,request_digest,http_status,reason_code,artifact
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [uuidV7(Date.parse(occurredAt) + attempt), row.delivery_id, tenantId, row.app_id,
      row.destination_id, state, attempt, occurredAt, row.request_digest,
      httpStatus ?? null, reason ?? null, JSON.stringify(artifact)],
  );
}

export async function discoverOperatorWebhookDeliveries(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  now = new Date(),
): Promise<number> {
  const candidates = await withTenant(pool, tenantId, (client) => client.query<OperatorWebhookCandidate>(
    `${webhookCandidateSelect}      WHERE destination.tenant_id=$1 AND destination.status='active'
        AND (policy.policy_revision IS NULL OR policy.definition->>'mode'='legacy_v1'
          OR logical.event_name<>'custom_event' OR policy.definition->'custom_events' ? custom.event_key)
        AND raw.received_at_ts >= control.canonical_timestamp_value(destination.created_at)
        AND logical.record_lifecycle='active'
        AND raw.payload_lifecycle_status='available'
        AND raw.withdrawal_recognized_at IS NULL
        AND raw.consent_decision_reason_code <> 'consent_withdrawn'
        AND COALESCE(session.logical_event_id,custom.logical_event_id,purchase.logical_event_id,
                     refund.logical_event_id,revenue.logical_event_id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ledger.privacy_tombstones AS tombstone
          WHERE tombstone.tenant_id=logical.tenant_id AND tombstone.app_id=logical.app_id
            AND tombstone.record_id=logical.record_id)
        AND NOT EXISTS (SELECT 1 FROM ephemeral.operator_webhook_deliveries AS delivery
          WHERE delivery.tenant_id=logical.tenant_id AND delivery.app_id=logical.app_id
            AND delivery.destination_id=destination.destination_id
            AND delivery.logical_event_id=logical.logical_event_id)
      ORDER BY destination.destination_id,logical.logical_event_id LIMIT 500`,
    [tenantId, null],
  ));
  let created = 0;
  for (const candidate of candidates.rows) {
    const secret = await payloadStore.read(candidate.secret_ref);
    const deliveryId = uuidV7(now.valueOf() + created);
    const prepared = buildOperatorWebhookRequest({
      candidate,
      deliveryId,
      emittedAt: now.toISOString(),
      secret,
    });
    const requestRef = await payloadStore.write({
      tenantId,
      appId: candidate.app_id,
      objectId: `operator-webhook-${deliveryId}`,
    }, prepared.body);
    try {
      const inserted = await withTenant(pool, tenantId, async (client) => {
        await lockRecord(client, candidate.record_id);
        await lockDestination(client, tenantId, candidate.app_id, candidate.destination_id);
        const eligible = await client.query<{ eligible: boolean }>(
          `SELECT destination.status='active'
                  AND (SELECT policy_revision FROM control.operator_webhook_content_revisions
                    WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND created_at<=raw.received_at
                    ORDER BY policy_revision DESC LIMIT 1) IS NOT DISTINCT FROM $5::bigint
                  AND raw.payload_lifecycle_status='available'
                  AND raw.withdrawal_recognized_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM ledger.privacy_tombstones AS tombstone
                    WHERE tombstone.tenant_id=$1 AND tombstone.app_id=$2 AND tombstone.record_id=$4)
                  AS eligible
             FROM control.operator_webhook_destinations AS base
             JOIN control.operator_webhook_destinations_current AS destination
               USING (destination_id,tenant_id,app_id)
             JOIN ledger.raw_records_current AS raw
               ON raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=$4
            WHERE base.tenant_id=$1 AND base.app_id=$2 AND base.destination_id=$3`,
          [tenantId, candidate.app_id, candidate.destination_id, candidate.record_id, candidate.policy_revision ?? null],
        );
        if (!eligible.rows[0]?.eligible) return false;
        const signing = await webhookSigningRevision(client, { tenantId, appId: candidate.app_id },
          candidate.destination_id, undefined, now);
        if (!signing) return false;
        const result = await client.query(
          `INSERT INTO ephemeral.operator_webhook_deliveries (
             delivery_id,tenant_id,app_id,destination_id,logical_event_id,record_id,event_name,
             request_ref,request_digest,state,attempts,next_attempt_at,created_at,updated_at,signing_revision,subject_ref,policy_revision
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',0,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (tenant_id,app_id,destination_id,logical_event_id) DO NOTHING`,
          [deliveryId, tenantId, candidate.app_id, candidate.destination_id, candidate.logical_event_id,
            candidate.record_id, candidate.event_name, requestRef, prepared.requestDigest,
            now.toISOString(), now.toISOString(), now.toISOString(), signing.signing_revision, prepared.envelope.event.subject_ref ?? null, candidate.policy_revision ?? null],
        );
        return result.rowCount === 1;
      });
      if (inserted) created += 1;
      else await payloadStore.purge(requestRef);
    } catch (error) {
      await payloadStore.purge(requestRef);
      throw error;
    }
  }
  return created;
}

export async function processOperatorWebhookDeliveries(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: Readonly<{
    enabled: boolean;
    destinationAllowlist: readonly string[];
    allowSyntheticLoopback?: boolean;
    now?: () => Date;
    lookup?: WebhookLookup;
    timeoutMilliseconds?: number;
    maximumAttempts?: number;
  }>,
): Promise<{ processed: number }> {
  if (!options.enabled) return { processed: 0 };
  const maximumAttempts = options.maximumAttempts ?? 8;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 32) {
    throw new Error("operator_webhook_maximum_attempts_invalid");
  }
  const now = options.now?.() ?? new Date();
  const due = await withTenant(pool, tenantId, (client) => client.query<{ delivery_id: string }>(
    `SELECT delivery_id::text FROM ephemeral.operator_webhook_deliveries
      WHERE tenant_id=$1 AND state IN ('queued','retry') AND next_attempt_at <= $2
      ORDER BY next_attempt_at,delivery_id LIMIT 100`,
    [tenantId, now.toISOString()],
  ));
  let processed = 0;
  for (const { delivery_id: deliveryId } of due.rows) {
    let purgeRef: string | undefined;
    let appId: string | undefined;
    await withTenant(pool, tenantId, async (client) => {
      const candidate = await client.query<{ record_id: string | null; comparison_id: string | null; app_id: string; destination_id: string }>(
        `SELECT record_id,comparison_id,app_id,destination_id
           FROM ephemeral.operator_webhook_deliveries
          WHERE tenant_id=$1 AND delivery_id=$2
            AND state IN ('queued','retry') AND next_attempt_at <= $3`,
        [tenantId, deliveryId, now.toISOString()],
      );
      if (!candidate.rows[0]) return;
      // Privacy deletion takes this advisory lock before it locks delivery rows.
      // Use the same order here so the privacy/dispatch race cannot deadlock.
      if (candidate.rows[0].comparison_id) await lockComparisonNotifications(client, tenantId);
      else if (candidate.rows[0].record_id) await lockRecord(client, candidate.rows[0].record_id);
      await lockDestination(
        client,
        tenantId,
        candidate.rows[0].app_id,
        candidate.rows[0].destination_id,
      );
      const attemptAt = options.now?.() ?? new Date();
      const selected = await client.query<DeliveryRow>(
        `SELECT delivery.delivery_id::text,delivery.destination_id,destination.endpoint_url,
                delivery.signing_revision::text,delivery.policy_revision::text,delivery.app_id,delivery.record_id,delivery.comparison_id,delivery.request_ref,
                delivery.event_name,delivery.subject_ref,delivery.privacy_request_id,destination.deletion_notifications,
                delivery.request_digest,delivery.state,delivery.attempts,delivery.created_at,
                destination.status AS destination_status,
                raw.payload_lifecycle_status,raw.withdrawal_recognized_at,
                EXISTS (SELECT 1 FROM ledger.privacy_tombstones AS tombstone
                  WHERE tombstone.tenant_id=delivery.tenant_id AND tombstone.app_id=delivery.app_id
                    AND tombstone.record_id=delivery.record_id) AS tombstoned
           FROM ephemeral.operator_webhook_deliveries AS delivery
           JOIN control.operator_webhook_destinations AS base
             ON base.tenant_id=delivery.tenant_id AND base.app_id=delivery.app_id
            AND base.destination_id=delivery.destination_id
           JOIN control.operator_webhook_destinations_current AS destination
             ON destination.tenant_id=base.tenant_id AND destination.app_id=base.app_id
            AND destination.destination_id=base.destination_id
           LEFT JOIN ledger.raw_records_current AS raw
             ON raw.tenant_id=delivery.tenant_id AND raw.app_id=delivery.app_id
            AND raw.record_id=delivery.record_id
          WHERE delivery.tenant_id=$1 AND delivery.delivery_id=$2
            AND delivery.state IN ('queued','retry') AND delivery.next_attempt_at <= $3
          FOR UPDATE OF delivery`,
        [tenantId, deliveryId, attemptAt.toISOString()],
      );
      const row = selected.rows[0];
      if (!row) return;
      appId = row.app_id;
      const attempt = row.attempts + 1;
      const signing = await webhookSigningRevision(client, { tenantId, appId: row.app_id },
        row.destination_id, Number(row.signing_revision), attemptAt);
      const suppressed = row.destination_status !== "active"
        ? "destination_disabled"
        : !signing ? "signing_key_unavailable"
        : signing.state === "retired" ? "signing_key_retired"
        : signing.state === "expired" ? "signing_key_expired"
        : row.event_name === "subject_deletion"
          ? !row.deletion_notifications ? "deletion_notifications_disabled"
            : !row.privacy_request_id || !row.subject_ref || !await recognizedWebhookDeletion(client,
              { tenantId, appId: row.app_id }, row.destination_id, row.privacy_request_id, row.subject_ref)
              ? "deletion_not_recognized" : undefined
        : row.comparison_id
          ? await comparisonNotificationEligible(client, { tenantId,appId:row.app_id }, row.delivery_id, attemptAt) ? undefined : "comparison_suppressed"
        : row.payload_lifecycle_status !== "available" || row.withdrawal_recognized_at || row.tombstoned
          ? "privacy_suppressed"
          : undefined;
      if (suppressed || !signing) {
        const reason = suppressed ?? "signing_key_unavailable";
        await client.query(
          `UPDATE ephemeral.operator_webhook_deliveries
              SET state='suppressed',attempts=$3,safe_reason=$4,updated_at=$5
            WHERE tenant_id=$1 AND delivery_id=$2`,
          [tenantId, row.delivery_id, attempt, reason, attemptAt.toISOString()],
        );
        await appendResult(client, row, tenantId, "suppressed", attempt, attemptAt.toISOString(), reason);
        purgeRef = row.request_ref;
        processed += 1;
        return;
      }
      let secret: Buffer;
      let body: Buffer;
      try {
        [secret, body] = await Promise.all([
          payloadStore.read(signing.secret_ref), payloadStore.read(row.request_ref),
        ]);
      } catch {
        await client.query(
          `UPDATE ephemeral.operator_webhook_deliveries
              SET state='failed',attempts=$3,safe_reason='protected_payload_unavailable',updated_at=$4
            WHERE tenant_id=$1 AND delivery_id=$2`,
          [tenantId, row.delivery_id, attempt, attemptAt.toISOString()],
        );
        await appendResult(client, row, tenantId, "failed", attempt, attemptAt.toISOString(), "protected_payload_unavailable");
        purgeRef = row.request_ref;
        processed += 1;
        return;
      }
      if (sha256(body) !== row.request_digest) {
        await client.query(
          `UPDATE ephemeral.operator_webhook_deliveries
              SET state='failed',attempts=$3,safe_reason='request_digest_mismatch',updated_at=$4
            WHERE tenant_id=$1 AND delivery_id=$2`,
          [tenantId, row.delivery_id, attempt, attemptAt.toISOString()],
        );
        await appendResult(client, row, tenantId, "failed", attempt, attemptAt.toISOString(), "request_digest_mismatch");
        purgeRef = row.request_ref;
        processed += 1;
        return;
      }
      const result = await sendOperatorWebhook({
        deliveryId: row.delivery_id,
        endpointUrl: row.endpoint_url,
        body,
        requestDigest: row.request_digest,
      }, secret, {
        destinationAllowlist: options.destinationAllowlist,
        attempt,
        signingRevision: signing.signing_revision,
        signingValidUntil: signing.valid_until,
        now: options.now,
        allowSyntheticLoopback: options.allowSyntheticLoopback,
        lookup: options.lookup,
        timeoutMilliseconds: options.timeoutMilliseconds,
      });
      let state: "retry" | "succeeded" | "failed" | "suppressed";
      let reason: string | undefined;
      if (result.outcome === "accepted") state = "succeeded";
      else if (result.outcome === "suppressed") { state = "suppressed"; reason = result.reason; }
      else if (result.outcome === "terminal" || attempt >= maximumAttempts) {
        state = "failed";
        reason = result.outcome === "terminal" ? result.reason : "retry_exhausted";
      } else {
        state = "retry";
        reason = result.reason;
      }
      const completedAt = options.now?.() ?? new Date();
      const nextAttemptAt = new Date(completedAt.valueOf() + Math.min(3_600_000, 60_000 * (2 ** Math.min(attempt - 1, 6))));
      await client.query(
        `UPDATE ephemeral.operator_webhook_deliveries
            SET state=$3,attempts=$4,next_attempt_at=$5,last_http_status=$6,
                safe_reason=$7,updated_at=$8
          WHERE tenant_id=$1 AND delivery_id=$2`,
        [tenantId, row.delivery_id, state, attempt, nextAttemptAt.toISOString(),
          "httpStatus" in result ? result.httpStatus ?? null : null,
          reason ?? null, completedAt.toISOString()],
      );
      await appendResult(client, row, tenantId, state, attempt, completedAt.toISOString(), reason,
        "httpStatus" in result ? result.httpStatus : undefined);
      if (state !== "retry") purgeRef = row.request_ref;
      processed += 1;
    });
    if (purgeRef) await payloadStore.purge(purgeRef);
    if (appId) await recordJobOutcome({
      pool, tenantId, appId, job: "operator_webhook_delivery", outcome: "succeeded", now,
    });
  }
  return { processed };
}
