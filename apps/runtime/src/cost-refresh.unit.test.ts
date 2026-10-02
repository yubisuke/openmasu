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
    assert.deepEqual(normalizeCostRefreshDefinition(definition), definition);
    assert.deepEqual(costRefreshRange(new Date("2026-09-01T23:59:59.000Z"), definition), {
      since: "2026-08-25", until: "2026-08-31",
    });
    assert.equal(definition.api_version, "v25");
    assert.equal(definition.limits.maxRequests, 8);
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
      writeFileSync(registry, JSON.stringify({ [name]: { value: "synthetic-token" } }));
      assert.equal(loadCostRefreshSecrets(registry).require(name), "synthetic-token");
      writeFileSync(registry, JSON.stringify({ "private-must-not-leak": { value: "secret", file: "private-path" } }));
      assert.throws(() => loadCostRefreshSecrets(registry), { message: "cost_refresh_secret_registry_invalid" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
