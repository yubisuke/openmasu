import { createServer } from "node:http";
import { createAppPool, createReaderPool, EncryptedFilePayloadStore, EnvironmentSecretStore } from "@openmasu/runtime";
import { assertSafeMaxTemplate, receiveMax, type MaxReceiverConfig } from "./max-receiver.js";
import { ensureAdminKeys, parseAdminRole } from "./admin-auth.js";
import { HourlyLedgerQuota } from "./apple-postback-receiver.js";
import { createRequestHandler } from "./router.js";
import { KeyedTokenBucket, TokenBucket } from "./rate-limit.js";
import { OperationalMetrics } from "./operational-metrics.js";
import { writeOperationalLog } from "./observability.js";
import { ensureSdkKeys } from "./sdk-auth.js";

const port = Number(process.env.OPENMASU_API_PORT ?? "8080");
const baseUrl = process.env.OPENMASU_PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const secrets = new EnvironmentSecretStore({
  OPENMASU_ADMIN_KEY: { value: process.env.OPENMASU_ADMIN_KEY, file: process.env.OPENMASU_ADMIN_KEY_FILE },
  OPENMASU_ADMIN_KEY_PREVIOUS: { value: process.env.OPENMASU_ADMIN_KEY_PREVIOUS, file: process.env.OPENMASU_ADMIN_KEY_PREVIOUS_FILE },
  OPENMASU_MAX_PATH_SECRET: { value: process.env.OPENMASU_MAX_PATH_SECRET, file: process.env.OPENMASU_MAX_PATH_SECRET_FILE },
  OPENMASU_MAX_EVENT_KEY: { value: process.env.OPENMASU_MAX_EVENT_KEY, file: process.env.OPENMASU_MAX_EVENT_KEY_FILE },
  OPENMASU_PAYLOAD_MASTER_KEY: { value: process.env.OPENMASU_PAYLOAD_MASTER_KEY, file: process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE },
  OPENMASU_SDK_KEY: { value: process.env.OPENMASU_SDK_KEY, file: process.env.OPENMASU_SDK_KEY_FILE },
  OPENMASU_SDK_KEY_PREVIOUS: { value: process.env.OPENMASU_SDK_KEY_PREVIOUS, file: process.env.OPENMASU_SDK_KEY_PREVIOUS_FILE },
  OPENMASU_INSTALLATION_DIGEST_KEY: { value: process.env.OPENMASU_INSTALLATION_DIGEST_KEY, file: process.env.OPENMASU_INSTALLATION_DIGEST_KEY_FILE },
});
const adminKey = secrets.require("OPENMASU_ADMIN_KEY");
const maxPathSecret = secrets.require("OPENMASU_MAX_PATH_SECRET");
const maxEventKey = secrets.require("OPENMASU_MAX_EVENT_KEY");
const pool = createAppPool();
const readerPool = createReaderPool();
const payloadStore = new EncryptedFilePayloadStore(
  process.env.OPENMASU_PAYLOAD_STORE_DIR ?? ".openmasu/payloads",
  secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"),
);
const maxConfig: MaxReceiverConfig = {
  tenantId: process.env.OPENMASU_MAX_TENANT_ID ?? "tenant-local",
  appId: process.env.OPENMASU_MAX_APP_ID ?? "app-local",
  pathSecret: maxPathSecret,
  eventKey: maxEventKey,
  tokenMode: (process.env.OPENMASU_MAX_TOKEN_MODE as MaxReceiverConfig["tokenMode"] | undefined) ?? "all_with_event_fallback",
  maxParameters: Number(process.env.OPENMASU_MAX_PARAMETER_LIMIT ?? "40"),
  maxQueryBytes: Number(process.env.OPENMASU_MAX_QUERY_BYTES ?? "8192"),
};
const maxTemplate = `${baseUrl}/v1/ingest/max/${maxPathSecret}?event_token_all={EVENT_TOKEN_ALL}&event_id={EVENT_ID}&revenue={REVENUE}&ts={TS}`;
assertSafeMaxTemplate(maxTemplate);
await ensureAdminKeys(
  pool,
  { tenantId: maxConfig.tenantId, appId: maxConfig.appId },
  [
    { key: adminKey, role: parseAdminRole(process.env.OPENMASU_ADMIN_ROLE) },
    ...(secrets.read("OPENMASU_ADMIN_KEY_PREVIOUS")
      ? [{
          key: secrets.read("OPENMASU_ADMIN_KEY_PREVIOUS")!,
          role: parseAdminRole(process.env.OPENMASU_ADMIN_KEY_PREVIOUS_ROLE),
        }]
      : []),
  ],
);
const sdkKeyId = process.env.OPENMASU_SDK_KEY_ID ?? "sdk-key-current";
const previousSdkKey = secrets.read("OPENMASU_SDK_KEY_PREVIOUS");
await ensureSdkKeys(pool, payloadStore, { tenantId: maxConfig.tenantId, appId: maxConfig.appId }, [
  { keyId: sdkKeyId, secret: secrets.require("OPENMASU_SDK_KEY") },
  ...(previousSdkKey ? [{ keyId: process.env.OPENMASU_SDK_KEY_PREVIOUS_ID ?? "sdk-key-previous", secret: previousSdkKey }] : []),
]);
const operationalMetrics = new OperationalMetrics();
const operationalLogWriter = (line: string) => process.stdout.write(line);

