import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  createAppPool, createReaderPool, createSeedPool, EncryptedFilePayloadStore, EnvironmentSecretStore,
  costRefreshSecretName, uuidV7, withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys, type AppAdminIdentity } from "../../api/src/admin-auth.js";
import { registerCostSchedule, listCostSchedules, disableCostSchedule } from "../../api/src/cost-schedules.js";
import { createRequestHandler } from "../../api/src/router.js";
import { processCostRefreshes } from "./cost-refresh-worker.js";
import { persistCostImportWithClient } from "./import/cost.js";
import type { FetchLike } from "./import/adapters.js";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { requestMetricRecalculation } from "../../api/src/metric-recalculations.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { metricReport } from "../../api/src/reporting.js";
import { jcs } from "@openmasu/attribution-core/canonical";

const pool = createAppPool();
const reader = createReaderPool();
const seed = createSeedPool();
const request = { provider: "google_ads", customer_id: "4300000000", currency: "USD", lookback_days: 7 };
const now = new Date("2026-08-22T00:00:00.000Z");
let identity: AppAdminIdentity;
let counter = 0;
const scope = () => ({ tenant_id: identity.tenantId, app_id: identity.appId });
const secrets = () => new EnvironmentSecretStore({
  [costRefreshSecretName(identity.tenantId, identity.appId, "access_token")]: { value: "synthetic-access-token" },
  [costRefreshSecretName(identity.tenantId, identity.appId, "developer_token")]: { value: "synthetic-developer-token" },
  [costRefreshSecretName(identity.tenantId, identity.appId, "apple_ads_access_token")]: { value: "synthetic-apple-token" },
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

const appleRequest = { provider: "apple_ads", ad_account_id: "23501", app_store_id: "23502", campaign_ids: ["23503", "23504"],
  currency: "USD", account_time_zone: "America/New_York", lookback_days: 7, limits: { pageSize: 1 } };
function appleSource(amount = "2.50", config: { failure?: number; duplicate?: boolean; empty?: boolean } = {}) {
  const requests: any[] = [];
  const fetcher: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer synthetic-apple-token");
    const offset = request.pagination.offset;
    if (config.empty) return Response.json({ result: {} });
    if (offset && config.failure) return new Response("synthetic-private-provider-detail", { status: config.failure });
    const dates: string[] = [];
    for (let time = Date.parse(request.timeRange.start); time <= Date.parse(request.timeRange.end); time += 86_400_000) dates.push(new Date(time).toISOString().slice(0, 10));
    return Response.json({ result: { rows: [{ metadata: { id: config.duplicate ? 23503 : 23503 + offset,
      adAccountId: 23501, promotedObjectId: "23502", promotedObjectType: "APPSTORE_APP" },
      granularMetrics: dates.map(date => ({ date, localSpend: { amount, currency: "USD" } })) }] },
      pagination: { offset, pageSize: 1, totalCount: 2 } });
  };
  return { fetcher, requests };
}

describe("durable bounded cost refresh", { concurrency: false }, () => {
  beforeEach(async () => {
    identity = { tenantId: `tenant-cost-refresh-${uuidV7().slice(-12)}-${++counter}`, appId: "app-cost-refresh", keyId: "synthetic-cost-admin", role: "admin" };
    await withTenant(pool, identity.tenantId, (client) => client.query(
      "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)",
      [identity.tenantId, identity.appId, now.toISOString()],
    ).then(() => undefined));
  });
  after(async () => { await Promise.all([pool.end(), reader.end(), seed.end()]); });

  it("selected_detail_refresh_reaches_saved_ROAS_revisions_and_reader_capability_without_parent_allocation_or_partial_publication", async () => {
    const input=JSON.parse(readFileSync("fixtures/v0.4/63-selected-acquisition-detail/input.json","utf8")
      .replaceAll('"tenant-a"',JSON.stringify(identity.tenantId)).replaceAll('"app-a"',JSON.stringify(identity.appId)));
    for(const record of input.records) {
      const p=record.payload;
      if(p.campaign_id==="campaign-a")p.campaign_id="43601";
      if(p.network==="synthetic-network")p.network="google-ads";
      if(p.ad_group_id==="synthetic-group-a")p.ad_group_id="43602";
      if(p.ad_group_id==="synthetic-group-b")p.ad_group_id="43604";
    }
    for(const evaluation of input.metric_evaluations) Object.assign(evaluation.grouping,{ campaign_id:"43601",network:"google-ads",
      ...(evaluation.grouping.ad_group_id?{ad_group_id:evaluation.grouping.ad_group_id==="synthetic-group-a"?"43602":"43604"}:{}) });
    input.cost_records=[];
    await ingestFixture("synthetic-provider-detail",{...input,metric_evaluations:[]},pool,seed);
    const detail={version:1,grain:"ad",country_scope:"all",coverage:"explicit_selection",selections:[
      {campaign_id:"43601",ad_group_id:"43602",provider_ad_id:"43603",creative_id:"synthetic-creative-a"}]};
    const first=await register({...request,detail});
    const mock=(amount:string,partial=false):FetchLike=>async(_url,init)=>{
      assert.match(JSON.parse(String(init?.body)).query,/FROM ad_group_ad/);
      return Response.json([{results:[{customer:{currencyCode:"USD"},campaign:{id:"43601"},adGroup:{id:"43602"},adGroupAd:{ad:{id:"43603"}},
        segments:{date:"2026-08-06"},metrics:{costMicros:amount}}]},...(partial?[{error:{message:"synthetic unread tail"}}]:[])]);
    };
    assert.equal((await processCostRefreshes(pool,identity.tenantId,options(mock("10000000"),new Date("2026-08-12T00:00:00.000Z")))).completed,1);
    const initial=await computeSqlMetricRuns(pool,input,true);
    const values=(runs:any[],prefix:string)=>["d7_roas","d30_total_net_roas"].map(name=>{const r=runs.find(row=>row.metric_run_id===`${prefix}:${name}`)!;return r.value_unscaled??r.undefined_reason;});
    assert.deepEqual(values(initial,"detail63-a"),["2000000","2600000"]);
    assert.deepEqual(values(initial,"detail63-b"),["no_attributed_cost","no_attributed_cost"]);
    assert.deepEqual(values(initial,"detail63-campaign"),["no_attributed_cost","no_attributed_cost"]);
    const health=(await listCostSchedules(reader,identity))[0];
    assert.equal(health.adapter_capability.grain,"ad"); assert.equal(health.adapter_capability.coverage,"explicit_selection");
    for(const forbidden of ["43601","43602","43603",request.customer_id,"selections","access_token"]) assert.equal(JSON.stringify(health).includes(forbidden),false);
    const before=await counts();
    await due(first.cost_schedule_id);
    assert.equal((await processCostRefreshes(pool,identity.tenantId,options(mock("20000000",true),new Date("2026-08-13T00:00:00.000Z")))).failed,1);
    assert.deepEqual(await counts(),before,"an incomplete stream cannot publish its valid prefix");
    await disableCostSchedule(pool,identity,first.cost_schedule_id);
    await register({...request,detail});
    assert.equal((await processCostRefreshes(pool,identity.tenantId,options(mock("15000000"),new Date("2026-08-13T00:00:00.000Z")))).completed,1);
    const revision=await withTenant(reader,identity.tenantId,async c=>(await c.query("SELECT import_run_id FROM control.import_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY started_at DESC LIMIT 1",[identity.tenantId,identity.appId])).rows[0]);
    const requested=await requestMetricRecalculation(pool,identity,{date_from:"2026-08-06",date_to:"2026-08-06",metric_names:["d7_roas","d30_total_net_roas"],cost_import_run_id:revision.import_run_id,watermark:"2026-08-13T00:00:00.000Z"});
    assert.equal(requested.selected_runs,4);
    assert.equal((await processMetricRecalculations(pool,identity.tenantId)).completed,4);
    const latest=(await metricReport(reader,identity,{...identity,supersession:"latest",limit:200,metricNames:["d7_roas","d30_total_net_roas"]})).data;
    const selected=latest.filter(r=>r.grouping?.creative_id==="synthetic-creative-a");
    assert.deepEqual(selected.map(r=>[r.metric_name,r.value_unscaled]).sort(),[["d30_total_net_roas","1733333"],["d7_roas","1333333"]]);
    assert.ok(latest.filter(r=>r.grouping?.creative_id!=="synthetic-creative-a").every(r=>r.value_state==="undefined"&&r.undefined_reason==="no_attributed_cost"));
    const history=await withTenant(reader,identity.tenantId,async c=>(await c.query("SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2",[identity.tenantId,identity.appId])).rows);
    for(const run of initial)assert.equal(jcs(history.find(row=>row.artifact.metric_run_id===run.metric_run_id)!.artifact),jcs(run));
  });

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
  it("publishes complete Apple pages through the shared worker, preserves revisions and never turns empty into zero", async () => {
    const google = await register();
    const schedule = await register(appleRequest); // Distinct providers may coexist in the same app.
    await assert.rejects(register(appleRequest), /cost_schedule_active_exists/);
    await disableCostSchedule(pool, identity, google.cost_schedule_id);
    const mock = appleSource();
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(mock.fetcher))).completed, 1);
    assert.deepEqual(mock.requests.map(value => value.pagination.offset), [0, 1]);
    assert.deepEqual(await counts(), { costs: 14, runs: 1 });
    await processCostRefreshes(pool, identity.tenantId, options(() => { throw new Error("completed range must not fetch"); }));
    assert.deepEqual(await counts(), { costs: 14, runs: 1 });
    await due(schedule.cost_schedule_id);
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(appleSource("5.00").fetcher, new Date("2026-08-23T00:00:00.000Z")))).completed, 1);
    assert.deepEqual(await counts(), { costs: 28, runs: 2 });
    await due(schedule.cost_schedule_id);
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(appleSource("0", { empty: true }).fetcher, new Date("2026-08-24T00:00:00.000Z")))).empty, 1);
    assert.deepEqual(await counts(), { costs: 28, runs: 2 });
    const current = await withTenant(pool, identity.tenantId, client => client.query(
      `SELECT spend_unscaled,artifact FROM ledger.cost_records_current WHERE tenant_id=$1 AND cost_date='2026-08-20'`, [identity.tenantId]));
    assert.equal(current.rows.length, 2);
    assert.ok(current.rows.every(row => row.spend_unscaled === "5000000000000000000" && row.artifact.reporting_time_zone === "UTC"));
    assert.equal((await listCostSchedules(reader, identity)).find(row => row.cost_schedule_id === schedule.cost_schedule_id)?.last_outcome, "empty");
  });
  it("keeps Apple partial, throttled, unauthorized and duplicate acquisitions unpublished with safe outcomes", async () => {
    for (const config of [{ failure: 503 }, { failure: 429 }, { failure: 401 }, { duplicate: true }]) {
      const schedule = await register(appleRequest);
      const mock = appleSource("1", config);
      assert.equal((await processCostRefreshes(pool, identity.tenantId, options(mock.fetcher))).failed, 1);
      assert.deepEqual(await counts(), { costs: 0, runs: 0 });
      const state = (await listCostSchedules(reader, identity)).find(row => row.cost_schedule_id === schedule.cost_schedule_id)!;
      assert.equal(state.state, [503, 429].includes(config.failure ?? 0) ? "retry" : "failed");
      assert.equal(JSON.stringify(state).includes("synthetic-private"), false);
      await disableCostSchedule(pool, identity, schedule.cost_schedule_id);
    }
    const schedule = await register(appleRequest);
    await processCostRefreshes(pool, identity.tenantId, options(appleSource("1", { failure: 503 }).fetcher));
    await due(schedule.cost_schedule_id);
    const recovered = appleSource("1");
    assert.equal((await processCostRefreshes(pool, identity.tenantId, options(recovered.fetcher, new Date("2026-08-25T00:00:00.000Z")))).completed, 1);
    assert.equal(recovered.requests[0].timeRange.end, "2026-08-21");
    const costs = await withTenant(pool, identity.tenantId, client => client.query("SELECT DISTINCT as_of FROM ledger.cost_records WHERE tenant_id=$1", [identity.tenantId]));
    assert.deepEqual(costs.rows, [{ as_of: now.toISOString() }]);
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
