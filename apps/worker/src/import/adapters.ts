import type { SecretStore } from "@openmasu/runtime";
import { decimalToUnscaled, type CostInput } from "./cost.js";

type Any = Record<string, any>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type CostScope = {
  tenant_id: string;
  app_id: string;
  currency: string;
  as_of: string;
};

export function normalizeMetaInsights(scope: CostScope, response: Any): CostInput[] {
  return (response.data ?? []).map((row: Any) => ({
    ...scope,
    network: "meta",
    campaign_id: String(row.campaign_id),
    ad_group_id: row.adset_id ? String(row.adset_id) : null,
    country: row.country ? String(row.country).toUpperCase() : null,
    date: String(row.date_start),
    amount_unscaled: decimalToUnscaled(String(row.spend), 6),
    amount_scale: 6,
    currency: scope.currency.toUpperCase(),
    source: "imported_reported" as const,
  }));
}

export async function fetchMetaInsights(options: {
  fetch: FetchLike;
  secrets: SecretStore;
  accountId: string;
  apiVersion?: string;
  scope: CostScope;
}): Promise<CostInput[]> {
  const token = options.secrets.require("OPENMASU_META_ACCESS_TOKEN");
  const version = options.apiVersion ?? "v26.0";
  const fields = "campaign_id,adset_id,ad_id,spend,date_start,date_stop";
  const url = new URL(`https://graph.facebook.com/${version}/act_${options.accountId}/insights`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("level", "ad");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("breakdowns", "country");
  const response = await options.fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Meta Insights request failed with ${response.status}`);
  return normalizeMetaInsights(options.scope, await response.json());
}

export function normalizeGoogleAds(scope: CostScope, response: Any, countries: Readonly<Record<string, string>>): CostInput[] {
  return (response.results ?? response ?? []).map((row: Any) => {
    const countryId = String(row.geographicView?.countryCriterionId ?? row.country_criterion_id ?? "");
    const country = countries[countryId];
    if (!country) throw new Error(`Google Ads country criterion is unmapped: ${countryId}`);
    return {
      ...scope,
      network: "google-ads",
      campaign_id: String(row.campaign?.id ?? row.campaign_id),
      // R-22 Stage 3 normalization: App campaign rows intentionally have no ad-group dimension.
      ad_group_id: row.is_app_campaign ? null : String(row.adGroup?.id ?? row.ad_group_id ?? "") || null,
      country,
      date: String(row.segments?.date ?? row.date),
      amount_unscaled: String(row.metrics?.costMicros ?? row.cost_micros),
      amount_scale: 6,
      currency: scope.currency.toUpperCase(),
      source: "imported_reported" as const,
    };
  });
}

export async function fetchGoogleAds(options: {
  fetch: FetchLike;
  secrets: SecretStore;
  customerId: string;
  apiVersion?: string;
  scope: CostScope;
  countries: Readonly<Record<string, string>>;
}): Promise<CostInput[]> {
  const token = options.secrets.require("OPENMASU_GOOGLE_ADS_ACCESS_TOKEN");
  const developerToken = options.secrets.require("OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN");
  const version = options.apiVersion ?? "v25";
  const response = await options.fetch(
    `https://googleads.googleapis.com/${version}/customers/${options.customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "developer-token": developerToken, "content-type": "application/json" },
      body: JSON.stringify({ query: "SELECT segments.date, campaign.id, ad_group.id, geographic_view.country_criterion_id, metrics.cost_micros FROM geographic_view" }),
    },
  );
  if (!response.ok) throw new Error(`Google Ads SearchStream failed with ${response.status}`);
  const batches = await response.json() as Any[];
  return normalizeGoogleAds(options.scope, { results: batches.flatMap((batch) => batch.results ?? []) }, options.countries);
}

export function normalizeMaxBackfill(scope: CostScope, response: Any): CostInput[] {
  return (response.results ?? response.data ?? response ?? []).map((row: Any) => ({
    ...scope,
    network: String(row.network ?? "applovin-max"),
    campaign_id: String(row.ad_unit_id ?? "aggregate"),
    ad_group_id: null,
    country: row.country ? String(row.country).toUpperCase() : null,
    date: String(row.day),
    amount_unscaled: decimalToUnscaled(String(row.estimated_revenue), 6),
    amount_scale: 6,
    currency: "USD",
    source: "imported_reported" as const,
  }));
}

export async function fetchMaxReportingBackfill(options: {
  fetch: FetchLike;
  secrets: SecretStore;
  start: string;
  end: string;
  scope: CostScope;
}): Promise<CostInput[]> {
  const reportKey = options.secrets.require("OPENMASU_MAX_REPORT_KEY");
  const url = new URL("https://r.applovin.com/maxReport");
  url.searchParams.set("api_key", reportKey);
  url.searchParams.set("start", options.start);
  url.searchParams.set("end", options.end);
  url.searchParams.set("format", "json");
  url.searchParams.set("columns", "day,country,ad_unit_id,network,estimated_revenue");
  const response = await options.fetch(url);
  if (!response.ok) throw new Error(`MAX Reporting API failed with ${response.status}`);
  return normalizeMaxBackfill(options.scope, await response.json());
}
