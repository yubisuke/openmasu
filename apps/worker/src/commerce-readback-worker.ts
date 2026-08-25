import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import {
  decodeCompactJwsPayloadUnverified,
  normalizeAppleNotification,
  normalizeGoogleOrderRefunds,
  sha256,
  type AppleSignedDataVerifier,
  type CommerceFinancialEffect,
} from "@openmasu/commerce-lifecycle";
import { ingestRuntimeBatch } from "./ingestion.js";
import { googleServiceAccountAccessToken } from "./google-service-account.js";
import { callAppleStoreApi, type AppleStoreApiCredentials } from "./apple-store-api.js";

type JsonObject = Record<string, unknown>;
type ReadbackRow = {
  readback_id: string;
  provider: "google_play" | "app_store";
  tenant_id: string;
  app_id: string;
  notification_digest: string;
  operation: "google_subscription" | "google_order_refund" | "apple_transaction_history" | "apple_refund_history";
  evidence_ref: string;
  cursor_ref: string | null;
  attempts: number;
};

export type CommerceReadbackResponse = { readonly status: number; readonly body: Buffer };
export type GoogleCommerceReadbackClient = (input: {
  readonly operation: "subscription" | "order";
  readonly packageName: string;
  readonly purchaseToken?: string;
  readonly orderId?: string;
}) => Promise<CommerceReadbackResponse>;
export type AppleCommerceReadbackClient = (input: {
  readonly operation: "transaction_history" | "refund_history";
  readonly transactionId: string;
  readonly revision?: string;
  readonly bundleId: string;
  readonly appAppleId?: number;
  readonly environment: "Sandbox" | "Production";
}) => Promise<CommerceReadbackResponse>;

