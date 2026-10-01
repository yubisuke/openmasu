import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  createAppPool, createReaderPool, EncryptedFilePayloadStore, EnvironmentSecretStore,
  costRefreshSecretName, uuidV7, withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys, type AppAdminIdentity } from "../../api/src/admin-auth.js";
import { registerCostSchedule, listCostSchedules, disableCostSchedule } from "../../api/src/cost-schedules.js";
import { createRequestHandler } from "../../api/src/router.js";
import { processCostRefreshes } from "./cost-refresh-worker.js";
import { persistCostImportWithClient } from "./import/cost.js";
import type { FetchLike } from "./import/adapters.js";

const pool = createAppPool();
const reader = createReaderPool();
const request = { provider: "google_ads", customer_id: "4300000000", currency: "USD", lookback_days: 7 };
const now = new Date("2026-08-22T00:00:00.000Z");
let identity: AppAdminIdentity;
let counter = 0;
const scope = () => ({ tenant_id: identity.tenantId, app_id: identity.appId });
const secrets = () => new EnvironmentSecretStore({
  [costRefreshSecretName(identity.tenantId, identity.appId, "access_token")]: { value: "synthetic-access-token" },
  [costRefreshSecretName(identity.tenantId, identity.appId, "developer_token")]: { value: "synthetic-developer-token" },
});
const options = (fetcher: FetchLike, clock = now) => ({ enabled: true, secrets: secrets(), fetch: fetcher, now: clock, maximumSchedules: 1 });
async function register(body: unknown = request) { return registerCostSchedule(pool, identity, body, now); }
async function counts() {
  return withTenant(pool, identity.tenantId, async (client) => (await client.query(
    `SELECT (SELECT count(*)::int FROM ledger.cost_records WHERE tenant_id=$1 AND app_id=$2) AS costs,
      (SELECT count(*)::int FROM control.import_runs WHERE tenant_id=$1 AND app_id=$2) AS runs`,
    [identity.tenantId, identity.appId],
  )).rows[0]);
}
async function due(id: string, expire = false) {
  await withTenant(pool, identity.tenantId, (client) => client.query(
    `UPDATE control.cost_schedule_checkpoints SET next_run_at=clock_timestamp()-interval '1 second',
       next_attempt_at=clock_timestamp()-interval '1 second'
       ${expire ? ",lease_expires_at=clock_timestamp()-interval '1 second'" : ""}
     WHERE tenant_id=$1 AND cost_schedule_id=$2`, [identity.tenantId, id],
  ).then(() => undefined));
}
function source(amount = "2500000", config: { empty?: boolean; partialFailure?: boolean; rows?: number } = {}) {
  const queries: string[] = [];
  const fetcher: FetchLike = async (_input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    queries.push(query);
    if (config.partialFailure && query.includes("campaign.advertising_channel_type IN")) return new Response("synthetic-private-detail", { status: 503 });
    const rows = config.empty ? [] : Array.from({ length: config.rows ?? 1 }, (_, index) => ({
      customer: { currencyCode: "USD" },
      campaign: { id: String(4300000000000001 + index), advertisingChannelType: "MULTI_CHANNEL", advertisingChannelSubType: "APP_CAMPAIGN" },
      geographicView: { countryCriterionId: "2840", locationType: "LOCATION_OF_PRESENCE" },
      segments: { date: "2026-08-20" }, metrics: { costMicros: amount },
    }));
    return new Response(JSON.stringify([{ results: query.includes("FROM geo_target_constant")
      ? [{ geoTargetConstant: { id: "2840", countryCode: "US" } }]
      : query.includes("advertising_channel_sub_type IN") ? rows : [] }]));
  };
  return { fetcher, queries };
}

