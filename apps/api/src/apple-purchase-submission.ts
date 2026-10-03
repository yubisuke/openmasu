import type { Pool } from "pg";
import { acquirePrivacyTenantXactFence, withTenant, type PayloadStore } from "@openmasu/runtime";
import { activeApplePurchaseAnchor, readApplePurchaseIntent } from "@openmasu/runtime/apple-purchase-binding";
import { normalizeAppleTransaction, sha256, type AppleSignedDataVerifier } from "@openmasu/commerce-lifecycle";
import { ApplePurchaseIntentError, type ApplePurchaseEnvironment } from "./apple-purchase-intents.js";
import { installationIdDigest, type SdkAuthConfig, type VerifiedSdkRequest } from "./sdk-auth.js";
import { recordCommerceNotification } from "./commerce-notifications.js";

export async function submitApplePurchase(input: { pool: Pool; payloadStore: PayloadStore; config: SdkAuthConfig;
  identity: VerifiedSdkRequest; environment?: ApplePurchaseEnvironment; verifySignedData?: AppleSignedDataVerifier; value: unknown; now?: Date }) {
  if (!input.environment || !input.verifySignedData) throw new ApplePurchaseIntentError(503,"app_store_purchase_submission_unavailable");
  const value = input.value as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["intent_id","installation_id","signed_transaction","revenue_measurement_consent"].includes(key))
    || typeof value.intent_id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.intent_id)
    || typeof value.installation_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.installation_id)
    || typeof value.signed_transaction !== "string" || Buffer.byteLength(value.signed_transaction,"utf8") > 256 * 1024
    || value.revenue_measurement_consent !== true) throw new ApplePurchaseIntentError(400,"purchase_submission_invalid");
  const identity = input.identity, intentId = value.intent_id.toLowerCase(), installationId = value.installation_id, compact = value.signed_transaction;
  if (identity.platform !== "ios" || !identity.installationKeyId || !identity.installationIdDigest
    || identity.tenantId !== input.config.tenantId || identity.appId !== input.config.appId
    || installationIdDigest(input.config,installationId) !== identity.installationIdDigest) throw new ApplePurchaseIntentError(403,"installation_scope_mismatch");
  const created: string[] = [], now = input.now ?? new Date();
  try {
    return await withTenant(input.pool,identity.tenantId,async client => {
      await acquirePrivacyTenantXactFence(client,identity.tenantId,"shared");
      const intent = await readApplePurchaseIntent(client,identity.tenantId,identity.appId,{ intentId });
      if (!intent || intent.installation_id_digest !== identity.installationIdDigest
        || intent.installation_key_id !== identity.installationKeyId) throw new ApplePurchaseIntentError(403,"purchase_intent_scope_mismatch");
      if (intent.environment !== input.environment) throw new ApplePurchaseIntentError(409,"purchase_intent_conflict");
      const anchor = await activeApplePurchaseAnchor(client,input.payloadStore,intent);
      if (!anchor) throw new ApplePurchaseIntentError(401,"unauthorized");
      let transaction;
      try { transaction = normalizeAppleTransaction(compact,input.verifySignedData!,{ bundleId: intent.bundle_id, environment: intent.environment }); }
      catch { throw new ApplePurchaseIntentError(400,"purchase_signed_transaction_invalid"); }
      if (transaction.productId !== intent.product_id || transaction.appAccountToken !== anchor.appAccountToken
        || anchor.installationId !== installationId) throw new ApplePurchaseIntentError(403,"purchase_transaction_scope_mismatch");
      const notificationDigest = sha256(JSON.stringify(["apple-sdk-transaction",identity.tenantId,identity.appId,intentId,sha256(compact)]));
      await recordCommerceNotification({ ...input, tenantId: identity.tenantId, appId: identity.appId, persistenceClient: client,
        payload: Buffer.from(JSON.stringify({ format: "apple_sdk_transaction_v1", intent_id: intentId, signed_transaction: compact })),
        notificationDigest, subjectDigest: sha256(transaction.originalTransactionId), installationIdDigest: intent.installation_id_digest,
        receivedAt: now, readbackOperation: "apple_transaction_history", onEvidenceCreated: ref => created.push(ref),
        event: { provider: "app_store", eventKind: "sdk_transaction_submitted", financialEffect: "none",
          externalEventDigest: notificationDigest, transactionDigest: sha256(transaction.transactionId),
          originalTransactionDigest: sha256(transaction.originalTransactionId), effectiveAt: transaction.purchaseAt, environment: intent.environment } });
      return { intent_id: intentId, state: "pending" as const };
    });
  } catch (error) { for (const ref of created) await input.payloadStore.purge(ref); throw error; }
}