function checkedBase(value: string | undefined, expectedHost: string): URL {
  const base = new URL(value ?? `https://${expectedHost}`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash
    || (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
    || (!loopback && base.hostname !== expectedHost)) throw new Error("commerce_provider_endpoint_invalid");
  return base;
}

export function createGoogleCommerceReadbackClient(options: {
  readonly credentialsJson: string;
  readonly apiBaseUrl?: string;
  readonly tokenUrl?: string;
  readonly fetch?: typeof fetch;
}): GoogleCommerceReadbackClient {
  return async (input) => {
    if (!/^[A-Za-z][A-Za-z0-9_.]{2,254}$/.test(input.packageName)) throw new Error("google_package_invalid");
    const base = checkedBase(options.apiBaseUrl, "androidpublisher.googleapis.com");
    const path = input.operation === "subscription"
      ? `androidpublisher/v3/applications/${encodeURIComponent(input.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(string(input.purchaseToken, "google_purchase_token"))}`
      : `androidpublisher/v3/applications/${encodeURIComponent(input.packageName)}/orders/${encodeURIComponent(string(input.orderId, "google_order_id", 255))}`;
    const token = await googleServiceAccountAccessToken({
      credentialsJson: options.credentialsJson,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      tokenUrl: options.tokenUrl,
      fetch: options.fetch,
    });
    const response = await (options.fetch ?? fetch)(new URL(path, `${base.toString().replace(/\/$/, "")}/`), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 1024 * 1024) throw new Error("google_commerce_response_too_large");
    return { status: response.status, body };
  };
}

export function createAppleCommerceReadbackClient(options: {
  readonly credentials: Omit<AppleStoreApiCredentials, "bundleId" | "environment">;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}): AppleCommerceReadbackClient {
  return (input) => callAppleStoreApi({
    operation: input.operation,
    transactionId: input.transactionId,
    revision: input.revision,
    credentials: { ...options.credentials, bundleId: input.bundleId, environment: input.environment },
    baseUrl: options.baseUrl,
    fetch: options.fetch,
  });
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as JsonObject;
}

function parse(body: Buffer, label: string): JsonObject {
  if (body.length > 1024 * 1024) throw new Error(`${label}_too_large`);
  return object(JSON.parse(body.toString("utf8")), label);
}

function string(value: unknown, label: string, maximum = 64 * 1024): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label}_invalid`);
  return value;
}

async function appendLifecycleFact(pool: Pool, row: ReadbackRow, input: {
  readonly eventKind: string;
  readonly providerEventDigest?: string;
  readonly transactionDigest?: string;
  readonly originalTransactionDigest?: string;
  readonly subscriptionState?: string;
  readonly financialEffect: CommerceFinancialEffect;
  readonly environment?: "Sandbox" | "Production";
  readonly effectiveAt: string;
  readonly now: Date;
}): Promise<void> {
  const artifact = {
    lifecycle_fact_id: uuidV7(input.now.getTime()), tenant_id: row.tenant_id, app_id: row.app_id,
    provider: row.provider, event_kind: input.eventKind, transaction_digest: input.transactionDigest,
    provider_event_digest: input.providerEventDigest ?? row.notification_digest,
    original_transaction_digest: input.originalTransactionDigest, subscription_state: input.subscriptionState,
    financial_effect: input.financialEffect, environment: input.environment,
    effective_at: input.effectiveAt, recorded_at: input.now.toISOString(),
  };
  await withTenant(pool, row.tenant_id, async (client) => client.query(
    `INSERT INTO ledger.commerce_lifecycle_facts (
       lifecycle_fact_id, provider, tenant_id, app_id, notification_digest, provider_event_digest, event_kind,
       subject_digest, transaction_digest, original_transaction_digest, subscription_state,
       financial_effect, environment, effective_at, recorded_at, artifact
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT DO NOTHING`,
    [artifact.lifecycle_fact_id, row.provider, row.tenant_id, row.app_id, row.notification_digest,
      input.providerEventDigest ?? row.notification_digest, input.eventKind,
      input.transactionDigest ?? null, input.originalTransactionDigest ?? null,
      input.subscriptionState ?? null, input.financialEffect, input.environment ?? null,
      input.effectiveAt, input.now.toISOString(), JSON.stringify(artifact)],
  ));
}

async function recordReadbackFailure(pool: Pool, row: ReadbackRow, now: Date): Promise<void> {
  await appendLifecycleFact(pool, row, {
    eventKind: "readback_failed",
    providerEventDigest: sha256(`${row.notification_digest}\0${row.operation}\0failed`),
    subscriptionState: "unavailable",
    financialEffect: "none",
    effectiveAt: now.toISOString(),
    now,
  });
}

async function defer(pool: Pool, row: ReadbackRow, now: Date, status?: number): Promise<void> {
  const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(row.attempts, 7)));
  await withTenant(pool, row.tenant_id, async (client) => client.query(
    `UPDATE ephemeral.commerce_provider_readbacks
        SET attempts=attempts+1, next_attempt_at=$4::timestamptz + ($5 || ' seconds')::interval, last_status=$6
      WHERE tenant_id=$1 AND app_id=$2 AND readback_id=$3`,
    [row.tenant_id, row.app_id, row.readback_id, now.toISOString(), String(delaySeconds), status ?? null],
  ));
}

async function retryOrFail(pool: Pool, row: ReadbackRow, now: Date, status?: number): Promise<"deferred" | "failed"> {
  if (row.attempts < 19) {
    await defer(pool, row, now, status);
    return "deferred";
  }
  await recordReadbackFailure(pool, row, now);
  await finish(pool, row, false, now);
  return "failed";
}

function checkpointStream(row: ReadbackRow): string {
  return `${row.operation}:${row.notification_digest.slice(0, 32)}`;
}

async function finish(pool: Pool, row: ReadbackRow, completed: boolean, now: Date): Promise<void> {
  await withTenant(pool, row.tenant_id, async (client) => {
    if (completed) {
      await client.query(
        `UPDATE control.commerce_backfill_checkpoints
            SET completed=true, cursor_ref=NULL, updated_at=$5
          WHERE provider=$1 AND tenant_id=$2 AND app_id=$3 AND stream=$4`,
        [row.provider, row.tenant_id, row.app_id, checkpointStream(row), now.toISOString()],
      );
    }
    await client.query(
      "DELETE FROM ephemeral.commerce_provider_readbacks WHERE tenant_id=$1 AND app_id=$2 AND readback_id=$3",
      [row.tenant_id, row.app_id, row.readback_id],
    );
  });
}

export async function processCommerceReadbacks(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: {
    readonly googleClient?: GoogleCommerceReadbackClient;
    readonly appleClient?: AppleCommerceReadbackClient;
    readonly verifyAppleSignedData?: AppleSignedDataVerifier;
    readonly now?: Date;
    readonly limit?: number;
  },
): Promise<{ processed: number; deferred: number; failed: number }> {
  const now = options.now ?? new Date();
  const rows = await withTenant(pool, tenantId, async (client) => (await client.query<ReadbackRow>(
    `SELECT readback.readback_id::text, readback.provider, readback.tenant_id, readback.app_id,
            readback.notification_digest, readback.operation, notification.evidence_ref,
            readback.cursor_ref, readback.attempts
       FROM ephemeral.commerce_provider_readbacks AS readback
       JOIN control.commerce_provider_notifications AS notification
         ON notification.provider=readback.provider AND notification.notification_digest=readback.notification_digest
      WHERE readback.tenant_id=$1 AND readback.next_attempt_at <= $2
      ORDER BY readback.next_attempt_at, readback.readback_id LIMIT $3`,
    [tenantId, now.toISOString(), options.limit ?? 25],
  )).rows);
  const counts = { processed: 0, deferred: 0, failed: 0 };
  for (const row of rows) {
    try {
      const raw = await payloadStore.read(row.evidence_ref);
      if (row.provider === "google_play") {
        if (!options.googleClient) { counts[await retryOrFail(pool, row, now)] += 1; continue; }
        const notification = parse(raw, "google_notification");
        const packageName = string(notification.packageName, "google_package", 255);
        if (row.operation === "google_subscription") {
          const subscription = object(notification.subscriptionNotification, "google_subscription");
          const purchaseToken = string(subscription.purchaseToken, "google_purchase_token");
          const response = await options.googleClient({ operation: "subscription", packageName, purchaseToken });
          if (response.status === 429 || response.status >= 500) {
            counts[await retryOrFail(pool, row, now, response.status)] += 1; continue;
          }
          if (response.status !== 200) {
            await recordReadbackFailure(pool, row, now); await finish(pool, row, false, now); counts.failed += 1; continue;
          }
          const state = string(parse(response.body, "google_subscription_response").subscriptionState, "google_subscription_state", 128);
          await appendLifecycleFact(pool, row, {
            eventKind: "subscription_state_verified", subscriptionState: state.toLowerCase(), financialEffect: "none",
            providerEventDigest: sha256(`${row.notification_digest}\0${state.toLowerCase()}`),
            effectiveAt: now.toISOString(), now,
          });
          await finish(pool, row, true, now); counts.processed += 1; continue;
        }
        const voided = object(notification.voidedPurchaseNotification, "google_voided_purchase");
        const orderId = string(voided.orderId, "google_order_id", 255);
        const response = await options.googleClient({ operation: "order", packageName, orderId });
        if (response.status === 429 || response.status >= 500) {
          counts[await retryOrFail(pool, row, now, response.status)] += 1; continue;
        }
        if (response.status !== 200) {
          await recordReadbackFailure(pool, row, now); await finish(pool, row, false, now); counts.failed += 1; continue;
        }
        const orderDigest = sha256(orderId);
        const refundEvents = normalizeGoogleOrderRefunds(response.body, orderDigest);
        let allPersisted = refundEvents.length > 0;
        let invalidRefund = false;
        for (const event of refundEvents) {
          const persisted = await appendVerifiedGoogleRefundForOrder(pool, row, orderDigest, event, now);
          if (persisted === "invalid") { invalidRefund = true; allPersisted = false; break; }
          allPersisted &&= persisted === "persisted";
          if (persisted === "persisted") await appendLifecycleFact(pool, row, {
            eventKind: "refund_verified", providerEventDigest: event.eventDigest,
            transactionDigest: orderDigest, financialEffect: "refund",
            effectiveAt: event.eventTime, now,
          });
        }
        if (invalidRefund) {
          await recordReadbackFailure(pool, row, now); await finish(pool, row, false, now); counts.failed += 1; continue;
        }
        if (!allPersisted) { counts[await retryOrFail(pool, row, now)] += 1; continue; }
        await finish(pool, row, true, now); counts.processed += 1; continue;
      }
      if (!options.appleClient || !options.verifyAppleSignedData) { counts[await retryOrFail(pool, row, now)] += 1; continue; }
      const envelope = parse(raw, "apple_envelope");
      const compact = string(envelope.signedPayload, "apple_signed_payload");
      const untrusted = decodeCompactJwsPayloadUnverified(compact);
      const data = object(untrusted.data, "apple_data");
      const bundleId = string(data.bundleId, "apple_bundle", 255);
      const environment = data.environment as "Sandbox" | "Production";
      const appAppleId = data.appAppleId === undefined ? undefined : Number(data.appAppleId);
      if (!new Set(["Sandbox", "Production"]).has(String(environment))
        || (environment === "Production" && (!Number.isSafeInteger(appAppleId) || Number(appAppleId) <= 0))
        || (appAppleId !== undefined && (!Number.isSafeInteger(appAppleId) || appAppleId <= 0))) {
        throw new Error("apple_history_scope_invalid");
      }
      const normalized = normalizeAppleNotification(compact, options.verifyAppleSignedData, {
        bundleId, environment, ...(appAppleId === undefined ? {} : { appAppleId }),
      });
      const transactionId = string(normalized.transaction?.originalTransactionId ?? normalized.transaction?.transactionId, "apple_transaction_id", 128);
      let revision: string | undefined;
      if (row.cursor_ref) {
        const cursor = parse(await payloadStore.read(row.cursor_ref), "apple_cursor");
        revision = string(cursor.revision, "apple_revision", 4096);
      }
      const response = await options.appleClient({
        operation: row.operation === "apple_refund_history" ? "refund_history" : "transaction_history",
        transactionId, ...(revision ? { revision } : {}), bundleId,
        ...(appAppleId === undefined ? {} : { appAppleId }), environment,
      });
      if (response.status === 429 || response.status >= 500) {
        counts[await retryOrFail(pool, row, now, response.status)] += 1; continue;
      }
      if (response.status !== 200) {
        await recordReadbackFailure(pool, row, now); await finish(pool, row, false, now); counts.failed += 1; continue;
      }
      const page = parse(response.body, "apple_history");
      if (!Array.isArray(page.signedTransactions)) throw new Error("apple_history_transactions_invalid");
      for (const signed of page.signedTransactions) {
        const transaction = options.verifyAppleSignedData(string(signed, "apple_signed_transaction"));
        if (transaction.bundleId !== bundleId || transaction.environment !== environment) throw new Error("apple_history_scope_mismatch");
        const transactionDigest = sha256(string(transaction.transactionId, "apple_transaction_id", 128));
        const originalDigest = sha256(string(transaction.originalTransactionId, "apple_original_transaction_id", 128));
        const revoked = transaction.revocationDate !== undefined;
        const financialEffect = normalized.event.financialEffect === "refund_reversal"
          ? "refund_reversal" as const
          : revoked ? "refund" as const : "purchase" as const;
        await appendLifecycleFact(pool, row, {
          eventKind: financialEffect === "refund_reversal" ? "refund_reversal_verified"
            : revoked ? "refund_history_verified" : "transaction_history_verified",
          providerEventDigest: transactionDigest,
          transactionDigest, originalTransactionDigest: originalDigest,
          financialEffect, environment,
          effectiveAt: new Date(Number(revoked ? transaction.revocationDate : transaction.purchaseDate)).toISOString(), now,
        });
      }
      if (page.hasMore === true) {
        const nextRevision = string(page.revision, "apple_revision", 4096);
        const nextRef = await payloadStore.write(
          { tenantId: row.tenant_id, appId: row.app_id, objectId: `apple-commerce-cursor-${row.readback_id}-${row.attempts}` },
          Buffer.from(JSON.stringify({ revision: nextRevision }), "utf8"),
        );
        await withTenant(pool, row.tenant_id, async (client) => client.query(
          `WITH updated_readback AS (
             UPDATE ephemeral.commerce_provider_readbacks SET cursor_ref=$4, attempts=0, next_attempt_at=$5, last_status=200
              WHERE tenant_id=$1 AND app_id=$2 AND readback_id=$3 RETURNING 1
           )
           UPDATE control.commerce_backfill_checkpoints
              SET cursor_ref=$4, updated_at=$5
            WHERE provider=$6 AND tenant_id=$1 AND app_id=$2 AND stream=$7`,
          [row.tenant_id, row.app_id, row.readback_id, nextRef, now.toISOString(), row.provider, checkpointStream(row)],
        ));
        if (row.cursor_ref) await payloadStore.purge(row.cursor_ref);
      } else {
        await finish(pool, row, true, now);
        if (row.cursor_ref) await payloadStore.purge(row.cursor_ref);
      }
      counts.processed += 1;
    } catch {
      counts[await retryOrFail(pool, row, now)] += 1;
    }
  }
  return counts;
}

async function appendVerifiedGoogleRefundForOrder(
  pool: Pool,
  row: ReadbackRow,
  orderDigest: string,
  event: { readonly eventDigest: string; readonly eventTime: string; readonly amountUnscaled: string; readonly amountScale: number; readonly currency: string },
  now: Date,
): Promise<"persisted" | "missing" | "invalid"> {
  const resolved = await withTenant(pool, row.tenant_id, async (client) => {
    const binding = (await client.query<{
      purchase_record_id: string; installation_id: string; transaction_id: string; currency: string;
      amount_unscaled: string; amount_scale: number;
    }>(
    `SELECT binding.purchase_record_id, purchase.installation_id, purchase.transaction_id,
            binding.currency, binding.amount_unscaled, binding.amount_scale
       FROM control.commerce_purchase_bindings AS binding
       JOIN ledger.purchase_facts AS purchase
         ON purchase.tenant_id=binding.tenant_id AND purchase.app_id=binding.app_id
        AND purchase.record_id=binding.purchase_record_id
      WHERE binding.provider='google_play' AND binding.tenant_id=$1 AND binding.app_id=$2
        AND binding.transaction_digest=$3`,
    [row.tenant_id, row.app_id, orderDigest],
  )).rows[0];
    if (!binding) return undefined;
    const prior = (await client.query<{ transaction_id: string; amount_unscaled: string; amount_scale: number }>(
      `SELECT transaction_id, amount_unscaled, amount_scale FROM ledger.refund_facts
        WHERE tenant_id=$1 AND app_id=$2 AND correction_target_record_id=$3`,
      [row.tenant_id, row.app_id, binding.purchase_record_id],
    )).rows;
    return { binding, prior };
  });
  if (!resolved) return "missing";
  const refundTransactionId = `refund:google-play:${event.eventDigest.slice(0, 48)}`;
  if (resolved.prior.some((value) => value.transaction_id === refundTransactionId)) return "persisted";
  if (resolved.binding.currency !== event.currency) return "invalid";
  const toBindingScale = (amount: string, scale: number): bigint | undefined => {
    const value = BigInt(amount);
    if (scale <= resolved.binding.amount_scale) return value * (10n ** BigInt(resolved.binding.amount_scale - scale));
    const divisor = 10n ** BigInt(scale - resolved.binding.amount_scale);
    return value % divisor === 0n ? value / divisor : undefined;
  };
  let refunded = 0n;
  for (const prior of resolved.prior) {
    const value = toBindingScale(prior.amount_unscaled, prior.amount_scale);
    if (value === undefined) return "invalid";
    refunded += value;
  }
  const next = toBindingScale(event.amountUnscaled, event.amountScale);
  if (next === undefined || refunded + next > BigInt(resolved.binding.amount_unscaled)) return "invalid";
  return await appendVerifiedGoogleRefundWithBinding(pool, row, resolved.binding, event, now)
    ? "persisted" : "missing";
}

async function appendVerifiedGoogleRefundWithBinding(
  pool: Pool,
  row: ReadbackRow,
  binding: { purchase_record_id: string; installation_id: string; transaction_id: string; currency: string },
  event: { readonly eventDigest: string; readonly eventTime: string; readonly amountUnscaled: string; readonly amountScale: number; readonly currency: string },
  now: Date,
): Promise<boolean> {
  const recordId = `record:google-play-refund:${event.eventDigest.slice(0, 48)}`;
  const output = await ingestRuntimeBatch([{
    batch_id: `google-play-refund:${event.eventDigest}`,
    record: {
      contract_version: "0.4.0", record_id: recordId,
      delivery_id: `delivery:google-play-refund:${event.eventDigest.slice(0, 48)}`,
      tenant_id: row.tenant_id, app_id: row.app_id, producer: "adapter:google-play",
      producer_version: "orders-refund-history-2026-08-25",
      event_id: `event:google-play-refund:${event.eventDigest.slice(0, 48)}`, event_name: "refund",
      schema_version: "0.4.0", occurred_at: event.eventTime, occurred_at_source: "server",
      received_at: now.toISOString(), processing_purpose_id: "revenue_measurement", processing_sequence: 0,
      payload: {
        event_name: "refund", installation_id: binding.installation_id,
        transaction_id: `refund:google-play:${event.eventDigest.slice(0, 48)}`,
        original_transaction_id: binding.transaction_id,
        correction_target_record_id: binding.purchase_record_id,
        amount_unscaled: event.amountUnscaled, amount_scale: event.amountScale,
        currency: event.currency, financial_status: "settled",
        extensions: { store_verification_provider: "google_play", monetary_authority: "google_play_order_refund_history" },
      },
    },
    server: {
      tenant_id: row.tenant_id, app_id: row.app_id, received_at: now.toISOString(),
      policy_digest: "verified-commerce-v1", processing_purposes: [{ processing_purpose_id: "revenue_measurement", consent_required: false, policy_version: "verified-commerce-v1" }],
      withdrawals: [], alternative_legal_bases: [], fraud_enabled: false, fraud_actions_enabled: false,
    },
  }], pool);
  return output.logical_events.some((value) => value.record_id === recordId)
    || await withTenant(pool, row.tenant_id, async (client) => (await client.query(
      "SELECT 1 FROM ledger.refund_facts WHERE tenant_id=$1 AND app_id=$2 AND correction_target_record_id=$3 AND transaction_id=$4",
      [row.tenant_id, row.app_id, binding.purchase_record_id, `refund:google-play:${event.eventDigest.slice(0, 48)}`],
    )).rowCount === 1);
}
