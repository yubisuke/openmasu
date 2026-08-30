import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  acquirePrivacyTenantXactFence,
  uuidV7,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";
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
import type { CandidateAttempt } from "@openmasu/attribution-core";

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
  claim_token: string | null;
  claimed_until: Date | string | null;
};

const DEFAULT_COMMERCE_READBACK_CLAIM_LEASE_MS = 5 * 60 * 1_000;

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

type LifecycleInput = {
  readonly eventKind: string;
  readonly providerEventDigest?: string;
  readonly transactionDigest?: string;
  readonly originalTransactionDigest?: string;
  readonly subscriptionState?: string;
  readonly financialEffect: CommerceFinancialEffect;
  readonly environment?: "Sandbox" | "Production";
  readonly effectiveAt: string;
  readonly now: Date;
};

async function appendLifecycleFact(client: PoolClient, row: ReadbackRow, input: LifecycleInput): Promise<void> {
  const artifact = {
    lifecycle_fact_id: uuidV7(input.now.getTime()), tenant_id: row.tenant_id, app_id: row.app_id,
    provider: row.provider, event_kind: input.eventKind, transaction_digest: input.transactionDigest,
    provider_event_digest: input.providerEventDigest ?? row.notification_digest,
    original_transaction_digest: input.originalTransactionDigest, subscription_state: input.subscriptionState,
    financial_effect: input.financialEffect, environment: input.environment,
    effective_at: input.effectiveAt, recorded_at: input.now.toISOString(),
  };
  await client.query(
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
  );
}

async function recordReadbackFailure(client: PoolClient, row: ReadbackRow, now: Date): Promise<void> {
  await appendLifecycleFact(client, row, {
    eventKind: "readback_failed",
    providerEventDigest: sha256(`${row.notification_digest}\0${row.operation}\0failed`),
    subscriptionState: "unavailable",
    financialEffect: "none",
    effectiveAt: now.toISOString(),
    now,
  });
}

async function claimCommerceReadback(
  pool: Pool,
  tenantId: string,
  now: Date,
  claimToken: string,
  leaseMs: number,
  excludedReadbackIds: readonly string[],
): Promise<ReadbackRow | undefined> {
  const claimed = await withTenant(pool, tenantId, (client) => client.query<ReadbackRow>(
    `WITH due AS (
       SELECT readback_id
         FROM ephemeral.commerce_provider_readbacks
        WHERE tenant_id=$1 AND next_attempt_at <= $2
          AND (claimed_until IS NULL OR claimed_until <= clock_timestamp())
          AND NOT (readback_id = ANY($5::uuid[]))
        ORDER BY next_attempt_at,readback_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ephemeral.commerce_provider_readbacks AS readback
        SET claim_token=$3::uuid,
            claimed_until=clock_timestamp() + ($4::integer * interval '1 millisecond')
       FROM due,
            control.commerce_provider_notifications AS notification
      WHERE readback.tenant_id=$1 AND readback.readback_id=due.readback_id
        AND notification.provider=readback.provider
        AND notification.notification_digest=readback.notification_digest
     RETURNING readback.readback_id::text,readback.provider,readback.tenant_id,readback.app_id,
       readback.notification_digest,readback.operation,notification.evidence_ref,
       readback.cursor_ref,readback.attempts,readback.claim_token::text,readback.claimed_until`,
    [tenantId, now.toISOString(), claimToken, leaseMs, excludedReadbackIds],
  ));
  return claimed.rows[0];
}

async function lockCurrentClaim(client: PoolClient, row: ReadbackRow): Promise<boolean> {
  if (!row.claim_token || !row.claimed_until) throw new Error("commerce_readback_claim_missing");
  const current = await client.query(
    `SELECT 1
       FROM ephemeral.commerce_provider_readbacks AS readback
      WHERE readback.tenant_id=$1 AND readback.app_id=$2
        AND readback.readback_id=$3::uuid
        AND readback.claim_token=$4::uuid
        AND readback.claimed_until > clock_timestamp()
      FOR UPDATE OF readback`,
    [row.tenant_id, row.app_id, row.readback_id, row.claim_token],
  );
  return current.rowCount === 1;
}

async function withCurrentClaim<T>(
  pool: Pool,
  row: ReadbackRow,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  return withTenant(pool, row.tenant_id, async (client) => {
    await acquirePrivacyTenantXactFence(client, row.tenant_id, "shared");
    if (!await lockCurrentClaim(client, row)) return undefined;
    return operation(client);
  });
}

