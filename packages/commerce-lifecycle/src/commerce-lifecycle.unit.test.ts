import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import {
  googleSubscriptionLifecycle,
  normalizeAppleNotification,
  normalizeGoogleOrderRefunds,
  sha256,
  verifyCompactJws,
} from "./index.js";

function jws(payload: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "synthetic" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${signature.toString("base64url")}`;
}

describe("verified commerce lifecycle", () => {
  it("maps every documented Google subscription lifecycle notification without making state financial", () => {
    assert.equal(googleSubscriptionLifecycle(1), "subscription_recovered");
    assert.equal(googleSubscriptionLifecycle(2), "subscription_renewed");
    assert.equal(googleSubscriptionLifecycle(5), "subscription_on_hold");
    assert.equal(googleSubscriptionLifecycle(6), "subscription_in_grace_period");
    assert.equal(googleSubscriptionLifecycle(10), "subscription_paused");
    assert.equal(googleSubscriptionLifecycle(12), "subscription_revoked");
    assert.equal(googleSubscriptionLifecycle(13), "subscription_expired");
    assert.throws(() => googleSubscriptionLifecycle(999), /unsupported/);
  });

  it("derives exact full and processed partial Google refund amounts from order history", () => {
    const orderId = "order.synthetic.wo19";
    const events = normalizeGoogleOrderRefunds(Buffer.from(JSON.stringify({
      orderId,
      orderHistory: {
        partialRefundEvents: [
          { processTime: "2026-08-25T01:00:00Z", state: "PENDING", refundDetails: { total: { currencyCode: "USD", units: "9" } } },
          { processTime: "2026-08-25T02:00:00Z", state: "PROCESSED_SUCCESSFULLY", refundDetails: { total: { currencyCode: "USD", units: "1", nanos: 230000000 } } },
        ],
        refundEvent: { eventTime: "2026-08-25T03:00:00Z", refundDetails: { total: { currencyCode: "USD", units: "4" } } },
      },
    })), sha256(orderId));
    assert.deepEqual(events.map(({ amountUnscaled, amountScale, full }) => ({ amountUnscaled, amountScale, full })), [
      { amountUnscaled: "1230000000", amountScale: 9, full: false },
      { amountUnscaled: "4000000000", amountScale: 9, full: true },
    ]);
  });

  it("verifies outer and nested Apple ES256 JWS and rejects signature or scope changes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const verify = (value: string) => verifyCompactJws(value, publicKey);
    const transaction = jws({
      transactionId: "transaction.synthetic.wo19", originalTransactionId: "original.synthetic.wo19",
      bundleId: "com.example.synthetic", environment: "Sandbox", purchaseDate: 1787623200000,
    }, privateKey);
    const renewal = jws({ environment: "Sandbox", autoRenewStatus: 1 }, privateKey);
    const outer = jws({
      notificationType: "DID_RENEW", notificationUUID: "00000000-0000-4000-8000-000000000019",
      signedDate: 1787623260000,
      data: { bundleId: "com.example.synthetic", environment: "Sandbox", signedTransactionInfo: transaction, signedRenewalInfo: renewal },
    }, privateKey);
    const result = normalizeAppleNotification(outer, verify, { bundleId: "com.example.synthetic", environment: "Sandbox" });
    assert.equal(result.event.financialEffect, "purchase");
    assert.equal(result.event.transactionDigest, sha256("transaction.synthetic.wo19"));
    const [outerHeader, outerBody, outerSignature] = outer.split(".");
    const changed = JSON.parse(Buffer.from(outerBody, "base64url").toString("utf8"));
    changed.notificationType = "REFUND";
    const tampered = `${outerHeader}.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${outerSignature}`;
    assert.throws(() => normalizeAppleNotification(tampered, verify, {
      bundleId: "com.example.synthetic", environment: "Sandbox",
    }), /signature/);
    assert.throws(() => normalizeAppleNotification(outer, verify, {
      bundleId: "com.other.synthetic", environment: "Sandbox",
    }), /scope/);
  });
});
