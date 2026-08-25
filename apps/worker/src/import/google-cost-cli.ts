import { resolve } from "node:path";
import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core";
import {
  createAppPool,
  EnvironmentSecretStore,
  recordJobOutcome,
  runWithTerminalJobOutcome,
  type SecretStore,
} from "@openmasu/runtime";
import {
  fetchGoogleAds,
  type FetchLike,
  type GoogleAdsLimits,
} from "./adapters.js";
import { persistCostImport, type CostImportResult } from "./cost.js";

export type GoogleCostImportResult = CostImportResult & { rows: number };

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function currencyCode(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) throw new Error("--currency must be an uppercase ISO-4217 code");
  return value;
}

function canonicalTimestamp(value: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw new Error("--as-of must be a canonical UTC ISO8601 timestamp");
  }
  return value;
}

export async function runGoogleCostImport(options: {
  pool: Pool;
  fetch: FetchLike;
  secrets: SecretStore;
  tenantId: string;
  appId: string;
  customerId: string;
  loginCustomerId?: string;
  currency: string;
  since: string;
  until: string;
  asOf?: string;
  apiVersion?: string;
  now?: Date;
  limits?: Partial<GoogleAdsLimits>;
}): Promise<GoogleCostImportResult> {
  const asOf = canonicalTimestamp(options.asOf ?? (options.now ?? new Date()).toISOString());
  const tenantId = identifier(options.tenantId, "--tenant");
  const appId = identifier(options.appId, "--app");
  const currency = currencyCode(options.currency);
  const rows = await fetchGoogleAds({
    fetch: options.fetch,
    secrets: options.secrets,
    customerId: options.customerId,
    loginCustomerId: options.loginCustomerId,
    apiVersion: options.apiVersion,
    since: options.since,
    until: options.until,
    limits: options.limits,
    scope: { tenant_id: tenantId, app_id: appId, currency, as_of: asOf },
  });
  if (rows.length === 0) throw new Error("Google Ads returned no cost rows for the requested range");
  const sourceId = `google-ads:${sha256(["customer", options.customerId]).slice(0, 24)}`;
  return { ...await persistCostImport(options.pool, sourceId, rows), rows: rows.length };
}

export async function runGoogleCostImportCommand(
  options: Parameters<typeof runGoogleCostImport>[0],
): Promise<GoogleCostImportResult> {
  const tenantId = identifier(options.tenantId, "--tenant");
  const appId = identifier(options.appId, "--app");
  return runWithTerminalJobOutcome(
    () => runGoogleCostImport(options),
    (outcome) => recordJobOutcome({
      pool: options.pool,
      tenantId,
      appId,
      job: "cost_import",
      outcome,
    }),
  );
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const tenantId = argument("tenant");
  const appId = argument("app");
  const customerId = argument("customer");
  const loginCustomerId = argument("login-customer");
  const currency = argument("currency");
  const since = argument("since");
  const until = argument("until");
  const asOf = argument("as-of");
  const apiVersion = argument("api-version");
  if (!tenantId || !appId || !customerId || !currency || !since || !until) {
    throw new Error("usage: npm run import:cost:google -- --tenant=<id> --app=<id> --customer=<10-digit-id> --currency=<ISO-4217> --since=<YYYY-MM-DD> --until=<YYYY-MM-DD> [--login-customer=<10-digit-id>] [--as-of=<UTC timestamp>] [--api-version=v25]");
  }
  const secrets = new EnvironmentSecretStore({
    OPENMASU_GOOGLE_ADS_ACCESS_TOKEN: {
      value: process.env.OPENMASU_GOOGLE_ADS_ACCESS_TOKEN,
      file: process.env.OPENMASU_GOOGLE_ADS_ACCESS_TOKEN_FILE,
    },
    OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN: {
      value: process.env.OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN,
      file: process.env.OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN_FILE,
    },
  });
  const pool = createAppPool();
  try {
    console.log(JSON.stringify(await runGoogleCostImportCommand({
      pool,
      fetch,
      secrets,
      tenantId,
      appId,
      customerId,
      loginCustomerId,
      currency,
      since,
      until,
      asOf,
      apiVersion,
    })));
  } finally {
    await pool.end();
  }
}
