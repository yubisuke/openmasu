import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { EnvironmentSecretStore, type SecretEntry } from "./secrets.js";
import { normalizeGoogleCostDetail, type GoogleCostDetailSelection } from "./google-cost-detail.js";
export { normalizeGoogleCostDetail, type GoogleCostDetailSelection } from "./google-cost-detail.js";

export type GoogleCostRefreshDefinition = Readonly<{
  version: 1;
  provider: "google_ads";
  api_version: "v25";
  customer_id: string;
  login_customer_id?: string;
  currency: string;
  detail?: GoogleCostDetailSelection;
  lag_days: number;
  lookback_days: number;
  limits: Readonly<{
    maxRows: number; maxBatches: number; maxResponseBytes: number;
    maxGeoCriteria: number; lookupChunkSize: number; maxRequests: number;
  }>;
}>;

export type AppleCostRefreshDefinition = Readonly<{
  version: 1; provider: "apple_ads"; api_version: "v1";
  ad_account_id: string; app_store_id: string; campaign_ids: readonly string[];
  account_time_zone: string; reporting_time_zone: "UTC"; currency: string;
  lag_days: number; lookback_days: number;
  limits: Readonly<{ maxRows: number; maxPages: number; pageSize: number; maxResponseBytes: number }>;
}>;
export type CostRefreshDefinition = GoogleCostRefreshDefinition | AppleCostRefreshDefinition;

/** Reader-safe configured scope, not proof of provider completeness or account permission. */
export function costAdapterCapability(definition: CostRefreshDefinition) {
  const detail = definition.provider === "google_ads" ? definition.detail : undefined;
  return { version:1, provider:definition.provider, api_version:definition.api_version,
    grain:detail?.grain ?? (definition.provider === "apple_ads" ? "campaign" : "provider_partitioned"),
    coverage:detail?.coverage ?? "provider_partitioned", country_scope:detail?.country_scope ?? (definition.provider === "apple_ads" ? "all" : "location_of_presence"),
    creative_binding:detail?.grain === "ad" ? "operator_explicit" : "not_provided",
    selection_count:detail?.selections.length ?? null, upstream_completeness:"unknown" } as const;
}

const ceilings: GoogleCostRefreshDefinition["limits"] = {
  maxRows: 100_000, maxBatches: 1_000, maxResponseBytes: 32 * 1024 * 1024,
  maxGeoCriteria: 1_000, lookupChunkSize: 200, maxRequests: 8,
};
const appleCeilings: AppleCostRefreshDefinition["limits"] = {
  maxRows: 100_000, maxPages: 100, pageSize: 5_000, maxResponseBytes: 32 * 1024 * 1024,
};

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error("cost_schedule_limit_invalid");
  }
  return result;
}

export function normalizeCostRefreshDefinition(value: unknown): CostRefreshDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cost_schedule_definition_invalid");
  const body = value as Record<string, unknown>;
  if (body.provider === "apple_ads") return normalizeAppleDefinition(body);
  if (Object.keys(body).some((key) => ![
    "version", "provider", "api_version", "customer_id", "login_customer_id", "currency",
    "lag_days", "lookback_days", "limits", "detail",
  ].includes(key))) throw new Error("cost_schedule_field_forbidden");
  if ((body.version ?? 1) !== 1 || body.provider !== "google_ads" || (body.api_version ?? "v25") !== "v25") {
    throw new Error("cost_schedule_provider_invalid");
  }
  if (typeof body.customer_id !== "string" || !/^[0-9]{10}$/.test(body.customer_id)
    || (body.login_customer_id !== undefined && (typeof body.login_customer_id !== "string"
      || !/^[0-9]{10}$/.test(body.login_customer_id)))) throw new Error("cost_schedule_customer_invalid");
  if (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) throw new Error("cost_schedule_currency_invalid");
  const configured = body.limits ?? {};
  if (!configured || typeof configured !== "object" || Array.isArray(configured)
    || Object.keys(configured).some((key) => !Object.hasOwn(ceilings, key))) throw new Error("cost_schedule_limit_invalid");
  const limits = Object.fromEntries(Object.entries(ceilings).map(([key, maximum]) => [
    key, boundedInteger((configured as Record<string, unknown>)[key], maximum, maximum),
  ])) as GoogleCostRefreshDefinition["limits"];
  if (limits.maxRequests < 3) throw new Error("cost_schedule_limit_invalid");
  return {
    version: 1, provider: "google_ads", api_version: "v25", customer_id: body.customer_id,
    ...(body.login_customer_id === undefined ? {} : { login_customer_id: body.login_customer_id as string }),
    currency: body.currency, lag_days: boundedInteger(body.lag_days, 1, 31),
    lookback_days: boundedInteger(body.lookback_days, 7, 31), limits,
    ...(body.detail === undefined ? {} : { detail: normalizeGoogleCostDetail(body.detail) }),
  };
}

