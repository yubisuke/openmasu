import { createServer } from "node:http";
import { createAppPool, EncryptedFilePayloadStore, EnvironmentSecretStore } from "@open-mmp/runtime";
import { assertSafeMaxTemplate, receiveMax, type MaxReceiverConfig } from "./max-receiver.js";
import { ensureAdminKeys } from "./admin-auth.js";
import { createRequestHandler } from "./router.js";
import { TokenBucket } from "./rate-limit.js";

const port = Number(process.env.OPENMMP_API_PORT ?? "8080");
const baseUrl = process.env.OPENMMP_PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const secrets = new EnvironmentSecretStore({
  OPENMMP_ADMIN_KEY: { value: process.env.OPENMMP_ADMIN_KEY, file: process.env.OPENMMP_ADMIN_KEY_FILE },
  OPENMMP_ADMIN_KEY_PREVIOUS: { value: process.env.OPENMMP_ADMIN_KEY_PREVIOUS, file: process.env.OPENMMP_ADMIN_KEY_PREVIOUS_FILE },
  OPENMMP_MAX_PATH_SECRET: { value: process.env.OPENMMP_MAX_PATH_SECRET, file: process.env.OPENMMP_MAX_PATH_SECRET_FILE },
  OPENMMP_MAX_EVENT_KEY: { value: process.env.OPENMMP_MAX_EVENT_KEY, file: process.env.OPENMMP_MAX_EVENT_KEY_FILE },
  OPENMMP_PAYLOAD_MASTER_KEY: { value: process.env.OPENMMP_PAYLOAD_MASTER_KEY, file: process.env.OPENMMP_PAYLOAD_MASTER_KEY_FILE },
});
const adminKey = secrets.require("OPENMMP_ADMIN_KEY");
const maxPathSecret = secrets.require("OPENMMP_MAX_PATH_SECRET");
const maxEventKey = secrets.require("OPENMMP_MAX_EVENT_KEY");
const pool = createAppPool();
const payloadStore = new EncryptedFilePayloadStore(
  process.env.OPENMMP_PAYLOAD_STORE_DIR ?? ".openmmp/payloads",
  secrets.require("OPENMMP_PAYLOAD_MASTER_KEY"),
);
const maxConfig: MaxReceiverConfig = {
  tenantId: process.env.OPENMMP_MAX_TENANT_ID ?? "tenant-local",
  appId: process.env.OPENMMP_MAX_APP_ID ?? "app-local",
  pathSecret: maxPathSecret,
  eventKey: maxEventKey,
  tokenMode: (process.env.OPENMMP_MAX_TOKEN_MODE as MaxReceiverConfig["tokenMode"] | undefined) ?? "all_with_event_fallback",
  maxParameters: Number(process.env.OPENMMP_MAX_PARAMETER_LIMIT ?? "40"),
  maxQueryBytes: Number(process.env.OPENMMP_MAX_QUERY_BYTES ?? "8192"),
};
const maxTemplate = `${baseUrl}/v1/ingest/max/${maxPathSecret}?event_token_all={EVENT_TOKEN_ALL}&event_id={EVENT_ID}&revenue={REVENUE}&ts={TS}`;
assertSafeMaxTemplate(maxTemplate);
await ensureAdminKeys(
  pool,
  { tenantId: maxConfig.tenantId, appId: maxConfig.appId },
  [adminKey, secrets.read("OPENMMP_ADMIN_KEY_PREVIOUS")].filter((value): value is string => !!value),
);

const server = createServer(createRequestHandler({
  pool,
  payloadStore,
  maxConfig,
  maxBucket: new TokenBucket(
    Number(process.env.OPENMMP_MAX_RATE_RPS ?? "200"),
    Number(process.env.OPENMMP_MAX_RATE_BURST ?? "500"),
  ),
  adminBucket: new TokenBucket(
    Number(process.env.OPENMMP_ADMIN_RATE_RPS ?? "10"),
    Number(process.env.OPENMMP_ADMIN_RATE_BURST ?? "30"),
  ),
}));

server.listen(port, "0.0.0.0", () => {
  console.log(`Open MMP API listening on ${port}`);
  console.log(`Open MMP admin key: ${adminKey}`);
  console.log(`Open MMP MAX postback URL template: ${maxTemplate}`);
});
