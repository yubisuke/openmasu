import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeGooglePlayOrderResponse,
  normalizeGooglePlayProductResponse,
  normalizeGooglePlaySubscriptionResponse,
} from "./google-play-product-verifier.js";

function response(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("Google Play one-time-product response normalization", () => {
  it("accepts only PURCHASED responses with the claimed product and completion time", () => {
    const result = normalizeGooglePlayProductResponse(response({
      purchaseStateContext: { purchaseState: "PURCHASED" },
      purchaseCompletionTime: "2026-08-24T00:00:00Z",
      orderId: "order:synthetic-53",
      productLineItem: [{ productId: "product.synthetic.51" }],
    }), "product.synthetic.51");
    assert.deepEqual(result, {
      purchaseState: "PURCHASED",
      purchaseCompletionTime: "2026-08-24T00:00:00.000Z",
      orderId: "order:synthetic-53",
      productMatched: true,
      verified: true,
    });
  });

  it("keeps pending, cancelled, and product-mismatched responses unverified", () => {
    for (const [purchaseState, returnedProduct] of [
      ["PENDING", "product.synthetic.51"],
      ["CANCELLED", "product.synthetic.51"],
      ["PURCHASED", "product.other.51"],
    ] as const) {
      const result = normalizeGooglePlayProductResponse(response({
        purchaseStateContext: { purchaseState },
        purchaseCompletionTime: "2026-08-24T00:00:00.000Z",
        orderId: "order:synthetic-53",
        productLineItem: [{ productId: returnedProduct }],
      }), "product.synthetic.51");
      assert.equal(result.verified, false);
    }
  });

  it("rejects malformed provider responses instead of guessing", () => {
    assert.throws(() => normalizeGooglePlayProductResponse(response({}), "product.synthetic.51"),
      /google_play_purchase_state_missing/);
    assert.throws(() => normalizeGooglePlayProductResponse(response({
      purchaseStateContext: { purchaseState: "PURCHASED" }, productLineItem: "not-an-array",
    }), "product.synthetic.51"), /google_play_product_lines_missing/);
  });

  it("requires an order ID before a purchased product can advance to monetary verification", () => {
    const result = normalizeGooglePlayProductResponse(response({
      purchaseStateContext: { purchaseState: "PURCHASED" },
      purchaseCompletionTime: "2026-08-24T00:00:00Z",
      productLineItem: [{ productId: "product.synthetic.51" }],
    }), "product.synthetic.51");
    assert.equal(result.verified, false);
  });
});

describe("Google Play initial subscription response normalization", () => {
  const productId = "subscription.synthetic.55";

  it("requires one matching line with a latest successful order", () => {
    assert.deepEqual(normalizeGooglePlaySubscriptionResponse(response({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      startTime: "2026-08-24T01:02:03Z",
      lineItems: [{ productId, latestSuccessfulOrderId: "order:subscription:55" }],
    }), productId), {
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productMatched: true,
      verified: true,
      startTime: "2026-08-24T01:02:03.000Z",
      orderId: "order:subscription:55",
    });
  });

  it("does not advance pending, unspecified, ambiguous, or orderless snapshots", () => {
    for (const value of [
      { subscriptionState: "SUBSCRIPTION_STATE_PENDING", startTime: "2026-08-24T01:02:03Z",
        lineItems: [{ productId, latestSuccessfulOrderId: "order:subscription:55" }] },
      { subscriptionState: "SUBSCRIPTION_STATE_UNSPECIFIED", startTime: "2026-08-24T01:02:03Z",
        lineItems: [{ productId, latestSuccessfulOrderId: "order:subscription:55" }] },
      { subscriptionState: "SUBSCRIPTION_STATE_FUTURE", startTime: "2026-08-24T01:02:03Z",
        lineItems: [{ productId, latestSuccessfulOrderId: "order:subscription:55" }] },
      { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", startTime: "2026-08-24T01:02:03Z",
        lineItems: [{ productId }, { productId, latestSuccessfulOrderId: "order:subscription:55" }] },
    ]) assert.equal(normalizeGooglePlaySubscriptionResponse(response(value), productId).verified, false);
  });

  it("accepts an order only when its subscription service period starts with the subscription", () => {
    const expected = {
      orderId: "order:subscription:55",
      purchaseToken: "token:subscription:55",
      productId,
      purchaseKind: "subscription_initial" as const,
      subscriptionStartTime: "2026-08-24T01:02:03.000Z",
    };
    const line = {
      productId,
      total: { currencyCode: "EUR", units: "7", nanos: 125_000_000 },
      subscriptionDetails: {
        servicePeriodStartTime: "2026-08-24T01:02:03Z",
        servicePeriodEndTime: "2026-09-24T01:02:03Z",
      },
    };
    assert.equal(normalizeGooglePlayOrderResponse(response({
      orderId: expected.orderId, purchaseToken: expected.purchaseToken,
      state: "PROCESSED", lineItems: [line],
    }), expected).amountUnscaled, "7125000000");
    assert.equal(normalizeGooglePlayOrderResponse(response({
      orderId: expected.orderId, purchaseToken: expected.purchaseToken,
      state: "PROCESSED", lineItems: [{ ...line, subscriptionDetails: {
        ...line.subscriptionDetails, servicePeriodStartTime: "2026-09-24T01:02:03Z",
      } }],
    }), expected).verified, false);
  });

  it("accepts a renewal only when its service period starts after the original subscription", () => {
    const expected = {
      orderId: "order:subscription:renewal:55",
      purchaseToken: "token:subscription:55",
      productId,
      purchaseKind: "subscription_renewal" as const,
      subscriptionStartTime: "2026-08-24T01:02:03.000Z",
    };
    const renewal = normalizeGooglePlayOrderResponse(response({
      orderId: expected.orderId,
      purchaseToken: expected.purchaseToken,
      state: "PROCESSED",
      lineItems: [{
        productId,
        total: { currencyCode: "EUR", units: "8", nanos: 0 },
        subscriptionDetails: {
          servicePeriodStartTime: "2026-09-24T01:02:03Z",
          servicePeriodEndTime: "2026-10-24T01:02:03Z",
        },
      }],
    }), expected);
    assert.equal(renewal.verified, true);
    assert.equal(renewal.servicePeriodStartTime, "2026-09-24T01:02:03.000Z");
    assert.equal(normalizeGooglePlayOrderResponse(response({
      orderId: expected.orderId,
      purchaseToken: expected.purchaseToken,
      state: "PROCESSED",
      lineItems: [{
        productId,
        total: { currencyCode: "EUR", units: "8", nanos: 0 },
        subscriptionDetails: {
          servicePeriodStartTime: "2026-08-24T01:02:03Z",
          servicePeriodEndTime: "2026-09-24T01:02:03Z",
        },
      }],
    }), expected).verified, false);
  });
});

describe("Google Play order response normalization", () => {
  const expected = {
    orderId: "order:synthetic-53",
    purchaseToken: "token:synthetic-53",
    productId: "product.synthetic.53",
  };

  it("converts the matching processed line total exactly without floating point or rounding", () => {
    const result = normalizeGooglePlayOrderResponse(response({
      orderId: expected.orderId,
      purchaseToken: expected.purchaseToken,
      state: "PROCESSED",
      lineItems: [{
        productId: expected.productId,
        total: { currencyCode: "USD", units: "12", nanos: 345_000_000 },
        oneTimePurchaseDetails: { quantity: 1 },
      }],
    }), expected);
    assert.deepEqual(result, {
      orderState: "PROCESSED",
      productMatched: true,
      tokenMatched: true,
      verified: true,
      amountUnscaled: "12345000000",
      amountScale: 9,
      currency: "USD",
    });
  });

  it("rejects ambiguous products, token mismatches, non-processed orders, and invalid money", () => {
    const line = {
      productId: expected.productId,
      total: { currencyCode: "USD", units: "1", nanos: 0 },
      oneTimePurchaseDetails: { quantity: 1 },
    };
    for (const value of [
      { orderId: expected.orderId, purchaseToken: "token:other", state: "PROCESSED", lineItems: [line] },
      { orderId: expected.orderId, purchaseToken: expected.purchaseToken, state: "REFUNDED", lineItems: [line] },
      { orderId: expected.orderId, purchaseToken: expected.purchaseToken, state: "PROCESSED", lineItems: [line, line] },
    ]) {
      assert.equal(normalizeGooglePlayOrderResponse(response(value), expected).verified, false);
    }
    assert.throws(() => normalizeGooglePlayOrderResponse(response({
      orderId: expected.orderId,
      purchaseToken: expected.purchaseToken,
      state: "PROCESSED",
      lineItems: [{ ...line, total: { currencyCode: "USD", units: "1", nanos: 1_000_000_000 } }],
    }), expected), /google_play_order_money_invalid/);
  });
});
