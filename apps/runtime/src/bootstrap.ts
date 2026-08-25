import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

function url(user: string, password: string, host: string, port: string, database: string): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

const repositoryRoot = resolve(process.env.OPENMMP_REPOSITORY_ROOT ?? process.cwd());
const runtimeSecretRoot = resolve(
  process.env.OPENMMP_RUNTIME_SECRET_ROOT ?? join(repositoryRoot, ".openmmp"),
);
const migrationEnvPath = join(runtimeSecretRoot, "migration", "runtime.env");
const appEnvPath = join(runtimeSecretRoot, "app", "runtime.env");
const seedEnvPath = join(runtimeSecretRoot, "seed", "runtime.env");
const postgresPasswordPath = join(runtimeSecretRoot, "postgres", "password");
const repositoryEnvPath = join(repositoryRoot, ".env");
const publicBaseUrl = process.env.OPENMMP_PUBLIC_BASE_URL ?? "http://localhost:8080";
const redirectorBaseUrl = process.env.OPENMMP_REDIRECTOR_BASE_URL ?? "http://localhost:8090";
const databaseHost = process.env.OPENMMP_DATABASE_HOST ?? "localhost";
const databasePort = process.env.OPENMMP_DATABASE_PORT ?? "5432";
const databaseName = process.env.OPENMMP_DATABASE_NAME ?? "openmmp";
const defaultTenantId = process.env.OPENMMP_MAX_TENANT_ID ?? "tenant-local";
const defaultAppId = process.env.OPENMMP_MAX_APP_ID ?? "app-local";

const runtimePaths = [migrationEnvPath, appEnvPath, seedEnvPath, postgresPasswordPath];
if (runtimePaths.every(existsSync)) {
  console.log(`Open MMP runtime secrets already exist: ${runtimeSecretRoot}`);
  process.exit(0);
}
if (runtimePaths.some(existsSync)) throw new Error(`incomplete runtime secret set: ${runtimeSecretRoot}`);

const existing = existsSync(repositoryEnvPath)
  ? Object.fromEntries(
      readFileSync(repositoryEnvPath, "utf8").split(/\r?\n/).flatMap((line) => {
        const separator = line.indexOf("=");
        return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
      }),
    )
  : {};
const postgresPassword = existing.OPENMMP_POSTGRES_BOOTSTRAP_PASSWORD ?? secret();
const appPassword = existing.OPENMMP_APP_DATABASE_PASSWORD ?? secret();
const readerPassword = existing.OPENMMP_READER_DATABASE_PASSWORD ?? secret();
const seedPassword = existing.OPENMMP_SEED_DATABASE_PASSWORD ?? secret();
const adminKey = existing.OPENMMP_ADMIN_KEY ?? secret();
const maxPathSecret = existing.OPENMMP_MAX_PATH_SECRET ?? secret(24);
const maxEventKey = existing.OPENMMP_MAX_EVENT_KEY ?? secret();
const payloadMasterKey = existing.OPENMMP_PAYLOAD_MASTER_KEY ?? secret();
const sdkKey = existing.OPENMMP_SDK_KEY ?? secret();
const installationDigestKey = existing.OPENMMP_INSTALLATION_DIGEST_KEY ?? secret();
const metaReferrerKey = existing.OPENMMP_META_IR_DECRYPTION_KEY ?? randomBytes(32).toString("hex");
const migrationDatabaseUrl = url("postgres", postgresPassword, databaseHost, databasePort, databaseName);
const appDatabaseUrl = url("openmmp_app", appPassword, databaseHost, databasePort, databaseName);
const readerDatabaseUrl = url("openmmp_reader", readerPassword, databaseHost, databasePort, databaseName);
const seedDatabaseUrl = url("openmmp_seed", seedPassword, databaseHost, databasePort, databaseName);
const hostMigrationDatabaseUrl = url("postgres", postgresPassword, "localhost", databasePort, databaseName);
const hostAppDatabaseUrl = url("openmmp_app", appPassword, "localhost", databasePort, databaseName);
const hostReaderDatabaseUrl = url("openmmp_reader", readerPassword, "localhost", databasePort, databaseName);
const hostSeedDatabaseUrl = url("openmmp_seed", seedPassword, "localhost", databasePort, databaseName);
const maxTemplate = `${publicBaseUrl}/v1/ingest/max/${maxPathSecret}?event_token_all={EVENT_TOKEN_ALL}&event_id={EVENT_ID}&revenue={REVENUE}&ts={TS}`;

