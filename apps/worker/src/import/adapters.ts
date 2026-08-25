import type { SecretStore } from "@openmasu/runtime";
import { decimalToUnscaled, prepareCostImportRows, type CostInput } from "./cost.js";

type Any = Record<string, any>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type CostScope = {
  tenant_id: string;
  app_id: string;
  currency: string;
  as_of: string;
};

export type MetaInsightsRange = { since: string; until: string };

const metaPageSize = 500;
const defaultMetaMaxPages = 1_000;

function metaText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Meta Insights ${field} is required`);
  return value;
}

function canonicalMetaDay(value: unknown, field: string): string {
  const day = metaText(value, field);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)
      || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
      || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) {
    throw new Error(`Meta Insights ${field} must be a real YYYY-MM-DD calendar day`);
  }
  return day;
}

function validateMetaRange(range: MetaInsightsRange): MetaInsightsRange {
  const since = canonicalMetaDay(range.since, "since");
  const until = canonicalMetaDay(range.until, "until");
  if (since > until) throw new Error("Meta Insights since must not be after until");
  return { since, until };
}

function metaIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9]{1,32}$/.test(value)) {
    throw new Error(`Meta Insights ${field} must be a numeric identifier`);
  }
  return value;
}

function metaCurrency(value: unknown, field: string): string {
  const currency = metaText(value, field);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Meta Insights ${field} must be an uppercase ISO-4217 code`);
  return currency;
}

function metaResponse(value: unknown): Any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Meta Insights response must be an object");
  }
  const response = value as Any;
  if (response.error !== undefined) {
    const code = response.error && typeof response.error === "object" && Number.isSafeInteger(response.error.code)
      ? ` with code ${response.error.code}`
      : "";
    throw new Error(`Meta Insights response contained an error${code}`);
  }
  if (!Array.isArray(response.data)) throw new Error("Meta Insights response data must be an array");
  return response;
}

