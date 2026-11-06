import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { operatorWebhookReference, type OperatorWebhookEventName } from "./index.js";
import { applyWebhookContent, type StoredWebhookContentPolicy } from "./webhook-content.js";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

export type OperatorWebhookCandidate = {
  content_policy?: StoredWebhookContentPolicy;
  policy_revision?: number;
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

export type OperatorEvent = Readonly<{
  name: string;
  event_ref: string;
  occurred_at: string;
  subject_ref?: string;
  details: JsonObject;
}>;

export type OperatorWebhookEnvelope = Readonly<{
  schema: "openmasu.operator_event.v1";
  policy_revision?: number;
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
  const event = applyWebhookContent(buildOperatorEvent(input.candidate, input.secret), input.candidate.content_policy ?? { mode: "legacy_v1" });
  if (!event) throw Error("operator_webhook_content_filtered");
  const envelope: OperatorWebhookEnvelope = {
    schema: "openmasu.operator_event.v1",
    delivery_id: input.deliveryId,
    emitted_at: input.emittedAt,
    app_id: input.candidate.app_id,
    event,
    ...(input.candidate.content_policy?.mode === "explicit_v1" ? { policy_revision: input.candidate.policy_revision } : {}),
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

// $1 = tenant; $2 = recorded policy revision, 0 for legacy, or null for discovery.
export const webhookCandidateSelect = `SELECT destination.destination_id,destination.endpoint_url,destination.secret_ref,
            policy.definition AS content_policy,policy.policy_revision::integer,
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
       LEFT JOIN LATERAL (SELECT definition,policy_revision FROM control.operator_webhook_content_revisions
         WHERE tenant_id=destination.tenant_id AND app_id=destination.app_id AND destination_id=destination.destination_id
           AND created_at<=raw.received_at AND ($2::bigint IS NULL OR policy_revision=$2) ORDER BY policy_revision DESC LIMIT 1) policy ON true
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
`;

type Scope = Readonly<{ tenantId: string; appId: string }>;
/** Closed, pseudonymous request. Neither the privacy request ID nor raw IDs leave the worker. */
export function buildOperatorWebhookDeletionRequest(input: Readonly<{
  deliveryId: string; appId: string; subjectRef: string; recognizedAt: string; endpointUrl: string;
}>) {
  if (!/^[a-f0-9]{64}$/.test(input.subjectRef)
      || !Number.isFinite(Date.parse(input.recognizedAt))
      || new Date(input.recognizedAt).toISOString() !== input.recognizedAt) {
    throw Error("operator_webhook_deletion_request_invalid");
  }
  const envelope = { schema: "openmasu.subject_deletion.v1" as const, delivery_id: input.deliveryId,
    app_id: input.appId, subject_ref: input.subjectRef, recognized_at: input.recognizedAt };
  const body = Buffer.from(JSON.stringify(envelope), "utf8");
  return { deliveryId: input.deliveryId, endpointUrl: input.endpointUrl, envelope, body,
    requestDigest: createHash("sha256").update(body).digest("hex") };
}

/** Recheck the exact recognized request/subject against a successful ordinary delivery. */
export async function recognizedWebhookDeletion(client: PoolClient, scope: Scope, destinationId: string,
  privacyRequestId: string, subjectRef: string): Promise<string | undefined> {
  const result = await client.query<{ recognized_at: string | null }>(
    `SELECT MIN(t.created_at)::text AS recognized_at
      FROM ephemeral.operator_webhook_deliveries source
      JOIN ledger.privacy_tombstones t ON t.tenant_id=source.tenant_id AND t.app_id=source.app_id AND t.record_id=source.record_id
      JOIN control.privacy_deletion_jobs job ON job.tenant_id=t.tenant_id AND job.privacy_request_id=t.privacy_request_id
      WHERE source.tenant_id=$1 AND source.app_id=$2 AND source.destination_id=$3
        AND source.subject_ref=$5 AND source.state='succeeded' AND source.logical_event_id IS NOT NULL
        AND source.record_id IS NOT NULL AND t.privacy_request_id=$4`,
    [scope.tenantId, scope.appId, destinationId, privacyRequestId, subjectRef]);
  return result.rows[0]?.recognized_at ?? undefined;
}

