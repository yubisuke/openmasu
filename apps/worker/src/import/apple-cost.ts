import { normalizeCostRefreshDefinition, type AppleCostRefreshDefinition, type SecretStore } from "@openmasu/runtime";
import { decimalToUnscaled, prepareCostImportRows, type CostInput } from "./cost.js";
import type { CostScope, FetchLike } from "./adapters.js";

const invalid = (field: string): never => { throw new Error(`Apple Ads ${field} is invalid or incomplete`); };
function object(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field);
  return value as Record<string, any>;
}
function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,17}$/.exec(value)?.[0] === value) return value;
  return invalid("identifier");
}
function day(value: unknown): string {
  if (typeof value !== "string" || /^\d{4}-\d{2}-\d{2}$/.exec(value)?.[0] !== value
    || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) return invalid("day");
  return value;
}

// A shared cumulative byte budget across pages, before JSON parsing. Provider
// response bodies, account names and credential values never enter errors.
async function readPage(response: Response, budget: { remaining: number }): Promise<Record<string, any>> {
  if (!response.body) return invalid("response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      budget.remaining -= part.value.byteLength;
      if (budget.remaining < 0) { await reader.cancel().catch(() => undefined); return invalid("byte limit"); }
      chunks.push(part.value);
    }
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), "response");
  } catch { return invalid("response body or byte limit"); }
  finally { reader.releaseLock(); }
}

export async function fetchAppleAds(options: {
  fetch: FetchLike; secrets: SecretStore; definition: AppleCostRefreshDefinition;
  scope: CostScope; since: string; until: string;
}): Promise<CostInput[]> {
  const definition = normalizeCostRefreshDefinition(options.definition);
  if (definition.provider !== "apple_ads" || definition.currency !== options.scope.currency) return invalid("scope");
  const since = day(options.since), until = day(options.until);
  const days = (Date.parse(until) - Date.parse(since)) / 86_400_000 + 1;
  if (days < 1 || days > 31) return invalid("range");
  const token = options.secrets.require("OPENMASU_APPLE_ADS_ACCESS_TOKEN");
  const budget = { remaining: definition.limits.maxResponseBytes };
  const campaigns = new Set(definition.campaign_ids), seen = new Set<string>();
  const rows: CostInput[] = [];
  let offset = 0, total: number | undefined;
  for (let page = 0; page < definition.limits.maxPages; page += 1) {
    let response: Response;
    try {
      response = await options.fetch("https://api.ads.apple.com/v1/reports/apps/campaigns/query", {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
          "X-AP-Context": `adAccountId=${definition.ad_account_id}` },
        body: JSON.stringify({ pagination: { offset, pageSize: definition.limits.pageSize },
          filters: [{ field: "campaignId", operator: "IN", value: definition.campaign_ids }],
          timeRange: { start: since, end: until, timeZone: "UTC", ...(days === 1 ? {} : { granularity: "DAILY" }) },
          options: { includeRows: ["EMPTY_METRICS"] } }),
      });
    } catch { throw new Error("Apple Ads request failed"); }
    if (!response.ok) throw new Error(`Apple Ads request failed with ${response.status}`);
    const body = await readPage(response, budget);
    if (body.error != null) return invalid("provider error");
    const result = object(body.result, "result");
    // Apple documents result:{} for no campaign rows. Never convert it to zero.
    if (!Object.keys(result).length && offset === 0 && (body.pagination == null || body.pagination.totalCount === 0)) return [];
    const pagination = object(body.pagination, "pagination");
    if (!Array.isArray(result.rows) || result.rows.length > definition.limits.pageSize
      || !Number.isSafeInteger(pagination.totalCount) || pagination.totalCount < 0 || pagination.totalCount > campaigns.size
      || pagination.offset !== offset || total !== undefined && total !== pagination.totalCount) return invalid("pagination");
    total = pagination.totalCount;
    if (!result.rows.length && offset === 0 && total === 0) return [];
    if (!result.rows.length || offset + result.rows.length > total!) return invalid("pagination progress");
    for (const value of result.rows) {
      const row = object(value, "campaign row"), metadata = object(row.metadata, "metadata");
      const campaign = identifier(metadata.id);
      if (!campaigns.has(campaign) || seen.has(campaign) || identifier(metadata.adAccountId) !== definition.ad_account_id
        || identifier(metadata.promotedObjectId) !== definition.app_store_id || metadata.promotedObjectType !== "APPSTORE_APP") return invalid("campaign scope or duplicate");
      seen.add(campaign);
      const metrics = days === 1 ? [{ ...object(row.totalMetrics, "single-day total"), date: since }] : row.granularMetrics;
      if (!Array.isArray(metrics) || metrics.length !== days) return invalid("daily coverage");
      const dates = new Set<string>();
      for (const raw of metrics) {
        const metric = object(raw, "daily metric"), date = day(metric.date), money = object(metric.localSpend, "spend");
        if (date < since || date > until || dates.has(date)) return invalid("daily coverage");
        dates.add(date);
        if (money.currency !== definition.currency || typeof money.amount !== "string"
          || /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/.exec(money.amount)?.[0] !== money.amount) return invalid("money");
        if (rows.length >= definition.limits.maxRows) return invalid("row limit");
        // Fixed scale prevents equivalent decimal spellings from changing the
        // amount identity; preserve up to the existing contract's 18 decimals.
        rows.push({ ...options.scope, network: "apple_adservices", campaign_id: campaign, date,
          reporting_time_zone: "UTC", amount_unscaled: decimalToUnscaled(money.amount, 18), amount_scale: 18,
          currency: definition.currency, source: "imported_reported" });
      }
    }
    offset += result.rows.length;
    if (offset === total) {
      // An explicit nonempty campaign set must be complete. Missing rows/days
      // are not invented zeros, even when upstream omits inactive campaigns.
      if (seen.size !== campaigns.size) return invalid("campaign coverage");
      return prepareCostImportRows(rows);
    }
  }
  return invalid("page limit");
}
