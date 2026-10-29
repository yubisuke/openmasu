import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  costRefreshEnabled, costRefreshRange, costRefreshSecretName,
  loadCostRefreshSecrets, normalizeCostRefreshDefinition,
} from "./cost-refresh.js";
import { costBackfillDates, costBackfillAsOf, costBackfillReceipt, normalizeCostBackfillRequest } from "./cost-backfill.js";

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
      const appleCredentials = ["apple_ads_client_id", "apple_ads_team_id", "apple_ads_key_id"] as const;
      const privateKey = costRefreshSecretName("tenant-synthetic", "app-synthetic", "apple_ads_private_key");
      const keyFile = join(directory, "synthetic-key.pem"); writeFileSync(keyFile, "synthetic-file-only-value");
      writeFileSync(registry, JSON.stringify({ [name]: { value: "synthetic-token" }, [apple]: { value: "synthetic-apple-token" },
        [privateKey]: { file: keyFile },
        ...Object.fromEntries([...google, ...appleCredentials].map(kind => [costRefreshSecretName("tenant-synthetic", "app-synthetic", kind), { value: `synthetic-${kind}` }])) }));
      assert.equal(loadCostRefreshSecrets(registry).require(name), "synthetic-token");
      assert.equal(loadCostRefreshSecrets(registry).require(apple), "synthetic-apple-token");
      for (const kind of [...google, ...appleCredentials]) assert.equal(loadCostRefreshSecrets(registry).require(costRefreshSecretName("tenant-synthetic", "app-synthetic", kind)), `synthetic-${kind}`);
      assert.equal(loadCostRefreshSecrets(registry).require(privateKey), "synthetic-file-only-value");
      writeFileSync(registry, JSON.stringify({ [privateKey]: { value: "synthetic-private-must-be-a-file-reference" } }));
      assert.throws(() => loadCostRefreshSecrets(registry), { message: "cost_refresh_secret_registry_invalid" });
      writeFileSync(registry, JSON.stringify({ "private-must-not-leak": { value: "secret", file: "private-path" } }));
      assert.throws(() => loadCostRefreshSecrets(registry), { message: "cost_refresh_secret_registry_invalid" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("bounds selected backfill dates and rejects invented fields without echoing their values", () => {
    const selection = { cost_schedule_id: "cost-schedule:synthetic", dates: ["2026-08-21", "2026-08-19"] };
    assert.deepEqual(normalizeCostBackfillRequest(selection).dates, ["2026-08-19", "2026-08-21"]);
    assert.equal(costBackfillDates("2026-08-01", "2026-08-31").length, 31);
    for (const value of [[], ["2026-08-19", "2026-08-19"], ["2026-02-30"], ["2026-08-01", "2026-09-01"]]) {
      assert.throws(() => normalizeCostBackfillRequest({ ...selection, dates: value }), /^Error: cost_backfill_/);
    }
    assert.throws(() => normalizeCostBackfillRequest({ ...selection, account: "synthetic-private-account" }), { message: "cost_backfill_request_invalid" });
    assert.throws(() => normalizeCostBackfillRequest({ ...selection, retry_of: "invalid" }), { message: "cost_backfill_request_invalid" });
    assert.throws(() => costBackfillDates("2026-08-02", "2026-08-01"), { message: "cost_backfill_dates_invalid" });
  });
  it("binds backfill receipts to scope, dates, limits and observed states at a canonical fixed as-of", () => {
    const clock = new Date("2026-08-22T00:00:00.000Z");
    assert.equal(costBackfillAsOf(clock.toISOString(), clock), clock.toISOString());
    for (const value of ["2026-08-22", "2026-08-22T00:00:00Z", "2026-08-23T00:00:00.000Z"]) {
      assert.throws(() => costBackfillAsOf(value, clock), { message: "cost_backfill_as_of_invalid" });
    }
    const plan = { cost_schedule_id: "cost-schedule:synthetic", dates: ["2026-08-20"], definition_digest: "a".repeat(64),
      as_of: clock.toISOString(), configuration: { provider: "google_ads" as const, api_version: "v25", currency: "USD", lag_days: 1, limits: { maxRows: 10 } },
      days: [{ date: "2026-08-20", state: "not_recorded", eligible: true, row_count: null, import_run_id: null, safe_reason: null, history_ref: null }] };
    const scope = { tenantId: "tenant-synthetic", appId: "app-synthetic" }, hash = costBackfillReceipt(scope, plan);
    assert.equal(costBackfillReceipt(scope, JSON.parse(JSON.stringify(plan))), hash);
    const otherOperator = { ...scope, keyId: "synthetic-other-admin" };
    assert.equal(costBackfillReceipt(otherOperator, plan), hash, "the receipt is app-scoped, not tied to one operator key");
    assert.notEqual(costBackfillReceipt({ ...scope, appId: "other-app" }, plan), hash);
    assert.notEqual(costBackfillReceipt(scope, { ...plan, configuration: { ...plan.configuration, limits: { maxRows: 11 } } }), hash);
    assert.notEqual(costBackfillReceipt(scope, { ...plan, days: [{ ...plan.days[0], state: "queued", eligible: false }] }), hash);
  });
});
