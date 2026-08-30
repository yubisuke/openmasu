import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  acquirePrivacyTenantXactFence,
  uuidV7,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";
import { ingestRuntimeBatch } from "./ingestion.js";
import { googleServiceAccountAccessToken } from "./google-service-account.js";

type JsonObject = Record<string, unknown>;

export type PendingGooglePlayProductVerification = {
  readonly tenantId: string;
  readonly appId: string;
  readonly subjectRecordId: string;
  readonly tokenRef: string;
  readonly purchaseToken: string;
  readonly productId: string;
  readonly purchaseKind?: "one_time_product" | "subscription_initial";
  readonly requestedAt: string;
};

type VerificationRow = {
  verification_id: string;
  tenant_id: string;
  app_id: string;
  subject_record_id: string;
  token_ref: string;
  token_digest: string;
  product_id: string;
  purchase_kind: "one_time_product" | "subscription_initial" | "subscription_renewal";
  verified_record_id: string;
  attempts: number;
  claim_token: string | null;
  claimed_until: Date | string | null;
};

type PurchaseClaim = {
  readonly token: string;
  readonly installationId: string;
  readonly amountUnscaled: string;
  readonly amountScale: number;
  readonly currency: string;
};

export type GooglePlayProviderResponse = { readonly status: number; readonly body: Buffer };
export type GooglePlayProviderClient = (input: {
  readonly operation: "product" | "subscription" | "order";
  readonly packageName: string;
  readonly productId: string;
  readonly purchaseToken: string;
  readonly orderId?: string;
  readonly credentialsJson?: string;
  readonly apiBaseUrl?: string;
  readonly tokenUrl?: string;
}) => Promise<GooglePlayProviderResponse>;

export const DEFAULT_GOOGLE_PLAY_CLAIM_LEASE_MS = 5 * 60_000;
export const DEFAULT_GOOGLE_PLAY_REQUEST_TIMEOUT_MS = 10_000;
const MIN_GOOGLE_PLAY_CLAIM_LEASE_MS = 1_000;
const MAX_GOOGLE_PLAY_CLAIM_LEASE_MS = 15 * 60_000;
const MIN_GOOGLE_PLAY_REQUEST_TIMEOUT_MS = 10;
const MAX_GOOGLE_PLAY_REQUEST_TIMEOUT_MS = 2 * 60_000;

type NormalizedProduct = {
  readonly purchaseState: string;
  readonly purchaseCompletionTime?: string;
  readonly orderId?: string;
  readonly productMatched: boolean;
  readonly verified: boolean;
};

export type NormalizedGooglePlaySubscription = {
  readonly subscriptionState: string;
  readonly productMatched: boolean;
  readonly verified: boolean;
  readonly startTime?: string;
  readonly orderId?: string;
};

