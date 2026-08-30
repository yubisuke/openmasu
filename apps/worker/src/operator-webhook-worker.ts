import { createHash } from "node:crypto";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Pool, PoolClient } from "pg";
import {
  operatorWebhookReference,
  operatorWebhookSignature,
  recordJobOutcome,
  resolveWebhookEndpoint,
  uuidV7,
  withTenant,
  type OperatorWebhookEventName,
  type PayloadStore,
  type WebhookLookup,
} from "@openmasu/runtime";

type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

export type OperatorWebhookCandidate = {
  destination_id: string;
  endpoint_url: string;
  secret_ref: string;
  logical_event_id: string;
  record_id: string;
  app_id: string;
  event_name: OperatorWebhookEventName;
  occurred_at: string;
  installation_id: string | null;
  event_key: string | null;
  transaction_id: string | null;
  original_transaction_id: string | null;
  amount_unscaled: string | null;
  amount_scale: number | null;
  currency: string | null;
  financial_status: string | null;
  revenue_source: string | null;
  ad_network: string | null;
  country: string | null;
};

type DeliveryRow = {
  delivery_id: string;
  destination_id: string;
  endpoint_url: string;
  secret_ref: string;
  app_id: string;
  record_id: string;
  request_ref: string;
  request_digest: string;
  state: "queued" | "retry";
  attempts: number;
  created_at: string;
  destination_status: "active" | "disabled";
  payload_lifecycle_status: "available" | "redacted" | "purged";
  withdrawal_recognized_at: string | null;
  tombstoned: boolean;
};

export type OperatorEvent = Readonly<{
  name: OperatorWebhookEventName;
  event_ref: string;
  occurred_at: string;
  subject_ref?: string;
  details: JsonObject;
}>;

export type OperatorWebhookEnvelope = Readonly<{
  schema: "openmasu.operator_event.v1";
  delivery_id: string;
  emitted_at: string;
  app_id: string;
  event: OperatorEvent;
}>;

export type PreparedOperatorWebhook = Readonly<{
  deliveryId: string;
  endpointUrl: string;
  envelope: OperatorWebhookEnvelope;
  body: Buffer;
  requestDigest: string;
}>;

export type OperatorWebhookDeliveryResult =
  | Readonly<{ outcome: "accepted"; httpStatus: number }>
  | Readonly<{ outcome: "retry"; reason: string; httpStatus?: number }>
  | Readonly<{ outcome: "terminal"; reason: string; httpStatus?: number }>;

export type OperatorWebhookTransportOptions = Readonly<{
  destinationAllowlist: readonly string[];
  attempt: number;
  allowSyntheticLoopback?: boolean;
  timeoutMilliseconds?: number;
  maximumRequestBytes?: number;
  lookup?: WebhookLookup;
}>;

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function moneyDetails(candidate: OperatorWebhookCandidate, secret: Buffer): JsonObject {
  if (candidate.amount_unscaled === null || candidate.amount_scale === null || candidate.currency === null) {
    throw new Error("operator_webhook_money_fact_incomplete");
  }
  const transactionId = candidate.original_transaction_id ?? candidate.transaction_id;
  return {
    amount_unscaled: candidate.amount_unscaled,
    amount_scale: candidate.amount_scale,
    currency: candidate.currency,
    ...(candidate.financial_status ? { financial_status: candidate.financial_status } : {}),
    ...(transactionId ? { transaction_ref: operatorWebhookReference(secret, "transaction_ref", transactionId) } : {}),
  };
}

function details(candidate: OperatorWebhookCandidate, secret: Buffer): JsonObject {
  if (candidate.event_name === "session_start") return {};
  if (candidate.event_name === "custom_event") {
    if (!candidate.event_key) throw new Error("operator_webhook_custom_event_fact_incomplete");
    return { event_key: candidate.event_key };
  }
  if (candidate.event_name === "purchase" || candidate.event_name === "refund") {
    return moneyDetails(candidate, secret);
  }
  if (candidate.amount_unscaled === null || candidate.amount_scale === null
    || candidate.currency === null || candidate.revenue_source === null) {
    throw new Error("operator_webhook_revenue_fact_incomplete");
  }
  return {
    amount_unscaled: candidate.amount_unscaled,
    amount_scale: candidate.amount_scale,
    currency: candidate.currency,
    revenue_source: candidate.revenue_source,
    ...(candidate.ad_network ? { ad_network: candidate.ad_network } : {}),
    ...(candidate.country ? { country: candidate.country } : {}),
  };
}

export function buildOperatorEvent(candidate: OperatorWebhookCandidate, secret: Buffer): OperatorEvent {
  if (secret.length < 32) throw new Error("operator_webhook_secret_invalid");
  return {
    name: candidate.event_name,
    event_ref: operatorWebhookReference(secret, "event_ref", candidate.logical_event_id),
    occurred_at: candidate.occurred_at,
    ...(candidate.installation_id
      ? { subject_ref: operatorWebhookReference(secret, "subject_ref", candidate.installation_id) }
      : {}),
    details: details(candidate, secret),
  };
}

