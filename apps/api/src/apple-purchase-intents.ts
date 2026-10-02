import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { acquirePrivacyTenantXactFence, withTenant, type PayloadStore } from "@openmasu/runtime";
import { privacyProjectionIsBlocked } from "../../runtime/src/privacy-fence.js";
import { installationIdDigest, type SdkAuthConfig, type VerifiedSdkRequest } from "./sdk-auth.js";

export type ApplePurchaseEnvironment = "Sandbox" | "Production";
export class ApplePurchaseIntentError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 503, message: string) { super(message); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function applePurchaseEnvironment(value: string | undefined): ApplePurchaseEnvironment | undefined {
  if (value === undefined || value === "off") return undefined;
  if (value === "Sandbox" || value === "Production") return value;
  throw new Error("app_store_purchase_environment_invalid");
}

export function parseApplePurchaseIntent(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApplePurchaseIntentError(400, "purchase_intent_invalid");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !["request_id", "installation_id", "product_id", "revenue_measurement_consent"].includes(key))
    || typeof source.request_id !== "string" || !uuid.test(source.request_id)
    || typeof source.installation_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(source.installation_id)
    || typeof source.product_id !== "string" || !/^[A-Za-z0-9._-]{1,255}$/.test(source.product_id)
    || source.revenue_measurement_consent !== true) throw new ApplePurchaseIntentError(400, "purchase_intent_invalid");
  return { requestId: source.request_id.toLowerCase(), installationId: source.installation_id, productId: source.product_id };
}

/** Issuance proves only an authenticated installation's purchase intent, never a purchase. */
export async function prepareApplePurchaseIntent(input: {
  pool: Pool; payloadStore: PayloadStore; config: SdkAuthConfig; identity: VerifiedSdkRequest;
  environment?: ApplePurchaseEnvironment; value: unknown; now?: Date;
}) {
  if (!input.environment) throw new ApplePurchaseIntentError(503, "app_store_purchase_preparation_unavailable");
  const request = parseApplePurchaseIntent(input.value), identity = input.identity;
  if (identity.platform !== "ios" || !identity.installationKeyId || !identity.installationIdDigest
    || identity.tenantId !== input.config.tenantId || identity.appId !== input.config.appId
    || installationIdDigest(input.config, request.installationId) !== identity.installationIdDigest) {
    throw new ApplePurchaseIntentError(403, "installation_scope_mismatch");
  }
  const now = (input.now ?? new Date()).toISOString();
  let createdRef: string | undefined;
  try {
    return await withTenant(input.pool, identity.tenantId, async client => {
      await acquirePrivacyTenantXactFence(client, identity.tenantId, "shared");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([
        "openmasu:apple-purchase-intent", identity.tenantId, identity.appId, identity.installationIdDigest, request.requestId,
      ])]);
      const existing = (await client.query<{
        intent_id: string; product_id: string; environment: string; installation_key_id: string;
        anchor_ref: string; token_digest: string; created_at: string;
      }>(`SELECT intent_id::text,product_id,environment,installation_key_id,anchor_ref,token_digest,created_at
            FROM control.apple_purchase_intents
           WHERE tenant_id=$1 AND app_id=$2 AND installation_id_digest=$3 AND request_id=$4::uuid`,
      [identity.tenantId, identity.appId, identity.installationIdDigest, request.requestId])).rows[0];
      if (await privacyProjectionIsBlocked(client, { entryId: request.requestId, tenantId: identity.tenantId,
        appId: identity.appId, subjectDigest: identity.installationIdDigest, receivedAt: existing?.created_at ?? now })) {
        throw new ApplePurchaseIntentError(401, "unauthorized");
      }
      const active = await client.query(`SELECT 1 FROM control.installation_credentials_current AS credential
        JOIN control.sdk_keys_current AS sdk USING (tenant_id,app_id,sdk_key_id)
        WHERE credential.tenant_id=$1 AND credential.app_id=$2 AND credential.installation_key_id=$3
          AND credential.installation_id_digest=$4 AND credential.status='active' AND sdk.status='active' AND sdk.platform='ios'
          AND NOT EXISTS (SELECT 1 FROM control.installation_withdrawals AS withdrawal
            WHERE withdrawal.tenant_id=credential.tenant_id AND withdrawal.app_id=credential.app_id
              AND withdrawal.installation_key_id=credential.installation_key_id AND withdrawal.processing_purpose_id='revenue_measurement')`,
      [identity.tenantId, identity.appId, identity.installationKeyId, identity.installationIdDigest]);
      if (active.rowCount !== 1) throw new ApplePurchaseIntentError(401, "unauthorized");
      if (existing) {
        if (existing.product_id !== request.productId || existing.environment !== input.environment
          || existing.installation_key_id !== identity.installationKeyId) throw new ApplePurchaseIntentError(409, "purchase_intent_conflict");
        const anchor = JSON.parse((await input.payloadStore.read(existing.anchor_ref)).toString("utf8"));
        if (typeof anchor.app_account_token !== "string" || !uuid.test(anchor.app_account_token)
          || digest(anchor.app_account_token) !== existing.token_digest || anchor.installation_id !== request.installationId) {
          throw new Error("purchase_intent_anchor_invalid");
        }
        return { intent_id: existing.intent_id, app_account_token: anchor.app_account_token as string,
          product_id: existing.product_id, environment: input.environment, state: "prepared" as const };
      }
      const registration = (await client.query<{ apple_bundle_id: string | null; apple_app_adam_id: string }>(
        "SELECT apple_bundle_id,apple_app_adam_id::text FROM control.apple_app_registrations WHERE tenant_id=$1 AND app_id=$2",
        [identity.tenantId, identity.appId])).rows[0];
      if (!registration?.apple_bundle_id) throw new ApplePurchaseIntentError(409, "apple_app_registration_required");
      const intentId = randomUUID(), token = randomUUID();
      createdRef = await input.payloadStore.write({ tenantId: identity.tenantId, appId: identity.appId, objectId: `apple-purchase-intent-${intentId}` },
        Buffer.from(JSON.stringify({ installation_id: request.installationId, app_account_token: token })));
      await client.query(`INSERT INTO control.apple_purchase_intents
        (intent_id,tenant_id,app_id,request_id,installation_key_id,installation_id_digest,token_digest,product_id,
         environment,bundle_id,app_apple_id,anchor_ref,created_at)
        VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11::bigint,$12,$13)`,
      [intentId, identity.tenantId, identity.appId, request.requestId, identity.installationKeyId, identity.installationIdDigest,
        digest(token), request.productId, input.environment, registration.apple_bundle_id, registration.apple_app_adam_id, createdRef, now]);
      return { intent_id: intentId, app_account_token: token, product_id: request.productId,
        environment: input.environment, state: "prepared" as const };
    });
  } catch (error) {
    if (createdRef) await input.payloadStore.purge(createdRef);
    throw error;
  }
}