export type NormalizedGooglePlayOrder = {
  readonly orderState: string;
  readonly productMatched: boolean;
  readonly tokenMatched: boolean;
  readonly verified: boolean;
  readonly amountUnscaled?: string;
  readonly amountScale?: number;
  readonly currency?: string;
  readonly servicePeriodStartTime?: string;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  reason: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(reason);
  }
  return selected;
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("google_play_request_timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}

function jsonObject(body: Buffer, label: string, maximumBytes = 256 * 1024): JsonObject {
  if (body.length > maximumBytes) throw new Error(`${label}_too_large`);
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}_invalid`);
  return parsed as JsonObject;
}

export function normalizeGooglePlayProductResponse(body: Buffer, productId: string): NormalizedProduct {
  const value = jsonObject(body, "google_play_product_response");
  const context = value.purchaseStateContext;
  const purchaseState = context && typeof context === "object" && !Array.isArray(context)
    ? (context as JsonObject).purchaseState
    : undefined;
  if (typeof purchaseState !== "string") throw new Error("google_play_purchase_state_missing");
  const lineItems = value.productLineItem;
  if (!Array.isArray(lineItems)) throw new Error("google_play_product_lines_missing");
  const productMatched = lineItems.some((line) =>
    !!line && typeof line === "object" && !Array.isArray(line)
      && (line as JsonObject).productId === productId,
  );
  const completion = value.purchaseCompletionTime;
  if (completion !== undefined && (typeof completion !== "string" || !Number.isFinite(Date.parse(completion)))) {
    throw new Error("google_play_completion_time_invalid");
  }
  const orderId = value.orderId;
  if (orderId !== undefined && (typeof orderId !== "string" || orderId.length < 1 || orderId.length > 255)) {
    throw new Error("google_play_order_id_invalid");
  }
  return {
    purchaseState,
    productMatched,
    verified: purchaseState === "PURCHASED" && productMatched
      && typeof completion === "string" && typeof orderId === "string",
    ...(typeof completion === "string" ? { purchaseCompletionTime: new Date(completion).toISOString() } : {}),
    ...(typeof orderId === "string" ? { orderId } : {}),
  };
}

export function normalizeGooglePlaySubscriptionResponse(
  body: Buffer,
  productId: string,
): NormalizedGooglePlaySubscription {
  const value = jsonObject(body, "google_play_subscription_response");
  const subscriptionState = value.subscriptionState;
  if (typeof subscriptionState !== "string") throw new Error("google_play_subscription_state_missing");
  const startTime = value.startTime;
  if (typeof startTime !== "string" || !Number.isFinite(Date.parse(startTime))) {
    throw new Error("google_play_subscription_start_time_invalid");
  }
  const lineItems = value.lineItems;
  if (!Array.isArray(lineItems)) throw new Error("google_play_subscription_lines_missing");
  const matches = lineItems.filter((line) => !!line && typeof line === "object" && !Array.isArray(line)
    && (line as JsonObject).productId === productId);
  const productMatched = matches.length === 1;
  const orderId = productMatched ? (matches[0] as JsonObject).latestSuccessfulOrderId : undefined;
  if (orderId !== undefined && (typeof orderId !== "string" || orderId.length < 1 || orderId.length > 255)) {
    throw new Error("google_play_order_id_invalid");
  }
  const stateCanContainASettledInitialOrder = new Set([
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_PAUSED",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
    "SUBSCRIPTION_STATE_ON_HOLD",
    "SUBSCRIPTION_STATE_CANCELED",
    "SUBSCRIPTION_STATE_EXPIRED",
  ]).has(subscriptionState);
  return {
    subscriptionState,
    productMatched,
    verified: stateCanContainASettledInitialOrder && productMatched && typeof orderId === "string",
    startTime: new Date(startTime).toISOString(),
    ...(typeof orderId === "string" ? { orderId } : {}),
  };
}

function googleMoney(value: unknown): { amountUnscaled: string; amountScale: number; currency: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("google_play_order_money_missing");
  const money = value as JsonObject;
  if (typeof money.currencyCode !== "string" || !/^[A-Z]{3}$/.test(money.currencyCode)) {
    throw new Error("google_play_order_currency_invalid");
  }
  const units = money.units === undefined ? "0" : money.units;
  const nanos = money.nanos === undefined ? 0 : money.nanos;
  if (typeof units !== "string" || !/^-?[0-9]+$/.test(units)
    || typeof nanos !== "number" || !Number.isInteger(nanos) || Math.abs(nanos) > 999_999_999) {
    throw new Error("google_play_order_money_invalid");
  }
  const unitValue = BigInt(units);
  if ((unitValue > 0n && nanos < 0) || (unitValue < 0n && nanos > 0)) {
    throw new Error("google_play_order_money_sign_invalid");
  }
  const amount = unitValue * 1_000_000_000n + BigInt(nanos);
  if (amount < 0n) throw new Error("google_play_order_money_negative");
  return { amountUnscaled: amount.toString(), amountScale: 9, currency: money.currencyCode };
}

export function normalizeGooglePlayOrderResponse(
  body: Buffer,
  expected: {
    readonly orderId: string;
    readonly purchaseToken: string;
    readonly productId: string;
    readonly purchaseKind?: "one_time_product" | "subscription_initial" | "subscription_renewal";
    readonly subscriptionStartTime?: string;
  },
): NormalizedGooglePlayOrder {
  const value = jsonObject(body, "google_play_order_response");
  const orderState = value.state;
  if (typeof orderState !== "string") throw new Error("google_play_order_state_missing");
  const tokenMatched = value.purchaseToken === expected.purchaseToken;
  if (value.orderId !== expected.orderId) {
    return { orderState, tokenMatched, productMatched: false, verified: false };
  }
  const lineItems = value.lineItems;
  if (!Array.isArray(lineItems)) throw new Error("google_play_order_lines_missing");
  const matches = lineItems.filter((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)
      || (line as JsonObject).productId !== expected.productId) return false;
    const detailsName = expected.purchaseKind === "subscription_initial" || expected.purchaseKind === "subscription_renewal"
      ? "subscriptionDetails"
      : "oneTimePurchaseDetails";
    const details = (line as JsonObject)[detailsName];
    if (!details || typeof details !== "object" || Array.isArray(details)) return false;
    if (expected.purchaseKind === "subscription_initial" || expected.purchaseKind === "subscription_renewal") {
      const serviceStart = (details as JsonObject).servicePeriodStartTime;
      return typeof expected.subscriptionStartTime === "string"
        && typeof serviceStart === "string"
        && Number.isFinite(Date.parse(serviceStart))
        && (expected.purchaseKind === "subscription_initial"
          ? new Date(serviceStart).toISOString() === expected.subscriptionStartTime
          : new Date(serviceStart).getTime() > Date.parse(expected.subscriptionStartTime));
    }
    return true;
  });
  const productMatched = matches.length === 1;
  if (orderState !== "PROCESSED" || !tokenMatched || !productMatched) {
    return { orderState, tokenMatched, productMatched, verified: false };
  }
  const money = googleMoney((matches[0] as JsonObject).total);
  const details = (matches[0] as JsonObject).subscriptionDetails;
  const servicePeriodStartTime = details && typeof details === "object" && !Array.isArray(details)
    && typeof (details as JsonObject).servicePeriodStartTime === "string"
    ? new Date(String((details as JsonObject).servicePeriodStartTime)).toISOString()
    : undefined;
  return { orderState, tokenMatched, productMatched, verified: true, ...money,
    ...(servicePeriodStartTime ? { servicePeriodStartTime } : {}) };
}

function checkedGoogleUrl(value: string, expectedHost: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error("google_play_endpoint_invalid");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("google_play_endpoint_must_be_https_or_loopback");
  }
  if (!loopback && url.hostname !== expectedHost) throw new Error("google_play_endpoint_host_invalid");
  return url;
}

async function accessToken(
  credentialsJson: string,
  tokenUrlValue: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  return googleServiceAccountAccessToken({ credentialsJson,
    scope: "https://www.googleapis.com/auth/androidpublisher", tokenUrl: tokenUrlValue, signal });
}

async function defaultClient(input: {
  operation: "product" | "subscription" | "order";
  packageName: string;
  productId: string;
  purchaseToken: string;
  orderId?: string;
  credentialsJson?: string;
  apiBaseUrl?: string;
  tokenUrl?: string;
}, signal: AbortSignal): Promise<GooglePlayProviderResponse> {
  if (!input.credentialsJson) throw new Error("google_play_credentials_missing");
  const token = await accessToken(input.credentialsJson, input.tokenUrl, signal);
  const base = checkedGoogleUrl(input.apiBaseUrl ?? "https://androidpublisher.googleapis.com", "androidpublisher.googleapis.com");
  const prefix = `/androidpublisher/v3/applications/${encodeURIComponent(input.packageName)}`;
  const path = input.operation === "product"
    ? `${prefix}/purchases/productsv2/tokens/${encodeURIComponent(input.purchaseToken)}`
    : input.operation === "subscription"
      ? `${prefix}/purchases/subscriptionsv2/tokens/${encodeURIComponent(input.purchaseToken)}`
      : `${prefix}/orders/${encodeURIComponent(input.orderId ?? "")}`;
  const response = await fetch(new URL(path, base), {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal,
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

export async function queueGooglePlayProductVerification(
  pool: Pool,
  input: PendingGooglePlayProductVerification,
): Promise<void> {
  if (input.purchaseToken.length < 1 || Buffer.byteLength(input.purchaseToken, "utf8") > 64 * 1024) {
    throw new Error("google_play_purchase_token_invalid");
  }
  if (input.productId.length < 1 || input.productId.length > 255) throw new Error("google_play_product_id_invalid");
  const purchaseKind = input.purchaseKind ?? "one_time_product";
  const verificationId = uuidV7(Date.parse(input.requestedAt));
  try {
    await withTenant(pool, input.tenantId, async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM ephemeral.google_play_product_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3
         UNION ALL
         SELECT 1 FROM ledger.google_play_purchase_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3
         LIMIT 1`,
        [input.tenantId, input.appId, input.subjectRecordId],
      );
      if (existing.rowCount === 1) return;
      const digest = sha256(input.purchaseToken);
      await client.query(
        `INSERT INTO control.google_play_purchase_tokens (
          token_digest, tenant_id, app_id, verification_id, registered_at, product_id, purchase_kind
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [digest, input.tenantId, input.appId, verificationId, input.requestedAt, input.productId, purchaseKind],
      );
      await client.query(
        `INSERT INTO ephemeral.google_play_product_verifications (
          verification_id, tenant_id, app_id, subject_record_id, token_ref,
          token_digest, product_id, purchase_kind, verified_record_id, next_attempt_at, requested_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11)`,
        [verificationId, input.tenantId, input.appId, input.subjectRecordId, input.tokenRef,
          digest, input.productId, purchaseKind, `record:google-play:${verificationId}`,
          input.requestedAt, input.requestedAt],
      );
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new Error("google_play_purchase_token_reused");
    }
    throw error;
  }
}

async function claimFor(payloadStore: PayloadStore, row: VerificationRow): Promise<PurchaseClaim> {
  const body = jsonObject(await payloadStore.read(row.token_ref), "google_play_purchase_batch");
  if (row.purchase_kind === "subscription_renewal") {
    const token = body.purchase_token;
    const installationId = body.installation_id;
    if (typeof token !== "string" || sha256(token) !== row.token_digest
      || typeof installationId !== "string" || installationId.length < 1) {
      throw new Error("google_play_renewal_claim_invalid");
    }
    return { token, installationId, amountUnscaled: "0", amountScale: 0, currency: "XXX" };
  }
  if (!Array.isArray(body.records)) throw new Error("google_play_purchase_batch_invalid");
  const record = body.records.find((candidate: unknown) =>
    !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as JsonObject).record_id === row.subject_record_id,
  ) as JsonObject | undefined;
  const payload = record?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("google_play_purchase_claim_missing");
  const purchase = payload as JsonObject;
  const extensions = purchase.extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) throw new Error("google_play_purchase_claim_missing");
  const protectedFields = extensions as JsonObject;
  const token = protectedFields.google_play_purchase_token_protected;
  const productId = protectedFields.google_play_product_id_protected;
  const purchaseKind = protectedFields.google_play_purchase_kind ?? "one_time_product";
  if (record?.event_name !== "purchase" || purchase.financial_status !== "pending"
    || typeof token !== "string" || sha256(token) !== row.token_digest || productId !== row.product_id
    || purchaseKind !== row.purchase_kind
    || typeof purchase.installation_id !== "string" || typeof purchase.amount_unscaled !== "string"
    || typeof purchase.amount_scale !== "number" || typeof purchase.currency !== "string") {
    throw new Error("google_play_purchase_claim_invalid");
  }
  return {
    token,
    installationId: purchase.installation_id,
    amountUnscaled: purchase.amount_unscaled,
    amountScale: purchase.amount_scale,
    currency: purchase.currency,
  };
}

async function packageNameFor(pool: Pool, row: VerificationRow): Promise<string | undefined> {
  return withTenant(pool, row.tenant_id, async (client) => (await client.query<{ android_package_name: string }>(
    `SELECT android_package_name FROM control.app_link_identities
      WHERE tenant_id=$1 AND app_id=$2 AND android_package_name IS NOT NULL`,
    [row.tenant_id, row.app_id],
  )).rows[0]?.android_package_name);
}

async function claimGooglePlayProductVerification(
  pool: Pool,
  tenantId: string,
  enabledKinds: readonly VerificationRow["purchase_kind"][],
  now: Date,
  claimToken: string,
  leaseMs: number,
): Promise<VerificationRow | undefined> {
  const claimed = await withTenant(pool, tenantId, (client) => client.query<VerificationRow>(
    `WITH due AS (
       SELECT verification_id
         FROM ephemeral.google_play_product_verifications
        WHERE tenant_id=$1 AND next_attempt_at <= $2
          AND purchase_kind=ANY($3::text[])
          AND (claimed_until IS NULL OR claimed_until <= clock_timestamp())
        ORDER BY next_attempt_at,verification_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ephemeral.google_play_product_verifications AS verification
        SET claim_token=$4::uuid,
            claimed_until=clock_timestamp() + ($5::integer * interval '1 millisecond')
       FROM due
      WHERE verification.tenant_id=$1 AND verification.verification_id=due.verification_id
     RETURNING verification.verification_id::text,verification.tenant_id,verification.app_id,
       verification.subject_record_id,verification.token_ref,verification.token_digest,
       verification.product_id,verification.purchase_kind,verification.verified_record_id,
       verification.attempts,verification.claim_token::text,verification.claimed_until`,
    [tenantId, now.toISOString(), enabledKinds, claimToken, leaseMs],
  ));
  return claimed.rows[0];
}

async function lockCurrentClaim(client: PoolClient, row: VerificationRow): Promise<boolean> {
  if (!row.claim_token || !row.claimed_until) throw new Error("google_play_claim_missing");
  const current = await client.query(
    `SELECT 1
       FROM ephemeral.google_play_product_verifications AS verification
      WHERE verification.tenant_id=$1 AND verification.app_id=$2
        AND verification.verification_id=$3::uuid
        AND verification.claim_token=$4::uuid
        AND verification.claimed_until > clock_timestamp()
      FOR UPDATE OF verification`,
    [row.tenant_id, row.app_id, row.verification_id, row.claim_token],
  );
  return current.rowCount === 1;
}

async function sourceIsAvailable(client: PoolClient, row: VerificationRow): Promise<boolean> {
  const source = await client.query(
    `SELECT 1 FROM ledger.raw_records_current
      WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3
        AND payload_lifecycle_status='available'`,
    [row.tenant_id, row.app_id, row.subject_record_id],
  );
  return source.rowCount === 1;
}

async function beginProviderRequest<T>(
  pool: Pool,
  row: VerificationRow,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<{ readonly response: Promise<T> } | undefined> {
  return withTenant(pool, row.tenant_id, async (client) => {
    await acquirePrivacyTenantXactFence(client, row.tenant_id, "shared");
    if (!await lockCurrentClaim(client, row) || !await sourceIsAvailable(client, row)) return undefined;
    const response = withRequestTimeout(timeoutMs, operation);
    // The request starts while the shared privacy barrier and claim row lock are
    // held. Keep a rejection handler attached while withTenant commits.
    void response.catch(() => undefined);
    return { response };
  });
}

async function appendVerifiedPurchase(
  pool: Pool,
  client: PoolClient,
  row: VerificationRow,
  claim: PurchaseClaim,
  completionTime: string,
  money: { readonly amountUnscaled: string; readonly amountScale: number; readonly currency: string },
  resultId: string,
  now: Date,
): Promise<void> {
  const record = {
    contract_version: "0.4.0",
    record_id: row.verified_record_id,
    delivery_id: `delivery:google-play:${row.verification_id}`,
    tenant_id: row.tenant_id,
    app_id: row.app_id,
    producer: "adapter:google-play",
    producer_version: row.purchase_kind === "one_time_product"
      ? "products-v2-orders-2026-08-24"
      : row.purchase_kind === "subscription_initial"
        ? "subscriptions-v2-orders-2026-08-24"
        : "rtdn-subscriptions-v2-orders-2026-08-24",
    event_id: `event:google-play:${row.verification_id}`,
    event_name: "purchase",
    schema_version: "0.4.0",
    occurred_at: completionTime,
    occurred_at_source: "server",
    received_at: now.toISOString(),
    processing_purpose_id: "revenue_measurement",
    processing_sequence: 0,
    payload: {
      event_name: "purchase",
      installation_id: claim.installationId,
      transaction_id: `transaction:google-play:${row.verification_id}`,
      amount_unscaled: money.amountUnscaled,
      amount_scale: money.amountScale,
      currency: money.currency,
      financial_status: "settled",
      extensions: {
        store_verification_provider: "google_play",
        store_verification_result_id: resultId,
        monetary_authority: "google_play_order_line_total",
        store_purchase_kind: row.purchase_kind,
      },
    },
  };
  const output = await ingestRuntimeBatch([{
    batch_id: `google-play-verification:${row.verification_id}`,
    record,
    server: {
      tenant_id: row.tenant_id,
      app_id: row.app_id,
      received_at: now.toISOString(),
      policy_digest: "google-play-product-verification-v1",
      processing_purposes: [{
        processing_purpose_id: "revenue_measurement",
        consent_required: false,
        policy_version: "google-play-product-verification-v1",
      }],
      withdrawals: [],
      alternative_legal_bases: [],
      fraud_enabled: false,
      fraud_actions_enabled: false,
    },
  }], pool, [], { persistenceClient: client });
  if (!output.logical_events.some((logical) => logical.record_id === row.verified_record_id)) {
    const replayed = (await client.query(
      `SELECT 1 FROM ledger.purchase_facts
        WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 AND financial_status='settled'`,
      [row.tenant_id, row.app_id, row.verified_record_id],
    )).rowCount === 1;
    if (!replayed) throw new Error("google_play_verified_purchase_not_persisted");
  }
}

type VerificationOutcome = {
  readonly verdict: "verified" | "failed" | "unavailable";
  readonly state?: string;
  readonly orderState?: string;
  readonly productMatched: boolean;
  readonly completionTime?: string;
};

async function claimRenewalOrder(
  client: PoolClient,
  row: VerificationRow,
  orderId: string,
  now: Date,
): Promise<{ readonly owned: boolean; readonly orderDigest: string }> {
  const orderDigest = sha256(orderId);
  await client.query(
    `INSERT INTO control.google_play_order_digests (
       order_digest, tenant_id, app_id, verification_id, token_digest,
       product_id, status, claimed_at, verified_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,NULL) ON CONFLICT DO NOTHING`,
    [orderDigest, row.tenant_id, row.app_id, row.verification_id, row.token_digest,
      row.product_id, now.toISOString()],
  );
  const existing = await client.query<{ verification_id: string }>(
    `SELECT verification_id::text FROM control.google_play_order_digests
      WHERE tenant_id=$1 AND app_id=$2 AND order_digest=$3`,
    [row.tenant_id, row.app_id, orderDigest],
  );
  return { owned: existing.rows[0]?.verification_id === row.verification_id, orderDigest };
}

async function complete(
  pool: Pool,
  payloadStore: PayloadStore,
  row: VerificationRow,
  outcome: VerificationOutcome,
  responseBody: Buffer | undefined,
  claim: PurchaseClaim | undefined,
  money: { readonly amountUnscaled: string; readonly amountScale: number; readonly currency: string } | undefined,
  now: Date,
  providerOrderId?: string,
): Promise<VerificationOutcome["verdict"] | undefined> {
  if (!row.claim_token || !row.claimed_until) throw new Error("google_play_claim_missing");
  const resultId = uuidV7(now.getTime());
  let evidenceRef: string | undefined;
  try {
    return await withTenant(pool, row.tenant_id, async (client) => {
      await acquirePrivacyTenantXactFence(client, row.tenant_id, "shared");
      if (!await lockCurrentClaim(client, row)) return undefined;
      if (!await sourceIsAvailable(client, row)) {
        await client.query(
          `DELETE FROM ephemeral.google_play_product_verifications
            WHERE tenant_id=$1 AND app_id=$2 AND verification_id=$3::uuid
              AND claim_token=$4::uuid`,
          [row.tenant_id, row.app_id, row.verification_id, row.claim_token],
        );
        return undefined;
      }
      const prior = await client.query(
        `SELECT 1 FROM ledger.google_play_purchase_verification_results
          WHERE tenant_id=$1 AND app_id=$2
            AND verification_id=$3::uuid
          LIMIT 1`,
        [row.tenant_id, row.app_id, row.verification_id],
      );
      if (prior.rowCount === 1) {
        await client.query(
          `DELETE FROM ephemeral.google_play_product_verifications
            WHERE tenant_id=$1 AND app_id=$2 AND verification_id=$3::uuid
              AND claim_token=$4::uuid`,
          [row.tenant_id, row.app_id, row.verification_id, row.claim_token],
        );
        return undefined;
      }

      let effectiveOutcome = outcome;
      let effectiveRow = row;
      let orderDigest = providerOrderId ? sha256(providerOrderId) : undefined;
      if (effectiveOutcome.verdict === "verified") {
        if (!claim || !effectiveOutcome.completionTime || !money || !providerOrderId) {
          throw new Error("google_play_verified_claim_missing");
        }
        if (row.purchase_kind === "subscription_renewal") {
          const renewal = await claimRenewalOrder(client, row, providerOrderId, now);
          orderDigest = renewal.orderDigest;
          if (renewal.owned) {
            effectiveRow = {
              ...row,
              verified_record_id: `record:google-play-renewal:${orderDigest.slice(0, 48)}`,
            };
          } else {
            effectiveOutcome = { ...outcome, verdict: "failed" };
          }
        }
      }

      evidenceRef = responseBody && effectiveOutcome.verdict !== "unavailable"
        ? await payloadStore.write(
          { tenantId: row.tenant_id, appId: row.app_id, objectId: `google-play-purchase-result-${row.verification_id}` },
          responseBody,
        )
        : undefined;
      if (effectiveOutcome.verdict === "verified") {
        await appendVerifiedPurchase(
          pool,
          client,
          effectiveRow,
          claim!,
          effectiveOutcome.completionTime!,
          money!,
          resultId,
          now,
        );
      }
      const artifact = {
        verification_result_id: resultId,
        verification_id: row.verification_id,
        tenant_id: row.tenant_id,
        app_id: row.app_id,
        subject_record_id: row.subject_record_id,
        provider: "google_play",
        verdict: effectiveOutcome.verdict,
        ...(effectiveOutcome.state ? { provider_purchase_state: effectiveOutcome.state } : {}),
        ...(effectiveOutcome.orderState ? { provider_order_state: effectiveOutcome.orderState } : {}),
        purchase_kind: row.purchase_kind,
        product_matched: effectiveOutcome.productMatched,
        ...(effectiveOutcome.verdict === "verified" ? { verified_record_id: effectiveRow.verified_record_id } : {}),
        monetary_authority: effectiveOutcome.verdict === "verified" ? "google_play_order_line_total" : "unverified",
        decided_at: now.toISOString(),
      };
      const inserted = await client.query(
        `INSERT INTO ledger.google_play_purchase_verification_results (
          verification_result_id, verification_id, tenant_id, app_id, subject_record_id,
          verified_record_id, token_digest, verdict, provider_purchase_state,
          product_matched, evidence_ref, response_digest, decided_at, artifact, purchase_kind
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [resultId, row.verification_id, row.tenant_id, row.app_id, row.subject_record_id,
          effectiveOutcome.verdict === "verified" ? effectiveRow.verified_record_id : null, row.token_digest,
          effectiveOutcome.verdict, effectiveOutcome.state ?? null, effectiveOutcome.productMatched, evidenceRef ?? null,
          responseBody && effectiveOutcome.verdict !== "unavailable" ? sha256(responseBody) : null,
          now.toISOString(), JSON.stringify(artifact), row.purchase_kind],
      );
      if (inserted.rowCount !== 1) throw new Error("google_play_result_not_persisted");
      if (row.purchase_kind === "subscription_renewal" && effectiveOutcome.verdict === "verified") {
        if (!orderDigest) throw new Error("google_play_renewal_order_digest_missing");
        const marked = await client.query(
          `UPDATE control.google_play_order_digests
              SET status='verified', verified_at=$4
            WHERE tenant_id=$1 AND app_id=$2 AND order_digest=$3
              AND verification_id=$5 AND status='pending'`,
          [row.tenant_id, row.app_id, orderDigest, now.toISOString(), row.verification_id],
        );
        if (marked.rowCount !== 1) throw new Error("google_play_renewal_order_claim_lost");
      }
      if (effectiveOutcome.verdict === "verified" && orderDigest && claim && money) {
        await client.query(
          `INSERT INTO control.commerce_purchase_bindings (
             provider, tenant_id, app_id, transaction_digest, original_transaction_digest,
             purchase_record_id, installation_digest, amount_unscaled, amount_scale, currency, quantity, bound_at
           ) VALUES ('google_play',$1,$2,$3,$3,$4,$5,$6,$7,$8,1,$9) ON CONFLICT DO NOTHING`,
           [row.tenant_id, row.app_id, orderDigest, effectiveRow.verified_record_id,
            sha256(`${row.tenant_id}\0${row.app_id}\0${claim.installationId}`),
            money.amountUnscaled, money.amountScale, money.currency, now.toISOString()],
        );
      }
      const removed = await client.query(
        `DELETE FROM ephemeral.google_play_product_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND verification_id=$3::uuid
            AND claim_token=$4::uuid`,
        [row.tenant_id, row.app_id, row.verification_id, row.claim_token],
      );
      if (removed.rowCount !== 1) throw new Error("google_play_claim_lost_during_completion");
      return effectiveOutcome.verdict;
    });
  } catch (error) {
    if (evidenceRef) await payloadStore.purge(evidenceRef);
    throw error;
  }
}