export function buildOperatorWebhookRequest(input: Readonly<{
  candidate: OperatorWebhookCandidate;
  deliveryId: string;
  emittedAt: string;
  secret: Buffer;
}>): PreparedOperatorWebhook {
  const envelope: OperatorWebhookEnvelope = {
    schema: "openmasu.operator_event.v1",
    delivery_id: input.deliveryId,
    emitted_at: input.emittedAt,
    app_id: input.candidate.app_id,
    event: buildOperatorEvent(input.candidate, input.secret),
  };
  const body = Buffer.from(JSON.stringify(envelope), "utf8");
  return {
    deliveryId: input.deliveryId,
    endpointUrl: input.candidate.endpoint_url,
    envelope,
    body,
    requestDigest: sha256(body),
  };
}

export async function sendOperatorWebhook(
  prepared: PreparedOperatorWebhook,
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
  row: Pick<DeliveryRow, "delivery_id" | "destination_id" | "app_id" | "request_digest">,
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
    `SELECT destination.destination_id,destination.endpoint_url,destination.secret_ref,
            logical.logical_event_id,logical.record_id,logical.app_id,logical.event_name,
            COALESCE(session.occurred_at,purchase.occurred_at,refund.occurred_at,
                     revenue.occurred_at,raw.occurred_at) AS occurred_at,
            COALESCE(session.installation_id,custom.installation_id,purchase.installation_id,
                     refund.installation_id,revenue.installation_id) AS installation_id,
            custom.event_key,COALESCE(refund.transaction_id,purchase.transaction_id) AS transaction_id,
            COALESCE(refund.original_transaction_id,purchase.original_transaction_id) AS original_transaction_id,
            COALESCE(purchase.amount_unscaled,refund.amount_unscaled,revenue.amount_unscaled) AS amount_unscaled,
            COALESCE(purchase.amount_scale,refund.amount_scale,revenue.amount_scale) AS amount_scale,
            COALESCE(purchase.currency,refund.currency,revenue.currency) AS currency,
            COALESCE(refund.financial_status,purchase.financial_status) AS financial_status,
            revenue.revenue_source,revenue.ad_network,revenue.country
       FROM control.operator_webhook_destinations_current AS destination
       JOIN ledger.logical_events AS logical
         ON logical.tenant_id=destination.tenant_id AND logical.app_id=destination.app_id
        AND logical.event_name=ANY(destination.allowed_events)
       JOIN ledger.raw_records_current AS raw
         ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
       LEFT JOIN ledger.session_facts AS session
         ON session.tenant_id=logical.tenant_id AND session.app_id=logical.app_id
        AND session.logical_event_id=logical.logical_event_id AND logical.event_name='session_start'
       LEFT JOIN ledger.custom_event_facts AS custom
         ON custom.tenant_id=logical.tenant_id AND custom.app_id=logical.app_id
        AND custom.logical_event_id=logical.logical_event_id AND logical.event_name='custom_event'
       LEFT JOIN ledger.purchase_facts AS purchase
         ON purchase.tenant_id=logical.tenant_id AND purchase.app_id=logical.app_id
        AND purchase.logical_event_id=logical.logical_event_id AND logical.event_name='purchase'
       LEFT JOIN ledger.refund_facts AS refund
         ON refund.tenant_id=logical.tenant_id AND refund.app_id=logical.app_id
        AND refund.logical_event_id=logical.logical_event_id AND logical.event_name='refund'
       LEFT JOIN ledger.ad_revenue_facts AS revenue
         ON revenue.tenant_id=logical.tenant_id AND revenue.app_id=logical.app_id
        AND revenue.logical_event_id=logical.logical_event_id AND logical.event_name='ad_revenue'
      WHERE destination.tenant_id=$1 AND destination.status='active'
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
    [tenantId],
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
          [tenantId, candidate.app_id, candidate.destination_id, candidate.record_id],
        );
        if (!eligible.rows[0]?.eligible) return false;
        const result = await client.query(
          `INSERT INTO ephemeral.operator_webhook_deliveries (
             delivery_id,tenant_id,app_id,destination_id,logical_event_id,record_id,event_name,
             request_ref,request_digest,state,attempts,next_attempt_at,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',0,$10,$11,$12)
           ON CONFLICT (tenant_id,app_id,destination_id,logical_event_id) DO NOTHING`,
          [deliveryId, tenantId, candidate.app_id, candidate.destination_id, candidate.logical_event_id,
            candidate.record_id, candidate.event_name, requestRef, prepared.requestDigest,
            now.toISOString(), now.toISOString(), now.toISOString()],
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
      const candidate = await client.query<{ record_id: string; app_id: string; destination_id: string }>(
        `SELECT record_id,app_id,destination_id
           FROM ephemeral.operator_webhook_deliveries
          WHERE tenant_id=$1 AND delivery_id=$2
            AND state IN ('queued','retry') AND next_attempt_at <= $3`,
        [tenantId, deliveryId, now.toISOString()],
      );
      if (!candidate.rows[0]) return;
      // Privacy deletion takes this advisory lock before it locks delivery rows.
      // Use the same order here so the privacy/dispatch race cannot deadlock.
      await lockRecord(client, candidate.rows[0].record_id);
      await lockDestination(
        client,
        tenantId,
        candidate.rows[0].app_id,
        candidate.rows[0].destination_id,
      );
      const selected = await client.query<DeliveryRow>(
        `SELECT delivery.delivery_id::text,delivery.destination_id,destination.endpoint_url,
                destination.secret_ref,delivery.app_id,delivery.record_id,delivery.request_ref,
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
           JOIN ledger.raw_records_current AS raw
             ON raw.tenant_id=delivery.tenant_id AND raw.app_id=delivery.app_id
            AND raw.record_id=delivery.record_id
          WHERE delivery.tenant_id=$1 AND delivery.delivery_id=$2
            AND delivery.state IN ('queued','retry') AND delivery.next_attempt_at <= $3
          FOR UPDATE OF delivery`,
        [tenantId, deliveryId, now.toISOString()],
      );
      const row = selected.rows[0];
      if (!row) return;
      appId = row.app_id;
      const attempt = row.attempts + 1;
      const suppressed = row.destination_status !== "active"
        ? "destination_disabled"
        : row.payload_lifecycle_status !== "available" || row.withdrawal_recognized_at || row.tombstoned
          ? "privacy_suppressed"
          : undefined;
      if (suppressed) {
        await client.query(
          `UPDATE ephemeral.operator_webhook_deliveries
              SET state='suppressed',attempts=$3,safe_reason=$4,updated_at=$5
            WHERE tenant_id=$1 AND delivery_id=$2`,
          [tenantId, row.delivery_id, attempt, suppressed, now.toISOString()],
        );
        await appendResult(client, row, tenantId, "suppressed", attempt, now.toISOString(), suppressed);
        purgeRef = row.request_ref;
        processed += 1;
        return;
      }
      let secret: Buffer;
      let body: Buffer;
      try {
        [secret, body] = await Promise.all([
          payloadStore.read(row.secret_ref), payloadStore.read(row.request_ref),
        ]);
      } catch {
        await client.query(
          `UPDATE ephemeral.operator_webhook_deliveries
              SET state='failed',attempts=$3,safe_reason='protected_payload_unavailable',updated_at=$4
            WHERE tenant_id=$1 AND delivery_id=$2`,
          [tenantId, row.delivery_id, attempt, now.toISOString()],
        );
        await appendResult(client, row, tenantId, "failed", attempt, now.toISOString(), "protected_payload_unavailable");
        purgeRef = row.request_ref;
        processed += 1;
        return;
      }
      if (sha256(body) !== row.request_digest) {
        await client.query(
          `UPDATE ephemeral.operator_webhook_deliveries
              SET state='failed',attempts=$3,safe_reason='request_digest_mismatch',updated_at=$4
            WHERE tenant_id=$1 AND delivery_id=$2`,
          [tenantId, row.delivery_id, attempt, now.toISOString()],
        );
        await appendResult(client, row, tenantId, "failed", attempt, now.toISOString(), "request_digest_mismatch");
        purgeRef = row.request_ref;
        processed += 1;
        return;
      }
      const result = await sendOperatorWebhook({
        deliveryId: row.delivery_id,
        endpointUrl: row.endpoint_url,
        envelope: JSON.parse(body.toString("utf8")) as OperatorWebhookEnvelope,
        body,
        requestDigest: row.request_digest,
      }, secret, {
        destinationAllowlist: options.destinationAllowlist,
        attempt,
        allowSyntheticLoopback: options.allowSyntheticLoopback,
        lookup: options.lookup,
        timeoutMilliseconds: options.timeoutMilliseconds,
      });
      let state: "retry" | "succeeded" | "failed";
      let reason: string | undefined;
      if (result.outcome === "accepted") state = "succeeded";
      else if (result.outcome === "terminal" || attempt >= maximumAttempts) {
        state = "failed";
        reason = result.outcome === "terminal" ? result.reason : "retry_exhausted";
      } else {
        state = "retry";
        reason = result.reason;
      }
      const nextAttemptAt = new Date(now.valueOf() + Math.min(3_600_000, 60_000 * (2 ** Math.min(attempt - 1, 6))));
      await client.query(
        `UPDATE ephemeral.operator_webhook_deliveries
            SET state=$3,attempts=$4,next_attempt_at=$5,last_http_status=$6,
                safe_reason=$7,updated_at=$8
          WHERE tenant_id=$1 AND delivery_id=$2`,
        [tenantId, row.delivery_id, state, attempt, nextAttemptAt.toISOString(),
          "httpStatus" in result ? result.httpStatus ?? null : null,
          reason ?? null, now.toISOString()],
      );
      await appendResult(client, row, tenantId, state, attempt, now.toISOString(), reason,
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
