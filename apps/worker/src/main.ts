import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  EncryptedFilePayloadStore,
  EnvironmentSecretStore,
  PostgresSchedulerStore,
  processPrivacyDeletionJobs,
  runScheduledJob,
  uuidV7,
  withTenant,
  type ScheduledWorkerJob,
} from "@openmasu/runtime";
import { AdServicesLookupLimiter, processAdServicesLookups } from "./adservices-worker.js";
import { processMaxInbox } from "./import/max-worker.js";
import { listRuntimeWorkTenants, processSdkInbox } from "./sdk-worker.js";
import { aggregateSourceDay, resolveExpiredQuarantines } from "./fraud-worker.js";
import { processIntegrityVerifications, type IntegrityProvider } from "./integrity-verifier.js";
import { processGooglePlayProductVerifications } from "./google-play-product-verifier.js";
import { discoverGoogleConversionDeliveries, processGoogleConversionDeliveries } from "./google-conversion-worker.js";
import {
  discoverOperatorWebhookDeliveries,
  processOperatorWebhookDeliveries,
} from "./operator-webhook-worker.js";
import {
  discoverOperatorBulkExports,
  processOperatorBulkExports,
} from "./operator-bulk-export-worker.js";
import {
  createAppleCommerceReadbackClient,
  createGoogleCommerceReadbackClient,
  processCommerceReadbacks,
} from "./commerce-readback-worker.js";
import { processMetricSchedules } from "./metric-schedule-worker.js";
import { appleLeafKeyFromChain, verifyCompactJws } from "@openmasu/commerce-lifecycle";

const connectionString = process.env.OPENMASU_APP_DATABASE_URL;
if (!connectionString) throw new Error("OPENMASU_APP_DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 2 });
const schedulerPool = new Pool({ connectionString, max: 1 });
await Promise.all([pool.query("SELECT 1"), schedulerPool.query("SELECT 1")]);
process.stdout.write('{"event":"service_started","component":"worker"}\n');

const interval = Number(process.env.OPENMASU_WORKER_POLL_MS ?? "5000");
if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 86_400_000) {
  throw new Error("OPENMASU_WORKER_POLL_MS must be an integer from 1000 through 86400000");
}
const maxTenantId = process.env.OPENMASU_MAX_TENANT_ID ?? "tenant-local";
const sdkTenantId = process.env.OPENMASU_SDK_TENANT_ID ?? maxTenantId;
const adServicesLimiter = new AdServicesLookupLimiter(
  Number(process.env.OPENMASU_ADSERVICES_LOOKUP_RATE_RPS ?? "10"),
  Number(process.env.OPENMASU_ADSERVICES_LOOKUP_RATE_BURST ?? "50"),
);
const secrets = new EnvironmentSecretStore({
  OPENMASU_PAYLOAD_MASTER_KEY: { value: process.env.OPENMASU_PAYLOAD_MASTER_KEY, file: process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE },
  OPENMASU_META_IR_DECRYPTION_KEY: { value: process.env.OPENMASU_META_IR_DECRYPTION_KEY, file: process.env.OPENMASU_META_IR_DECRYPTION_KEY_FILE },
  OPENMASU_META_IR_DECRYPTION_KEY_PREVIOUS: { value: process.env.OPENMASU_META_IR_DECRYPTION_KEY_PREVIOUS, file: process.env.OPENMASU_META_IR_DECRYPTION_KEY_PREVIOUS_FILE },
  OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: {
    value: process.env.OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
    file: process.env.OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_FILE,
  },
  OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON: {
    value: process.env.OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON,
    file: process.env.OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON_FILE,
  },
  OPENMASU_APP_STORE_API_PRIVATE_KEY: {
    value: process.env.OPENMASU_APP_STORE_API_PRIVATE_KEY,
    file: process.env.OPENMASU_APP_STORE_API_PRIVATE_KEY_FILE,
  },
});
const payloadStore = new EncryptedFilePayloadStore(
  process.env.OPENMASU_PAYLOAD_STORE_DIR ?? ".openmasu/payloads",
  secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"),
);
const fraudEnabled = process.env.OPENMASU_FRAUD_ENABLED !== "0";
const appleRootFingerprints = new Set(
  (process.env.OPENMASU_APPLE_ROOT_SHA256 ?? "")
    .split(",").map((value) => value.replaceAll(":", "").trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{64}$/.test(value)),
);
const googleCommerceClient = process.env.OPENMASU_COMMERCE_READBACKS === "on"
  && secrets.read("OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")
  ? createGoogleCommerceReadbackClient({
      credentialsJson: secrets.read("OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")!,
      apiBaseUrl: process.env.OPENMASU_GOOGLE_PLAY_ANDROID_PUBLISHER_BASE_URL,
      tokenUrl: process.env.OPENMASU_GOOGLE_PLAY_OAUTH_TOKEN_URL,
    })
  : undefined;