describe("durable bounded cost refresh", { concurrency: false }, () => {
  beforeEach(async () => {
    identity = { tenantId: `tenant-cost-refresh-${uuidV7().slice(-12)}-${++counter}`, appId: "app-cost-refresh", keyId: "synthetic-cost-admin", role: "admin" };
    await withTenant(pool, identity.tenantId, (client) => client.query(
      "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)",
      [identity.tenantId, identity.appId, now.toISOString()],
    ).then(() => undefined));
  });
  after(async () => { await Promise.all([pool.end(), reader.end()]); });

  it("publishes only a complete partitioned lookback and makes replay a no-op", async () => {
    await register();
    const mock = source();
    assert.deepEqual(await processCostRefreshes(pool, identity.tenantId, options(mock.fetcher)), { completed: 1, empty: 0, failed: 0, fenced: 0 });
    assert.equal(mock.queries.length, 4);
    assert.match(mock.queries[0], /BETWEEN '2026-08-15' AND '2026-08-21'/);
    assert.deepEqual(await counts(), { costs: 1, runs: 1 });
    assert.equal((await listCostSchedules(reader, identity))[0].last_outcome, "complete");
    await processCostRefreshes(pool, identity.tenantId, options(() => { throw new Error("replay must not fetch"); }));
    assert.deepEqual(await counts(), { costs: 1, runs: 1 });
  });
  it("keeps incomplete acquisition unpublished and resumes its fixed range and as-of", async () => {
    const schedule = await register();
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(source("1", { partialFailure: true }).fetcher))).failed, 1);
    assert.deepEqual(await counts(), { costs: 0, runs: 0 });
    const pending = await listCostSchedules(reader, identity);
    assert.equal(pending[0].state, "retry");
    await due(schedule.cost_schedule_id);
    const mock = source();
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(mock.fetcher, new Date("2026-08-25T00:00:00.000Z")))).completed, 1);
    assert.match(mock.queries[0], /BETWEEN '2026-08-15' AND '2026-08-21'/);
    const history = await withTenant(pool, identity.tenantId, (client) => client.query(
      "SELECT as_of FROM ledger.cost_records WHERE tenant_id=$1", [identity.tenantId],
    ));
    assert.equal(history.rows[0].as_of, now.toISOString());
  });
  it("preserves old and corrected cost provenance and does not turn empty into zero", async () => {
    const schedule = await register();
    await processCostRefreshes(pool, identity.tenantId, options(source().fetcher));
    await due(schedule.cost_schedule_id);
    await processCostRefreshes(pool, identity.tenantId, options(source("5000000").fetcher, new Date("2026-08-23T00:00:00.000Z")));
    const history = await withTenant(pool, identity.tenantId, (client) => client.query(
      "SELECT spend_unscaled::text FROM ledger.cost_records WHERE tenant_id=$1 ORDER BY as_of", [identity.tenantId],
    ));
    assert.deepEqual(history.rows.map((row) => row.spend_unscaled), ["2500000", "5000000"]);
    assert.deepEqual(await counts(), { costs: 2, runs: 2 });
    await due(schedule.cost_schedule_id);
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(source("0", { empty: true }).fetcher, new Date("2026-08-24T00:00:00.000Z")))).empty, 1);
    assert.deepEqual(await counts(), { costs: 2, runs: 2 });
    assert.equal((await listCostSchedules(reader, identity))[0].last_outcome, "empty");
    const current = await withTenant(pool, identity.tenantId, (client) => client.query(
      "SELECT spend_unscaled::text FROM ledger.cost_records_current WHERE tenant_id=$1", [identity.tenantId],
    ));
    assert.equal(current.rows[0].spend_unscaled, "5000000");
  });
  it("excludes concurrent workers and rejects a late result after expired-claim recovery", async () => {
    const schedule = await register();
    const capturedIdentity = identity;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = source();
    let first = true;
    const old = processCostRefreshes(pool, identity.tenantId, options(async (input, init) => {
      if (first) { first = false; started(); await blocked; }
      return original.fetcher(input, init);
    }));
    await entered;
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(() => { throw new Error("active lease must exclude fetch"); }))).completed, 0);
    await due(schedule.cost_schedule_id, true);
    assert.equal((await processCostRefreshes(pool, capturedIdentity.tenantId, options(source("3000000").fetcher))).completed, 1);
    release();
    assert.equal((await old).fenced, 1);
    assert.deepEqual(await counts(), { costs: 1, runs: 1 });
  });
  it("fences publication after an operator stops a claimed schedule", async () => {
    const schedule = await register();
    let stopped = false;
    const mock = source();
    const result = await processCostRefreshes(pool, identity.tenantId, options(async (input, init) => {
      if (!stopped) { stopped = true; await disableCostSchedule(pool, identity, schedule.cost_schedule_id); }
      return mock.fetcher(input, init);
    }));
    assert.equal(result.fenced, 1);
    assert.deepEqual(await counts(), { costs: 0, runs: 0 });
    assert.equal((await listCostSchedules(reader, identity))[0].state, "stopped");
  });
  it("bounds retry exhaustion and acquisition limits without leaking provider detail", async () => {
    const schedule = await register();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await due(schedule.cost_schedule_id);
      assert.equal((await processCostRefreshes(pool, identity.tenantId, options(async () => new Response("private-detail", { status: 503 })))).failed, 1);
    }
    const health = (await listCostSchedules(reader, identity))[0];
    assert.equal(health.state, "failed");
    assert.equal(health.safe_reason, "retry_exhausted");
    assert.equal(health.attempts, 3);
    assert.equal(JSON.stringify(health).includes("private-detail"), false);
    await disableCostSchedule(pool, identity, schedule.cost_schedule_id);
    await register({ ...request, limits: { maxRows: 1 } });
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(source("1", { rows: 2 }).fetcher))).failed, 1);
    assert.deepEqual(await counts(), { costs: 0, runs: 0 });
    assert.equal((await listCostSchedules(reader, identity)).find((row) => row.status === "active")?.safe_reason, "source_invalid");
  });
  it("times out a source that ignores cancellation and leaves no partial import", async () => {
    await register();
    const result = await processCostRefreshes(pool, identity.tenantId, {
      ...options(async () => new Promise<Response>(() => undefined)), timeoutMs: 10,
    });
    assert.equal(result.failed, 1);
    assert.equal((await listCostSchedules(reader, identity))[0].safe_reason, "acquisition_timeout");
    assert.deepEqual(await counts(), { costs: 0, runs: 0 });
  });
  it("rolls back costs and the import completion record in one transaction", async () => {
    await assert.rejects(withTenant(pool, identity.tenantId, async (client) => {
      await persistCostImportWithClient(client, "synthetic-atomic-cost", [{
        ...scope(), network: "synthetic-network", date: "2026-08-20", amount_unscaled: "1", amount_scale: 6,
        currency: "USD", source: "imported_reported", as_of: now.toISOString(),
      }]);
      throw new Error("synthetic fault before checkpoint commit");
    }), /synthetic fault/);
    assert.deepEqual(await counts(), { costs: 0, runs: 0 });
  });
  it("keeps the health API reader-only and excludes private definition and cross-tenant scope", async () => {
    const key = "synthetic-cost-admin-key-at-least-thirty-two-bytes";
    const root = mkdtempSync(join(tmpdir(), "openmasu-cost-api-"));
    await ensureAdminKeys(pool, { tenantId: identity.tenantId, appId: identity.appId }, [key]);
    const server = createServer(createRequestHandler({
      pool, readerPool: reader, payloadStore: new EncryptedFilePayloadStore(root, "synthetic-cost-master-key-at-least-thirty-two-bytes"),
      maxConfig: { tenantId: identity.tenantId, appId: identity.appId, pathSecret: "synthetic-path", eventKey: "synthetic-event", tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId: identity.tenantId, sessionTtlSeconds: 43_200 },
    }));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/apps`;
    try {
      const registered = await fetch(`${base}/${identity.appId}/cost-schedules`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(request),
      });
      assert.equal(registered.status, 201);
      const schedule = await registered.json() as { cost_schedule_id: string };
      const response = await fetch(`${base}/${identity.appId}/cost-schedules`, { headers: { authorization: `Bearer ${key}` } });
      assert.equal(response.status, 200);
      const body = await response.text();
      for (const forbidden of [request.customer_id, "customer_id", "definition\"", "access_token", "developer_token", "secret", "lease_token"]) assert.equal(body.includes(forbidden), false);
      await assert.rejects(withTenant(reader, identity.tenantId, (client) => client.query("SELECT definition FROM control.cost_schedules")), /permission denied/);
      assert.deepEqual(await listCostSchedules(reader, { ...identity, tenantId: "tenant-cost-unrelated" }), []);
      const stopped = await fetch(`${base}/${identity.appId}/cost-schedules/${encodeURIComponent(schedule.cost_schedule_id)}/disable`, {
        method: "POST", headers: { authorization: `Bearer ${key}` },
      });
      assert.equal(stopped.status, 200);
      const unknown = await fetch(`${base}/app-cost-unrelated/cost-schedules`, { headers: { authorization: `Bearer ${key}` } });
      assert.equal(unknown.status, 404);
    } finally { server.close(); await once(server, "close"); rmSync(root, { recursive: true, force: true }); }
  });
});
