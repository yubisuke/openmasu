import { resolve } from "node:path";
import type { Pool } from "pg";
import {
  createAppPool,
  EnvironmentSecretStore,
  recordJobOutcome,
  runWithTerminalJobOutcome,
  type SecretStore,
} from "@openmasu/runtime";
import type { FetchLike } from "./adapters.js";
import {
  MAX_AGGREGATE_REVENUE_PAGE_ROWS,
  MAX_AGGREGATE_REVENUE_RESPONSE_BYTES,
  normalizeMaxAggregateRevenue,
  persistMaxAggregateRevenue,
  validateMaxAggregateRevenueResponse,
  type MaxAggregateRevenueImportResult,
} from "./max-revenue.js";

type Any = Record<string, unknown>;

export type MaxRevenueImportResult = MaxAggregateRevenueImportResult & {
  readonly rows: number;
  readonly pages: number;
};

const DEFAULT_PAGE_SIZE = MAX_AGGREGATE_REVENUE_PAGE_ROWS;
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_RESPONSE_BYTES = MAX_AGGREGATE_REVENUE_RESPONSE_BYTES;

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function canonicalTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw new Error("--as-of must be a canonical UTC ISO8601 timestamp");
  }
  return value;
}

function utcDay(value: string, name: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid UTC calendar day`);
  }
  return timestamp;
}

export function validateMaxReportRange(start: string, end: string, now = new Date()): void {
  const startMs = utcDay(start, "--start");
  const endMs = utcDay(end, "--end");
  if (startMs > endMs) throw new Error("--start must not be after --end");
  const todayMs = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const earliestMs = todayMs - 44 * 86_400_000;
  if (startMs < earliestMs || endMs > todayMs) {
    throw new Error("MAX Reporting API dates must stay within the current 45-day UTC request window");
  }
}

async function boundedJson(response: Response, maxBytes: number): Promise<Any> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("MAX Reporting API response exceeds the byte limit");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("MAX Reporting API response exceeds the byte limit");
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be a JSON object");
    return value as Any;
  } catch (error) {
    throw new Error(`MAX Reporting API returned invalid JSON: ${error instanceof Error ? error.message : "parse failure"}`);
  }
}

export async function fetchMaxAggregateRevenue(options: {
  fetch: FetchLike;
  secrets: SecretStore;
  tenantId: string;
  appId: string;
  start: string;
  end: string;
  asOf: string;
  now?: Date;
  pageSize?: number;
  maxPages?: number;
  maxResponseBytes?: number;
}): Promise<{ rows: ReturnType<typeof normalizeMaxAggregateRevenue>; pages: number }> {
  validateMaxReportRange(options.start, options.end, options.now);
  const tenantId = identifier(options.tenantId, "--tenant");
  const appId = identifier(options.appId, "--app");
  const asOf = canonicalTimestamp(options.asOf);
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new Error("MAX page size is invalid");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new Error("MAX page limit is invalid");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error("MAX response byte limit is invalid");

  const reportKey = options.secrets.require("OPENMASU_MAX_REPORT_KEY");
  const rows: ReturnType<typeof normalizeMaxAggregateRevenue> = [];
  let pages = 0;
  for (let offset = 0; pages < maxPages; offset += pageSize) {
    const url = new URL("https://r.applovin.com/maxReport");
    url.searchParams.set("api_key", reportKey);
    url.searchParams.set("start", options.start);
    url.searchParams.set("end", options.end);
    url.searchParams.set("format", "json");
    url.searchParams.set("columns", "day,country,max_ad_unit_id,network,estimated_revenue");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sort_day", "ASC");
    url.searchParams.set("sort_country", "ASC");
    url.searchParams.set("sort_max_ad_unit_id", "ASC");
    url.searchParams.set("sort_network", "ASC");
    let response: Response;
    try {
      response = await options.fetch(url, { redirect: "error" });
    } catch {
      // Never attach the URL: the provider requires its Report Key in the query string.
      throw new Error("MAX Reporting API request failed");
    }
    if (!response.ok) throw new Error(`MAX Reporting API failed with status ${response.status}`);
    const payload = await boundedJson(response, maxResponseBytes);
    const responseRows = validateMaxAggregateRevenueResponse(payload, pageSize);
    const pageRows = normalizeMaxAggregateRevenue(
      { tenant_id: tenantId, app_id: appId, as_of: asOf },
      responseRows,
      { maxRows: pageSize },
    );
    rows.push(...pageRows);
    pages += 1;
    if (pageRows.length < pageSize) return { rows, pages };
  }
  throw new Error(`MAX Reporting API exceeded ${maxPages} pages`);
}

export async function runMaxRevenueImport(options: Parameters<typeof fetchMaxAggregateRevenue>[0] & { pool: Pool }): Promise<MaxRevenueImportResult> {
  const fetched = await fetchMaxAggregateRevenue(options);
  if (fetched.rows.length === 0) throw new Error("MAX Reporting API returned no aggregate revenue rows for the requested range");
  return {
    ...await persistMaxAggregateRevenue(options.pool, fetched.rows),
    rows: fetched.rows.length,
    pages: fetched.pages,
  };
}

export async function runMaxRevenueImportCommand(options: Parameters<typeof runMaxRevenueImport>[0]): Promise<MaxRevenueImportResult> {
  const tenantId = identifier(options.tenantId, "--tenant");
  const appId = identifier(options.appId, "--app");
  return runWithTerminalJobOutcome(
    () => runMaxRevenueImport(options),
    (outcome) => recordJobOutcome({
      pool: options.pool,
      tenantId,
      appId,
      job: "max_revenue_import",
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
  const start = argument("start");
  const end = argument("end");
  const asOf = argument("as-of") ?? new Date().toISOString();
  if (!tenantId || !appId || !start || !end) {
    throw new Error("usage: npm run import:revenue:max -- --tenant=<id> --app=<id> --start=<YYYY-MM-DD> --end=<YYYY-MM-DD> [--as-of=<UTC timestamp>]");
  }
  const secrets = new EnvironmentSecretStore({
    OPENMASU_MAX_REPORT_KEY: {
      value: process.env.OPENMASU_MAX_REPORT_KEY,
      file: process.env.OPENMASU_MAX_REPORT_KEY_FILE,
    },
  });
  const pool = createAppPool();
  try {
    console.log(JSON.stringify(await runMaxRevenueImportCommand({
      pool, fetch, secrets, tenantId, appId, start, end, asOf,
    })));
  } finally {
    await pool.end();
  }
}
