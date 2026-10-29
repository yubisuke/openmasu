import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  costRefreshEnabled, costRefreshRange, costRefreshSecretName,
  loadCostRefreshSecrets, normalizeCostRefreshDefinition,
} from "./cost-refresh.js";

const request = { provider: "google_ads", customer_id: "4300000000", currency: "USD" };
describe("bounded cost refresh configuration", () => {
  it("fixes a UTC lagged inclusive lookback and preserves a normalized revision", () => {
    const definition = normalizeCostRefreshDefinition(request);
    assert.equal(definition.provider, "google_ads");
    if (definition.provider !== "google_ads") throw new Error("unexpected provider");
    assert.deepEqual(normalizeCostRefreshDefinition(definition), definition);
    assert.deepEqual(costRefreshRange(new Date("2026-09-01T23:59:59.000Z"), definition), {
      since: "2026-08-25", until: "2026-08-31",
    });
    assert.equal(definition.api_version, "v25");
    assert.equal(definition.limits.maxRequests, 8);
  });
  it("keeps Apple account declarations separate from UTC report days and provider secrets", () => {
    const request = { provider: "apple_ads", ad_account_id: "23501", app_store_id: "23502",
      campaign_ids: ["23504", "23503"], currency: "USD", account_time_zone: "America/New_York" };
    const definition = normalizeCostRefreshDefinition(request);
    assert.equal(definition.provider, "apple_ads");
    if (definition.provider !== "apple_ads") throw new Error("unexpected provider");
    assert.equal(definition.reporting_time_zone, "UTC");
    assert.equal(definition.account_time_zone, "America/New_York");
    assert.deepEqual(definition.campaign_ids, ["23503", "23504"]);
    assert.deepEqual(normalizeCostRefreshDefinition(definition), definition);
    for (const value of [{ ...request, campaign_ids: [] }, { ...request, campaign_ids: ["1", "1"] },
      { ...request, reporting_time_zone: "ORTZ" }, { ...request, account_time_zone: "unknown" },
      { ...request, api_version: "v5" }, { ...request, access_token: "synthetic-token" },
      { ...request, limits: { pageSize: 5001 } }, { ...request, limits: { maxRequests: 1 } }]) {
      assert.throws(() => normalizeCostRefreshDefinition(value), /^Error: cost_schedule_/);
    }
    assert.notEqual(costRefreshSecretName("tenant", "app", "apple_ads_access_token"), costRefreshSecretName("tenant", "app", "access_token"));
  });
  it("rejects unknown providers, fields, credentials and unbounded acquisition", () => {
    for (const body of [
      { ...request, provider: "another" }, { ...request, api_version: "v26" },
      { ...request, access_token: "synthetic-private" }, { ...request, lookback_days: 32 },
      { ...request, lag_days: 0 }, { ...request, limits: { maxRows: 100_001 } },
      { ...request, limits: { maxRequests: 2 } }, { ...request, limits: { extra: 1 } },
    ]) assert.throws(() => normalizeCostRefreshDefinition(body), /^Error: cost_schedule_/);
  });
  it("is default-off and derives unambiguous app-scoped secret names", () => {
    assert.equal(costRefreshEnabled(undefined), false);
    assert.equal(costRefreshEnabled("off"), false);
    assert.equal(costRefreshEnabled("on"), true);
    assert.throws(() => costRefreshEnabled("yes"));
    assert.notEqual(costRefreshSecretName("a:b", "c", "access_token"), costRefreshSecretName("a", "b:c", "access_token"));
    assert.notEqual(costRefreshSecretName("a", "b", "access_token"), costRefreshSecretName("a", "c", "access_token"));
  });
  it("loads only explicit SecretStore entries and returns value-free registry errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-cost-secrets-"));
    try {
      const registry = join(directory, "registry.json");
      const name = costRefreshSecretName("tenant-synthetic", "app-synthetic", "access_token");
      const apple = costRefreshSecretName("tenant-synthetic", "app-synthetic", "apple_ads_access_token");
      const google = ["google_client_id", "google_client_secret", "google_refresh_token"] as const;
      writeFileSync(registry, JSON.stringify({ [name]: { value: "synthetic-token" }, [apple]: { value: "synthetic-apple-token" },
        ...Object.fromEntries(google.map(kind => [costRefreshSecretName("tenant-synthetic", "app-synthetic", kind), { value: `synthetic-${kind}` }])) }));
      assert.equal(loadCostRefreshSecrets(registry).require(name), "synthetic-token");
      assert.equal(loadCostRefreshSecrets(registry).require(apple), "synthetic-apple-token");
      for (const kind of google) assert.equal(loadCostRefreshSecrets(registry).require(costRefreshSecretName("tenant-synthetic", "app-synthetic", kind)), `synthetic-${kind}`);
      writeFileSync(registry, JSON.stringify({ "private-must-not-leak": { value: "secret", file: "private-path" } }));
      assert.throws(() => loadCostRefreshSecrets(registry), { message: "cost_refresh_secret_registry_invalid" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
