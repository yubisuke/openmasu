import { createHash, createPublicKey, verify, X509Certificate, type KeyObject } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type CommerceProvider = "google_play" | "app_store";
export type CommerceFinancialEffect = "none" | "purchase" | "refund" | "refund_reversal";
export type CommerceLifecycleEvent = {
  readonly provider: CommerceProvider;
  readonly eventKind: string;
  readonly subscriptionState?: string;
  readonly financialEffect: CommerceFinancialEffect;
  readonly externalEventDigest: string;
  readonly transactionDigest?: string;
  readonly originalTransactionDigest?: string;
  readonly effectiveAt: string;
  readonly environment?: "Sandbox" | "Production";
};

export const googleSubscriptionNotificationKinds = new Map<number, string>([
  [1, "subscription_recovered"], [2, "subscription_renewed"], [3, "subscription_canceled"],
  [4, "subscription_purchased"], [5, "subscription_on_hold"], [6, "subscription_in_grace_period"],
  [7, "subscription_restarted"], [8, "subscription_price_change_confirmed"], [9, "subscription_deferred"],
  [10, "subscription_paused"], [11, "subscription_pause_schedule_changed"], [12, "subscription_revoked"],
  [13, "subscription_expired"], [17, "subscription_items_changed"],
  [18, "subscription_cancellation_scheduled"], [19, "subscription_price_change_updated"],
  [20, "subscription_pending_purchase_canceled"], [22, "subscription_price_step_up_consent_updated"],
]);

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label}_invalid`);
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}_invalid`);
  return date.toISOString();
}

export function googleSubscriptionLifecycle(notificationType: number): string {
  const value = googleSubscriptionNotificationKinds.get(notificationType);
  if (!value) throw new Error("google_subscription_notification_type_unsupported");
  return value;
}

export type GoogleRefundEvent = {
  readonly eventDigest: string;
  readonly eventTime: string;
  readonly amountUnscaled: string;
  readonly amountScale: number;
  readonly currency: string;
  readonly full: boolean;
};

function googleMoney(value: unknown): { amountUnscaled: string; amountScale: number; currency: string } {
  const money = object(value, "google_order_refund_money");
  const currency = requiredString(money.currencyCode, "google_order_refund_currency", 3);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("google_order_refund_currency_invalid");
  const units = money.units === undefined ? "0" : String(money.units);
  const nanos = money.nanos === undefined ? 0 : money.nanos;
  if (!/^[0-9]+$/.test(units) || !Number.isInteger(nanos) || Number(nanos) < 0 || Number(nanos) > 999_999_999) {
    throw new Error("google_order_refund_money_invalid");
  }
  return { amountUnscaled: `${units}${String(nanos).padStart(9, "0")}`.replace(/^0+(?=\d)/, ""), amountScale: 9, currency };
}

export function normalizeGoogleOrderRefunds(body: Buffer, expectedOrderDigest: string): readonly GoogleRefundEvent[] {
  const order = object(JSON.parse(body.toString("utf8")), "google_order");
  const orderId = requiredString(order.orderId, "google_order_id", 255);
  if (sha256(orderId) !== expectedOrderDigest) throw new Error("google_order_identity_mismatch");
  const history = object(order.orderHistory, "google_order_history");
  const output: GoogleRefundEvent[] = [];
  if (history.refundEvent !== undefined) {
    const refund = object(history.refundEvent, "google_order_refund_event");
    const eventTime = timestamp(refund.eventTime, "google_order_refund_time");
    const money = googleMoney(object(refund.refundDetails, "google_order_refund_details").total);
    output.push({ eventDigest: sha256(`${orderId}\0full\0${eventTime}\0${money.amountUnscaled}`), eventTime, ...money, full: true });
  }
  if (history.partialRefundEvents !== undefined) {
    if (!Array.isArray(history.partialRefundEvents)) throw new Error("google_order_partial_refunds_invalid");
    for (const value of history.partialRefundEvents) {
      const refund = object(value, "google_order_partial_refund");
      if (refund.state !== "PROCESSED_SUCCESSFULLY") continue;
      const eventTime = timestamp(refund.processTime, "google_order_partial_refund_time");
      const money = googleMoney(object(refund.refundDetails, "google_order_partial_refund_details").total);
      output.push({ eventDigest: sha256(`${orderId}\0partial\0${eventTime}\0${money.amountUnscaled}`), eventTime, ...money, full: false });
    }
  }
  return output.sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.eventDigest.localeCompare(right.eventDigest));
}

function decodePart(value: string, label: string): JsonObject {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0 || decoded.length > 256 * 1024) throw new Error("invalid");
    return object(JSON.parse(decoded.toString("utf8")), label);
  } catch {
    throw new Error(`${label}_invalid`);
  }
}

export function decodeCompactJwsPayloadUnverified(compact: string): JsonObject {
  const parts = compact.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("jws_compact_invalid");
  }
  return decodePart(parts[1], "jws_payload");
}