const server = createServer(createRequestHandler({
  pool,
  readerPool,
  payloadStore,
  maxConfig,
  publicBaseUrl: baseUrl,
  redirectorBaseUrl: process.env.OPENMASU_REDIRECTOR_BASE_URL ?? "http://localhost:8090",
  dashboard: {
    enabled: process.env.OPENMASU_DASHBOARD_ENABLED !== "false",
    publicBaseUrl: baseUrl,
    tenantId: maxConfig.tenantId,
    sessionTtlSeconds: Number(process.env.OPENMASU_DASHBOARD_SESSION_TTL_SECONDS ?? "43200"),
  },
  maxBucket: new TokenBucket(
    Number(process.env.OPENMASU_MAX_RATE_RPS ?? "200"),
    Number(process.env.OPENMASU_MAX_RATE_BURST ?? "500"),
  ),
  adminBucket: new TokenBucket(
    Number(process.env.OPENMASU_ADMIN_RATE_RPS ?? "10"),
    Number(process.env.OPENMASU_ADMIN_RATE_BURST ?? "30"),
  ),
  dashboardLoginBucket: new KeyedTokenBucket(
    Number(process.env.OPENMASU_DASHBOARD_LOGIN_RATE_RPM ?? "5") / 60,
    Number(process.env.OPENMASU_DASHBOARD_LOGIN_RATE_BURST ?? "10"),
  ),
  dashboardLoginGlobalBucket: new TokenBucket(1, 60),
  reportMaximumRows: Number(process.env.OPENMASU_REPORT_MAX_ROWS ?? "1000"),
  reportMaximumExportRows: Number(process.env.OPENMASU_REPORT_EXPORT_MAX_ROWS ?? "200000"),
  trackingDestinationAllowlist: (process.env.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
  applePostback: {
    pool,
    payloadStore,
    maximumBytes: Number(process.env.OPENMASU_POSTBACK_MAX_BYTES ?? String(16 * 1024)),
    acceptDevelopmentPostbacks: process.env.OPENMASU_APPLE_ACCEPT_DEVELOPMENT_POSTBACKS === "1",
    sourceBucket: new KeyedTokenBucket(
      Number(process.env.OPENMASU_POSTBACK_RATE_RPS ?? "20"),
      Number(process.env.OPENMASU_POSTBACK_RATE_BURST ?? "100"),
    ),
    appBucket: new KeyedTokenBucket(
      Number(process.env.OPENMASU_POSTBACK_APP_RATE_RPS ?? "200"),
      Number(process.env.OPENMASU_POSTBACK_APP_RATE_BURST ?? "1000"),
    ),
    invalidLedgerQuota: new HourlyLedgerQuota(
      Number(process.env.OPENMASU_POSTBACK_INVALID_LEDGER_QUOTA_PER_HOUR ?? "100"),
    ),
  },
  operationalMetrics,
  operationalLogWriter,
  sdk: {
    pool,
    payloadStore,
    config: {
      tenantId: maxConfig.tenantId,
      appId: maxConfig.appId,
      timestampSkewMs: Number(process.env.OPENMASU_INGEST_SKEW_MS ?? "300000"),
      nonceTtlMs: Number(process.env.OPENMASU_NONCE_TTL_MS ?? "900000"),
      installationDigestKey: secrets.require("OPENMASU_INSTALLATION_DIGEST_KEY"),
    },
    maximumBytes: Number(process.env.OPENMASU_INGEST_MAX_BYTES ?? String(256 * 1024)),
    maximumEvents: Number(process.env.OPENMASU_INGEST_MAX_EVENTS ?? "100"),
    enrollmentBucket: new KeyedTokenBucket(
      Number(process.env.OPENMASU_ENROLL_RATE_RPS ?? "50"),
      Number(process.env.OPENMASU_ENROLL_RATE_BURST ?? "100"),
    ),
    installationBucket: new KeyedTokenBucket(
      Number(process.env.OPENMASU_INGEST_RATE_RPS ?? "1"),
      Number(process.env.OPENMASU_INGEST_RATE_BURST ?? "20"),
    ),
    appBucket: new KeyedTokenBucket(
      Number(process.env.OPENMASU_INGEST_APP_RATE_RPS ?? "500"),
      Number(process.env.OPENMASU_INGEST_APP_RATE_BURST ?? "1000"),
    ),
    privacyBucket: new KeyedTokenBucket(
      Number(process.env.OPENMASU_DEVICE_PRIVACY_RATE_RPM ?? "1") / 60,
      Number(process.env.OPENMASU_DEVICE_PRIVACY_RATE_BURST ?? "3"),
    ),
  },
}));

server.listen(port, "0.0.0.0", () => {
  writeOperationalLog({ event: "service_started", component: "api" }, operationalLogWriter);
});