async function beginProviderRequest<T>(
  pool: Pool,
  row: ReadbackRow,
  operation: () => Promise<T>,
): Promise<{ readonly response: Promise<T> } | undefined> {
  return withTenant(pool, row.tenant_id, async (client) => {
    await acquirePrivacyTenantXactFence(client, row.tenant_id, "shared");
    if (!await lockCurrentClaim(client, row)) return undefined;
    const response = operation();
    void response.catch(() => undefined);
    return { response };
  });
}

async function defer(pool: Pool, row: ReadbackRow, now: Date, status?: number): Promise<boolean> {
  if (!row.claim_token || !row.claimed_until) throw new Error("commerce_readback_claim_missing");
  const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(row.attempts, 7)));
  return withTenant(pool, row.tenant_id, async (client) => (await client.query(
    `UPDATE ephemeral.commerce_provider_readbacks
        SET attempts=attempts+1,
            next_attempt_at=$4::timestamptz + ($5 || ' seconds')::interval,
            last_status=$6,
            claim_token=NULL,
            claimed_until=NULL
      WHERE tenant_id=$1 AND app_id=$2 AND readback_id=$3::uuid
        AND claim_token=$7::uuid AND claimed_until > clock_timestamp()`,
    [row.tenant_id, row.app_id, row.readback_id, now.toISOString(), String(delaySeconds),
      status ?? null, row.claim_token],
  )).rowCount === 1);
}

async function retryOrFail(
  pool: Pool,
  payloadStore: PayloadStore,
  row: ReadbackRow,
  now: Date,
  status?: number,
): Promise<"deferred" | "failed" | undefined> {
  if (row.attempts < 19) {
    return await defer(pool, row, now, status) ? "deferred" : undefined;
  }
  const completed = await withCurrentClaim(pool, row, async (client) => {
    if (row.cursor_ref) await payloadStore.purge(row.cursor_ref);
    await recordReadbackFailure(client, row, now);
    await finish(client, row, false, now);
    return true;
  });
  return completed ? "failed" : undefined;
}

async function failReadback(
  pool: Pool,
  payloadStore: PayloadStore,
  row: ReadbackRow,
  now: Date,
): Promise<boolean> {
  return (await withCurrentClaim(pool, row, async (client) => {
    if (row.cursor_ref) await payloadStore.purge(row.cursor_ref);
    await recordReadbackFailure(client, row, now);
    await finish(client, row, false, now);
    return true;
  })) === true;
}

function checkpointStream(row: ReadbackRow): string {
  return `${row.operation}:${row.notification_digest.slice(0, 32)}`;
}