const migrationEntries: Record<string, string> = {
  OPENMMP_MIGRATION_DATABASE_URL: migrationDatabaseUrl,
  OPENMMP_APP_DATABASE_PASSWORD: appPassword,
  OPENMMP_READER_DATABASE_PASSWORD: readerPassword,
  OPENMMP_SEED_DATABASE_PASSWORD: seedPassword,
};
const appEntries: Record<string, string> = {
  OPENMMP_APP_DATABASE_URL: appDatabaseUrl,
  OPENMMP_READER_DATABASE_URL: readerDatabaseUrl,
  OPENMMP_ADMIN_KEY: adminKey,
  OPENMMP_ADMIN_ROLE: "admin",
  OPENMMP_MAX_PATH_SECRET: maxPathSecret,
  OPENMMP_MAX_EVENT_KEY: maxEventKey,
  OPENMMP_PAYLOAD_MASTER_KEY: payloadMasterKey,
  OPENMMP_SDK_KEY_ID: "sdk-key-current",
  OPENMMP_SDK_KEY: sdkKey,
  OPENMMP_INSTALLATION_DIGEST_KEY: installationDigestKey,
  OPENMMP_META_IR_DECRYPTION_KEY: metaReferrerKey,
  OPENMMP_PUBLIC_BASE_URL: publicBaseUrl,
  OPENMMP_API_PORT: "8080",
  OPENMMP_WORKER_POLL_MS: "5000",
  OPENMMP_SYNTHETIC_MODE: "0",
  OPENMMP_MAX_TENANT_ID: defaultTenantId,
  OPENMMP_MAX_APP_ID: defaultAppId,
  OPENMMP_MAX_TOKEN_MODE: "all_with_event_fallback",
  OPENMMP_PAYLOAD_STORE_DIR: "/run/openmmp/payloads",
  OPENMMP_SDK_TENANT_ID: defaultTenantId,
  OPENMMP_INGEST_SKEW_MS: "300000",
  OPENMMP_NONCE_TTL_MS: "900000",
  OPENMMP_INGEST_MAX_BYTES: "262144",
  OPENMMP_INGEST_MAX_EVENTS: "100",
  OPENMMP_ENROLL_RATE_RPS: process.env.OPENMMP_ENROLL_RATE_RPS ?? "50",
  OPENMMP_ENROLL_RATE_BURST: process.env.OPENMMP_ENROLL_RATE_BURST ?? "100",
  OPENMMP_INGEST_RATE_RPS: process.env.OPENMMP_INGEST_RATE_RPS ?? "1",
  OPENMMP_INGEST_RATE_BURST: process.env.OPENMMP_INGEST_RATE_BURST ?? "20",
  OPENMMP_INGEST_APP_RATE_RPS: process.env.OPENMMP_INGEST_APP_RATE_RPS ?? "500",
  OPENMMP_INGEST_APP_RATE_BURST: process.env.OPENMMP_INGEST_APP_RATE_BURST ?? "1000",
  OPENMMP_MAX_RATE_RPS: process.env.OPENMMP_MAX_RATE_RPS ?? "200",
  OPENMMP_MAX_RATE_BURST: process.env.OPENMMP_MAX_RATE_BURST ?? "500",
  OPENMMP_DEVICE_PRIVACY_RATE_RPM: "1",
  OPENMMP_DEVICE_PRIVACY_RATE_BURST: "3",
  OPENMMP_REDIRECTOR_PORT: "8090",
  OPENMMP_REDIRECTOR_BASE_URL: "http://redirector:8090",
  OPENMMP_REDIRECTOR_TENANT_ID: defaultTenantId,
  OPENMMP_REDIRECTOR_FALLBACK_URL: "https://play.google.com/store",
  OPENMMP_REDIRECTOR_DESTINATION_ALLOWLIST: "",
  OPENMMP_REDIRECTOR_GEO: "off",
  OPENMMP_REDIRECTOR_RATE_RPS: "20",
  OPENMMP_REDIRECTOR_RATE_BURST: "50",
  OPENMMP_DASHBOARD_ENABLED: "true",
  OPENMMP_DASHBOARD_SESSION_TTL_SECONDS: "43200",
  OPENMMP_DASHBOARD_LOGIN_RATE_RPM: "5",
  OPENMMP_DASHBOARD_LOGIN_RATE_BURST: "10",
  OPENMMP_REPORT_MAX_ROWS: "1000",
  OPENMMP_REPORT_EXPORT_MAX_ROWS: "200000",
  OPENMMP_APPLE_ACCEPT_DEVELOPMENT_POSTBACKS: "0",
  OPENMMP_POSTBACK_MAX_BYTES: "16384",
  OPENMMP_POSTBACK_RATE_RPS: "20",
  OPENMMP_POSTBACK_RATE_BURST: "100",
  OPENMMP_POSTBACK_APP_RATE_RPS: "200",
  OPENMMP_POSTBACK_APP_RATE_BURST: "1000",
  OPENMMP_POSTBACK_INVALID_LEDGER_QUOTA_PER_HOUR: "100",
  OPENMMP_ADSERVICES_LOOKUP: "on",
  OPENMMP_ADSERVICES_ENDPOINT: "https://api-adservices.apple.com/api/v1/",
  OPENMMP_ADSERVICES_LOOKUP_RATE_RPS: "10",
  OPENMMP_ADSERVICES_LOOKUP_RATE_BURST: "50",
};
const seedEntries: Record<string, string> = {
  OPENMMP_APP_DATABASE_URL: appDatabaseUrl,
  OPENMMP_SEED_DATABASE_URL: seedDatabaseUrl,
  OPENMMP_SYNTHETIC_MODE: "1",
};
const repositoryEntries: Record<string, string> = {
  OPENMMP_POSTGRES_BOOTSTRAP_PASSWORD: postgresPassword,
  OPENMMP_APP_DATABASE_PASSWORD: appPassword,
  OPENMMP_READER_DATABASE_PASSWORD: readerPassword,
  OPENMMP_SEED_DATABASE_PASSWORD: seedPassword,
  ...appEntries,
  OPENMMP_MIGRATION_DATABASE_URL: hostMigrationDatabaseUrl,
  OPENMMP_APP_DATABASE_URL: hostAppDatabaseUrl,
  OPENMMP_READER_DATABASE_URL: hostReaderDatabaseUrl,
  OPENMMP_SEED_DATABASE_URL: hostSeedDatabaseUrl,
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

console.log(`Open MMP admin key: ${adminKey}`);
console.log(`Open MMP MAX postback URL template: ${maxTemplate}`);
console.log(`Open MMP redirector base URL: ${redirectorBaseUrl}`);
console.log(`Open MMP dashboard URL: ${publicBaseUrl}/dashboard`);
