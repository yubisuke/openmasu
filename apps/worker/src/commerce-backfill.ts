import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import {
  createAppPool,
  EncryptedFilePayloadStore,
  EnvironmentSecretStore,
  uuidV7,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";
import { sha256 } from "@openmasu/commerce-lifecycle";

export type CommerceBackfillOperation = "google_subscription" | "google_order_refund"
  | "apple_transaction_history" | "apple_refund_history";

export type CommerceBackfillOptions = {
  readonly tenantId: string;
  readonly appId: string;
  readonly provider: "google_play" | "app_store";
  readonly operation: CommerceBackfillOperation;
  readonly subjectFile: string;
  readonly windowStart: string;
  readonly windowEnd: string;
};

const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const canonicalTimestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function argument(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function parseCommerceBackfillOptions(args: readonly string[]): CommerceBackfillOptions {
  const tenantId = argument(args, "tenant");
  const appId = argument(args, "app");
  const provider = argument(args, "provider");
  const operation = argument(args, "operation");
  const subjectFile = argument(args, "subject-file");
  const windowStart = argument(args, "window-start");
  const windowEnd = argument(args, "window-end");
  if (!tenantId || !identifier.test(tenantId) || !appId || !identifier.test(appId)
    || !subjectFile || !windowStart || !windowEnd
    || !canonicalTimestamp.test(windowStart) || !canonicalTimestamp.test(windowEnd)
    || new Date(windowStart).toISOString() !== windowStart || new Date(windowEnd).toISOString() !== windowEnd
    || windowStart >= windowEnd
    || !new Set(["google_play", "app_store"]).has(String(provider))
    || !new Set(["google_subscription", "google_order_refund", "apple_transaction_history", "apple_refund_history"]).has(String(operation))) {
    throw new Error("usage: npm run commerce:backfill -- --tenant=<id> --app=<id> --provider=<google_play|app_store> --operation=<operation> --subject-file=<protected-json> --window-start=<ISO8601> --window-end=<ISO8601>");
  }
  if ((provider === "google_play") !== String(operation).startsWith("google_")) throw new Error("commerce_backfill_provider_operation_mismatch");
  return { tenantId, appId, provider: provider as CommerceBackfillOptions["provider"], operation: operation as CommerceBackfillOperation,
    subjectFile: resolve(subjectFile), windowStart, windowEnd };
}

function validateProtectedSeed(body: Buffer, options: CommerceBackfillOptions): void {
  if (body.length < 2 || body.length > 512 * 1024) throw new Error("commerce_backfill_subject_size_invalid");
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    value = parsed as Record<string, unknown>;
  } catch { throw new Error("commerce_backfill_subject_invalid"); }
  if (options.provider === "app_store") {
    if (Object.keys(value).some((key) => key !== "signedPayload") || typeof value.signedPayload !== "string" || value.signedPayload.length < 10) {
      throw new Error("commerce_backfill_apple_subject_invalid");
    }
    return;
  }
  if (typeof value.packageName !== "string" || !/^[A-Za-z][A-Za-z0-9_.]{2,254}$/.test(value.packageName)) {
    throw new Error("commerce_backfill_google_subject_invalid");
  }
  const expectedArm = options.operation === "google_subscription" ? "subscriptionNotification" : "voidedPurchaseNotification";
  if (!value[expectedArm] || typeof value[expectedArm] !== "object" || Array.isArray(value[expectedArm])) {
    throw new Error("commerce_backfill_google_subject_invalid");
  }
}

export async function enqueueCommerceBackfill(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly options: CommerceBackfillOptions;
  readonly now?: Date;
}): Promise<{ queued: boolean; notificationDigest: string }> {
  const body = readFileSync(input.options.subjectFile);
  validateProtectedSeed(body, input.options);
  const now = input.now ?? new Date();
  const notificationDigest = sha256(`${input.options.provider}\0${body.toString("base64")}`);
  const stream = `${input.options.operation}:${notificationDigest.slice(0, 32)}`;
  const lifecycleFactId = uuidV7(now.getTime());
  const evidenceRef = await input.payloadStore.write(
    { tenantId: input.options.tenantId, appId: input.options.appId, objectId: `commerce-backfill-${lifecycleFactId}` }, body,
  );
  try {
    const queued = await withTenant(input.pool, input.options.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO control.commerce_provider_notifications (
           provider, notification_digest, tenant_id, app_id, event_kind, subject_digest,
           evidence_ref, payload_digest, occurred_at, received_at
         ) VALUES ($1,$2,$3,$4,'operator_backfill_seed',$5,$6,$5,$7,$8) ON CONFLICT DO NOTHING`,
        [input.options.provider, notificationDigest, input.options.tenantId, input.options.appId,
          sha256(body), evidenceRef, input.options.windowStart, now.toISOString()],
      );
      if (inserted.rowCount !== 1) return false;
      const artifact = { lifecycle_fact_id: lifecycleFactId, tenant_id: input.options.tenantId, app_id: input.options.appId,
        provider: input.options.provider, event_kind: "operator_backfill_seed", subject_digest: sha256(body),
        financial_effect: "none", effective_at: input.options.windowStart, recorded_at: now.toISOString() };
      await client.query(
        `INSERT INTO ledger.commerce_lifecycle_facts (
           lifecycle_fact_id, provider, tenant_id, app_id, notification_digest, event_kind,
           subject_digest, financial_effect, effective_at, recorded_at, artifact
         ) VALUES ($1,$2,$3,$4,$5,'operator_backfill_seed',$6,'none',$7,$8,$9::jsonb)`,
        [lifecycleFactId, input.options.provider, input.options.tenantId, input.options.appId,
          notificationDigest, sha256(body), input.options.windowStart, now.toISOString(), JSON.stringify(artifact)],
      );
      await client.query(
        `INSERT INTO ephemeral.commerce_provider_readbacks (
           readback_id, provider, tenant_id, app_id, notification_digest, operation, next_attempt_at, requested_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [uuidV7(now.getTime() + 1), input.options.provider, input.options.tenantId, input.options.appId,
          notificationDigest, input.options.operation, now.toISOString()],
      );
      await client.query(
        `INSERT INTO control.commerce_backfill_checkpoints (
           provider, tenant_id, app_id, stream, window_start, window_end, completed, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,false,$7)`,
        [input.options.provider, input.options.tenantId, input.options.appId, stream,
          input.options.windowStart, input.options.windowEnd, now.toISOString()],
      );
      return true;
    });
    if (!queued) await input.payloadStore.purge(evidenceRef);
    return { queued, notificationDigest };
  } catch (error) {
    await input.payloadStore.purge(evidenceRef);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseCommerceBackfillOptions(process.argv.slice(2));
  const secrets = new EnvironmentSecretStore({
    OPENMASU_PAYLOAD_MASTER_KEY: { value: process.env.OPENMASU_PAYLOAD_MASTER_KEY, file: process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE },
  });
  const pool = createAppPool();
  const payloadStore = new EncryptedFilePayloadStore(
    process.env.OPENMASU_PAYLOAD_STORE_DIR ?? ".openmasu/payloads", secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"),
  );
  try {
    const result = await enqueueCommerceBackfill({ pool, payloadStore, options });
    console.log(JSON.stringify({ queued: result.queued, notification_digest: result.notificationDigest }));
  } finally { await pool.end(); }
}

