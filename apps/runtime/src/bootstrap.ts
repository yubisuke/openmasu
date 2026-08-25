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

const repositoryRoot = resolve(process.env.OPENMASU_REPOSITORY_ROOT ?? process.cwd());
const runtimeSecretRoot = resolve(
  process.env.OPENMASU_RUNTIME_SECRET_ROOT ?? join(repositoryRoot, ".openmasu"),
);
const migrationEnvPath = join(runtimeSecretRoot, "migration", "runtime.env");
const appEnvPath = join(runtimeSecretRoot, "app", "runtime.env");
const seedEnvPath = join(runtimeSecretRoot, "seed", "runtime.env");
const postgresPasswordPath = join(runtimeSecretRoot, "postgres", "password");
const repositoryEnvPath = join(repositoryRoot, ".env");
const publicBaseUrl = process.env.OPENMASU_PUBLIC_BASE_URL ?? "http://localhost:8080";
const redirectorBaseUrl = process.env.OPENMASU_REDIRECTOR_BASE_URL ?? "http://localhost:8090";
const databaseHost = process.env.OPENMASU_DATABASE_HOST ?? "localhost";
const databasePort = process.env.OPENMASU_DATABASE_PORT ?? "5432";
const databaseName = process.env.OPENMASU_DATABASE_NAME ?? "openmasu";
const defaultTenantId = process.env.OPENMASU_MAX_TENANT_ID ?? "tenant-local";
const defaultAppId = process.env.OPENMASU_MAX_APP_ID ?? "app-local";

const runtimePaths = [migrationEnvPath, appEnvPath, seedEnvPath, postgresPasswordPath];
if (runtimePaths.every(existsSync)) {
  console.log(`OpenMasu runtime secrets already exist: ${runtimeSecretRoot}`);
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
  OPENMASU_MAX_RATE_RPS: process.env.OPENMASU_MAX_RATE_RPS ?? "200",
  OPENMASU_MAX_RATE_BURST: process.env.OPENMASU_MAX_RATE_BURST ?? "500",
  OPENMASU_DEVICE_PRIVACY_RATE_RPM: "1",
  OPENMASU_DEVICE_PRIVACY_RATE_BURST: "3",
  OPENMASU_REDIRECTOR_PORT: "8090",
  OPENMASU_REDIRECTOR_BASE_URL: "http://redirector:8090",
  OPENMASU_REDIRECTOR_TENANT_ID: defaultTenantId,
  OPENMASU_REDIRECTOR_FALLBACK_URL: "https://play.google.com/store",
  OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST: "",
  OPENMASU_REDIRECTOR_GEO: "off",
  OPENMASU_REDIRECTOR_RATE_RPS: "20",
  OPENMASU_REDIRECTOR_RATE_BURST: "50",
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
