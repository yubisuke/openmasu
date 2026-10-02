import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import { sha256Jcs } from "@openmasu/fraud-rules";
import {
  createAppPool,
  createReaderPool,
  createSeedPool,
  EncryptedFilePayloadStore,
  withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { renderMetricSchedules } from "../../api/src/dashboard/metric-schedules.js";
import type { MetricScheduleRecord } from "../../api/src/metric-schedules.js";
import { csrfToken, issueDashboardSession, type DashboardSession } from "../../api/src/session.js";
import { buildDashboardView } from "../../api/src/dashboard/view.js";
import { parseMetricQuery } from "../../api/src/report-query.js";
import { metricReport } from "../../api/src/reporting.js";
import { reportToSnapshot } from "../../api/src/report-snapshot.js";
import { createRequestHandler } from "../../api/src/router.js";
import { ingestFixture } from "./ingestion.js";
import { buildScheduledMetricInput, processMetricSchedules } from "./metric-schedule-worker.js";
import { computeSqlMetricRuns, persistMetricRun } from "./metrics/cohort.js";

type Any = Record<string, any>;

const fixtureInput: Any = JSON.parse(readFileSync(
  join(process.cwd(), "fixtures", "v0.4", "33-stage-b-cohort-metrics", "input.json"),
  "utf8",
));
const dailyMetricInput: Any = JSON.parse(readFileSync(
  join(process.cwd(), "fixtures", "v0.4", "42-daily-metric-date", "input.json"),
  "utf8",
));
const tenantId = "tenant-a";
const appId = "app-a";
const reportIdentity = { tenantId, appId, keyId: "synthetic-metric-schedule", role: "admin" as const };
const adminKey = `synthetic-metric-schedule-${randomBytes(32).toString("base64url")}`;
const payloadRoot = mkdtempSync(join(tmpdir(), "openmasu-metric-schedule-"));
const payloadStore = new EncryptedFilePayloadStore(
  payloadRoot,
  `synthetic-metric-schedule-master-${randomBytes(32).toString("base64url")}`,
);
const appPool = createAppPool();
const seedPool = createSeedPool();
const readerPool = createReaderPool();
let session: Omit<DashboardSession, "role">;
let api: ReturnType<typeof createServer>;
let baseUrl = "";
let scheduleId = "";
let dailyScheduleId = "";

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("durable scheduled metric runs", { concurrency: false }, () => {
  before(async () => {
    await ingestFixture(`metric-schedule-${randomBytes(6).toString("hex")}`, fixtureInput, appPool, seedPool);
    await seedPool.query(
      `TRUNCATE control.metric_schedule_checkpoints,control.metric_schedule_states,
         control.metric_schedules CASCADE`,
    );
    const [adminKeyId] = await ensureAdminKeys(appPool, { tenantId, appId }, [adminKey]);
    session = await issueDashboardSession(appPool, tenantId, adminKeyId!, 43_200);
    api = createServer(createRequestHandler({
      pool: appPool,
      readerPool,
      payloadStore,
      maxConfig: {
        tenantId,
        appId,
        pathSecret: "synthetic-metric-schedule-path",
        eventKey: "synthetic-metric-schedule-event",
        tokenMode: "all_with_event_fallback",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: true, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43_200 },
    }));
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  after(async () => {
    api.close();
    await once(api, "close");
    await Promise.all([appPool.end(), seedPool.end(), readerPool.end()]);
    rmSync(payloadRoot, { recursive: true, force: true });
  });

  it("registers an app-scoped schedule without accepting a static date", async () => {
    const response = await admin(`/v1/admin/apps/${appId}/metric-schedules`, {
      method: "POST",
      body: JSON.stringify({
        lag_days: 9,
        start_date: "2026-08-01",
        fx_policy: fixtureInput.fx_policy,
        metric_definitions: fixtureInput.metric_definitions,
        evaluations: [{
          metric_names: ["d7_roas"],
          date_dimension: "cohort_date",
          grouping: {
            campaign_id: "provider-campaign-33",
            network: "synthetic-network",
            country: "JP",
            attribution_status: "non_organic",
          },
        }],
      }),
    });
    assert.equal(response.status, 201);
    const registered = await response.json() as { metric_schedule_id: string; definition_digest: string };
    scheduleId = registered.metric_schedule_id;
    assert.match(scheduleId, /^metric-schedule:/);
    assert.match(registered.definition_digest, /^[a-f0-9]{64}$/);

    const overlap = await admin(`/v1/admin/apps/${appId}/metric-schedules`, {
      method: "POST",
      body: JSON.stringify({
        lag_days: 9,
        fx_policy: fixtureInput.fx_policy,
        metric_definitions: fixtureInput.metric_definitions,
        evaluations: [{
          metric_names: ["d7_roas"],
          date_dimension: "cohort_date",
          grouping: { country: "JP" },
        }],
      }),
    });
    assert.equal(overlap.status, 409);
    assert.deepEqual(await overlap.json(), { error: "metric_schedule_metric_overlap" });

    const daily = await admin(`/v1/admin/apps/${appId}/metric-schedules`, {
      method: "POST",
      body: JSON.stringify({
        lag_days: 10,
        start_date: "2026-07-31",
        fx_policy: fixtureInput.fx_policy,
        metric_definitions: [dailyMetricInput.metric_definitions.find(
          (definition: Any) => definition.metric_name === "daily_click_count",
        )],
        evaluations: [{
          metric_names: ["daily_click_count"],
          date_dimension: "metric_date",
          grouping: {},
        }],
      }),
    });
    assert.equal(daily.status, 201);
    dailyScheduleId = ((await daily.json()) as { metric_schedule_id: string }).metric_schedule_id;

    const invalid = await admin(`/v1/admin/apps/${appId}/metric-schedules`, {
      method: "POST",
      body: JSON.stringify({
        lag_days: 9,
        fx_policy: fixtureInput.fx_policy,
        evaluations: [{
          metric_names: ["d7_roas"],
          date_dimension: "cohort_date",
          grouping: { cohort_date: "2026-08-01" },
        }],
      }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "metric_schedule_grouping_dimension_invalid" });
  });

  it("computes a fixed-watermark metric, exposes it to reports and dashboard view, and advances the checkpoint", async () => {
    const cycle = await processMetricSchedules(appPool, tenantId, {
      now: new Date("2026-08-10T12:34:56.000Z"),
    });
    assert.deepEqual(cycle, { schedules: 2, completedDates: 2, replayedDates: 0, failedSchedules: 0 });
    const parsed = parseMetricQuery({
      tenantId,
      appId,
      searchParams: new URLSearchParams("metric_name=d7_roas&grouping_cohort_date=2026-08-01&limit=200"),
      maximumRows: 1_000,
    });
    const page = await metricReport(appPool, reportIdentity, parsed.query);
    const scheduled = page.data.find((row) => row.metric_run_id.startsWith("scheduled:"));
    assert.ok(scheduled);
    assert.equal(scheduled.value_unscaled, "1500000");
    assert.equal(scheduled.input_received_at_watermark, "2026-08-10T00:00:00.000Z");
    const view = buildDashboardView({
      apps: [{ app_id: appId, created_at: "2026-08-01T00:00:00.000Z" }],
      selectedAppId: appId,
      query: parsed.query,
      metrics: { data: [scheduled] },
      records: [],
      csrfToken: "synthetic-metric-schedule-csrf",
    });
    assert.equal(view.rows[0]?.metric_run_id, scheduled.metric_run_id);
    const dailyQuery = parseMetricQuery({
      tenantId,
      appId,
      searchParams: new URLSearchParams("metric_name=daily_click_count&grouping_metric_date=2026-07-31&limit=200"),
      maximumRows: 1_000,
    });
    const dailyPage = await metricReport(appPool, reportIdentity, dailyQuery.query);
    const dailyRun = dailyPage.data.find((row) => row.metric_run_id.startsWith("scheduled:"));
    assert.ok(dailyRun);
    assert.equal(dailyRun.value_unscaled, "1");
    assert.deepEqual(dailyRun.grouping, { metric_date: "2026-07-31" });
    const listed = await admin(`/v1/admin/apps/${appId}/metric-schedules`);
    assert.equal(listed.status, 200);
    const list = await listed.json() as { data: Array<{ metric_schedule_id: string; last_target_date: string }> };
    assert.equal(list.data.find((entry) => entry.metric_schedule_id === scheduleId)?.last_target_date, "2026-08-01");
  });

  it("replays the exact committed artifact after a simulated crash before checkpoint finalization", async () => {
    const before = await withTenant(appPool, tenantId, async (client) => (await client.query<{
      metric_run_id: string;
      artifact: Any;
      definition_digest: string;
    }>(
      `SELECT run.metric_run_id,run.artifact,schedule.definition_digest
         FROM ledger.metric_runs AS run
         CROSS JOIN control.metric_schedules AS schedule
        WHERE run.tenant_id=$1 AND run.app_id=$2 AND run.metric_run_id LIKE 'scheduled:%'
          AND schedule.metric_schedule_id=$3
        ORDER BY run.metric_run_id LIMIT 1`,
      [tenantId, appId, scheduleId],
    )).rows[0]!);
    await withTenant(appPool, tenantId, async (client) => {
      await client.query(
        `UPDATE control.metric_schedule_checkpoints
            SET last_target_date=NULL,pending_target_date='2026-08-01'::date,
                pending_watermark='2026-08-10T00:00:00.000Z',pending_definition_digest=$4,
                updated_at='2026-08-10T00:00:00.000Z'
          WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3`,
        [tenantId, appId, scheduleId, before.definition_digest],
      );
    });
    const replay = await processMetricSchedules(appPool, tenantId, {
      now: new Date("2026-08-10T23:59:59.999Z"),
    });
    assert.deepEqual(replay, { schedules: 2, completedDates: 1, replayedDates: 1, failedSchedules: 0 });
    const after = await withTenant(appPool, tenantId, async (client) => (await client.query<{
      count: number;
      artifact: Any;
    }>(
      `SELECT count(*)::int AS count,min(artifact::text)::jsonb AS artifact
         FROM ledger.metric_runs
        WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id=$3`,
      [tenantId, appId, before.metric_run_id],
    )).rows[0]!);
    assert.equal(after.count, 1);
    assert.deepEqual(after.artifact, before.artifact);
  });

  it("disables the schedule and leaves later eligible dates untouched", async () => {
    const disabled = await admin(
      `/v1/admin/apps/${appId}/metric-schedules/${encodeURIComponent(scheduleId)}/disable`,
      { method: "POST", body: "{}" },
    );
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), {
      metric_schedule_id: scheduleId,
      status: "disabled",
      changed_at: (await withTenant(appPool, tenantId, async (client) => (await client.query<{ changed_at: string }>(
        `SELECT status_changed_at AS changed_at FROM control.metric_schedules_current
          WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3`,
        [tenantId, appId, scheduleId],
      )).rows[0]!.changed_at)),
    });
    const dailyDisabled = await admin(
      `/v1/admin/apps/${appId}/metric-schedules/${encodeURIComponent(dailyScheduleId)}/disable`,
      { method: "POST", body: "{}" },
    );
    assert.equal(dailyDisabled.status, 200);
    assert.deepEqual(await processMetricSchedules(appPool, tenantId, {
      now: new Date("2026-08-11T12:00:00.000Z"),
    }), { schedules: 0, completedDates: 0, replayedDates: 0, failedSchedules: 0 });
  });

  it("connects dashboard registration to worker checkpoint and disablement with API parity and scoped permissions", async () => {
    const path = `/dashboard/apps/${appId}/metric-schedules`;
    const apiPath = `/v1/admin/apps/${appId}/metric-schedules`;
    const cookie = `openmasu_dashboard=${session.token}`;
    const csrf = csrfToken(session.token);
    const list = async (): Promise<MetricScheduleRecord[]> => {
      const response = await admin(apiPath); assert.equal(response.status, 200);
      return (await response.json() as { data: MetricScheduleRecord[] }).data;
    };
    const page = (url = path, selectedCookie = cookie) => fetch(`${baseUrl}${url}`, { headers: { cookie: selectedCookie }, redirect: "manual" });
    const post = (body: URLSearchParams, url = path, selectedCookie = cookie, origin = "http://localhost:8080") => fetch(`${baseUrl}${url}`, {
      method: "POST", body, headers: { cookie: selectedCookie, origin }, redirect: "manual",
    });
    const form = (body: Any) => new URLSearchParams({ csrf_token: csrf, request_json: JSON.stringify(body) });
    const state = () => withTenant(readerPool, tenantId, async client => (await client.query(
      `SELECT (SELECT count(*)::int FROM control.metric_schedules WHERE tenant_id=$1 AND app_id=$2) AS schedules,
        (SELECT count(*)::int FROM control.metric_schedule_states WHERE tenant_id=$1 AND app_id=$2) AS states,
        (SELECT count(*)::int FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2) AS runs,
        (SELECT count(*)::int FROM ledger.audit_logs WHERE tenant_id=$1) AS audits`, [tenantId, appId],
    )).rows[0]);
    const assertPage = async () => {
      const records = await list(), before = await state(), response = await page();
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), renderMetricSchedules(appId, records, csrf));
      assert.deepEqual(await state(), before, "GET uses the reader pool and does not mutate schedules, runs or audit logs");
      return records;
    };
    await assertPage();
    // This UI flow uses a different aggregate selection from the API cases.
    // The following recovery test exercises exact re-registration separately.
    const body = { lag_days: 9, start_date: "2026-08-01", fx_policy: fixtureInput.fx_policy,
      metric_definitions: fixtureInput.metric_definitions, evaluations: [{ metric_names: ["d7_roas"],
        date_dimension: "cohort_date", grouping: { campaign_id: "provider-campaign-33", country: "JP", attribution_status: "non_organic" } }] };
    const before = await list();
    const registered = await post(form(body)); assert.equal(registered.status, 303); assert.equal(registered.headers.get("location"), path);
    const records = await assertPage();
    const created = records.find(row => !before.some(old => old.metric_schedule_id === row.metric_schedule_id))!;
    assert.ok(created); assert.equal(created.status, "active"); assert.equal(created.last_target_date, null);
    assert.equal(created.lag_days, 9); assert.equal(created.start_date, "2026-08-01");
    assert.deepEqual(created.definition.evaluations, body.evaluations);

    const invalid = structuredClone(body); invalid.metric_definitions[0].definition.calculation = "unsupported";
    for (const [candidate, status, reason] of [
      [invalid, 400, "metric_schedule_definitions_invalid"],
      [body, 409, "metric_schedule_metric_overlap"],
      [{ ...body, start_date: "9999-01-01" }, 400, "metric_schedule_start_date_in_future"],
    ] as const) {
      const apiResponse = await admin(apiPath, { method: "POST", body: JSON.stringify(candidate) });
      assert.equal(apiResponse.status, status); assert.deepEqual(await apiResponse.json(), { error: reason });
      const browserResponse = await post(form(candidate)); assert.equal(browserResponse.status, status);
      assert.ok((await browserResponse.text()).includes(reason));
      assert.deepEqual(await list(), records, "rejected registration does not change a schedule");
    }

    const disablePath = `${path}/${encodeURIComponent(created.metric_schedule_id)}/disable`;
    const readerKey = `synthetic-schedule-reader-${randomBytes(32).toString("base64url")}`;
    const [readerId] = await ensureAdminKeys(appPool, { tenantId, appId }, [{ key: readerKey, role: "read_only" }]);
    const readerSession = await issueDashboardSession(appPool, tenantId, readerId!, 43_200);
    const readerCookie = `openmasu_dashboard=${readerSession.token}`;
    assert.equal((await page(path, readerCookie)).status, 403);
    assert.equal((await post(new URLSearchParams({ csrf_token: csrfToken(readerSession.token), request_json: JSON.stringify(body) }), path, readerCookie)).status, 403);
    assert.equal((await post(new URLSearchParams({ csrf_token: csrfToken(readerSession.token) }), disablePath, readerCookie)).status, 403);
    assert.equal((await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${adminKey}` } })).status, 401);
    assert.equal((await fetch(`${baseUrl}${apiPath}`, { headers: { cookie } })).status, 401);
    for (const token of ["", csrfToken(readerSession.token)]) {
      assert.equal((await post(new URLSearchParams({ csrf_token: token, request_json: JSON.stringify(body) }))).status, 403);
      assert.equal((await post(new URLSearchParams({ csrf_token: token }), disablePath)).status, 403);
    }
    assert.equal((await post(form(body), path, cookie, "https://other.example.test")).status, 403);
    assert.equal((await post(new URLSearchParams({ csrf_token: csrf }), disablePath, cookie, "https://other.example.test")).status, 403);
    for (const [tenant, app] of [["tenant-schedule-foreign", "app-schedule-foreign"], [tenantId, "app-schedule-other"]]) {
      await withTenant(appPool, tenant!, client => client.query(
        "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,'2026-08-01T00:00:00.000Z') ON CONFLICT DO NOTHING",
        [tenant, app],
      ));
    }
    for (const app of ["app-schedule-foreign", "app-schedule-missing"]) {
      const foreignPath = `/dashboard/apps/${app}/metric-schedules`;
      assert.equal((await page(foreignPath)).status, 404);
      assert.equal((await post(form(body), foreignPath)).status, 404);
    }
    assert.equal((await post(new URLSearchParams({ csrf_token: csrf }),
      `/dashboard/apps/app-schedule-other/metric-schedules/${encodeURIComponent(created.metric_schedule_id)}/disable`)).status, 404);
    assert.deepEqual(await list(), records);

    const savedRuns = () => withTenant(readerPool, tenantId, async client => (await client.query<{ metric_run_id: string; artifact: Any }>(
      "SELECT metric_run_id,artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id", [tenantId, appId],
    )).rows);
    const oldRuns = await savedRuns();
    assert.deepEqual(await processMetricSchedules(appPool, tenantId, { now: new Date("2026-08-10T12:34:56.000Z") }),
      { schedules: 1, completedDates: 1, replayedDates: 0, failedSchedules: 0 });
    const completedRuns = await savedRuns();
    const newRuns = completedRuns.filter(run => !oldRuns.some(old => old.metric_run_id === run.metric_run_id));
    assert.equal(newRuns.length, 1); assert.equal(newRuns[0]!.artifact.value_unscaled, "1500000");
    assert.equal(newRuns[0]!.artifact.input_received_at_watermark, "2026-08-10T00:00:00.000Z");
    const completed = (await assertPage()).find(row => row.metric_schedule_id === created.metric_schedule_id)!;
    assert.equal(completed.last_target_date, "2026-08-01"); assert.equal(completed.pending_target_date, null);
    const stopped = await post(new URLSearchParams({ csrf_token: csrf }), disablePath);
    assert.equal(stopped.status, 303); assert.equal(stopped.headers.get("location"), path);
    const disabled = (await assertPage()).find(row => row.metric_schedule_id === created.metric_schedule_id)!;
    assert.equal(disabled.status, "disabled"); assert.equal(disabled.last_target_date, "2026-08-01");
    assert.deepEqual(disabled.definition, created.definition); assert.equal(disabled.definition_digest, created.definition_digest);
    assert.deepEqual(await processMetricSchedules(appPool, tenantId, { now: new Date("2026-08-11T12:00:00.000Z") }),
      { schedules: 0, completedDates: 0, replayedDates: 0, failedSchedules: 0 });
    assert.deepEqual(await savedRuns(), completedRuns, "disablement preserves every existing metric artifact");
  });

  it("re-registers the same saved selection and replays a committed run after checkpoint interruption without losing either identity", async () => {
    const list = async () => (await (await admin(`/v1/admin/apps/${appId}/metric-schedules`)).json() as { data: MetricScheduleRecord[] }).data;
    const original = (await list()).find(row => row.metric_schedule_id === scheduleId)!;
    assert.equal(original.status, "disabled");
    const saved = () => withTenant(readerPool, tenantId, async client => (await client.query<{ metric_run_id: string; artifact: Any }>(
      "SELECT metric_run_id,artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id", [tenantId, appId],
    )).rows);
    const oldRuns = await saved();
    const response = await admin(`/v1/admin/apps/${appId}/metric-schedules`, {
      method: "POST", body: JSON.stringify({ ...original.definition, lag_days: original.lag_days, start_date: original.start_date }),
    });
    assert.equal(response.status, 201);
    const registered = await response.json() as MetricScheduleRecord;
    assert.notEqual(registered.metric_schedule_id, scheduleId);
    assert.equal(registered.definition_digest, original.definition_digest);

    // Fail exactly between committed run/manifest publication and progress commit.
    let interrupted = false;
    const failingPool = { connect: async () => {
      const client = await appPool.connect(), execute = client.query.bind(client);
      return new Proxy(client, { get(target, key) {
        if (key === "query") return async (...args: any[]) => {
          if (!interrupted && typeof args[0] === "string" && args[0].includes("SET last_target_date=$4::date")) {
            interrupted = true; throw new Error("synthetic checkpoint interruption");
          }
          return (execute as any)(...args);
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    } } as unknown as Pool;
    const now = new Date("2026-08-10T12:34:56.000Z");
    await assert.rejects(processMetricSchedules(failingPool, tenantId, { now }), /metric_schedule_cycle_failed/);
    assert.equal(interrupted, true, "publication must pass the former snapshot uniqueness collision");
    const pending = (await list()).find(row => row.metric_schedule_id === registered.metric_schedule_id)!;
    assert.equal(pending.last_target_date, null); assert.equal(pending.pending_target_date, "2026-08-01");
    const committed = await saved(), added = committed.filter(run => !oldRuns.some(old => old.metric_run_id === run.metric_run_id));
    assert.equal(added.length, 1);
    const newRun = added[0]!.artifact;
    const oldRun = oldRuns.find(row => row.artifact.metric_name === newRun.metric_name
      && row.artifact.input_received_at_watermark === newRun.input_received_at_watermark
      && row.artifact.grouping?.dimension_digest === newRun.grouping.dimension_digest)!.artifact;
    assert.equal(oldRun.input_snapshot_id, newRun.input_snapshot_id);
    assert.notEqual(oldRun.metric_run_id, newRun.metric_run_id);
    assert.equal(newRun.value_unscaled, "1500000");
    await withTenant(readerPool, tenantId, async client => {
      const manifests = await client.query(`SELECT source_metric_run_id FROM control.metric_replay_manifests
        WHERE tenant_id=$1 AND app_id=$2 AND source_metric_run_id=ANY($3::text[])`,
      [tenantId, appId, [oldRun.metric_run_id, newRun.metric_run_id]]);
      assert.equal(manifests.rowCount, 2);
    });
    assert.deepEqual(await processMetricSchedules(appPool, tenantId, { now }),
      { schedules: 1, completedDates: 1, replayedDates: 1, failedSchedules: 0 });
    assert.equal((await list()).find(row => row.metric_schedule_id === registered.metric_schedule_id)!.last_target_date, "2026-08-01");
    assert.equal((await processMetricSchedules(appPool, tenantId, { now })).completedDates, 0);
    assert.equal(sha256Jcs(await saved()), sha256Jcs(committed));
    for (const prior of oldRuns) assert.equal(sha256Jcs(committed.find(row => row.metric_run_id === prior.metric_run_id)), sha256Jcs(prior));

    // Reports retain both independent runs. "latest" means not superseded, not
    // an implicit newest-per-cohort selection; comparison refuses duplicate keys.
    const query = { tenantId, appId, metricNames: ["d7_roas"], grouping: newRun.grouping.dimensions, supersession: "latest" as const, limit: 200 };
    const report = await metricReport(readerPool, reportIdentity, query);
    for (const id of [oldRun.metric_run_id, newRun.metric_run_id]) assert.ok(report.data.some(row => row.metric_run_id === id && !row.superseded));
    const pair = report.data.filter(row => [oldRun.metric_run_id, newRun.metric_run_id].includes(row.metric_run_id));
    assert.throws(() => reportToSnapshot({ data: pair }, { source: "synthetic-schedule-recovery", conditions: {
      date_from: "2026-08-01", date_to: "2026-08-02", time_zone: "UTC", maturity: "unknown", aggregation: "cumulative",
      attribution_scope: "non_organic", metric_definition: "d7_roas@0.3.0", source_cutoff: newRun.input_received_at_watermark,
    }, rows: [] }), /duplicate_key/);
    const paged: string[] = []; let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ metric_name: "d7_roas", limit: "1" });
      for (const [key, value] of Object.entries(newRun.grouping.dimensions)) params.set(`grouping_${key}`, String(value));
      if (cursor) params.set("after", cursor);
      const page = await metricReport(readerPool, reportIdentity, parseMetricQuery({ tenantId, appId, searchParams: params, maximumRows: 1000 }).query);
      paged.push(...page.data.map(row => row.metric_run_id)); cursor = page.next_cursor;
      assert.ok(paged.length <= report.data.length, "keyset cursor must advance");
    } while (cursor);
    assert.deepEqual(paged, report.data.map(row => row.metric_run_id));
    for (const scope of [{ tenantId: "tenant-schedule-foreign", appId }, { tenantId, appId: "app-schedule-other" }]) {
      assert.deepEqual((await metricReport(readerPool, { ...reportIdentity, ...scope }, { ...query, ...scope })).data, []);
    }
    await assert.rejects(withTenant(appPool, tenantId, client => persistMetricRun(client, { tenant_id: tenantId, app_id: appId },
      { ...newRun, value_unscaled: "0" })), /metric run already exists/);
    assert.equal(sha256Jcs(await saved()), sha256Jcs(committed), "same-ID mismatch never overwrites a run");
    assert.equal((await admin(`/v1/admin/apps/${appId}/metric-schedules/${encodeURIComponent(registered.metric_schedule_id)}/disable`,
      { method: "POST", body: "{}" })).status, 200);
  });

  it("keeps unchanged inputs distinct across cutoffs and FX definitions and only supersedes the explicitly named source", async () => {
    const listed = await (await admin(`/v1/admin/apps/${appId}/metric-schedules`)).json() as { data: MetricScheduleRecord[] };
    const schedule = listed.data.find(row => row.metric_schedule_id === scheduleId)!;
    const input = buildScheduledMetricInput(schedule, { targetDate: "2026-08-01", watermark: "2026-08-11T00:00:00.000Z", definitionDigest: schedule.definition_digest });
    const [later] = await computeSqlMetricRuns(appPool, input, true, { tenant_id: tenantId, app_id: appId });
    const earlierInput = buildScheduledMetricInput(schedule, { targetDate: "2026-08-01", watermark: "2026-08-10T00:00:00.000Z", definitionDigest: schedule.definition_digest });
    const [earlier] = await computeSqlMetricRuns(appPool, earlierInput, false, { tenant_id: tenantId, app_id: appId });
    assert.equal(later.input_snapshot_id, earlier.input_snapshot_id); assert.notEqual(later.metric_run_id, earlier.metric_run_id);
    assert.equal(later.value_unscaled, earlier.value_unscaled); assert.notEqual(later.input_received_at_watermark, earlier.input_received_at_watermark);
    const changedDefinition: Any = structuredClone(schedule.definition);
    changedDefinition.fx_policy.rates[0].rate_unscaled = "4";
    const changed = { ...schedule, definition: changedDefinition, definition_digest: sha256Jcs(changedDefinition) };
    const changedInput = buildScheduledMetricInput(changed, { targetDate: "2026-08-01", watermark: "2026-08-11T00:00:00.000Z", definitionDigest: changed.definition_digest });
    const [differentFx] = await computeSqlMetricRuns(appPool, changedInput, true, { tenant_id: tenantId, app_id: appId });
    assert.equal(differentFx.input_snapshot_id, later.input_snapshot_id); assert.notEqual(differentFx.metric_run_id, later.metric_run_id);
    assert.equal(differentFx.value_unscaled, "1200000");
    const manifests = await withTenant(readerPool, tenantId, async client => (await client.query<{ source_metric_run_id: string; artifact: Any }>(
      "SELECT source_metric_run_id,artifact FROM control.metric_replay_manifests WHERE tenant_id=$1 AND app_id=$2 AND source_metric_run_id=ANY($3::text[])",
      [tenantId, appId, [later.metric_run_id, differentFx.metric_run_id]],
    )).rows);
    assert.equal(manifests.length, 2);
    assert.equal(manifests.find(row => row.source_metric_run_id === later.metric_run_id)!.artifact.fx_policy.rates[0].rate_unscaled, "5");
    assert.equal(manifests.find(row => row.source_metric_run_id === differentFx.metric_run_id)!.artifact.fx_policy.rates[0].rate_unscaled, "4");
    const replacementInput = structuredClone(input);
    replacementInput.metric_evaluations[0].metric_run_id_prefix = "synthetic-schedule-explicit-replacement";
    replacementInput.metric_evaluations[0].supersedes_metric_run_id = later.metric_run_id;
    replacementInput.metric_evaluations[0].data_freshness = "recalculated";
    const [replacement] = await computeSqlMetricRuns(appPool, replacementInput, true, { tenant_id: tenantId, app_id: appId });
    const query = { tenantId, appId, metricNames: ["d7_roas"], supersession: "all" as const, limit: 200 };
    const history = (await metricReport(readerPool, reportIdentity, query)).data;
    assert.equal(history.find(row => row.metric_run_id === later.metric_run_id)!.superseded, true);
    for (const artifact of [earlier, differentFx, replacement]) assert.equal(history.find(row => row.metric_run_id === artifact.metric_run_id)!.superseded, false);
    await withTenant(readerPool, tenantId, async client => {
      const stored = await client.query<{ artifact: Any }>("SELECT artifact FROM ledger.metric_runs WHERE metric_run_id=$1", [later.metric_run_id]);
      assert.equal(sha256Jcs(stored.rows[0]!.artifact), sha256Jcs(later));
    });
  });
});
