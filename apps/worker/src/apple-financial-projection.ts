import type { Pool, PoolClient } from "pg";
import type { CandidateAttempt } from "@openmasu/attribution-core";
import { sha256, type AppleTransaction } from "@openmasu/commerce-lifecycle";
import type { PayloadStore } from "@openmasu/runtime";
import { activeApplePurchaseAnchor, readApplePurchaseIntent } from "@openmasu/runtime/apple-purchase-binding";
import { ingestRuntimeBatch } from "./ingestion.js";

type Scope = { tenantId: string; appId: string };
type Purchase = {
  record_id: string; installation_id: string; transaction_id: string; original_transaction_id: string | null;
  amount_unscaled: string; amount_scale: number; currency: string; financial_status: string;
  producer: string; producer_version: string; event_id: string; delivery_id: string; schema_version: string;
  occurred_at: string; occurred_at_source: string; received_at: string; processing_purpose_id: string;
  policy_digest: string; consent_evaluation_policy_version: string;
  correction_target_record_id?: string;
};

export type AppleRefundReversal = {
  transaction: AppleTransaction; effectiveAt: string; notificationDigest: string;
};

function attempt(scope: Scope, recordId: string, name: "purchase" | "refund", occurredAt: string,
  now: Date, payload: Record<string, unknown>): CandidateAttempt {
  return {
    batch_id: `apple:${recordId}`,
    record: {
      contract_version: "0.4.0", record_id: recordId, delivery_id: `delivery:${recordId}`,
      tenant_id: scope.tenantId, app_id: scope.appId, producer: "adapter:app-store",
      producer_version: "verified-transaction-history-v1", event_id: `event:${recordId}`, event_name: name,
      schema_version: "0.4.0", occurred_at: occurredAt, occurred_at_source: "server", received_at: now.toISOString(),
      processing_purpose_id: "revenue_measurement", processing_sequence: 0, payload: { event_name: name, ...payload },
    },
    server: {
      tenant_id: scope.tenantId, app_id: scope.appId, received_at: now.toISOString(), policy_digest: "verified-commerce-v1",
      processing_purposes: [{ processing_purpose_id: "revenue_measurement", consent_required: false, policy_version: "verified-commerce-v1" }],
      withdrawals: [], alternative_legal_bases: [], fraud_enabled: false, fraud_actions_enabled: false,
    },
  };
}

function historical(scope: Scope, purchase: Purchase, name: "purchase" | "refund" = "purchase"): CandidateAttempt {
  const result = attempt(scope,purchase.record_id,name,purchase.occurred_at,new Date(purchase.received_at), {
    installation_id: purchase.installation_id, transaction_id: purchase.transaction_id,
    ...(purchase.original_transaction_id ? { original_transaction_id: purchase.original_transaction_id } : {}),
    amount_unscaled: purchase.amount_unscaled, amount_scale: purchase.amount_scale, currency: purchase.currency,
    financial_status: purchase.financial_status,
    ...(purchase.correction_target_record_id ? { correction_target_record_id: purchase.correction_target_record_id } : {}),
  });
  Object.assign(result.record, { producer: purchase.producer, producer_version: purchase.producer_version,
    event_id: purchase.event_id, delivery_id: purchase.delivery_id, schema_version: purchase.schema_version,
    occurred_at_source: purchase.occurred_at_source, processing_purpose_id: purchase.processing_purpose_id });
  result.server.policy_digest = purchase.policy_digest;
  result.server.processing_purposes[0].policy_version = purchase.consent_evaluation_policy_version;
  return result;
}