const appleCommerceClient = process.env.OPENMASU_COMMERCE_READBACKS === "on"
  && secrets.read("OPENMASU_APP_STORE_API_PRIVATE_KEY")
  && process.env.OPENMASU_APP_STORE_API_ISSUER_ID && process.env.OPENMASU_APP_STORE_API_KEY_ID
  ? createAppleCommerceReadbackClient({
      credentials: {
        privateKey: secrets.read("OPENMASU_APP_STORE_API_PRIVATE_KEY")!,
        issuerId: process.env.OPENMASU_APP_STORE_API_ISSUER_ID,
        keyId: process.env.OPENMASU_APP_STORE_API_KEY_ID,
      },
      baseUrl: process.env.OPENMASU_APP_STORE_API_BASE_URL,
    })
  : undefined;
const verifyAppleCommerce = appleRootFingerprints.size > 0
  ? (value: string) => verifyCompactJws(value, appleLeafKeyFromChain(value, appleRootFingerprints, new Date()))
  : undefined;
const integrityProviderMode = (() => {
  const value = process.env.OPENMASU_INTEGRITY_PROVIDER ?? "off";
  if (!["off", "play_integrity", "app_attest", "both"].includes(value)) {
    throw new Error("OPENMASU_INTEGRITY_PROVIDER is invalid");
  }
  return value as "off" | IntegrityProvider | "both";
})();
async function sweepDashboardSessions(): Promise<void> {
  const now = new Date();
  await withTenant(pool, maxTenantId, async (client) => {
    const deleted = await client.query(
      "DELETE FROM ephemeral.dashboard_sessions WHERE tenant_id=$1 AND expires_at <= $2::timestamptz RETURNING session_id",
      [maxTenantId, now.toISOString()],
    );
    if ((deleted.rowCount ?? 0) === 0) return;
    const requestDigest = createHash("sha256")
      .update(`dashboard_session_expired_sweep\u0000${deleted.rowCount}`, "utf8")
      .digest("hex");
    await client.query(
      `INSERT INTO ledger.audit_logs (
        audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
        action, target_scope, target_ref, policy_version, request_digest,
        outcome, reason_code
      ) VALUES ($1,$2,NULL,$3,'system_job','dashboard_session_sweeper',
        'dashboard_session_expired_sweep','session','session:expired-sweep',
        'dashboard-v1',$4,'succeeded',NULL)`,
      [uuidV7(now.getTime()), maxTenantId, now.toISOString(), requestDigest],
    );
  });
}
let busy = false;
const schedulerStore = new PostgresSchedulerStore(schedulerPool);
const schedulePolicy = {
  intervalMs: interval,
  retryMs: interval,
  leaseMs: Math.min(86_400_000, Math.max(300_000, interval * 12)),
};

async function runWorkerJob(
  tenantId: string,
  job: ScheduledWorkerJob,
  task: () => Promise<void>,
  policy = schedulePolicy,
): Promise<void> {
  try {
    const outcome = await runScheduledJob({
      store: schedulerStore,
      tenantId,
      job,
      policy,
      task,
    });
    if (outcome === "failed") {
      process.stderr.write(`${JSON.stringify({
        event: "worker_job_failed",
        component: "worker",
        job,
        retry: "durable_schedule",
      })}\n`);
    }
  } catch {
    process.stderr.write(`${JSON.stringify({
      event: "worker_schedule_unavailable",
      component: "worker",
      job,
      retry: "next_poll",
    })}\n`);
  }
}