export function verifyCompactJws(
  compact: string,
  publicKey: KeyObject,
  options: { readonly maximumBytes?: number } = {},
): JsonObject {
  if (Buffer.byteLength(compact, "utf8") > (options.maximumBytes ?? 512 * 1024)) throw new Error("jws_too_large");
  const parts = compact.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("jws_compact_invalid");
  const header = decodePart(parts[0], "jws_header");
  if (header.alg !== "ES256") throw new Error("jws_algorithm_invalid");
  const valid = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!valid) throw new Error("jws_signature_invalid");
  return decodePart(parts[1], "jws_payload");
}

export function appleLeafKeyFromChain(
  compact: string,
  trustedRootFingerprints: ReadonlySet<string>,
  effectiveAt: Date,
): KeyObject {
  const parts = compact.split(".");
  if (parts.length !== 3) throw new Error("apple_jws_compact_invalid");
  const header = decodePart(parts[0], "apple_jws_header");
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
    throw new Error("apple_jws_chain_invalid");
  }
  const certificates = header.x5c.map((value) => new X509Certificate(Buffer.from(requiredString(value, "apple_jws_certificate", 16 * 1024), "base64")));
  const [leaf, intermediate, root] = certificates;
  if (!leaf.verify(intermediate.publicKey) || !intermediate.verify(root.publicKey)) throw new Error("apple_jws_chain_invalid");
  const rootFingerprint = root.fingerprint256.replaceAll(":", "").toLowerCase();
  if (!trustedRootFingerprints.has(rootFingerprint)) throw new Error("apple_jws_root_untrusted");
  for (const certificate of certificates) {
    if (Date.parse(certificate.validFrom) > effectiveAt.getTime() || Date.parse(certificate.validTo) < effectiveAt.getTime()) {
      throw new Error("apple_jws_certificate_expired");
    }
  }
  return createPublicKey(leaf.publicKey);
}

export type AppleSignedDataVerifier = (compact: string) => JsonObject;

const appleFinancialEffects = new Map<string, CommerceFinancialEffect>([
  ["ONE_TIME_CHARGE", "purchase"], ["SUBSCRIBED", "purchase"], ["DID_RENEW", "purchase"],
  ["REFUND", "refund"], ["REVOKE", "refund"], ["REFUND_REVERSED", "refund_reversal"],
]);

export function normalizeAppleNotification(
  compact: string,
  verifySignedData: AppleSignedDataVerifier,
  expected: { readonly bundleId: string; readonly appAppleId?: number; readonly environment: "Sandbox" | "Production" },
): { readonly event: CommerceLifecycleEvent; readonly notificationUuid: string; readonly transaction?: JsonObject; readonly renewal?: JsonObject } {
  const outer = verifySignedData(compact);
  const notificationType = requiredString(outer.notificationType, "apple_notification_type", 128);
  const notificationUuid = requiredString(outer.notificationUUID, "apple_notification_uuid", 64);
  const signedDate = timestamp(outer.signedDate, "apple_notification_signed_date");
  const data = object(outer.data, "apple_notification_data");
  if (data.bundleId !== expected.bundleId || data.environment !== expected.environment
    || (expected.environment === "Production" && data.appAppleId !== expected.appAppleId)) {
    throw new Error("apple_notification_scope_mismatch");
  }
  const signedTransaction = data.signedTransactionInfo;
  const transaction = typeof signedTransaction === "string" ? verifySignedData(signedTransaction) : undefined;
  if (transaction && (transaction.bundleId !== expected.bundleId || transaction.environment !== expected.environment)) {
    throw new Error("apple_transaction_scope_mismatch");
  }
  const signedRenewal = data.signedRenewalInfo;
  const renewal = typeof signedRenewal === "string" ? verifySignedData(signedRenewal) : undefined;
  if (renewal && renewal.environment !== undefined && renewal.environment !== expected.environment) {
    throw new Error("apple_renewal_scope_mismatch");
  }
  const transactionId = transaction?.transactionId;
  const originalTransactionId = transaction?.originalTransactionId;
  const effectiveAt = transaction?.revocationDate !== undefined
    ? timestamp(transaction.revocationDate, "apple_revocation_date")
    : transaction?.purchaseDate !== undefined
      ? timestamp(transaction.purchaseDate, "apple_purchase_date")
      : signedDate;
  return {
    notificationUuid,
    event: {
      provider: "app_store",
      eventKind: notificationType.toLowerCase(),
      financialEffect: appleFinancialEffects.get(notificationType) ?? "none",
      externalEventDigest: sha256(notificationUuid),
      ...(typeof transactionId === "string" ? { transactionDigest: sha256(transactionId) } : {}),
      ...(typeof originalTransactionId === "string" ? { originalTransactionDigest: sha256(originalTransactionId) } : {}),
      effectiveAt,
      environment: expected.environment,
    },
    ...(transaction ? { transaction } : {}),
    ...(renewal ? { renewal } : {}),
  };
}
