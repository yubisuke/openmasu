import type { AppleSignedDataVerifier } from "./index.js";

type Money = { readonly amountUnscaled: string; readonly amountScale: number; readonly currency: string };
export type AppleTransaction = {
  readonly transactionId: string;
  readonly originalTransactionId: string;
  readonly bundleId: string;
  readonly productId: string;
  readonly environment: "Sandbox" | "Production";
  readonly appAccountToken?: string;
  readonly purchaseAt: string;
  readonly signedAt: string;
  readonly quantity?: number;
  readonly ownership?: string;
  readonly purchase?: Money;
  readonly purchaseExclusion?: "ownership_not_purchased" | "money_missing";
  readonly revocationAt?: string;
  readonly refund?: Money & {
    readonly basis: "full_transaction_price" | "prorated_transaction_price";
    readonly percentage?: number;
  };
  readonly refundExclusion?: "revocation_not_monetary" | "refund_basis_unavailable" | "refund_basis_inconsistent";
};

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`apple_transaction_${label}_invalid`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`apple_transaction_${label}_invalid`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) throw new Error(`apple_transaction_${label}_invalid`);
  return date.toISOString();
}

/**
 * Decode only through the injected signature verifier. The returned identifiers
 * are protected working data, not a public artifact or an installation binding.
 * Price is a transaction basis, not App Store Connect accounting proceeds.
 */
export function normalizeAppleTransaction(
  compact: string,
  verifySignedData: AppleSignedDataVerifier,
  expected: { readonly bundleId: string; readonly environment: "Sandbox" | "Production" },
): AppleTransaction {
  const value = verifySignedData(compact);
  if (value.bundleId !== expected.bundleId || value.environment !== expected.environment) {
    throw new Error("apple_transaction_scope_mismatch");
  }
  const transactionId = text(value.transactionId, "id", 128);
  const originalTransactionId = text(value.originalTransactionId, "original_id", 128);
  const productId = text(value.productId, "product", 255);
  const purchaseAt = instant(value.purchaseDate, "purchase_date");
  const signedAt = instant(value.signedDate, "signed_date");
  let appAccountToken: string | undefined;
  if (value.appAccountToken !== undefined) {
    appAccountToken = text(value.appAccountToken, "token", 36).toLowerCase();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(appAccountToken)) {
      throw new Error("apple_transaction_token_invalid");
    }
  }
  if (value.quantity !== undefined && (typeof value.quantity !== "number" || !Number.isSafeInteger(value.quantity)
    || value.quantity < 1 || value.quantity > 10000)) throw new Error("apple_transaction_quantity_invalid");
  const ownership = value.inAppOwnershipType === undefined ? undefined : text(value.inAppOwnershipType, "ownership", 64);
  if (value.price !== undefined && (typeof value.price !== "number" || !Number.isSafeInteger(value.price) || value.price < 0)) {
    throw new Error("apple_transaction_price_invalid");
  }
  if (value.currency !== undefined && (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency))) {
    throw new Error("apple_transaction_currency_invalid");
  }
  // Apple price already includes quantity. Never multiply by quantity here.
  const money: Money | undefined = value.price !== undefined && value.currency !== undefined
    ? { amountUnscaled: String(value.price), amountScale: 3, currency: value.currency as string } : undefined;
  const purchase = ownership === "PURCHASED" ? money : undefined;
  const purchaseExclusion = ownership !== "PURCHASED" ? "ownership_not_purchased" as const
    : money === undefined ? "money_missing" as const : undefined;
  const revocationAt = value.revocationDate === undefined ? undefined : instant(value.revocationDate, "revocation_date");
  if (revocationAt && revocationAt < purchaseAt) throw new Error("apple_transaction_revocation_date_invalid");
  if (value.revocationPercentage !== undefined && (typeof value.revocationPercentage !== "number"
    || !Number.isSafeInteger(value.revocationPercentage) || value.revocationPercentage < 0 || value.revocationPercentage > 100000)) {
    throw new Error("apple_transaction_revocation_percentage_invalid");
  }
  let refund: AppleTransaction["refund"], refundExclusion: AppleTransaction["refundExclusion"];
  if (revocationAt !== undefined || value.revocationType !== undefined || value.revocationPercentage !== undefined) {
    if (!["REFUND_FULL", "REFUND_PRORATED"].includes(String(value.revocationType))) {
      // Family/organization access loss and unknown future types are not money.
      refundExclusion = "revocation_not_monetary";
    } else if (!purchase || !revocationAt || (value.revocationType === "REFUND_PRORATED" && value.revocationPercentage === undefined)) {
      refundExclusion = "refund_basis_unavailable";
    } else if (value.revocationType === "REFUND_FULL") {
      if (value.revocationPercentage !== undefined && value.revocationPercentage !== 100000) refundExclusion = "refund_basis_inconsistent";
      else refund = { ...purchase, basis: "full_transaction_price" };
    } else {
      // Milliunits times milli-percent / 100000 is exact at scale 8. This is a
      // derived transaction-price basis, not an asserted settled refund amount.
      refund = { amountUnscaled: String(BigInt(purchase.amountUnscaled) * BigInt(value.revocationPercentage as number)),
        amountScale: 8, currency: purchase.currency, basis: "prorated_transaction_price", percentage: value.revocationPercentage as number };
    }
  }
  return { transactionId, originalTransactionId, productId, bundleId: expected.bundleId, environment: expected.environment,
    purchaseAt, signedAt, ...(appAccountToken === undefined ? {} : { appAccountToken }),
    ...(value.quantity === undefined ? {} : { quantity: value.quantity as number }),
    ...(ownership === undefined ? {} : { ownership }), ...(purchase ? { purchase } : { purchaseExclusion }),
    ...(revocationAt === undefined ? {} : { revocationAt }), ...(refund ? { refund } : {}), ...(refundExclusion ? { refundExclusion } : {}) };
}