/** The caller owns the current read-back claim and shared tenant privacy fence. */
export async function projectAppleTransaction(input: Scope & {
  pool: Pool; client: PoolClient; store: PayloadStore; transaction: AppleTransaction; signed: string;
  now: Date; reversal?: AppleRefundReversal; createdReferences: string[];
}): Promise<string> {
  const { client, transaction: tx } = input;
  if (input.reversal) {
    const notice = input.reversal.transaction;
    if (notice.transactionId !== tx.transactionId || notice.originalTransactionId !== tx.originalTransactionId
      || notice.productId !== tx.productId || notice.bundleId !== tx.bundleId || notice.environment !== tx.environment
      || (notice.appAccountToken !== undefined && tx.appAccountToken !== undefined && notice.appAccountToken !== tx.appAccountToken)) {
      return "refund_reversal_scope_mismatch";
    }
    if (notice.ownership !== "PURCHASED") return "ownership_not_purchased";
    if (notice.revocationAt || notice.refundExclusion || tx.revocationAt || tx.refundExclusion) return "refund_reversal_not_restored";
    if (tx.signedAt < notice.signedAt) return "refund_reversal_history_stale";
    if (notice.purchase && (!tx.purchase || notice.purchase.currency !== tx.purchase.currency
      || notice.purchase.amountUnscaled !== tx.purchase.amountUnscaled || notice.purchase.amountScale !== tx.purchase.amountScale)) {
      return "refund_reversal_basis_mismatch";
    }
    if (input.reversal.effectiveAt > input.now.toISOString()) return "refund_reversal_history_stale";
  }
  if (!tx.purchase) return tx.purchaseExclusion!;
  // One global provider transaction binding, even across competing notifications.
  const transactionDigest = sha256(tx.transactionId), originalDigest = sha256(tx.originalTransactionId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`apple-purchase:${transactionDigest}`]);
  let intent;
  if (tx.appAccountToken !== undefined) {
    intent = await readApplePurchaseIntent(client,input.tenantId,input.appId,{ tokenDigest: sha256(tx.appAccountToken) });
  } else {
    // A renewal may omit the token, but only a previously verified original-
    // transaction binding can carry its installation. Never infer from time.
    const bindings = await client.query<{ apple_intent_id: string }>(`SELECT DISTINCT apple_intent_id::text
      FROM control.commerce_purchase_bindings WHERE provider='app_store' AND tenant_id=$1 AND app_id=$2
      AND original_transaction_digest=$3 AND apple_intent_id IS NOT NULL`, [input.tenantId,input.appId,originalDigest]);
    if (bindings.rows.length === 1) intent = await readApplePurchaseIntent(client,input.tenantId,input.appId,{ intentId: bindings.rows[0].apple_intent_id });
  }
  if (!intent || intent.bundle_id !== tx.bundleId || intent.environment !== tx.environment || intent.product_id !== tx.productId) return "transaction_unbound";
  const anchor = await activeApplePurchaseAnchor(client,input.store,intent);
  if (!anchor) return "transaction_privacy_blocked";
  const purchaseId = `record:apple-purchase:${sha256(JSON.stringify([input.tenantId,input.appId,tx.environment,transactionDigest])).slice(0,48)}`;
  const purchaseTransactionId = purchaseId.replace("record:","transaction:");
  const binding = (await client.query<{ apple_intent_id: string | null; purchase_record_id: string; amount_unscaled: string; amount_scale: number; currency: string; original_transaction_digest: string }>(
    `SELECT apple_intent_id::text,purchase_record_id,amount_unscaled,amount_scale,currency,original_transaction_digest
      FROM control.commerce_purchase_bindings WHERE provider='app_store' AND transaction_digest=$1`, [transactionDigest])).rows[0];
  if (binding && (binding.apple_intent_id !== intent.intent_id || binding.purchase_record_id !== purchaseId
    || binding.amount_unscaled !== tx.purchase.amountUnscaled || binding.amount_scale !== tx.purchase.amountScale
    || binding.currency !== tx.purchase.currency || binding.original_transaction_digest !== originalDigest)) return "transaction_binding_conflict";
  // A reversal must never create a purchase merely to make its target exist.
  if (input.reversal && !binding) return "refund_reversal_target_missing";

  async function persist(value: CandidateAttempt, history: CandidateAttempt[] = []) {
    const output = await ingestRuntimeBatch([value],input.pool,history,{ persistenceClient: client });
    if (!output.logical_events.some(row => row.record_id === value.record.record_id) || output.rejections.length) {
      throw new Error("apple_financial_projection_not_persisted");
    }
    const evidenceRef = await input.store.write({ tenantId: input.tenantId, appId: input.appId,
      objectId: `apple-transaction-${value.record.record_id}` },Buffer.from(input.signed));
    input.createdReferences.push(evidenceRef);
    await client.query(`INSERT INTO control.apple_purchase_evidence
      (record_id,tenant_id,app_id,installation_id_digest,intent_id,evidence_ref,signed_digest,recorded_at)
      VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8)`, [value.record.record_id,input.tenantId,input.appId,
      intent!.installation_id_digest,intent!.intent_id,evidenceRef,sha256(input.signed),input.now.toISOString()]);
  }
  const readPurchase = async () => (await client.query<Purchase>(`SELECT purchase.*,raw.producer,raw.producer_version,raw.event_id,raw.delivery_id,
    raw.schema_version,raw.occurred_at,raw.occurred_at_source,raw.received_at,raw.processing_purpose_id,
    raw.policy_digest,raw.consent_evaluation_policy_version
    FROM ledger.purchase_facts AS purchase JOIN ledger.raw_records AS raw USING (tenant_id,app_id,record_id)
    JOIN ledger.raw_records_current AS current USING (tenant_id,app_id,record_id)
    WHERE purchase.tenant_id=$1 AND purchase.app_id=$2 AND purchase.record_id=$3 AND current.payload_lifecycle_status='available'`,
  [input.tenantId,input.appId,purchaseId])).rows[0];
  if (input.reversal) {
    const purchase = await readPurchase();
    if (!purchase) return "transaction_privacy_blocked";
    const refunds = (await client.query<Purchase & { lifecycle: string; intent_id: string | null }>(`SELECT refund.*,raw.record_id,
      raw.producer,raw.producer_version,raw.event_id,raw.delivery_id,raw.schema_version,raw.occurred_at,
      raw.occurred_at_source,raw.received_at,raw.processing_purpose_id,raw.policy_digest,raw.consent_evaluation_policy_version,
      current.payload_lifecycle_status AS lifecycle,evidence.intent_id::text
      FROM ledger.refund_facts AS refund
      JOIN ledger.logical_events AS logical USING (tenant_id,app_id,logical_event_id)
      JOIN ledger.raw_records AS raw USING (tenant_id,app_id,record_id)
      JOIN ledger.raw_records_current AS current USING (tenant_id,app_id,record_id)
      LEFT JOIN control.apple_purchase_evidence AS evidence USING (tenant_id,app_id,record_id)
      WHERE refund.tenant_id=$1 AND refund.app_id=$2 AND refund.correction_target_record_id=$3
        AND refund.financial_status='settled' ORDER BY raw.record_id COLLATE "C" LIMIT 2`,
    [input.tenantId,input.appId,purchaseId])).rows;
    // The provider notification names a transaction, not an individual partial
    // refund. Do not guess which of multiple recorded deductions it cancels.
    if (!refunds.length) return "refund_reversal_target_missing";
    if (refunds.length !== 1) return "refund_reversal_target_ambiguous";
    const refund = refunds[0];
    if (refund.lifecycle !== "available" || refund.intent_id !== intent.intent_id
      || refund.producer !== "adapter:app-store") return "refund_reversal_target_unavailable";
    if (refund.installation_id !== anchor.installationId || refund.currency !== purchase.currency
      || refund.original_transaction_id !== purchase.transaction_id
      || refund.occurred_at > input.reversal.effectiveAt || refund.received_at > input.now.toISOString()) {
      return "refund_reversal_basis_mismatch";
    }
    const reversalId = `record:apple-refund-reversal:${sha256(JSON.stringify([purchaseId,refund.record_id])).slice(0,48)}`;
    if ((await client.query(`SELECT 1 FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3`,
      [input.tenantId,input.appId,reversalId])).rowCount) return "refund_reversal_already_projected";
    await persist(attempt(input,reversalId,"refund",input.reversal.effectiveAt,input.now, {
      installation_id: anchor.installationId, transaction_id: reversalId.replace("record:","transaction:"),
      original_transaction_id: purchase.transaction_id, correction_target_record_id: purchaseId,
      reverses_refund_record_id: refund.record_id, amount_unscaled: refund.amount_unscaled,
      amount_scale: refund.amount_scale, currency: refund.currency, financial_status: "reversed",
      extensions: { store_verification_provider: "app_store", monetary_authority: "app_store_refund_reversal",
        monetary_basis: "previously_verified_refund", notification_digest: input.reversal.notificationDigest },
    }),[historical(input,purchase),historical(input,refund,"refund")]);
    return "refund_reversal_projected";
  }
  if (!binding) {
    // Do not put the subscription-series identifier in original_transaction_id:
    // refunds target one renewal, not all purchases sharing the original series.
    await persist(attempt(input,purchaseId,"purchase",tx.purchaseAt,input.now, {
      installation_id: anchor.installationId, transaction_id: purchaseTransactionId,
      amount_unscaled: tx.purchase.amountUnscaled, amount_scale: tx.purchase.amountScale, currency: tx.purchase.currency,
      financial_status: "settled", extensions: { store_verification_provider: "app_store",
        monetary_authority: "app_store_transaction_price", monetary_basis: "transaction_price_including_quantity" },
    }));
    await client.query(`INSERT INTO control.commerce_purchase_bindings
      (provider,tenant_id,app_id,transaction_digest,original_transaction_digest,purchase_record_id,installation_digest,
       amount_unscaled,amount_scale,currency,quantity,bound_at,apple_intent_id)
      VALUES ('app_store',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid)`,
    [input.tenantId,input.appId,transactionDigest,originalDigest,purchaseId,
      sha256(`${input.tenantId}\0${input.appId}\0${anchor.installationId}`),tx.purchase.amountUnscaled,
      tx.purchase.amountScale,tx.purchase.currency,tx.quantity ?? 1,input.now.toISOString(),intent.intent_id]);
  }
  if (!tx.refund) return tx.refundExclusion ?? "purchase_projected";
  const purchase = await readPurchase();
  if (!purchase) return "transaction_privacy_blocked";
  const previous = (await client.query<{ amount_unscaled: string; amount_scale: number }>(`SELECT amount_unscaled,amount_scale
    FROM ledger.refund_facts WHERE tenant_id=$1 AND app_id=$2 AND correction_target_record_id=$3 AND financial_status='settled'`,
  [input.tenantId,input.appId,purchaseId])).rows;
  // The signed revocation describes the refund basis of this transaction, not
  // a second refund on every poll. Keep exact scale-18 sums and append only the
  // previously unrepresented amount. Refund reversals have a separate gate.
  const atScale = (amount: string, scale: number) => BigInt(amount) * 10n ** BigInt(18-scale);
  const already = previous.reduce((sum,row) => sum + atScale(row.amount_unscaled,row.amount_scale),0n);
  const desired = atScale(tx.refund.amountUnscaled,tx.refund.amountScale);
  if (desired <= already) return "refund_already_projected";
  const delta = desired - already;
  const refundId = `record:apple-refund:${sha256(JSON.stringify([purchaseId,tx.revocationAt,desired.toString()])).slice(0,48)}`;
  await persist(attempt(input,refundId,"refund",tx.revocationAt!,input.now, {
    installation_id: anchor.installationId, transaction_id: refundId.replace("record:","transaction:"),
    original_transaction_id: purchase.transaction_id, correction_target_record_id: purchaseId,
    amount_unscaled: delta.toString(), amount_scale: 18, currency: tx.refund.currency, financial_status: "settled",
    extensions: { store_verification_provider: "app_store", monetary_authority: "app_store_transaction_revocation",
      monetary_basis: tx.refund.basis, ...(tx.refund.percentage === undefined ? {} : { milli_percent: tx.refund.percentage }) },
  }),[historical(input,purchase)]);
  return "refund_projected";
}
