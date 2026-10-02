import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { normalizeAppleTransaction, verifyCompactJws } from "./index.js";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const expected = { bundleId: "dev.openmasu.synthetic.commerce", environment: "Sandbox" as const };
const purchaseDate = Date.parse("2026-08-06T01:00:00.000Z"), revoked = purchaseDate + 86400000;
const base = { transactionId: "synthetic.apple.transaction", originalTransactionId: "synthetic.apple.original",
  productId: "synthetic.product", bundleId: expected.bundleId, environment: expected.environment,
  purchaseDate, signedDate: revoked, inAppOwnershipType: "PURCHASED", quantity: 3, price: 1230, currency: "USD",
  appAccountToken: "00000000-0000-4000-8000-000000000186" };
function signed(value: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(value)).toString("base64url"), input = `${header}.${body}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const decode = (value: Record<string, unknown> = base) => normalizeAppleTransaction(signed(value),
  compact => verifyCompactJws(compact, keys.publicKey), expected);

describe("Apple signed transaction monetary basis", () => {
  it("uses verified milliunits once including quantity and keeps zero distinct from missing money", () => {
    assert.deepEqual(decode().purchase, { amountUnscaled: "1230", amountScale: 3, currency: "USD" });
    assert.equal(decode().quantity, 3);
    assert.equal(decode({ ...base, price: 0 }).purchase?.amountUnscaled, "0");
    for (const missing of [{ price: undefined }, { currency: undefined }]) {
      const result = decode({ ...base, ...missing });
      assert.equal(result.purchase, undefined); assert.equal(result.purchaseExclusion, "money_missing");
    }
  });

  it("does not treat family organization unknown or missing ownership as purchaser revenue", () => {
    for (const inAppOwnershipType of ["FAMILY_SHARED", "ASSIGNED", "FUTURE_VALUE", undefined]) {
      const value = decode({ ...base, inAppOwnershipType, revocationDate: revoked, revocationType: "REFUND_FULL" });
      assert.equal(value.purchase, undefined); assert.equal(value.refund, undefined);
      assert.equal(value.purchaseExclusion, "ownership_not_purchased");
    }
  });

  it("derives full and fractional-milliunit prorated bases without rounding or quantity multiplication", () => {
    const full = decode({ ...base, revocationDate: revoked, revocationType: "REFUND_FULL" });
    assert.deepEqual(full.refund, { amountUnscaled: "1230", amountScale: 3, currency: "USD", basis: "full_transaction_price" });
    const partial = decode({ ...base, revocationDate: revoked, revocationType: "REFUND_PRORATED", revocationPercentage: 33333 });
    assert.deepEqual(partial.refund, { amountUnscaled: "40999590", amountScale: 8, currency: "USD",
      basis: "prorated_transaction_price", percentage: 33333 });
    assert.equal(partial.purchase?.amountUnscaled, "1230");
  });

  it("never infers money from entitlement revocation or incomplete contradictory refund evidence", () => {
    for (const revocationType of [undefined, "FAMILY_REVOKE", "ASSIGNMENT_REVOKE", "UNKNOWN"]) {
      const value = decode({ ...base, revocationDate: revoked, revocationType });
      assert.equal(value.refund, undefined); assert.equal(value.refundExclusion, "revocation_not_monetary");
    }
    for (const missing of [{ revocationDate: undefined }, { revocationPercentage: undefined }, { price: undefined }]) {
      const value = decode({ ...base, revocationDate: revoked, revocationType: "REFUND_PRORATED", revocationPercentage: 50000, ...missing });
      assert.equal(value.refund, undefined); assert.equal(value.refundExclusion, "refund_basis_unavailable");
    }
    assert.equal(decode({ ...base, revocationDate: revoked, revocationType: "REFUND_FULL", revocationPercentage: 50000 }).refundExclusion,
      "refund_basis_inconsistent");
  });

  it("rejects tampering scope mismatch noninteger money invalid times and malformed identity fields", () => {
    const compact = signed(base), [head, body, signature] = compact.split(".");
    const changed = JSON.parse(Buffer.from(body, "base64url").toString()); changed.price = 1;
    assert.throws(() => normalizeAppleTransaction(`${head}.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`,
      value => verifyCompactJws(value, keys.publicKey), expected), /signature/);
    for (const mismatch of [{ bundleId: "dev.other.synthetic" }, { environment: "Production" }]) assert.throws(() => decode({ ...base, ...mismatch }), /scope/);
    for (const invalid of [{ price: -1 }, { price: 1.23 }, { price: "1230" }, { price: Number.MAX_SAFE_INTEGER + 1 },
      { currency: "usd" }, { purchaseDate: "2026-08-06" }, { purchaseDate: Infinity }, { signedDate: -1 },
      { transactionId: "" }, { originalTransactionId: "" }, { productId: "" }, { appAccountToken: "not-a-uuid" },
      { quantity: 0 }, { quantity: 1.5 }, { revocationDate: purchaseDate - 1 },
      { revocationPercentage: -1 }, { revocationPercentage: 100001 }, { revocationPercentage: 0.5 }]) {
      assert.throws(() => decode({ ...base, ...invalid }), /invalid/);
    }
  });
});