export function normalizeMetaInsights(scope: CostScope, responseValue: unknown, requestedRange: MetaInsightsRange): CostInput[] {
  const response = metaResponse(responseValue);
  const range = validateMetaRange(requestedRange);
  const expectedCurrency = metaCurrency(scope.currency, "configured currency");
  return response.data.map((value: unknown, index: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Meta Insights row ${index} must be an object`);
    }
    const row = value as Any;
    const dateStart = canonicalMetaDay(row.date_start, `row ${index} date_start`);
    const dateStop = canonicalMetaDay(row.date_stop, `row ${index} date_stop`);
    if (dateStart !== dateStop) throw new Error(`Meta Insights row ${index} is not a daily result`);
    if (dateStart < range.since || dateStart > range.until) {
      throw new Error(`Meta Insights row ${index} is outside the requested range`);
    }
    const currency = metaCurrency(row.account_currency, `row ${index} account_currency`);
    if (currency !== expectedCurrency) throw new Error(`Meta Insights row ${index} account currency does not match --currency`);
    const country = metaText(row.country, `row ${index} country`);
    if (!/^[A-Z]{2}$/.test(country)) throw new Error(`Meta Insights row ${index} country must be an uppercase ISO-3166-1 alpha-2 code`);
    const spend = metaText(row.spend, `row ${index} spend`);
    return {
      ...scope,
      network: "meta",
      campaign_id: metaIdentifier(row.campaign_id, `row ${index} campaign_id`),
      ad_group_id: metaIdentifier(row.adset_id, `row ${index} adset_id`),
      country,
      date: dateStart,
      amount_unscaled: decimalToUnscaled(spend, 6),
      amount_scale: 6,
      currency,
      source: "imported_reported" as const,
    };
  });
}

export async function fetchMetaInsights(options: {
  fetch: FetchLike;
  secrets: SecretStore;
  accountId: string;
  apiVersion?: string;
  scope: CostScope;
  since: string;
  until: string;
  maxPages?: number;
}): Promise<CostInput[]> {
  const range = validateMetaRange({ since: options.since, until: options.until });
  const version = options.apiVersion ?? "v26.0";
  if (!/^v[0-9]+\.[0-9]+$/.test(version)) throw new Error("Meta Insights apiVersion must use v<major>.<minor>");
  const accountId = metaIdentifier(options.accountId, "accountId");
  metaCurrency(options.scope.currency, "configured currency");
  const maxPages = options.maxPages ?? defaultMetaMaxPages;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error("Meta Insights maxPages must be a positive safe integer");
  const token = options.secrets.require("OPENMASU_META_ACCESS_TOKEN");
  const fields = "account_currency,campaign_id,adset_id,spend,date_start,date_stop";
  const rows: CostInput[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let pages = 0;
  while (true) {
    const url = new URL(`https://graph.facebook.com/${version}/act_${accountId}/insights`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("level", "adset");
    url.searchParams.set("time_increment", "1");
    url.searchParams.set("breakdowns", "country");
    url.searchParams.set("time_range", JSON.stringify(range));
    url.searchParams.set("limit", String(metaPageSize));
    if (after !== undefined) url.searchParams.set("after", after);
    const response = await options.fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Meta Insights request failed with ${response.status}`);
    let responseValue: unknown;
    try {
      responseValue = await response.json();
    } catch {
      throw new Error("Meta Insights response was not valid JSON");
    }
    const body = metaResponse(responseValue);
    if (body.data.length > metaPageSize) {
      throw new Error(`Meta Insights response exceeded the requested ${metaPageSize}-row page size`);
    }
    rows.push(...normalizeMetaInsights(options.scope, body, range));
    pages += 1;
    if (body.paging === undefined) break;
    if (!body.paging || typeof body.paging !== "object" || Array.isArray(body.paging)) {
      throw new Error("Meta Insights paging must be an object");
    }
    if (body.paging.next === undefined || body.paging.next === null) break;
    if (typeof body.paging.next !== "string" || body.paging.next.length === 0) {
      throw new Error("Meta Insights paging.next must be a non-empty string");
    }
    const cursor = body.paging.cursors?.after;
    if (typeof cursor !== "string" || cursor.length === 0) {
      throw new Error("Meta Insights paging.next requires a non-empty after cursor");
    }
    if (seenCursors.has(cursor)) throw new Error("Meta Insights pagination repeated an after cursor");
    if (pages >= maxPages) throw new Error(`Meta Insights pagination exceeded ${maxPages} pages`);
    seenCursors.add(cursor);
    after = cursor;
  }
  return prepareCostImportRows(rows);
}

export type GoogleAdsRange = { since: string; until: string };

export type GoogleAdsLimits = {
  maxRows: number;
  maxBatches: number;
  maxResponseBytes: number;
  maxGeoCriteria: number;
  lookupChunkSize: number;
  maxRequests: number;
};

const defaultGoogleAdsLimits: GoogleAdsLimits = {
  maxRows: 100_000,
  maxBatches: 1_000,
  maxResponseBytes: 32 * 1024 * 1024,
  maxGeoCriteria: 1_000,
  lookupChunkSize: 200,
  maxRequests: 8,
};

const googleAppCampaignSubtypes = new Set([
  "APP_CAMPAIGN",
  "APP_CAMPAIGN_FOR_ENGAGEMENT",
  "APP_CAMPAIGN_FOR_PRE_REGISTRATION",
]);

const googleAdGroupCampaignTypes = new Set([
  "DEMAND_GEN",
  "DISPLAY",
  "HOTEL",
  "LOCAL",
  "SEARCH",
  "SHOPPING",
  "SMART",
  "TRAVEL",
  "VIDEO",
]);

const googleCampaignOnlyTypes = new Set([
  "LOCAL_SERVICES",
  "PERFORMANCE_MAX",
]);

type GoogleCostRow = {
  date: string;
  campaignId: string;
  adGroupId: string | null;
  countryCriterionId: string;
  costMicros: string;
  currency: string;
};

function googleText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Google Ads ${field} is required`);
  return value;
}

function canonicalGoogleDay(value: unknown, field: string): string {
  const day = googleText(value, field);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)
      || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
      || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) {
    throw new Error(`Google Ads ${field} must be a real YYYY-MM-DD calendar day`);
  }
  return day;
}