async function finish(client: PoolClient, row: ReadbackRow, completed: boolean, now: Date): Promise<void> {
  if (!row.claim_token || !row.claimed_until) throw new Error("commerce_readback_claim_missing");
  if (completed) {
    await client.query(
      `UPDATE control.commerce_backfill_checkpoints
          SET completed=true, cursor_ref=NULL, updated_at=$5
        WHERE provider=$1 AND tenant_id=$2 AND app_id=$3 AND stream=$4`,
      [row.provider, row.tenant_id, row.app_id, checkpointStream(row), now.toISOString()],
    );
  }
  const removed = await client.query(
    `DELETE FROM ephemeral.commerce_provider_readbacks
      WHERE tenant_id=$1 AND app_id=$2 AND readback_id=$3::uuid AND claim_token=$4::uuid`,
    [row.tenant_id, row.app_id, row.readback_id, row.claim_token],
  );
  if (removed.rowCount !== 1) throw new Error("commerce_readback_claim_lost_during_completion");
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
    readonly claimLeaseMs?: number;
    readonly claimToken?: () => string;
  },
): Promise<{ processed: number; deferred: number; failed: number }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 25;
  const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_COMMERCE_READBACK_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("commerce_readback_limit_invalid");
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1_000 || claimLeaseMs > 900_000) {
    throw new Error("commerce_readback_claim_lease_invalid");
  }
  const counts = { processed: 0, deferred: 0, failed: 0 };
  const claimedReadbackIds: string[] = [];
  const record = (outcome: keyof typeof counts | undefined): void => {
    if (outcome) counts[outcome] += 1;
  };
  for (let processed = 0; processed < limit; processed += 1) {
    const row = await claimCommerceReadback(
      pool,
      tenantId,
      now,
      (options.claimToken ?? randomUUID)(),
      claimLeaseMs,
      claimedReadbackIds,
    );
    if (!row) break;
    claimedReadbackIds.push(row.readback_id);
    try {
      const raw = await payloadStore.read(row.evidence_ref);
      if (row.provider === "google_play") {
        if (!options.googleClient) { record(await retryOrFail(pool, payloadStore, row, now)); continue; }
        const notification = parse(raw, "google_notification");
        const packageName = string(notification.packageName, "google_package", 255);
        if (row.operation === "google_subscription") {
          const subscription = object(notification.subscriptionNotification, "google_subscription");
          const purchaseToken = string(subscription.purchaseToken, "google_purchase_token");
          const started = await beginProviderRequest(pool, row, () => options.googleClient!({
            operation: "subscription", packageName, purchaseToken,
          }));
          if (!started) continue;
          const response = await started.response;
          if (response.status === 429 || response.status >= 500) {
            record(await retryOrFail(pool, payloadStore, row, now, response.status)); continue;
          }
          if (response.status !== 200) {
            if (await failReadback(pool, payloadStore, row, now)) counts.failed += 1;
            continue;
          }
          const state = string(parse(response.body, "google_subscription_response").subscriptionState, "google_subscription_state", 128);
          const committed = await withCurrentClaim(pool, row, async (client) => {
            await appendLifecycleFact(client, row, {
              eventKind: "subscription_state_verified", subscriptionState: state.toLowerCase(), financialEffect: "none",
              providerEventDigest: sha256(`${row.notification_digest}\0${state.toLowerCase()}`),
              effectiveAt: now.toISOString(), now,
            });
            await finish(client, row, true, now);
            return true;
          });
          if (committed) counts.processed += 1;
          continue;
        }
        const voided = object(notification.voidedPurchaseNotification, "google_voided_purchase");
        const orderId = string(voided.orderId, "google_order_id", 255);
        const started = await beginProviderRequest(pool, row, () => options.googleClient!({
          operation: "order", packageName, orderId,
        }));
        if (!started) continue;
        const response = await started.response;
        if (response.status === 429 || response.status >= 500) {
          record(await retryOrFail(pool, payloadStore, row, now, response.status)); continue;
        }
        if (response.status !== 200) {
          if (await failReadback(pool, payloadStore, row, now)) counts.failed += 1;
          continue;
        }
        const orderDigest = sha256(orderId);
        const refundEvents = normalizeGoogleOrderRefunds(response.body, orderDigest);
        const outcome = refundEvents.length === 0 ? "missing" : await withCurrentClaim(pool, row, async (client) => {
          const persisted = await appendVerifiedGoogleRefundForOrder(
            pool, client, row, orderDigest, refundEvents, now,
          );
          if (persisted === "invalid") {
            await recordReadbackFailure(client, row, now);
            await finish(client, row, false, now);
            return "failed" as const;
          }
          if (persisted === "missing") return "missing" as const;
          for (const event of refundEvents) {
            await appendLifecycleFact(client, row, {
              eventKind: "refund_verified", providerEventDigest: event.eventDigest,
              transactionDigest: orderDigest, financialEffect: "refund",
              effectiveAt: event.eventTime, now,
            });
          }
          await finish(client, row, true, now);
          return "processed" as const;
        });
        if (outcome === "failed") counts.failed += 1;
        else if (outcome === "processed") counts.processed += 1;
        else if (outcome === "missing") record(await retryOrFail(pool, payloadStore, row, now));
        continue;
      }
      if (!options.appleClient || !options.verifyAppleSignedData) {
        record(await retryOrFail(pool, payloadStore, row, now));
        continue;
      }
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
      const started = await beginProviderRequest(pool, row, () => options.appleClient!({
          operation: row.operation === "apple_refund_history" ? "refund_history" : "transaction_history",
          transactionId, ...(revision ? { revision } : {}), bundleId,
          ...(appAppleId === undefined ? {} : { appAppleId }), environment,
        }));
      if (!started) continue;
      const response = await started.response;
      if (response.status === 429 || response.status >= 500) {
        record(await retryOrFail(pool, payloadStore, row, now, response.status)); continue;
      }
      if (response.status !== 200) {
        if (await failReadback(pool, payloadStore, row, now)) counts.failed += 1;
        continue;
      }
      const page = parse(response.body, "apple_history");
      if (!Array.isArray(page.signedTransactions)) throw new Error("apple_history_transactions_invalid");
      const lifecycle: LifecycleInput[] = [];
      for (const signed of page.signedTransactions) {
        const transaction = options.verifyAppleSignedData(string(signed, "apple_signed_transaction"));
        if (transaction.bundleId !== bundleId || transaction.environment !== environment) throw new Error("apple_history_scope_mismatch");
        const transactionDigest = sha256(string(transaction.transactionId, "apple_transaction_id", 128));
        const originalDigest = sha256(string(transaction.originalTransactionId, "apple_original_transaction_id", 128));
        const revoked = transaction.revocationDate !== undefined;
        const financialEffect = normalized.event.financialEffect === "refund_reversal"
          ? "refund_reversal" as const
          : revoked ? "refund" as const : "purchase" as const;
        lifecycle.push({
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
        let nextRef: string | undefined;
        try {
          const committed = await withCurrentClaim(pool, row, async (client) => {
            nextRef = await payloadStore.write(
              { tenantId: row.tenant_id, appId: row.app_id, objectId: `apple-commerce-cursor-${row.readback_id}-${row.attempts}` },
              Buffer.from(JSON.stringify({ revision: nextRevision }), "utf8"),
            );
            for (const fact of lifecycle) await appendLifecycleFact(client, row, fact);
            const updated = await client.query(
              `UPDATE ephemeral.commerce_provider_readbacks
                  SET cursor_ref=$4,attempts=0,next_attempt_at=$5,last_status=200,
                      claim_token=NULL,claimed_until=NULL
                WHERE tenant_id=$1 AND app_id=$2 AND readback_id=$3::uuid AND claim_token=$6::uuid`,
              [row.tenant_id, row.app_id, row.readback_id, nextRef, now.toISOString(), row.claim_token],
            );
            if (updated.rowCount !== 1) throw new Error("commerce_readback_claim_lost_during_checkpoint");
            await client.query(
              `UPDATE control.commerce_backfill_checkpoints
                  SET cursor_ref=$4,updated_at=$5
                WHERE provider=$6 AND tenant_id=$1 AND app_id=$2 AND stream=$7`,
              [row.tenant_id, row.app_id, row.readback_id, nextRef, now.toISOString(), row.provider, checkpointStream(row)],
            );
            if (row.cursor_ref) await payloadStore.purge(row.cursor_ref);
            return true;
          });
          if (!committed) {
            continue;
          }
        } catch (error) {
          if (nextRef) await payloadStore.purge(nextRef);
          throw error;
        }
      } else {
        const committed = await withCurrentClaim(pool, row, async (client) => {
          for (const fact of lifecycle) await appendLifecycleFact(client, row, fact);
          if (row.cursor_ref) await payloadStore.purge(row.cursor_ref);
          await finish(client, row, true, now);
          return true;
        });
        if (!committed) continue;
      }
      counts.processed += 1;
    } catch {
      record(await retryOrFail(pool, payloadStore, row, now));
    }
  }
  return counts;
}

type GoogleRefundEvent = {
  readonly eventDigest: string;
  readonly eventTime: string;
  readonly amountUnscaled: string;
  readonly amountScale: number;
  readonly currency: string;
};

async function appendVerifiedGoogleRefundForOrder(
  pool: Pool,
  client: PoolClient,
  row: ReadbackRow,
  orderDigest: string,
  events: readonly GoogleRefundEvent[],
  now: Date,
): Promise<"persisted" | "missing" | "invalid"> {
  const binding = (await client.query<{
      purchase_record_id: string; installation_id: string; transaction_id: string; currency: string;
      amount_unscaled: string; amount_scale: number;
      producer: string; producer_version: string; event_id: string; delivery_id: string;
      schema_version: string; occurred_at: string; occurred_at_source: string; received_at: string;
      processing_purpose_id: string; policy_digest: string; consent_evaluation_policy_version: string;
      financial_status: string; original_transaction_id: string | null;
    }>(
    `SELECT binding.purchase_record_id, purchase.installation_id, purchase.transaction_id,
            binding.currency, binding.amount_unscaled, binding.amount_scale,
            raw.producer, raw.producer_version, raw.event_id, raw.delivery_id,
            raw.schema_version, raw.occurred_at, raw.occurred_at_source, raw.received_at,
            raw.processing_purpose_id, raw.policy_digest, raw.consent_evaluation_policy_version,
            purchase.financial_status, purchase.original_transaction_id
       FROM control.commerce_purchase_bindings AS binding
       JOIN ledger.purchase_facts AS purchase
         ON purchase.tenant_id=binding.tenant_id AND purchase.app_id=binding.app_id
         AND purchase.record_id=binding.purchase_record_id
       JOIN ledger.raw_records AS raw
         ON raw.tenant_id=purchase.tenant_id AND raw.app_id=purchase.app_id
        AND raw.record_id=purchase.record_id
      WHERE binding.provider='google_play' AND binding.tenant_id=$1 AND binding.app_id=$2
        AND binding.transaction_digest=$3`,
    [row.tenant_id, row.app_id, orderDigest],
  )).rows[0];
  if (!binding) return "missing";
  const prior = (await client.query<{ transaction_id: string; amount_unscaled: string; amount_scale: number }>(
    `SELECT transaction_id, amount_unscaled, amount_scale FROM ledger.refund_facts
      WHERE tenant_id=$1 AND app_id=$2 AND correction_target_record_id=$3`,
    [row.tenant_id, row.app_id, binding.purchase_record_id],
  )).rows;
  const toBindingScale = (amount: string, scale: number): bigint | undefined => {
    const value = BigInt(amount);
    if (scale <= binding.amount_scale) return value * (10n ** BigInt(binding.amount_scale - scale));
    const divisor = 10n ** BigInt(scale - binding.amount_scale);
    return value % divisor === 0n ? value / divisor : undefined;
  };
  let refunded = 0n;
  for (const previous of prior) {
    const value = toBindingScale(previous.amount_unscaled, previous.amount_scale);
    if (value === undefined) return "invalid";
    refunded += value;
  }
  const existingTransactions = new Set(prior.map((value) => value.transaction_id));
  const pending: GoogleRefundEvent[] = [];
  for (const event of events) {
    const refundTransactionId = `refund:google-play:${event.eventDigest.slice(0, 48)}`;
    if (existingTransactions.has(refundTransactionId)) continue;
    if (binding.currency !== event.currency) return "invalid";
    const next = toBindingScale(event.amountUnscaled, event.amountScale);
    if (next === undefined || refunded + next > BigInt(binding.amount_unscaled)) return "invalid";
    refunded += next;
    existingTransactions.add(refundTransactionId);
    pending.push(event);
  }
  const purchase = binding;
  const historicalPurchase: CandidateAttempt = {
    batch_id: `historical:${purchase.purchase_record_id}`,
    record: {
      contract_version: "0.4.0", record_id: purchase.purchase_record_id,
      tenant_id: row.tenant_id, app_id: row.app_id,
      producer: purchase.producer, producer_version: purchase.producer_version,
      event_id: purchase.event_id, delivery_id: purchase.delivery_id, event_name: "purchase",
      schema_version: purchase.schema_version, occurred_at: purchase.occurred_at,
      occurred_at_source: purchase.occurred_at_source, received_at: purchase.received_at,
      processing_purpose_id: purchase.processing_purpose_id, processing_sequence: 0,
      payload: {
        event_name: "purchase", installation_id: purchase.installation_id,
        transaction_id: purchase.transaction_id,
        ...(purchase.original_transaction_id ? { original_transaction_id: purchase.original_transaction_id } : {}),
        amount_unscaled: purchase.amount_unscaled, amount_scale: purchase.amount_scale,
        currency: purchase.currency, financial_status: purchase.financial_status,
      },
    },
    server: {
      tenant_id: row.tenant_id, app_id: row.app_id, received_at: purchase.received_at,
      policy_digest: purchase.policy_digest,
      processing_purposes: [{
        processing_purpose_id: purchase.processing_purpose_id,
        consent_required: false,
        policy_version: purchase.consent_evaluation_policy_version,
      }],
      withdrawals: [], alternative_legal_bases: [], fraud_enabled: false, fraud_actions_enabled: false,
    },
  };
  for (const event of pending) {
    if (!await appendVerifiedGoogleRefundWithBinding(
      pool, client, row, purchase, historicalPurchase, event, now,
    )) throw new Error("google_refund_page_not_persisted");
  }
  return "persisted";
}

async function appendVerifiedGoogleRefundWithBinding(
  pool: Pool,
  client: PoolClient,
  row: ReadbackRow,
  binding: { purchase_record_id: string; installation_id: string; transaction_id: string; currency: string },
  historicalPurchase: CandidateAttempt,
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
  }], pool, [historicalPurchase], { persistenceClient: client });
  return output.logical_events.some((value) => value.record_id === recordId)
    || (await client.query(
      "SELECT 1 FROM ledger.refund_facts WHERE tenant_id=$1 AND app_id=$2 AND correction_target_record_id=$3 AND transaction_id=$4",
      [row.tenant_id, row.app_id, binding.purchase_record_id, `refund:google-play:${event.eventDigest.slice(0, 48)}`],
    )).rowCount === 1;
}