async function defer(pool: Pool, row: VerificationRow, now: Date): Promise<boolean> {
  if (!row.claim_token || !row.claimed_until) throw new Error("google_play_claim_missing");
  const delaySeconds = Math.min(60 * (2 ** row.attempts), 900);
  return withTenant(pool, row.tenant_id, async (client) => (await client.query(
    `UPDATE ephemeral.google_play_product_verifications
        SET attempts=attempts+1,
            next_attempt_at=$4::timestamptz + ($5::text || ' seconds')::interval,
            claim_token=NULL,
            claimed_until=NULL
      WHERE tenant_id=$1 AND app_id=$2 AND verification_id=$3::uuid
        AND claim_token=$6::uuid AND claimed_until > clock_timestamp()`,
    [row.tenant_id, row.app_id, row.verification_id, now.toISOString(), String(delaySeconds), row.claim_token],
  )).rowCount === 1);
}

export async function processGooglePlayProductVerifications(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: {
    readonly enabled?: boolean;
    readonly credentialsJson?: string;
    readonly apiBaseUrl?: string;
    readonly tokenUrl?: string;
    readonly client?: GooglePlayProviderClient;
    readonly now?: () => Date;
    readonly maximumAttempts?: number;
    readonly enabledKinds?: readonly ("one_time_product" | "subscription_initial" | "subscription_renewal")[];
    readonly claimLeaseMs?: number;
    readonly requestTimeoutMs?: number;
    readonly claimToken?: () => string;
  } = {},
): Promise<{ readonly verified: number; readonly failed: number; readonly unavailable: number; readonly deferred: number }> {
  if (options.enabled !== true) return { verified: 0, failed: 0, unavailable: 0, deferred: 0 };
  const now = options.now?.() ?? new Date();
  const enabledKinds = options.enabledKinds ?? ["one_time_product", "subscription_initial", "subscription_renewal"];
  if (enabledKinds.length === 0) return { verified: 0, failed: 0, unavailable: 0, deferred: 0 };
  const claimLeaseMs = boundedInteger(
    options.claimLeaseMs,
    DEFAULT_GOOGLE_PLAY_CLAIM_LEASE_MS,
    MIN_GOOGLE_PLAY_CLAIM_LEASE_MS,
    MAX_GOOGLE_PLAY_CLAIM_LEASE_MS,
    "google_play_claim_lease_invalid",
  );
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs,
    DEFAULT_GOOGLE_PLAY_REQUEST_TIMEOUT_MS,
    MIN_GOOGLE_PLAY_REQUEST_TIMEOUT_MS,
    MAX_GOOGLE_PLAY_REQUEST_TIMEOUT_MS,
    "google_play_request_timeout_invalid",
  );
  if (requestTimeoutMs >= claimLeaseMs) {
    throw new Error("google_play_request_timeout_must_be_shorter_than_claim_lease");
  }
  const counts = { verified: 0, failed: 0, unavailable: 0, deferred: 0 };
  const recordCompletion = (verdict: VerificationOutcome["verdict"] | undefined): void => {
    if (verdict) counts[verdict] += 1;
  };
  for (let processed = 0; processed < 100; processed += 1) {
    const row = await claimGooglePlayProductVerification(
      pool,
      tenantId,
      enabledKinds,
      now,
      (options.claimToken ?? randomUUID)(),
      claimLeaseMs,
    );
    if (!row) break;
    let claim: PurchaseClaim | undefined;
    let packageName: string | undefined;
    try {
      claim = await claimFor(payloadStore, row);
      packageName = await packageNameFor(pool, row);
    } catch {
      // A protected-claim integrity failure is permanent and never produces revenue.
    }
    if (!claim || !packageName) {
      recordCompletion(await complete(
        pool,
        payloadStore,
        row,
        { verdict: "failed", productMatched: false },
        Buffer.from("{}"),
        undefined,
        undefined,
        now,
      ));
      continue;
    }
    let response: GooglePlayProviderResponse;
    try {
      const input = {
        operation: row.purchase_kind === "one_time_product" ? "product" : "subscription",
        packageName,
        productId: row.product_id,
        purchaseToken: claim.token,
        credentialsJson: options.credentialsJson,
        apiBaseUrl: options.apiBaseUrl,
        tokenUrl: options.tokenUrl,
      } as const;
      const started = await beginProviderRequest(pool, row, requestTimeoutMs, (signal) => options.client
        ? options.client(input)
        : defaultClient(input, signal));
      if (!started) continue;
      response = await started.response;
    } catch {
      response = { status: 503, body: Buffer.alloc(0) };
    }
    if (response.status === 429 || response.status >= 500) {
      if (row.attempts + 1 < (options.maximumAttempts ?? 96)) {
        if (await defer(pool, row, now)) counts.deferred += 1;
      } else {
        recordCompletion(await complete(
          pool,
          payloadStore,
          row,
          { verdict: "unavailable", productMatched: false },
          undefined,
          claim,
          undefined,
          now,
        ));
      }
      continue;
    }
    if (response.status !== 200) {
      recordCompletion(await complete(
        pool,
        payloadStore,
        row,
        { verdict: "failed", productMatched: false },
        response.body,
        claim,
        undefined,
        now,
      ));
      continue;
    }
    let normalized: NormalizedProduct | NormalizedGooglePlaySubscription;
    try {
      normalized = row.purchase_kind === "one_time_product"
        ? normalizeGooglePlayProductResponse(response.body, row.product_id)
        : normalizeGooglePlaySubscriptionResponse(response.body, row.product_id);
    } catch {
      recordCompletion(await complete(
        pool,
        payloadStore,
        row,
        { verdict: "failed", productMatched: false },
        response.body,
        claim,
        undefined,
        now,
      ));
      continue;
    }
    const purchaseState = "purchaseState" in normalized
      ? normalized.purchaseState
      : normalized.subscriptionState;
    if (purchaseState === "PENDING" || purchaseState === "SUBSCRIPTION_STATE_PENDING") {
      if (row.attempts + 1 < (options.maximumAttempts ?? 96)) {
        if (await defer(pool, row, now)) counts.deferred += 1;
      } else {
        recordCompletion(await complete(pool, payloadStore, row, {
          verdict: "unavailable", state: purchaseState, productMatched: normalized.productMatched,
        }, undefined, claim, undefined, now));
      }
      continue;
    }
    if (!normalized.verified) {
      recordCompletion(await complete(pool, payloadStore, row, {
        verdict: "failed",
        state: purchaseState,
        productMatched: normalized.productMatched,
      }, response.body, claim, undefined, now));
      continue;
    }
    let orderResponse: GooglePlayProviderResponse;
    try {
      const input = {
        operation: "order",
        packageName,
        productId: row.product_id,
        purchaseToken: claim.token,
        orderId: normalized.orderId,
        credentialsJson: options.credentialsJson,
        apiBaseUrl: options.apiBaseUrl,
        tokenUrl: options.tokenUrl,
      } as const;
      const started = await beginProviderRequest(pool, row, requestTimeoutMs, (signal) => options.client
        ? options.client(input)
        : defaultClient(input, signal));
      if (!started) continue;
      orderResponse = await started.response;
    } catch {
      orderResponse = { status: 503, body: Buffer.alloc(0) };
    }
    if (orderResponse.status === 429 || orderResponse.status >= 500) {
      if (row.attempts + 1 < (options.maximumAttempts ?? 96)) {
        if (await defer(pool, row, now)) counts.deferred += 1;
      } else {
        recordCompletion(await complete(pool, payloadStore, row, {
          verdict: "unavailable", state: purchaseState, productMatched: true,
        }, undefined, claim, undefined, now));
      }
      continue;
    }
    const evidenceBody = orderResponse.status === 200
      ? Buffer.from(JSON.stringify({
        purchase_response_base64: response.body.toString("base64"),
        order_response_base64: orderResponse.body.toString("base64"),
      }), "utf8")
      : orderResponse.body;
    if (orderResponse.status !== 200) {
      recordCompletion(await complete(pool, payloadStore, row, {
        verdict: "failed", state: purchaseState, productMatched: true,
      }, evidenceBody, claim, undefined, now));
      continue;
    }
    let order: NormalizedGooglePlayOrder;
    try {
      order = normalizeGooglePlayOrderResponse(orderResponse.body, {
        orderId: normalized.orderId!, purchaseToken: claim.token, productId: row.product_id,
        purchaseKind: row.purchase_kind,
        ...(row.purchase_kind !== "one_time_product" && "startTime" in normalized
          ? { subscriptionStartTime: normalized.startTime }
          : {}),
      });
    } catch {
      recordCompletion(await complete(pool, payloadStore, row, {
        verdict: "failed", state: purchaseState, productMatched: true,
      }, evidenceBody, claim, undefined, now));
      continue;
    }
    if (!order.verified || order.amountUnscaled === undefined
      || order.amountScale === undefined || order.currency === undefined) {
      recordCompletion(await complete(pool, payloadStore, row, {
        verdict: "failed", state: purchaseState,
        orderState: order.orderState, productMatched: order.productMatched,
      }, evidenceBody, claim, undefined, now));
      continue;
    }
    const completionTime = row.purchase_kind === "one_time_product"
      ? (normalized as NormalizedProduct).purchaseCompletionTime
      : row.purchase_kind === "subscription_initial"
        ? (normalized as NormalizedGooglePlaySubscription).startTime
        : order.servicePeriodStartTime;
    recordCompletion(await complete(pool, payloadStore, row, {
      verdict: "verified",
      state: purchaseState,
      orderState: order.orderState,
      productMatched: true,
      completionTime,
    }, evidenceBody, claim, {
      amountUnscaled: order.amountUnscaled, amountScale: order.amountScale, currency: order.currency,
    }, now, normalized.orderId));
  }
  return counts;
}
