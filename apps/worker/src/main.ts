import { Pool } from "pg";
import { EncryptedFilePayloadStore, EnvironmentSecretStore } from "@open-mmp/runtime";
import { processMaxInbox } from "./import/max-worker.js";

const connectionString = process.env.OPENMMP_APP_DATABASE_URL;
if (!connectionString) throw new Error("OPENMMP_APP_DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 2 });
await pool.query("SELECT 1");
console.log("Open MMP worker connected to PostgreSQL");

const interval = Number(process.env.OPENMMP_WORKER_POLL_MS ?? "5000");
const maxTenantId = process.env.OPENMMP_MAX_TENANT_ID ?? "tenant-local";
const secrets = new EnvironmentSecretStore({
  OPENMMP_PAYLOAD_MASTER_KEY: { value: process.env.OPENMMP_PAYLOAD_MASTER_KEY, file: process.env.OPENMMP_PAYLOAD_MASTER_KEY_FILE },
});
const payloadStore = new EncryptedFilePayloadStore(
  process.env.OPENMMP_PAYLOAD_STORE_DIR ?? ".openmmp/payloads",
  secrets.require("OPENMMP_PAYLOAD_MASTER_KEY"),
);
let busy = false;
const tick = async (): Promise<void> => {
  if (busy) return;
  busy = true;
  try { await processMaxInbox(pool, payloadStore, maxTenantId); }
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