function validateGoogleRange(range: GoogleAdsRange): GoogleAdsRange {
  const since = canonicalGoogleDay(range.since, "since");
  const until = canonicalGoogleDay(range.until, "until");
  if (since > until) throw new Error("Google Ads since must not be after until");
  return { since, until };
}

function googleCustomerId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9]{10}$/.test(value)) {
    throw new Error(`Google Ads ${field} must be a 10-digit customer ID without hyphens`);
  }
  return value;
}

function googleInt64(value: unknown, field: string, allowZero = false): string {
  if (typeof value !== "string" || !(allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)) {
    throw new Error(`Google Ads ${field} must be a canonical non-negative INT64 string`);
  }
  if (BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new Error(`Google Ads ${field} exceeds INT64`);
  }
  return value;
}

function googleCurrency(value: unknown, field: string): string {
  const currency = googleText(value, field);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Google Ads ${field} must be an uppercase ISO-4217 code`);
  return currency;
}

function googleCountry(value: unknown, field: string): string {
  const country = googleText(value, field);
  if (!/^[A-Z]{2}$/.test(country)) throw new Error(`Google Ads ${field} must be an uppercase ISO-3166-1 alpha-2 code`);
  return country;
}

function googleSubtype(value: unknown, field: string): string {
  const subtype = googleText(value, field);
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(subtype)) throw new Error(`Google Ads ${field} is invalid`);
  return subtype;
}

function googleLimit(value: unknown, field: keyof GoogleAdsLimits): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Google Ads ${field} must be a positive safe integer`);
  return Number(value);
}

function googleLimits(configured: Partial<GoogleAdsLimits> | undefined): GoogleAdsLimits {
  const limits = Object.fromEntries(Object.entries(defaultGoogleAdsLimits).map(([field, fallback]) => [
    field,
    googleLimit(configured?.[field as keyof GoogleAdsLimits] ?? fallback, field as keyof GoogleAdsLimits),
  ])) as GoogleAdsLimits;
  if (limits.lookupChunkSize > limits.maxGeoCriteria) {
    throw new Error("Google Ads lookupChunkSize must not exceed maxGeoCriteria");
  }
  if (limits.lookupChunkSize > 20_000) {
    throw new Error("Google Ads lookupChunkSize must not exceed the provider IN-list limit");
  }
  if (limits.maxRows === Number.MAX_SAFE_INTEGER) {
    throw new Error("Google Ads maxRows must leave room for a one-row overflow sentinel");
  }
  return limits;
}

