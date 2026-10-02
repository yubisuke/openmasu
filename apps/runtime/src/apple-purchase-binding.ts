import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { PayloadStore } from "./payload-store.js";
import { privacyProjectionIsBlocked } from "./privacy-fence.js";

export type ApplePurchaseIntent = {
  intent_id: string; tenant_id: string; app_id: string; installation_key_id: string; installation_id_digest: string;
  token_digest: string; product_id: string; environment: "Sandbox" | "Production"; bundle_id: string;
  app_apple_id: string; anchor_ref: string; created_at: string;
};

export async function readApplePurchaseIntent(client: PoolClient, tenantId: string, appId: string,
  selector: { intentId: string } | { tokenDigest: string }): Promise<ApplePurchaseIntent | undefined> {
  const byId = "intentId" in selector;
  return (await client.query<ApplePurchaseIntent>(`SELECT intent_id::text,tenant_id,app_id,installation_key_id,
    installation_id_digest,token_digest,product_id,environment,bundle_id,app_apple_id::text,anchor_ref,created_at
    FROM control.apple_purchase_intents WHERE tenant_id=$1 AND app_id=$2
    AND ${byId ? "intent_id=$3::uuid" : "token_digest=$3"}`,
  [tenantId,appId,byId ? selector.intentId : selector.tokenDigest])).rows[0];
}

/** Caller holds the shared tenant privacy fence until its ledger transaction commits. */
export async function activeApplePurchaseAnchor(client: PoolClient, store: PayloadStore, intent: ApplePurchaseIntent): Promise<
  { installationId: string; appAccountToken: string } | undefined> {
  if (await privacyProjectionIsBlocked(client, { entryId: intent.intent_id, tenantId: intent.tenant_id,
    appId: intent.app_id, subjectDigest: intent.installation_id_digest, receivedAt: intent.created_at })) return undefined;
  const active = await client.query(`SELECT 1 FROM control.installation_credentials_current AS credential
    JOIN control.sdk_keys_current AS sdk USING (tenant_id,app_id,sdk_key_id)
    JOIN control.apple_app_registrations AS app USING (tenant_id,app_id)
    WHERE credential.tenant_id=$1 AND credential.app_id=$2 AND credential.installation_key_id=$3
      AND credential.installation_id_digest=$4 AND credential.status='active' AND sdk.status='active' AND sdk.platform='ios'
      AND app.apple_bundle_id=$5 AND app.apple_app_adam_id=$6::bigint
      AND NOT EXISTS (SELECT 1 FROM control.installation_withdrawals AS withdrawal
        WHERE withdrawal.tenant_id=credential.tenant_id AND withdrawal.app_id=credential.app_id
          AND withdrawal.installation_key_id=credential.installation_key_id AND withdrawal.processing_purpose_id='revenue_measurement')`,
  [intent.tenant_id,intent.app_id,intent.installation_key_id,intent.installation_id_digest,intent.bundle_id,intent.app_apple_id]);
  if (active.rowCount !== 1) return undefined;
  const anchor = JSON.parse((await store.read(intent.anchor_ref)).toString("utf8"));
  if (typeof anchor.installation_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(anchor.installation_id)
    || typeof anchor.app_account_token !== "string"
    || createHash("sha256").update(anchor.app_account_token).digest("hex") !== intent.token_digest) throw new Error("apple_purchase_anchor_invalid");
  return { installationId: anchor.installation_id, appAccountToken: anchor.app_account_token };
}
