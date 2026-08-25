import { createHash } from "node:crypto";
import { Pool } from "pg";
import { EncryptedFilePayloadStore, EnvironmentSecretStore, uuidV7, withTenant } from "@openmasu/runtime";
import { AdServicesLookupLimiter, processAdServicesLookups } from "./adservices-worker.js";
import { processMaxInbox } from "./import/max-worker.js";
import { listRuntimeWorkTenants, processSdkInbox } from "./sdk-worker.js";

const connectionString = process.env.OPENMASU_APP_DATABASE_URL;
if (!connectionString) throw new Error("OPENMASU_APP_DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 2 });
await pool.query("SELECT 1");
process.stdout.write('{"event":"service_started","component":"worker"}\n');

const interval = Number(process.env.OPENMASU_WORKER_POLL_MS ?? "5000");
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
});
const payloadStore = new EncryptedFilePayloadStore(
  process.env.OPENMASU_PAYLOAD_STORE_DIR ?? ".openmasu/payloads",
  secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"),
);
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
const tick = async (): Promise<void> => {
  if (busy) return;
  busy = true;
  try {
    await processMaxInbox(pool, payloadStore, maxTenantId);
    const metaKeys = [
      secrets.read("OPENMASU_META_IR_DECRYPTION_KEY") ? { key_id: "current", key_hex: secrets.read("OPENMASU_META_IR_DECRYPTION_KEY")! } : undefined,
      secrets.read("OPENMASU_META_IR_DECRYPTION_KEY_PREVIOUS") ? { key_id: "previous", key_hex: secrets.read("OPENMASU_META_IR_DECRYPTION_KEY_PREVIOUS")! } : undefined,
    ].filter((value): value is { key_id: string; key_hex: string } => value !== undefined);
    const inboxTenants = new Set([sdkTenantId, ...await listRuntimeWorkTenants(pool)]);
    for (const tenantId of [...inboxTenants].sort()) {
      await processSdkInbox(pool, payloadStore, tenantId, { metaKeys });
      await processAdServicesLookups(pool, payloadStore, tenantId, {
        enabled: process.env.OPENMASU_ADSERVICES_LOOKUP !== "off",
        endpoint: process.env.OPENMASU_ADSERVICES_ENDPOINT,
        limiter: adServicesLimiter,
      });
    }
    await sweepDashboardSessions();
  }
  finally { busy = false; }
};
await tick();
const timer = setInterval(() => void tick(), interval);

async function stop(): Promise<void> {
  clearInterval(timer);
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