function normalizeAppleDefinition(body: Record<string, unknown>): AppleCostRefreshDefinition {
  if (Object.keys(body).some(key => !["version", "provider", "api_version", "ad_account_id", "app_store_id",
    "campaign_ids", "account_time_zone", "reporting_time_zone", "currency", "lag_days", "lookback_days", "limits"].includes(key))) {
    throw new Error("cost_schedule_field_forbidden");
  }
  if ((body.version ?? 1) !== 1 || (body.api_version ?? "v1") !== "v1"
    || (body.reporting_time_zone ?? "UTC") !== "UTC") throw new Error("cost_schedule_provider_invalid");
  const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,17}$/.exec(v)?.[0] === v;
  if (!id(body.ad_account_id) || !id(body.app_store_id) || !Array.isArray(body.campaign_ids)
    || body.campaign_ids.length < 1 || body.campaign_ids.length > 1_000 || body.campaign_ids.some(v => !id(v))
    || new Set(body.campaign_ids).size !== body.campaign_ids.length) throw new Error("cost_schedule_customer_invalid");
  if (typeof body.account_time_zone !== "string" || body.account_time_zone.length > 64
    || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(body.account_time_zone)) throw new Error("cost_schedule_timezone_invalid");
  try { new Intl.DateTimeFormat("en", { timeZone: body.account_time_zone }); }
  catch { throw new Error("cost_schedule_timezone_invalid"); }
  if (typeof body.currency !== "string" || /^[A-Z]{3}$/.exec(body.currency)?.[0] !== body.currency) throw new Error("cost_schedule_currency_invalid");
  const configured = body.limits ?? {};
  if (!configured || typeof configured !== "object" || Array.isArray(configured)
    || Object.keys(configured).some(key => !Object.hasOwn(appleCeilings, key))) throw new Error("cost_schedule_limit_invalid");
  const limits = Object.fromEntries(Object.entries(appleCeilings).map(([key, maximum]) => [key,
    boundedInteger((configured as Record<string, unknown>)[key], key === "pageSize" ? 100 : maximum, maximum),
  ])) as AppleCostRefreshDefinition["limits"];
  return { version: 1, provider: "apple_ads", api_version: "v1", ad_account_id: body.ad_account_id,
    app_store_id: body.app_store_id, campaign_ids: [...body.campaign_ids].sort(), account_time_zone: body.account_time_zone,
    reporting_time_zone: "UTC", currency: body.currency, lag_days: boundedInteger(body.lag_days, 1, 31),
    lookback_days: boundedInteger(body.lookback_days, 7, 31), limits };
}

export function costRefreshRange(now: Date, definition: CostRefreshDefinition): Readonly<{ since: string; until: string }> {
  if (!Number.isFinite(now.valueOf())) throw new Error("cost_schedule_time_invalid");
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const until = midnight - definition.lag_days * 86_400_000;
  return {
    since: new Date(until - (definition.lookback_days - 1) * 86_400_000).toISOString().slice(0, 10),
    until: new Date(until).toISOString().slice(0, 10),
  };
}

export type CostRefreshSecretKind = "access_token" | "developer_token" | "apple_ads_access_token"
  | "google_client_id" | "google_client_secret" | "google_refresh_token"
  | "apple_ads_client_id" | "apple_ads_team_id" | "apple_ads_key_id" | "apple_ads_private_key";

export function costRefreshSecretName(tenantId: string, appId: string, kind: CostRefreshSecretKind): string {
  const scope = createHash("sha256").update(JSON.stringify([tenantId, appId])).digest("hex");
  return `cost_refresh:${scope}:${kind}`;
}

// The registry is operator-owned, outside the public repository. Neither its
// path, entries nor names appear in API health projections or error messages.
export function loadCostRefreshSecrets(path: string): EnvironmentSecretStore {
  try {
    if (statSync(path).size > 1_048_576) throw new Error();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const entries: Record<string, SecretEntry> = {};
    for (const [name, entry] of Object.entries(value)) {
      if (!/^cost_refresh:[a-f0-9]{64}:(access_token|developer_token|apple_ads_access_token|google_client_id|google_client_secret|google_refresh_token|apple_ads_client_id|apple_ads_team_id|apple_ads_key_id|apple_ads_private_key)$/.test(name)
        || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      const fields = entry as Record<string, unknown>;
      if (Object.keys(fields).length !== 1 || !["value", "file"].includes(Object.keys(fields)[0])
        || Object.values(fields).some((item) => typeof item !== "string" || item.length < 1 || item.length > 16_384)) throw new Error();
      if (name.endsWith(":apple_ads_private_key") && typeof fields.file !== "string") throw new Error();
      entries[name] = fields as SecretEntry;
    }
    return new EnvironmentSecretStore(entries);
  } catch { throw new Error("cost_refresh_secret_registry_invalid"); }
}

export function costRefreshEnabled(value: string | undefined): boolean {
  if (value !== undefined && value !== "on" && value !== "off") throw new Error("cost_refresh_enabled_invalid");
  return value === "on";
}
