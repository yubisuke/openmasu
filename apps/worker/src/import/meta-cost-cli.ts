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
import { fetchMetaInsights, type FetchLike } from "./adapters.js";
import { persistCostImport, type CostImportResult } from "./cost.js";

export type MetaCostImportResult = CostImportResult & { rows: number };

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

export async function runMetaCostImport(options: {
  pool: Pool;
  fetch: FetchLike;
  secrets: SecretStore;
  tenantId: string;
  appId: string;
  accountId: string;
  currency: string;
  since: string;
  until: string;
  asOf?: string;
  apiVersion?: string;
  now?: Date;
  maxPages?: number;
}): Promise<MetaCostImportResult> {
  const asOf = canonicalTimestamp(options.asOf ?? (options.now ?? new Date()).toISOString());
  const tenantId = identifier(options.tenantId, "--tenant");
  const appId = identifier(options.appId, "--app");
  const currency = currencyCode(options.currency);
  const rows = await fetchMetaInsights({
    fetch: options.fetch,
    secrets: options.secrets,
    accountId: options.accountId,
    apiVersion: options.apiVersion,
    since: options.since,
    until: options.until,
    maxPages: options.maxPages,
    scope: { tenant_id: tenantId, app_id: appId, currency, as_of: asOf },
  });
  if (rows.length === 0) throw new Error("Meta Insights returned no cost rows for the requested range");
  const sourceId = `meta-insights:${sha256(["account", options.accountId]).slice(0, 24)}`;
  return { ...await persistCostImport(options.pool, sourceId, rows), rows: rows.length };
}

export async function runMetaCostImportCommand(
  options: Parameters<typeof runMetaCostImport>[0],
): Promise<MetaCostImportResult> {
  const tenantId = identifier(options.tenantId, "--tenant");
  const appId = identifier(options.appId, "--app");
  return runWithTerminalJobOutcome(
    () => runMetaCostImport(options),
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
  const accountId = argument("account");
  const currency = argument("currency");
  const since = argument("since");
  const until = argument("until");
  const asOf = argument("as-of");
  const apiVersion = argument("api-version");
  if (!tenantId || !appId || !accountId || !currency || !since || !until) {
    throw new Error("usage: npm run import:cost:meta -- --tenant=<id> --app=<id> --account=<numeric-id> --currency=<ISO-4217> --since=<YYYY-MM-DD> --until=<YYYY-MM-DD> [--as-of=<UTC timestamp>] [--api-version=v26.0]");
  }
  const secrets = new EnvironmentSecretStore({
    OPENMASU_META_ACCESS_TOKEN: {
      value: process.env.OPENMASU_META_ACCESS_TOKEN,
      file: process.env.OPENMASU_META_ACCESS_TOKEN_FILE,
    },
  });
  const pool = createAppPool();
  try {
    console.log(JSON.stringify(await runMetaCostImportCommand({
      pool,
      fetch,
      secrets,
      tenantId,
      appId,
      accountId,
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