const tick = async (): Promise<void> => {
  if (busy) return;
  busy = true;
  try {
    await runWorkerJob(maxTenantId, "max_inbox", async () => {
      await processMaxInbox(pool, payloadStore, maxTenantId);
    });
    const metaKeys = [
      secrets.read("OPENMASU_META_IR_DECRYPTION_KEY") ? { key_id: "current", key_hex: secrets.read("OPENMASU_META_IR_DECRYPTION_KEY")! } : undefined,
      secrets.read("OPENMASU_META_IR_DECRYPTION_KEY_PREVIOUS") ? { key_id: "previous", key_hex: secrets.read("OPENMASU_META_IR_DECRYPTION_KEY_PREVIOUS")! } : undefined,
    ].filter((value): value is { key_id: string; key_hex: string } => value !== undefined);
    const inboxTenants = new Set([sdkTenantId, ...await listRuntimeWorkTenants(pool)]);
    for (const tenantId of [...inboxTenants].sort()) {
      await runWorkerJob(tenantId, "privacy_purge", async () => {
        const privacy = await processPrivacyDeletionJobs({ pool, payloadStore, tenantId });
        if (privacy.jobs > 0) {
          process.stdout.write(`${JSON.stringify({ event: "privacy_purge_cycle", component: "worker", ...privacy })}\n`);
        }
      });
      await runWorkerJob(tenantId, "sdk_inbox", async () => {
        await processSdkInbox(pool, payloadStore, tenantId, { metaKeys });
      });
      await runWorkerJob(tenantId, "adservices_lookup", async () => {
        await processAdServicesLookups(pool, payloadStore, tenantId, {
          enabled: process.env.OPENMASU_ADSERVICES_LOOKUP !== "off",
          endpoint: process.env.OPENMASU_ADSERVICES_ENDPOINT,
          limiter: adServicesLimiter,
        });
      });
      await runWorkerJob(tenantId, "integrity_verification", async () => {
        await processIntegrityVerifications(pool, payloadStore, tenantId, {
          providerMode: integrityProviderMode,
          playEndpoint: process.env.OPENMASU_PLAY_INTEGRITY_ENDPOINT,
          appAttestEndpoint: process.env.OPENMASU_APP_ATTEST_ENDPOINT,
        });
      });
      await runWorkerJob(tenantId, "google_play_verification", async () => {
        await processGooglePlayProductVerifications(pool, payloadStore, tenantId, {
          enabled: process.env.OPENMASU_GOOGLE_PLAY_PRODUCT_VERIFICATION === "on"
            || process.env.OPENMASU_GOOGLE_PLAY_SUBSCRIPTION_VERIFICATION === "on"
            || process.env.OPENMASU_GOOGLE_PLAY_RTDN_RENEWAL_VERIFICATION === "on",
          enabledKinds: [
            ...(process.env.OPENMASU_GOOGLE_PLAY_PRODUCT_VERIFICATION === "on" ? ["one_time_product" as const] : []),
            ...(process.env.OPENMASU_GOOGLE_PLAY_SUBSCRIPTION_VERIFICATION === "on" ? ["subscription_initial" as const] : []),
            ...(process.env.OPENMASU_GOOGLE_PLAY_RTDN_RENEWAL_VERIFICATION === "on" ? ["subscription_renewal" as const] : []),
          ],
          credentialsJson: secrets.read("OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"),
          apiBaseUrl: process.env.OPENMASU_GOOGLE_PLAY_ANDROID_PUBLISHER_BASE_URL,
          tokenUrl: process.env.OPENMASU_GOOGLE_PLAY_OAUTH_TOKEN_URL,
        });
      });
      await runWorkerJob(tenantId, "commerce_readback", async () => {
        if (process.env.OPENMASU_COMMERCE_READBACKS === "on") {
          const commerce = await processCommerceReadbacks(pool, payloadStore, tenantId, {
            googleClient: googleCommerceClient,
            appleClient: appleCommerceClient,
            verifyAppleSignedData: verifyAppleCommerce,
          });
          if (commerce.processed + commerce.deferred + commerce.failed > 0) {
            process.stdout.write(`${JSON.stringify({ event: "commerce_readback_cycle", component: "worker", ...commerce })}\n`);
          }
        }
      });
      await runWorkerJob(tenantId, "google_conversion_delivery", async () => {
        if (process.env.OPENMASU_GOOGLE_DATA_MANAGER_ENABLED === "on") {
          await discoverGoogleConversionDeliveries(pool, payloadStore, tenantId);
          await processGoogleConversionDeliveries(pool, payloadStore, tenantId, {
            enabled: true,
            credentialsJson: secrets.read("OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON"),
            apiBaseUrl: process.env.OPENMASU_GOOGLE_DATA_MANAGER_BASE_URL,
            tokenUrl: process.env.OPENMASU_GOOGLE_DATA_MANAGER_OAUTH_TOKEN_URL,
          });
        }
      });
      await runWorkerJob(tenantId, "operator_webhook_delivery", async () => {
        if (process.env.OPENMASU_OPERATOR_WEBHOOKS_ENABLED === "on") {
          await discoverOperatorWebhookDeliveries(pool, payloadStore, tenantId);
          await processOperatorWebhookDeliveries(pool, payloadStore, tenantId, {
            enabled: true,
            destinationAllowlist: (process.env.OPENMASU_OPERATOR_WEBHOOK_DESTINATION_ALLOWLIST ?? "")
              .split(",").map((value) => value.trim()).filter(Boolean),
            timeoutMilliseconds: Number(process.env.OPENMASU_OPERATOR_WEBHOOK_TIMEOUT_MS ?? "5000"),
            maximumAttempts: Number(process.env.OPENMASU_OPERATOR_WEBHOOK_MAX_ATTEMPTS ?? "8"),
          });
        }
      });
      await runWorkerJob(tenantId, "operator_bulk_export", async () => {
        if (process.env.OPENMASU_OPERATOR_BULK_EXPORTS_ENABLED === "on") {
          await discoverOperatorBulkExports(pool, payloadStore, tenantId, {
            maximumRows: Number(process.env.OPENMASU_OPERATOR_BULK_EXPORT_MAX_ROWS ?? "500"),
            maximumObjectBytes: Number(process.env.OPENMASU_OPERATOR_BULK_EXPORT_MAX_OBJECT_BYTES ?? "10485760"),
          });
          await processOperatorBulkExports(pool, payloadStore, tenantId, {
            enabled: true,
            destinationAllowlist: (process.env.OPENMASU_OPERATOR_BULK_EXPORT_DESTINATION_ALLOWLIST ?? "")
              .split(",").map((value) => value.trim()).filter(Boolean),
            timeoutMilliseconds: Number(process.env.OPENMASU_OPERATOR_BULK_EXPORT_TIMEOUT_MS ?? "5000"),
            maximumAttempts: Number(process.env.OPENMASU_OPERATOR_BULK_EXPORT_MAX_ATTEMPTS ?? "8"),
            maximumObjectBytes: Number(process.env.OPENMASU_OPERATOR_BULK_EXPORT_MAX_OBJECT_BYTES ?? "10485760"),
          });
        }
      });
      await runWorkerJob(tenantId, "metric_run", async () => {
        const metrics = await processMetricSchedules(pool, tenantId);
        if (metrics.completedDates > 0) {
          process.stdout.write(`${JSON.stringify({ event: "metric_schedule_cycle", component: "worker", ...metrics })}\n`);
        }
      }, {
        intervalMs: 86_400_000,
        retryMs: Math.min(86_400_000, Math.max(60_000, interval)),
        leaseMs: 86_400_000,
      });
      await runWorkerJob(tenantId, "fraud_maintenance", async () => {
        if (fraudEnabled) {
          const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
          await aggregateSourceDay(pool, tenantId, yesterday);
          await resolveExpiredQuarantines(pool, tenantId);
        }
      });
    }
    await runWorkerJob(maxTenantId, "dashboard_session_sweep", sweepDashboardSessions);
  }
  finally { busy = false; }
};
const poll = async (): Promise<void> => {
  try {
    await tick();
  }
  catch {
    process.stderr.write('{"event":"worker_tick_failed","component":"worker","retry":"next_poll"}\n');
  }
};
await poll();
const timer = setInterval(() => void poll(), interval);

async function stop(): Promise<void> {
  clearInterval(timer);
  await Promise.all([pool.end(), schedulerPool.end()]);
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
