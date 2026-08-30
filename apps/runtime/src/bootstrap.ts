import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function requiredDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function exclusiveWrite(path: string, content: string): void {
  requiredDirectory(dirname(path));
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function boundedIntegerSetting(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): string {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return String(parsed);
}

function reconcileEnvSettings(path: string, settings: Readonly<Record<string, string>>): void {
  let next = readFileSync(path, "utf8").trimEnd();
  for (const [name, value] of Object.entries(settings)) {
    const line = `${name}=${value}`;
    const matcher = new RegExp(`^${name}=.*$`, "m");
    next = matcher.test(next) ? next.replace(matcher, line) : `${next}\n${line}`;
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${next}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporaryPath, path);
  } catch (error) {
    try { closeSync(descriptor); } catch { /* already closed */ }
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function url(user: string, password: string, host: string, port: string, database: string): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

const repositoryRoot = resolve(process.env.OPENMASU_REPOSITORY_ROOT ?? process.cwd());
const runtimeSecretRoot = resolve(
  process.env.OPENMASU_RUNTIME_SECRET_ROOT ?? join(repositoryRoot, ".openmasu"),
);
const migrationEnvPath = join(runtimeSecretRoot, "migration", "runtime.env");
const appEnvPath = join(runtimeSecretRoot, "app", "runtime.env");
const seedEnvPath = join(runtimeSecretRoot, "seed", "runtime.env");
const postgresPasswordPath = join(runtimeSecretRoot, "postgres", "password");
const repositoryEnvPath = join(repositoryRoot, ".env");
const existing = existsSync(repositoryEnvPath)
  ? Object.fromEntries(
      readFileSync(repositoryEnvPath, "utf8").split(/\r?\n/).flatMap((line) => {
        const separator = line.indexOf("=");
        return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
      }),
    )
  : {};
const publicBaseUrl = process.env.OPENMASU_PUBLIC_BASE_URL ?? "http://localhost:8080";
const redirectorBaseUrl = process.env.OPENMASU_REDIRECTOR_BASE_URL ?? "http://localhost:8090";
const databaseHost = process.env.OPENMASU_DATABASE_HOST ?? "localhost";
const databasePort = process.env.OPENMASU_DATABASE_PORT ?? "5432";
const databaseName = process.env.OPENMASU_DATABASE_NAME ?? "openmasu";
const defaultTenantId = process.env.OPENMASU_MAX_TENANT_ID ?? "tenant-local";
const defaultAppId = process.env.OPENMASU_MAX_APP_ID ?? "app-local";
const workerConcurrency = boundedIntegerSetting(
  "OPENMASU_WORKER_CONCURRENCY",
  process.env.OPENMASU_WORKER_CONCURRENCY ?? existing.OPENMASU_WORKER_CONCURRENCY,
  4,
  1,
  16,
);
const workerShutdownTimeout = boundedIntegerSetting(
  "OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS",
  process.env.OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS
    ?? existing.OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS,
  30_000,
  1_000,
  300_000,
);
const sdkInboxBatchLimit = boundedIntegerSetting(
  "OPENMASU_SDK_INBOX_BATCH_LIMIT",
  process.env.OPENMASU_SDK_INBOX_BATCH_LIMIT ?? existing.OPENMASU_SDK_INBOX_BATCH_LIMIT,
  100,
  1,
  1_000,
);
const maxInboxBatchLimit = boundedIntegerSetting(
  "OPENMASU_MAX_INBOX_BATCH_LIMIT",
  process.env.OPENMASU_MAX_INBOX_BATCH_LIMIT ?? existing.OPENMASU_MAX_INBOX_BATCH_LIMIT,
  100,
  1,
  1_000,
);

const runtimePaths = [migrationEnvPath, appEnvPath, seedEnvPath, postgresPasswordPath];
if (runtimePaths.every(existsSync)) {
  reconcileEnvSettings(appEnvPath, {
    OPENMASU_WORKER_CONCURRENCY: workerConcurrency,
    OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS: workerShutdownTimeout,
    OPENMASU_SDK_INBOX_BATCH_LIMIT: sdkInboxBatchLimit,
    OPENMASU_MAX_INBOX_BATCH_LIMIT: maxInboxBatchLimit,
  });
  console.log(`OpenMasu runtime secrets already exist: ${runtimeSecretRoot}`);
  process.exit(0);
}
if (runtimePaths.some(existsSync)) throw new Error(`incomplete runtime secret set: ${runtimeSecretRoot}`);

const postgresPassword = existing.OPENMASU_POSTGRES_BOOTSTRAP_PASSWORD ?? secret();
const appPassword = existing.OPENMASU_APP_DATABASE_PASSWORD ?? secret();
const readerPassword = existing.OPENMASU_READER_DATABASE_PASSWORD ?? secret();
const seedPassword = existing.OPENMASU_SEED_DATABASE_PASSWORD ?? secret();
const adminKey = existing.OPENMASU_ADMIN_KEY ?? secret();
const maxPathSecret = existing.OPENMASU_MAX_PATH_SECRET ?? secret(24);
const maxEventKey = existing.OPENMASU_MAX_EVENT_KEY ?? secret();
const payloadMasterKey = existing.OPENMASU_PAYLOAD_MASTER_KEY ?? secret();
const sdkKey = existing.OPENMASU_SDK_KEY ?? secret();
const installationDigestKey = existing.OPENMASU_INSTALLATION_DIGEST_KEY ?? secret();
const metaReferrerKey = existing.OPENMASU_META_IR_DECRYPTION_KEY ?? randomBytes(32).toString("hex");
const migrationDatabaseUrl = url("postgres", postgresPassword, databaseHost, databasePort, databaseName);
const appDatabaseUrl = url("openmasu_app", appPassword, databaseHost, databasePort, databaseName);
const readerDatabaseUrl = url("openmasu_reader", readerPassword, databaseHost, databasePort, databaseName);
const seedDatabaseUrl = url("openmasu_seed", seedPassword, databaseHost, databasePort, databaseName);
const hostMigrationDatabaseUrl = url("postgres", postgresPassword, "localhost", databasePort, databaseName);
const hostAppDatabaseUrl = url("openmasu_app", appPassword, "localhost", databasePort, databaseName);
const hostReaderDatabaseUrl = url("openmasu_reader", readerPassword, "localhost", databasePort, databaseName);
const hostSeedDatabaseUrl = url("openmasu_seed", seedPassword, "localhost", databasePort, databaseName);
const maxTemplate = `${publicBaseUrl}/v1/ingest/max/${maxPathSecret}?event_token_all={EVENT_TOKEN_ALL}&event_id={EVENT_ID}&revenue={REVENUE}&ts={TS}`;

const migrationEntries: Record<string, string> = {
  OPENMASU_MIGRATION_DATABASE_URL: migrationDatabaseUrl,
  OPENMASU_APP_DATABASE_PASSWORD: appPassword,
  OPENMASU_READER_DATABASE_PASSWORD: readerPassword,
  OPENMASU_SEED_DATABASE_PASSWORD: seedPassword,
};
const appEntries: Record<string, string> = {
  OPENMASU_APP_DATABASE_URL: appDatabaseUrl,
  OPENMASU_READER_DATABASE_URL: readerDatabaseUrl,
  OPENMASU_ADMIN_KEY: adminKey,
  OPENMASU_ADMIN_ROLE: "admin",
  OPENMASU_MAX_PATH_SECRET: maxPathSecret,
  OPENMASU_MAX_EVENT_KEY: maxEventKey,
  OPENMASU_PAYLOAD_MASTER_KEY: payloadMasterKey,
  OPENMASU_SDK_KEY_ID: "sdk-key-current",
  OPENMASU_SDK_KEY: sdkKey,
  OPENMASU_INSTALLATION_DIGEST_KEY: installationDigestKey,
  OPENMASU_META_IR_DECRYPTION_KEY: metaReferrerKey,
  OPENMASU_PUBLIC_BASE_URL: publicBaseUrl,
  OPENMASU_API_PORT: "8080",
  OPENMASU_WORKER_POLL_MS: "5000",
  OPENMASU_WORKER_CONCURRENCY: workerConcurrency,
  OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS: workerShutdownTimeout,
  OPENMASU_SDK_INBOX_BATCH_LIMIT: sdkInboxBatchLimit,
  OPENMASU_MAX_INBOX_BATCH_LIMIT: maxInboxBatchLimit,
  OPENMASU_SYNTHETIC_MODE: "0",
  OPENMASU_MAX_TENANT_ID: defaultTenantId,
  OPENMASU_MAX_APP_ID: defaultAppId,
  OPENMASU_MAX_TOKEN_MODE: "all_with_event_fallback",
  OPENMASU_PAYLOAD_STORE_DIR: "/run/openmasu/payloads",
  OPENMASU_SDK_TENANT_ID: defaultTenantId,
  OPENMASU_INGEST_SKEW_MS: "300000",
  OPENMASU_NONCE_TTL_MS: "900000",
  OPENMASU_INGEST_MAX_BYTES: "262144",
  OPENMASU_INGEST_MAX_EVENTS: "100",
  OPENMASU_ENROLL_RATE_RPS: process.env.OPENMASU_ENROLL_RATE_RPS ?? "50",
  OPENMASU_ENROLL_RATE_BURST: process.env.OPENMASU_ENROLL_RATE_BURST ?? "100",
  OPENMASU_INGEST_RATE_RPS: process.env.OPENMASU_INGEST_RATE_RPS ?? "1",
  OPENMASU_INGEST_RATE_BURST: process.env.OPENMASU_INGEST_RATE_BURST ?? "20",
  OPENMASU_INGEST_APP_RATE_RPS: process.env.OPENMASU_INGEST_APP_RATE_RPS ?? "500",
  OPENMASU_INGEST_APP_RATE_BURST: process.env.OPENMASU_INGEST_APP_RATE_BURST ?? "1000",
  OPENMASU_SERVER_INGEST_SKEW_MS: process.env.OPENMASU_SERVER_INGEST_SKEW_MS ?? "300000",
  OPENMASU_SERVER_NONCE_TTL_MS: process.env.OPENMASU_SERVER_NONCE_TTL_MS ?? "900000",
  OPENMASU_SERVER_INGEST_MAX_BYTES: process.env.OPENMASU_SERVER_INGEST_MAX_BYTES ?? "262144",
  OPENMASU_SERVER_INGEST_MAX_EVENTS: process.env.OPENMASU_SERVER_INGEST_MAX_EVENTS ?? "100",
  OPENMASU_SERVER_INGEST_RATE_RPS: process.env.OPENMASU_SERVER_INGEST_RATE_RPS ?? "50",
  OPENMASU_SERVER_INGEST_RATE_BURST: process.env.OPENMASU_SERVER_INGEST_RATE_BURST ?? "100",
  OPENMASU_SERVER_INGEST_APP_RATE_RPS: process.env.OPENMASU_SERVER_INGEST_APP_RATE_RPS ?? "500",
  OPENMASU_SERVER_INGEST_APP_RATE_BURST: process.env.OPENMASU_SERVER_INGEST_APP_RATE_BURST ?? "1000",
  OPENMASU_MAX_RATE_RPS: process.env.OPENMASU_MAX_RATE_RPS ?? "200",
  OPENMASU_MAX_RATE_BURST: process.env.OPENMASU_MAX_RATE_BURST ?? "500",
  OPENMASU_DEVICE_PRIVACY_RATE_RPM: "1",
  OPENMASU_DEVICE_PRIVACY_RATE_BURST: "3",
  OPENMASU_REDIRECTOR_PORT: "8090",
  OPENMASU_REDIRECTOR_BASE_URL: redirectorBaseUrl,
  OPENMASU_REDIRECTOR_TENANT_ID: defaultTenantId,
  OPENMASU_REDIRECTOR_FALLBACK_URL: "https://play.google.com/store",
  OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST:
    process.env.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST ?? "",
  OPENMASU_OPERATOR_WEBHOOKS_ENABLED:
    process.env.OPENMASU_OPERATOR_WEBHOOKS_ENABLED ?? "off",
  OPENMASU_OPERATOR_WEBHOOK_DESTINATION_ALLOWLIST:
    process.env.OPENMASU_OPERATOR_WEBHOOK_DESTINATION_ALLOWLIST ?? "",
  OPENMASU_OPERATOR_WEBHOOK_TIMEOUT_MS:
    process.env.OPENMASU_OPERATOR_WEBHOOK_TIMEOUT_MS ?? "5000",
  OPENMASU_OPERATOR_WEBHOOK_MAX_ATTEMPTS:
    process.env.OPENMASU_OPERATOR_WEBHOOK_MAX_ATTEMPTS ?? "8",
  OPENMASU_OPERATOR_BULK_EXPORTS_ENABLED:
    process.env.OPENMASU_OPERATOR_BULK_EXPORTS_ENABLED ?? "off",
  OPENMASU_OPERATOR_BULK_EXPORT_DESTINATION_ALLOWLIST:
    process.env.OPENMASU_OPERATOR_BULK_EXPORT_DESTINATION_ALLOWLIST ?? "",
  OPENMASU_OPERATOR_BULK_EXPORT_TIMEOUT_MS:
    process.env.OPENMASU_OPERATOR_BULK_EXPORT_TIMEOUT_MS ?? "5000",
  OPENMASU_OPERATOR_BULK_EXPORT_MAX_ATTEMPTS:
    process.env.OPENMASU_OPERATOR_BULK_EXPORT_MAX_ATTEMPTS ?? "8",
  OPENMASU_OPERATOR_BULK_EXPORT_MAX_ROWS:
    process.env.OPENMASU_OPERATOR_BULK_EXPORT_MAX_ROWS ?? "500",
  OPENMASU_OPERATOR_BULK_EXPORT_MAX_OBJECT_BYTES:
    process.env.OPENMASU_OPERATOR_BULK_EXPORT_MAX_OBJECT_BYTES ?? "10485760",
  OPENMASU_REDIRECTOR_GEO: "off",
  OPENMASU_REDIRECTOR_RATE_RPS: "20",
  OPENMASU_REDIRECTOR_RATE_BURST: "50",
  OPENMASU_REDIRECTOR_CLIENT_CLASS: "on",
  OPENMASU_REDIRECTOR_REMOTE_CLICK_PARAM: "cid",
  OPENMASU_REFERRER_MAX_ENCODED_CHARS: "512",
  OPENMASU_WELLKNOWN_RATE_RPS: "5",
  OPENMASU_WELLKNOWN_RATE_BURST: "20",
  OPENMASU_WELLKNOWN_MAX_BYTES: "65536",
  OPENMASU_WELLKNOWN_CACHE_SECONDS: "300",
  OPENMASU_REDIRECTOR_LINK_HOST_MODE: "host_header",
  OPENMASU_FRAUD_ENABLED: "1",
  OPENMASU_FRAUD_ACTIONS_ENABLED: "0",
  OPENMASU_FRAUD_AGGREGATE_HOUR_UTC: "2",
  OPENMASU_INTEGRITY_PROVIDER: "off",
  OPENMASU_INTEGRITY_MODE: "observe",
  OPENMASU_INTEGRITY_RATE_RPS: "10",
  OPENMASU_INTEGRITY_RATE_BURST: "50",
  OPENMASU_PLAY_INTEGRITY_ENDPOINT: "",
  OPENMASU_APP_ATTEST_ENDPOINT: "",
  OPENMASU_GOOGLE_PLAY_PRODUCT_VERIFICATION: "off",
  OPENMASU_GOOGLE_PLAY_SUBSCRIPTION_VERIFICATION: "off",
  OPENMASU_GOOGLE_PLAY_RTDN_RENEWAL_VERIFICATION: "off",
  OPENMASU_GOOGLE_PLAY_RTDN_AUDIENCE: process.env.OPENMASU_GOOGLE_PLAY_RTDN_AUDIENCE ?? "",
  OPENMASU_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL:
    process.env.OPENMASU_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL ?? "",
  OPENMASU_GOOGLE_PLAY_RTDN_MAX_BYTES: "16384",
  OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_FILE: "",
  OPENMASU_GOOGLE_PLAY_ANDROID_PUBLISHER_BASE_URL: "https://androidpublisher.googleapis.com",
  OPENMASU_GOOGLE_PLAY_OAUTH_TOKEN_URL: "https://oauth2.googleapis.com/token",
  OPENMASU_COMMERCE_READBACKS: process.env.OPENMASU_COMMERCE_READBACKS ?? "off",
  OPENMASU_APPLE_STORE_NOTIFICATIONS: process.env.OPENMASU_APPLE_STORE_NOTIFICATIONS ?? "off",
  OPENMASU_APPLE_ROOT_SHA256: process.env.OPENMASU_APPLE_ROOT_SHA256 ?? "",
  OPENMASU_APPLE_STORE_NOTIFICATION_MAX_BYTES: "524288",
  OPENMASU_APP_STORE_API_ISSUER_ID: process.env.OPENMASU_APP_STORE_API_ISSUER_ID ?? "",
  OPENMASU_APP_STORE_API_KEY_ID: process.env.OPENMASU_APP_STORE_API_KEY_ID ?? "",
  OPENMASU_APP_STORE_API_PRIVATE_KEY_FILE: process.env.OPENMASU_APP_STORE_API_PRIVATE_KEY_FILE ?? "",
  OPENMASU_APP_STORE_API_BASE_URL: process.env.OPENMASU_APP_STORE_API_BASE_URL ?? "",
  OPENMASU_GOOGLE_DATA_MANAGER_ENABLED: process.env.OPENMASU_GOOGLE_DATA_MANAGER_ENABLED ?? "off",
  OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON_FILE:
    process.env.OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON_FILE ?? "",
  OPENMASU_GOOGLE_DATA_MANAGER_BASE_URL: "https://datamanager.googleapis.com",
  OPENMASU_GOOGLE_DATA_MANAGER_OAUTH_TOKEN_URL: "https://oauth2.googleapis.com/token",
  OPENMASU_DASHBOARD_ENABLED: "true",
  OPENMASU_DASHBOARD_SESSION_TTL_SECONDS: "43200",
  OPENMASU_DASHBOARD_LOGIN_RATE_RPM: "5",
  OPENMASU_DASHBOARD_LOGIN_RATE_BURST: "10",
  OPENMASU_REPORT_MAX_ROWS: "1000",
  OPENMASU_REPORT_EXPORT_MAX_ROWS: "200000",
  OPENMASU_APPLE_ACCEPT_DEVELOPMENT_POSTBACKS: "0",
  OPENMASU_POSTBACK_MAX_BYTES: "16384",
  OPENMASU_POSTBACK_RATE_RPS: "20",
  OPENMASU_POSTBACK_RATE_BURST: "100",
  OPENMASU_POSTBACK_APP_RATE_RPS: "200",
  OPENMASU_POSTBACK_APP_RATE_BURST: "1000",
  OPENMASU_POSTBACK_INVALID_LEDGER_QUOTA_PER_HOUR: "100",
  OPENMASU_ADSERVICES_LOOKUP: "on",
  OPENMASU_ADSERVICES_ENDPOINT: "https://api-adservices.apple.com/api/v1/",
  OPENMASU_ADSERVICES_LOOKUP_RATE_RPS: "10",
  OPENMASU_ADSERVICES_LOOKUP_RATE_BURST: "50",
};
const seedEntries: Record<string, string> = {
  OPENMASU_APP_DATABASE_URL: appDatabaseUrl,
  OPENMASU_SEED_DATABASE_URL: seedDatabaseUrl,
  OPENMASU_SYNTHETIC_MODE: "1",
};
const repositoryEntries: Record<string, string> = {
  OPENMASU_POSTGRES_BOOTSTRAP_PASSWORD: postgresPassword,
  OPENMASU_APP_DATABASE_PASSWORD: appPassword,
  OPENMASU_READER_DATABASE_PASSWORD: readerPassword,
  OPENMASU_SEED_DATABASE_PASSWORD: seedPassword,
  ...appEntries,
  OPENMASU_MIGRATION_DATABASE_URL: hostMigrationDatabaseUrl,
  OPENMASU_APP_DATABASE_URL: hostAppDatabaseUrl,
  OPENMASU_READER_DATABASE_URL: hostReaderDatabaseUrl,
  OPENMASU_SEED_DATABASE_URL: hostSeedDatabaseUrl,
};
const envBody = (entries: Record<string, string>): string =>
  `${Object.entries(entries).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;

exclusiveWrite(migrationEnvPath, envBody(migrationEntries));
exclusiveWrite(appEnvPath, envBody(appEntries));
exclusiveWrite(seedEnvPath, envBody(seedEntries));
exclusiveWrite(postgresPasswordPath, `${postgresPassword}\n`);
if (!existsSync(repositoryEnvPath)) {
  exclusiveWrite(repositoryEnvPath, envBody(repositoryEntries));
} else {
  const missing = Object.fromEntries(
    Object.entries(repositoryEntries).filter(([name]) => existing[name] === undefined),
  );
  if (Object.keys(missing).length > 0) writeFileSync(repositoryEnvPath, envBody(missing), { flag: "a" });
}

console.log(`OpenMasu admin key: ${adminKey}`);
console.log(`OpenMasu MAX postback URL template: ${maxTemplate}`);
console.log(`OpenMasu redirector base URL: ${redirectorBaseUrl}`);
console.log(`OpenMasu dashboard URL: ${publicBaseUrl}/dashboard`);