function googleObject(value: unknown, field: string): Any {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Google Ads ${field} must be an object`);
  return value as Any;
}

function googleSearchStreamResults(
  value: unknown,
  label: string,
  maxBatches: number,
  maxRows: number,
): Any[] {
  if (!Array.isArray(value)) throw new Error(`Google Ads ${label} response must be an array`);
  if (value.length > maxBatches) throw new Error(`Google Ads ${label} response exceeded the batch limit`);
  const rows: Any[] = [];
  for (const [batchIndex, batchValue] of value.entries()) {
    const batch = googleObject(batchValue, `${label} batch ${batchIndex}`);
    const results = batch.results === undefined ? [] : batch.results;
    if (!Array.isArray(results)) throw new Error(`Google Ads ${label} batch ${batchIndex} results must be an array`);
    if (rows.length + results.length > maxRows) throw new Error(`Google Ads ${label} response exceeded the row limit`);
    for (const [rowIndex, rowValue] of results.entries()) {
      rows.push(googleObject(rowValue, `${label} batch ${batchIndex} row ${rowIndex}`));
    }
  }
  return rows;
}

function googleCostRows(
  value: unknown,
  rangeValue: GoogleAdsRange,
  limits: GoogleAdsLimits,
  mode: "ad_group" | "app" | "campaign_only",
  expectedCurrency: string,
): GoogleCostRow[] {
  const range = validateGoogleRange(rangeValue);
  return googleSearchStreamResults(value, "cost", limits.maxBatches, limits.maxRows).map((row, index) => {
    const date = canonicalGoogleDay(row.segments?.date, `cost row ${index} segments.date`);
    if (date < range.since || date > range.until) throw new Error(`Google Ads cost row ${index} is outside the requested range`);
    const subtype = googleSubtype(
      mode !== "app" && row.campaign?.advertisingChannelSubType === undefined
        ? "UNSPECIFIED"
        : row.campaign?.advertisingChannelSubType,
      `cost row ${index} campaign.advertisingChannelSubType`,
    );
    const channelType = googleSubtype(
      row.campaign?.advertisingChannelType,
      `cost row ${index} campaign.advertisingChannelType`,
    );
    const appCampaign = googleAppCampaignSubtypes.has(subtype);
    if ((mode === "app") !== appCampaign
        || (mode === "app" && channelType !== "MULTI_CHANNEL")
        || (mode === "ad_group" && !googleAdGroupCampaignTypes.has(channelType))
        || (mode === "campaign_only" && !googleCampaignOnlyTypes.has(channelType))) {
      throw new Error(`Google Ads cost row ${index} did not match the requested campaign subtype partition`);
    }
    const adGroupId = mode === "ad_group"
      ? googleInt64(row.adGroup?.id, `cost row ${index} adGroup.id`)
      : null;
    const currency = googleCurrency(row.customer?.currencyCode, `cost row ${index} customer.currencyCode`);
    if (currency !== expectedCurrency) {
      throw new Error(`Google Ads cost row ${index} account currency does not match --currency`);
    }
    const locationType = googleText(row.geographicView?.locationType, `cost row ${index} geographicView.locationType`);
    if (locationType !== "LOCATION_OF_PRESENCE") {
      throw new Error(`Google Ads cost row ${index} location type is not LOCATION_OF_PRESENCE`);
    }
    return {
      date,
      campaignId: googleInt64(row.campaign?.id, `cost row ${index} campaign.id`),
      adGroupId,
      countryCriterionId: googleInt64(
        row.geographicView?.countryCriterionId,
        `cost row ${index} geographicView.countryCriterionId`,
      ),
      costMicros: googleInt64(row.metrics?.costMicros, `cost row ${index} metrics.costMicros`, true),
      currency,
    };
  });
}

function googleCostInputs(
  scope: CostScope,
  rows: readonly GoogleCostRow[],
  countries: Readonly<Record<string, string>>,
): CostInput[] {
  return rows.map((row, index) => {
    const country = countries[row.countryCriterionId];
    if (country === undefined) throw new Error(`Google Ads cost row ${index} has an unmapped country criterion`);
    return {
      ...scope,
      network: "google-ads",
      campaign_id: row.campaignId,
      ad_group_id: row.adGroupId,
      country: googleCountry(country, `cost row ${index} country`),
      date: row.date,
      amount_unscaled: row.costMicros,
      amount_scale: 6,
      currency: row.currency,
      source: "imported_reported" as const,
    };
  });
}

export function normalizeGoogleAds(
  scope: CostScope,
  responseValue: unknown,
  countries: Readonly<Record<string, string>>,
  requestedRange: GoogleAdsRange,
  configuredLimits?: Partial<GoogleAdsLimits>,
): CostInput[] {
  const limits = googleLimits(configuredLimits);
  const currency = googleCurrency(scope.currency, "configured currency");
  const response = googleObject(responseValue, "normalized cost response");
  const appRows = googleCostRows(response.app, requestedRange, limits, "app", currency);
  const adGroupRemaining = limits.maxRows - appRows.length;
  const adGroupRows = googleCostRows(
    response.adGroup,
    requestedRange,
    { ...limits, maxRows: adGroupRemaining },
    "ad_group",
    currency,
  );
  const campaignOnlyRows = googleCostRows(
    response.campaignOnly,
    requestedRange,
    { ...limits, maxRows: adGroupRemaining - adGroupRows.length },
    "campaign_only",
    currency,
  );
  return prepareCostImportRows(googleCostInputs(
    scope,
    [...appRows, ...adGroupRows, ...campaignOnlyRows],
    countries,
  ));
}

async function boundedGoogleJson(
  response: Response,
  label: string,
  context: GoogleRequestContext,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  const remainingBytes = context.limits.maxResponseBytes - context.responseBytes;
  if (contentLength && /^[0-9]+$/.test(contentLength) && BigInt(contentLength) > BigInt(remainingBytes)) {
    throw new Error(`Google Ads ${label} response exceeded the byte limit`);
  }
  if (!response.body) throw new Error(`Google Ads ${label} response body is required`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error(`Google Ads ${label} response body could not be read`);
    }
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    context.responseBytes += chunk.value.byteLength;
    if (context.responseBytes > context.limits.maxResponseBytes) {
      try {
        await reader.cancel();
      } catch {
        // The bounded failure below remains authoritative even if stream cancellation fails.
      }
      throw new Error(`Google Ads ${label} response exceeded the byte limit`);
    }
    chunks.push(chunk.value);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch {
    throw new Error(`Google Ads ${label} response was not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Google Ads ${label} response was not valid JSON`);
  }
}

type GoogleRequestContext = {
  fetch: FetchLike;
  url: string;
  headers: Readonly<Record<string, string>>;
  limits: GoogleAdsLimits;
  requests: number;
  responseBytes: number;
};

async function googleSearchStream(context: GoogleRequestContext, query: string, label: string): Promise<unknown> {
  if (context.requests >= context.limits.maxRequests) throw new Error("Google Ads request limit exceeded");
  context.requests += 1;
  let response: Response;
  try {
    response = await context.fetch(context.url, {
      method: "POST",
      redirect: "error",
      headers: context.headers,
      body: JSON.stringify({ query }),
    });
  } catch {
    throw new Error(`Google Ads ${label} request failed`);
  }
  if (!response.ok) throw new Error(`Google Ads ${label} request failed with ${response.status}`);
  return boundedGoogleJson(response, label, context);
}

async function resolveGoogleCountries(
  context: GoogleRequestContext,
  countryCriterionIds: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  if (countryCriterionIds.length > context.limits.maxGeoCriteria) {
    throw new Error("Google Ads cost response exceeded the country-criterion limit");
  }
  const requiredRequests = Math.ceil(countryCriterionIds.length / context.limits.lookupChunkSize);
  if (context.requests + requiredRequests > context.limits.maxRequests) throw new Error("Google Ads request limit exceeded");
  const countries: Record<string, string> = {};
  for (let offset = 0; offset < countryCriterionIds.length; offset += context.limits.lookupChunkSize) {
    const chunk = countryCriterionIds.slice(offset, offset + context.limits.lookupChunkSize);
    const chunkExpected = new Set(chunk);
    const query = "SELECT geo_target_constant.id, geo_target_constant.country_code "
      + `FROM geo_target_constant WHERE geo_target_constant.id IN (${chunk.join(", ")}) `
      + `LIMIT ${chunk.length + 1}`;
    const response = await googleSearchStream(context, query, "geo lookup");
    const results = googleSearchStreamResults(response, "geo lookup", context.limits.maxBatches, chunk.length);
    for (const [index, row] of results.entries()) {
      const id = googleInt64(row.geoTargetConstant?.id, `geo lookup row ${index} geoTargetConstant.id`);
      if (!chunkExpected.has(id)) throw new Error(`Google Ads geo lookup row ${index} returned an unexpected criterion`);
      if (Object.hasOwn(countries, id)) throw new Error(`Google Ads geo lookup row ${index} returned an ambiguous criterion`);
      countries[id] = googleCountry(
        row.geoTargetConstant?.countryCode,
        `geo lookup row ${index} geoTargetConstant.countryCode`,
      );
    }
  }
  if (countryCriterionIds.some((id) => !Object.hasOwn(countries, id))) {
    throw new Error("Google Ads geo lookup did not resolve every country criterion");
  }
  return countries;
}

export async function fetchGoogleAds(options: {
  fetch: FetchLike;
  secrets: SecretStore;
  customerId: string;
  loginCustomerId?: string;
  apiVersion?: string;
  scope: CostScope;
  since: string;
  until: string;
  limits?: Partial<GoogleAdsLimits>;
}): Promise<CostInput[]> {
  const range = validateGoogleRange({ since: options.since, until: options.until });
  const customerId = googleCustomerId(options.customerId, "customerId");
  const loginCustomerId = options.loginCustomerId === undefined
    ? undefined
    : googleCustomerId(options.loginCustomerId, "loginCustomerId");
  const version = options.apiVersion ?? "v25";
  if (version !== "v25") throw new Error("Google Ads apiVersion must be v25 for this campaign partition");
  googleCurrency(options.scope.currency, "configured currency");
  const limits = googleLimits(options.limits);
  const token = options.secrets.require("OPENMASU_GOOGLE_ADS_ACCESS_TOKEN");
  const developerToken = options.secrets.require("OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN");
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "developer-token": developerToken,
    "content-type": "application/json",
  };
  if (loginCustomerId !== undefined) headers["login-customer-id"] = loginCustomerId;
  const context: GoogleRequestContext = {
    fetch: options.fetch,
    url: `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`,
    headers,
    limits,
    requests: 0,
    responseBytes: 0,
  };
  const appSubtypes = [...googleAppCampaignSubtypes].map((value) => `'${value}'`).join(", ");
  const adGroupCampaignTypes = [...googleAdGroupCampaignTypes].map((value) => `'${value}'`).join(", ");
  const sharedFields = "customer.currency_code, segments.date, campaign.id, campaign.advertising_channel_type, "
    + "campaign.advertising_channel_sub_type, ";
  const sharedTail = "geographic_view.country_criterion_id, geographic_view.location_type, metrics.cost_micros "
    + "FROM geographic_view "
    + "WHERE geographic_view.location_type = 'LOCATION_OF_PRESENCE' "
    + `AND segments.date BETWEEN '${range.since}' AND '${range.until}' `;
  const appQuery = `SELECT ${sharedFields}${sharedTail}`
    + `AND campaign.advertising_channel_sub_type IN (${appSubtypes}) `
    + `LIMIT ${limits.maxRows + 1}`;
  const appResponse = await googleSearchStream(context, appQuery, "App cost");
  const appRows = googleCostRows(appResponse, range, limits, "app", options.scope.currency);
  const adGroupRemainingRows = limits.maxRows - appRows.length;
  const adGroupQuery = `SELECT ${sharedFields}ad_group.id, ${sharedTail}`
    + `AND campaign.advertising_channel_type IN (${adGroupCampaignTypes}) `
    + `AND campaign.advertising_channel_sub_type NOT IN (${appSubtypes}) `
    + `LIMIT ${adGroupRemainingRows + 1}`;
  const adGroupResponse = await googleSearchStream(context, adGroupQuery, "ad-group cost");
  const adGroupRows = googleCostRows(
    adGroupResponse,
    range,
    { ...limits, maxRows: adGroupRemainingRows },
    "ad_group",
    options.scope.currency,
  );
  const campaignOnlyRemainingRows = adGroupRemainingRows - adGroupRows.length;
  const campaignOnlyQuery = `SELECT ${sharedFields}${sharedTail}`
    + `AND campaign.advertising_channel_type NOT IN (${adGroupCampaignTypes}) `
    + `AND campaign.advertising_channel_sub_type NOT IN (${appSubtypes}) `
    + `LIMIT ${campaignOnlyRemainingRows + 1}`;
  const campaignOnlyResponse = await googleSearchStream(context, campaignOnlyQuery, "campaign-only cost");
  const campaignOnlyRows = googleCostRows(
    campaignOnlyResponse,
    range,
    { ...limits, maxRows: campaignOnlyRemainingRows },
    "campaign_only",
    options.scope.currency,
  );
  const costRows = [...appRows, ...adGroupRows, ...campaignOnlyRows];
  const countryCriterionIds = [...new Set(costRows.map((row) => row.countryCriterionId))].sort();
  const countries = await resolveGoogleCountries(context, countryCriterionIds);
  return prepareCostImportRows(googleCostInputs(options.scope, costRows, countries));
}

