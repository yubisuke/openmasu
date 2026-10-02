import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { EnvironmentSecretStore, type SecretEntry } from "./secrets.js";

export type CostRefreshDefinition = Readonly<{
  version: 1;
  provider: "google_ads";
  api_version: "v25";
  customer_id: string;
  login_customer_id?: string;
  currency: string;
  lag_days: number;
  lookback_days: number;
  limits: Readonly<{
    maxRows: number; maxBatches: number; maxResponseBytes: number;
    maxGeoCriteria: number; lookupChunkSize: number; maxRequests: number;
  }>;
}>;

const ceilings: CostRefreshDefinition["limits"] = {
  maxRows: 100_000, maxBatches: 1_000, maxResponseBytes: 32 * 1024 * 1024,
  maxGeoCriteria: 1_000, lookupChunkSize: 200, maxRequests: 8,
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
  if (Object.keys(body).some((key) => ![
    "version", "provider", "api_version", "customer_id", "login_customer_id", "currency",
    "lag_days", "lookback_days", "limits",
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
  ])) as CostRefreshDefinition["limits"];
  if (limits.maxRequests < 3) throw new Error("cost_schedule_limit_invalid");
  return {
    version: 1, provider: "google_ads", api_version: "v25", customer_id: body.customer_id,
    ...(body.login_customer_id === undefined ? {} : { login_customer_id: body.login_customer_id as string }),
    currency: body.currency, lag_days: boundedInteger(body.lag_days, 1, 31),
    lookback_days: boundedInteger(body.lookback_days, 7, 31), limits,
  };
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

export function costRefreshSecretName(tenantId: string, appId: string, kind: "access_token" | "developer_token"): string {
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
      if (!/^cost_refresh:[a-f0-9]{64}:(access_token|developer_token)$/.test(name)
        || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      const fields = entry as Record<string, unknown>;
      if (Object.keys(fields).length !== 1 || !["value", "file"].includes(Object.keys(fields)[0])
        || Object.values(fields).some((item) => typeof item !== "string" || item.length < 1 || item.length > 16_384)) throw new Error();
      entries[name] = fields as SecretEntry;
    }
    return new EnvironmentSecretStore(entries);
  } catch { throw new Error("cost_refresh_secret_registry_invalid"); }
}

export function costRefreshEnabled(value: string | undefined): boolean {
  if (value !== undefined && value !== "on" && value !== "off") throw new Error("cost_refresh_enabled_invalid");
  return value === "on";
}
