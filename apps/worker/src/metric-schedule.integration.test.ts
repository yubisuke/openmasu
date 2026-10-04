import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
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
import { disableMetricSchedule, registerMetricSchedule, type MetricScheduleRecord } from "../../api/src/metric-schedules.js";
import { previewMetricScheduleReplacement, replaceMetricSchedule } from "../../api/src/metric-schedule-replacements.js";
import { csrfToken, issueDashboardSession, type DashboardSession } from "../../api/src/session.js";
import { buildDashboardView } from "../../api/src/dashboard/view.js";
import { parseMetricQuery } from "../../api/src/report-query.js";
import { metricReport } from "../../api/src/reporting.js";
import { reportToSnapshot } from "../../api/src/report-snapshot.js";
import { fixedComparisonDownload } from "../../api/src/fixed-comparison.js";
import { parseSnapshot } from "../../api/src/cohort-comparison.js";
import { jcs } from "@openmasu/attribution-core/canonical";
import { createRequestHandler } from "../../api/src/router.js";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { persistSyntheticPlatformResults } from "./test-support/platform-acquisition.js";
import { buildScheduledMetricInput, claimNextScheduledDate, processMetricSchedules } from "./metric-schedule-worker.js";
import { computeSqlMetricRuns, persistMetricRun } from "./metrics/cohort.js";
import { syntheticConversionCases } from "../../../tools/synthetic-conversion-cases.js";
import { keyedCustomConversionMetricDefinitions, customConversionMetricDefinitions } from "@openmasu/contracts/definitions";
import { listCustomConversionKeys } from "../../api/src/metric-schedules.js";
import { ingestRuntimeBatch } from "./ingestion.js";
import { requestMetricRecalculation } from "../../api/src/metric-recalculations.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { encodeMetricReport } from "../../api/src/reporting.js";
import { parseCsv } from "@openmasu/runtime/import-normalization";

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
      const html = await response.text();
      // Check persisted schedule evidence, not unrelated live-health text or page layout.
      for (const record of records) {
        assert.ok(html.includes(`data-metric-schedule-id="${record.metric_schedule_id}"`));
        assert.ok(html.includes(record.definition_digest));
      }
      if (!records.length) assert.match(html, /No metric schedules are registered/);
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
    await withTenant(appPool, tenantId, async client => {
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
    const manifests = await withTenant(appPool, tenantId, async client => (await client.query<{ source_metric_run_id: string; artifact: Any }>(
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

  it("recommended_SSR_setup_previews_without_writes_then_computes_two_campaigns_and_guides_unsupported_or_unauthorized_choices", async () => {
    await seedPool.query("TRUNCATE control.metric_schedules,control.metric_schedule_states,control.metric_schedule_checkpoints CASCADE");
    const appId = `app-setup-${randomBytes(6).toString("hex")}`;
    const reportIdentity = { tenantId, appId, keyId: "synthetic-recommended-setup", role: "admin" as const };
    const source: Any = JSON.parse(readFileSync("fixtures/v0.4/70-saved-acquisition-kpis/input.json", "utf8"));
    source.server_context.app_id = appId;
    for (const row of [...source.records, ...source.cost_records]) row.app_id = appId;
    source.metric_definitions = []; source.metric_evaluations = [];
    const empty = { ...source, records: [], cost_records: [] };
    await ingestFixture(`setup-empty-${randomBytes(6).toString("hex")}`, empty, appPool, seedPool);
    // A new app has no prior import receipts; never widen seed permissions to clear them.
    const adminKey = `synthetic-setup-admin-${randomBytes(32).toString("base64url")}`;
    const [keyId] = await ensureAdminKeys(appPool, { tenantId, appId }, [adminKey]);
    const session = await issueDashboardSession(appPool, tenantId, keyId!, 43_200);
    const admin = (path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${adminKey}` } });
    const path = `/dashboard/apps/${appId}/metric-schedules`, cookie = `openmasu_dashboard=${session.token}`;
    const page = async () => (await fetch(`${baseUrl}${path}`, { headers: { cookie } })).text();
    const post = (form: URLSearchParams, suffix = "/preview-recommended", sessionCookie = cookie) => fetch(`${baseUrl}${path}${suffix}`, {
      method: "POST", redirect: "manual", headers: { cookie: sessionCookie, origin: "http://localhost:8080",
        "content-type": "application/x-www-form-urlencoded" }, body: form });
    const schedules = async () => (await admin(`/v1/admin/apps/${appId}/metric-schedules`).then(response => response.json()) as Any).data;
    const form = new URLSearchParams({ csrf_token: csrfToken(session.token), recommended_profile: "native_d7_v1",
      acquisition_basis: "selected_first_party_click", target_currency: "USD", cutoff_policy: "utc_start_of_worker_day",
      include_retention: "true", lag_days: "9", start_date: "2026-08-06" });
    assert.match(await page(), /data-measurement-state="no_observations"/);
    const preview = await post(form); assert.equal(preview.status, 200);
    const previewHtml = await preview.text(); assert.match(previewHtml, /Confirm recommended schedule/);
    assert.deepEqual(await schedules(), []);
    assert.equal((await metricReport(readerPool, reportIdentity, { tenantId, appId, supersession: "latest", limit: 200 })).data.length, 0);
    assert.doesNotMatch(previewHtml, /<script\b|javascript:|\son[a-z]+=/i);
    for (const [name, value] of [["acquisition_basis", "selected_verified_platform"], ["target_currency", "EUR"],
      ["custom_conversion_event_keys", "unknown_outcome"]]) {
      const invalid = new URLSearchParams(form); invalid.set(name, value);
      assert.equal((await post(invalid)).status, 400);
    }
    const readerKey = `synthetic-setup-reader-${randomBytes(32).toString("base64url")}`;
    const [readerId] = await ensureAdminKeys(appPool, { tenantId, appId }, [{ key: readerKey, role: "read_only" }]);
    const reader = await issueDashboardSession(appPool, tenantId, readerId!, 43_200);
    const denied = new URLSearchParams(form); denied.set("csrf_token", csrfToken(reader.token));
    assert.equal((await post(denied, "/preview-recommended", `openmasu_dashboard=${reader.token}`)).status, 403);
    const confirmed = new URLSearchParams(form);
    confirmed.set("preview_digest", /name="preview_digest" value="([a-f0-9]{64})"/.exec(previewHtml)![1]);
    const altered = new URLSearchParams(confirmed); altered.set("lag_days", "10");
    assert.equal((await post(altered, "")).status, 409);
    assert.equal((await post(confirmed, "")).status, 303);
    assert.equal((await schedules()).length, 1);
    const id = (await schedules())[0].metric_schedule_id;
    for (const [group, hour] of [["a", "00"], ["b", "03"]]) for (const day of ["07", "13"]) {
      const recordId = `setup-session-${group}-${day}`, occurred = `2026-08-${day}T${hour}:30:00.000Z`;
      const prototype = fixtureInput.records.find((record: Any) => record.event_name === "session_start");
      source.records.push({ ...structuredClone(prototype), tenant_id: tenantId, app_id: appId, record_id: recordId, event_id: `event:${recordId}`,
        delivery_id: `delivery:${recordId}`, occurred_at: occurred, received_at: `2026-08-${day}T${hour}:30:01.000Z`,
        processing_sequence: source.records.length + 1,
        payload: { installation_id: `installation:kpi70-install-${group}-0`, session_id: recordId } });
    }
    await ingestFixture(`setup-observed-${randomBytes(6).toString("hex")}`, source, appPool, seedPool);
    assert.match(await page(), /data-measurement-state="not_computed"/);
    assert.equal((await processMetricSchedules(appPool, tenantId, { now: new Date("2026-08-15T00:00:00.000Z") })).completedDates, 1);
    const rows = (await metricReport(readerPool, reportIdentity, { tenantId, appId, metricScheduleId: id,
      supersession: "latest", limit: 200 })).data;
    for (const [campaign, installs, cost, roas, retention] of [["kpi70-a", "3", "10000000", "1200000", "333333"],
      ["kpi70-b", "2", "4000000", "1500000", "500000"]]) {
      const value = (name: string) => rows.find(row => row.grouping.campaign_id === campaign && row.metric_name === name)!.value_unscaled;
      assert.equal(value("acquisition_d7_installs"), installs); assert.equal(value("acquisition_d7_cost"), cost);
      assert.equal(value("acquisition_d7_total_roas"), roas); assert.equal(value("retention_d1"), retention);
      assert.equal(value("retention_d7"), retention);
    }
    const organic = rows.find(row => row.grouping.attribution_status === "organic" && row.metric_name === "acquisition_d7_total_roas");
    assert.equal(organic?.value_state, "undefined"); assert.equal(organic?.undefined_reason, "no_attributed_cost");
    assert.match(await page(), /data-measurement-state="results_observed"/);
    const dashboard = await fetch(`${baseUrl}/dashboard/apps/${appId}?metric_schedule_id=${encodeURIComponent(id)}`, { headers: { cookie } });
    assert.equal(dashboard.status, 200); const html = await dashboard.text();
    assert.match(html, /kpi70-a/); assert.match(html, /kpi70-b/); assert.match(html, /data-value-unscaled="1200000"/);
    const before = await schedules(); await page(); assert.deepEqual(await schedules(), before, "GET does not claim or change a schedule");
  });

  describe("per-key custom-conversion schedules on the existing engine", () => {
    const legacy = JSON.parse(readFileSync("fixtures/v0.4/61-custom-conversion/input.json", "utf8"));
    const native = JSON.parse(readFileSync("fixtures/v0.4/58-selected-native-acquisition/input.json", "utf8"));
    const source = syntheticConversionCases(legacy, native).find(entry => entry.name === "two-key-D7-series-reuse-existing-arithmetic")!.input;
    const clock = new Date("2026-08-15T00:00:00.000Z");
    const schedule = (key: string) => ({ custom_conversion_event_keys: [key], start_date: "2026-08-06", lag_days: 9 });
    const query = { tenantId, appId, supersession: "latest" as const, limit: 200 };
    beforeEach(async () => {
      await seedPool.query("TRUNCATE control.metric_schedules,control.metric_schedule_states,control.metric_schedule_checkpoints CASCADE");
      await ingestFixture(`two-key-schedules-${randomBytes(6).toString("hex")}`, source, appPool, seedPool);
    });
    it("two_keys_register_compute_correct_and_export_without_mixing_or_rewriting_the_other_key", async () => {
      for (const key of ["signup_complete", "tutorial_complete"]) {
        const registered = await admin(`/v1/admin/apps/${appId}/metric-schedules`, {
          method: "POST", body: JSON.stringify(schedule(key)) });
        assert.equal(registered.status, 201);
      }
      assert.equal((await processMetricSchedules(appPool, tenantId, { now: clock })).completedDates, 2);
      const before = await metricReport(readerPool, reportIdentity, query);
      assert.equal(before.data.length, 4);
      assert.deepEqual(before.data.map(row => row.value_unscaled), ["2", "200000", "3", "300000"]);
      const signup = before.data.filter(row => row.metric_name.includes("signup_complete"));
      const saved = async (id: string) => withTenant(readerPool, tenantId, async client =>
        jcs((await client.query("SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id=$3", [tenantId, appId, id])).rows[0].artifact));
      const signupBytes = await Promise.all(signup.map(row => saved(row.metric_run_id)));
      const original = source.records.find((row: Any) => row.event_name === "custom_event");
      const late = { ...structuredClone(original), record_id: "two-key-late-tutorial", delivery_id: "delivery:two-key-late-tutorial",
        event_id: "event:two-key-late-tutorial", received_at: "2026-08-16T00:00:00.000Z",
        payload: { installation_id: "installation:install-conversion-04", event_key: "tutorial_complete" } };
      await ingestRuntimeBatch([{ server: { ...source.server_context, received_at: late.received_at }, record: late,
        batch_id: "two-key-late-tutorial" }], appPool);
      const correction = await requestMetricRecalculation(appPool, reportIdentity, { trigger_kind: "late_events",
        source_record_ids: [late.record_id], date_from: "2026-08-06", date_to: "2026-08-06", watermark: "2026-08-17T00:00:00.000Z" });
      assert.equal(correction.selected_runs, 2, "only the tutorial count and rate are selected");
      await processMetricRecalculations(appPool, tenantId);
      const after = await metricReport(readerPool, reportIdentity, query);
      assert.deepEqual(after.data.map(row => row.value_unscaled), ["2", "200000", "4", "400000"]);
      assert.deepEqual(await Promise.all(signup.map(row => saved(row.metric_run_id))), signupBytes);
      const csv = parseCsv(encodeMetricReport(after, "csv").body);
      for (const row of after.data) {
        const key = row.metric_name.includes("signup_complete") ? "signup_complete" : "tutorial_complete";
        const context = row.comparison_context as Any;
        assert.equal(context.definition.conversion_event_key, key);
        const csvRow = csv.find(value => value.metric_run_id === row.metric_run_id)!;
        assert.equal(csvRow.value_unscaled, row.value_unscaled);
        assert.equal(JSON.parse(csvRow.comparison_context).definition.conversion_event_key, key);
      }
      assert.deepEqual(after.data.filter(row => row.metric_name.includes("signup_complete")).map(row => row.metric_run_id), signup.map(row => row.metric_run_id));
    });
    it("closed_key_selection_rejects_alias_ownership_unknown_keys_and_cross_scope_in_API_and_SSR", async () => {
      const list = await admin(`/v1/admin/apps/${appId}/metric-schedules`);
      assert.equal(list.status, 200);
      assert.deepEqual((await list.json() as Any).custom_conversion_event_keys, ["signup_complete", "tutorial_complete"]);
      const form = new URLSearchParams({ csrf_token: csrfToken(session.token), lag_days: "9", start_date: "2026-08-06" });
      form.append("custom_conversion_event_keys", "tutorial_complete");
      const registered = await fetch(`${baseUrl}/dashboard/apps/${appId}/metric-schedules`, { method: "POST", redirect: "manual",
        headers: { cookie: `openmasu_dashboard=${session.token}`, origin: "http://localhost:8080", "content-type": "application/x-www-form-urlencoded" }, body: form });
      assert.equal(registered.status, 303);
      const keyed = keyedCustomConversionMetricDefinitions("tutorial_complete");
      for (const definitions of [customConversionMetricDefinitions("tutorial_complete"),
        keyed.map(definition => ({ ...definition, metric_name: `${definition.metric_name}_renamed` }))]) {
        const response = await admin(`/v1/admin/apps/${appId}/metric-schedules`, { method: "POST", body: JSON.stringify({
          lag_days: 9, start_date: "2026-08-06", fx_policy: legacy.fx_policy, metric_definitions: definitions,
          evaluations: [{ metric_names: definitions.map(definition => definition.metric_name), date_dimension: "cohort_date", grouping: {} }] }) });
        assert.equal(response.status, 409); assert.equal((await response.json() as Any).error, "metric_schedule_conversion_overlap");
      }
      for (const body of [schedule("unknown_outcome"), { ...schedule("signup_complete"), tenant_id: "foreign-tenant" },
        { ...schedule("signup_complete"), custom_conversion_event_keys: ["signup_complete", "signup_complete"] }]) {
        assert.equal((await admin(`/v1/admin/apps/${appId}/metric-schedules`, { method: "POST", body: JSON.stringify(body) })).status, 400);
      }
      assert.equal((await admin("/v1/admin/apps/foreign-app/metric-schedules", { method: "POST", body: JSON.stringify(schedule("signup_complete")) })).status, 404);
      assert.deepEqual(await listCustomConversionKeys(readerPool, { ...reportIdentity, appId: "foreign-app" }), []);
      assert.deepEqual(await listCustomConversionKeys(readerPool, { ...reportIdentity, tenantId: "foreign-tenant" }), []);
      const html = await fetch(`${baseUrl}/dashboard/apps/${appId}/metric-schedules`, { headers: { cookie: `openmasu_dashboard=${session.token}` } });
      assert.equal(html.status, 200); assert.match(await html.text(), /name="custom_conversion_event_keys" value="signup_complete"/);
    });
  });

  describe("explicit schedule replacement and series handoff", () => {
    const clock = new Date("2026-08-10T12:00:00.000Z");
    const body = { lag_days: 9, start_date: "2026-08-01", fx_policy: fixtureInput.fx_policy,
      metric_definitions: fixtureInput.metric_definitions,
      evaluations: [{ metric_names: ["d7_roas"], date_dimension: "cohort_date",
        grouping: { campaign_id: "provider-campaign-33", network: "synthetic-network", country: "JP", attribution_status: "non_organic" } }] };
    const report = (id: string, supersession: "latest" | "all" = "latest") => ({ tenantId, appId,
      metricNames: ["d7_roas"], metricScheduleId: id, supersession, limit: 200 });
    const path = (id: string, action: string) => `/v1/admin/apps/${appId}/metric-schedules/${encodeURIComponent(id)}/${action}`;
    const stored = async (id: string) => withTenant(readerPool, tenantId, async client =>
      (await client.query<{ artifact: Any }>("SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id=$3", [tenantId, appId, id])).rows[0].artifact);
    const fresh = async (calculate = true) => {
      const saved = await registerMetricSchedule({ pool: appPool, identity: reportIdentity, body, now: clock });
      if (calculate) await processMetricSchedules(appPool, tenantId, { now: clock });
      return saved;
    };
    beforeEach(async () => {
      await seedPool.query("TRUNCATE control.metric_schedules,control.metric_schedule_states,control.metric_schedule_checkpoints CASCADE");
      await ingestFixture(`replacement-${randomBytes(6).toString("hex")}`, fixtureInput, appPool, seedPool);
    });

    it("replaces the same meaning once with explicit full keys, unique latest, retained history and an unchanged old comparison file", async () => {
      const source = await fresh();
      const oldPage = await metricReport(readerPool, reportIdentity, report(source.metric_schedule_id));
      const oldRun = oldPage.data[0]; assert.equal(oldPage.data.length, 1);
      const oldArtifact = jcs(await stored(oldRun.metric_run_id));
      const oldComparison = await fixedComparisonDownload(readerPool, reportIdentity, { ...report(source.metric_schedule_id),
        grouping: { attribution_status: "non_organic" },
        dateFrom: "2026-08-01", dateTo: "2026-08-02", watermarkAtMost: "2026-08-10T00:00:00.000Z" });
      const request = { mode: "same_meaning", schedule: body };
      const audits = async () => withTenant(readerPool, tenantId, async client => (await client.query("SELECT count(*)::int AS count FROM ledger.audit_logs WHERE tenant_id=$1", [tenantId])).rows[0].count);
      const beforePreview = await audits();
      const response = await admin(path(source.metric_schedule_id, "preview-replacement"), { method: "POST", body: JSON.stringify(request) });
      assert.equal(response.status, 200);
      const preview = await response.json() as Any;
      assert.equal(await audits(), beforePreview, "successful preview uses reader state and makes no writes");
      assert.equal(preview.definition_matches, true); assert.equal(preview.in_flight.can_replace, true);
      assert.equal(preview.source_runs.length, 1); assert.equal(preview.source_runs[0].can_supersede, true);
      const selected = preview.source_runs[0];
      assert.equal(selected.calculation_key.source_metric_run_id, oldRun.metric_run_id);
      assert.equal(sha256Jcs(selected.calculation_key), selected.calculation_key_digest);
      const confirmation = { ...request, preview_digest: preview.preview_digest, supersessions: [{
        source_metric_run_id: selected.source_metric_run_id, calculation_key_digest: selected.calculation_key_digest }] };
      const responses = await Promise.all([1, 2].map(() => admin(path(source.metric_schedule_id, "replace"), { method: "POST", body: JSON.stringify(confirmation) })));
      assert.deepEqual(responses.map(row => row.status), [200, 200]);
      const replacements = await Promise.all(responses.map(row => row.json() as Promise<Any>));
      assert.equal(new Set(replacements.map(row => row.metric_schedule_id)).size, 1);
      assert.deepEqual(replacements.map(row => row.replayed).sort(), [false, true]);
      const replacement = replacements[0];
      await processMetricSchedules(appPool, tenantId, { now: clock });
      const newPage = await metricReport(readerPool, reportIdentity, report(replacement.metric_schedule_id));
      assert.equal(newPage.data.length, 1); assert.equal(newPage.data[0].supersedes_metric_run_id, oldRun.metric_run_id);
      assert.equal(newPage.data[0].value_unscaled, oldRun.value_unscaled);
      const latest = await metricReport(readerPool, reportIdentity, { ...report(source.metric_schedule_id), metricScheduleId: undefined });
      const selectedLatest = latest.data.filter(row => [oldRun.metric_run_id, newPage.data[0].metric_run_id].includes(row.metric_run_id));
      assert.deepEqual(selectedLatest.map(row => row.metric_run_id), [newPage.data[0].metric_run_id]);
      assert.deepEqual((await metricReport(readerPool, reportIdentity, report(source.metric_schedule_id, "all"))).data.map(row => row.metric_run_id), [oldRun.metric_run_id]);
      assert.equal(jcs(await stored(oldRun.metric_run_id)), oldArtifact);
      assert.equal(`${jcs(parseSnapshot(JSON.parse(oldComparison)))}\n`, oldComparison, "the previously saved comparison file rereads byte-identically; it is not a new latest export");
      await assert.rejects(withTenant(appPool, tenantId, client => client.query("UPDATE control.metric_schedule_runs SET evaluation=1 WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId])), { code: "42501" });
      const query = `metric_schedule_id=${encodeURIComponent(replacement.metric_schedule_id)}&metric_name=d7_roas&format=csv`;
      const apiCsv = await admin(`/v1/reports/metrics?app_id=${appId}&${query}`);
      const dashboardCsv = await fetch(`${baseUrl}/dashboard/apps/${appId}/cohorts.csv?${query}`, { headers: { cookie: `openmasu_dashboard=${session.token}` } });
      assert.equal(apiCsv.status, 200); assert.equal(dashboardCsv.status, 200); assert.equal(await apiCsv.text(), await dashboardCsv.text());
      const page = await fetch(`${baseUrl}/dashboard/apps/${appId}?${query.replace("&format=csv", "")}`, { headers: { cookie: `openmasu_dashboard=${session.token}` } });
      assert.equal(page.status, 200); assert.ok((await page.text()).includes(newPage.data[0].metric_run_id));
    });

    it("separates a changed FX meaning without supersession and renders the same API preview in zero-JS SSR", async () => {
      const source = await fresh();
      const schedule = structuredClone(body); schedule.fx_policy.rates[0].rate_unscaled = "4";
      const request = { mode: "new_series", schedule };
      const preview = await previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, request, clock);
      assert.equal(preview.definition_matches, false); assert.ok(preview.definition_changes.some(row => row.field === "fx_policy"));
      assert.ok(preview.source_runs.every(row => !row.can_supersede));
      await assert.rejects(previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, { ...request, mode: "same_meaning" }, clock), /meaning_changed/);
      const form = new URLSearchParams({ csrf_token: csrfToken(session.token), request_json: JSON.stringify(request) });
      const htmlResponse = await fetch(`${baseUrl}/dashboard/apps/${appId}/metric-schedules/${encodeURIComponent(source.metric_schedule_id)}/preview-replacement`, {
        method: "POST", headers: { cookie: `openmasu_dashboard=${session.token}`, origin: "http://localhost:8080", "content-type": "application/x-www-form-urlencoded" }, body: form,
      });
      assert.equal(htmlResponse.status, 200); const html = await htmlResponse.text();
      assert.ok(html.includes("fx_policy")); assert.ok(html.includes("new_series")); assert.ok(html.includes("2026-08-01"));
      assert.doesNotMatch(html, /<script\b|javascript:|\son[a-z]+=/i);
      const replacement = await replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request, preview_digest: preview.preview_digest }, clock);
      await processMetricSchedules(appPool, tenantId, { now: clock });
      const oldRows = (await metricReport(readerPool, reportIdentity, report(source.metric_schedule_id))).data;
      const newRows = (await metricReport(readerPool, reportIdentity, report(replacement.metric_schedule_id))).data;
      assert.equal(oldRows.length, 1); assert.equal(newRows.length, 1);
      assert.equal(oldRows[0].value_unscaled, "1500000"); assert.equal(newRows[0].value_unscaled, "1200000");
      assert.equal(newRows[0].supersedes_metric_run_id, null); assert.equal(oldRows[0].superseded, false);
      assert.deepEqual((await metricReport(readerPool, { ...reportIdentity, tenantId: "tenant-synthetic-foreign" }, { ...report(source.metric_schedule_id), tenantId: "tenant-synthetic-foreign" })).data, []);
    });

    it("rejects stale or foreign full keys and competing successors before writing a replacement", async () => {
      const source = await fresh();
      const request = { mode: "same_meaning", schedule: body };
      const preview = await previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, request, clock);
      const selected = preview.source_runs[0];
      await assert.rejects(replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request,
        preview_digest: preview.preview_digest, supersessions: [{ source_metric_run_id: selected.source_metric_run_id, calculation_key_digest: "0".repeat(64) }] }, clock), /source_key_conflict/);
      await assert.rejects(replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request,
        preview_digest: "0".repeat(64) }, clock), /preview_stale/);
      await assert.rejects(previewMetricScheduleReplacement(readerPool, { ...reportIdentity, tenantId: "tenant-synthetic-foreign" }, source.metric_schedule_id, request, clock), /not_found/);
      const input = buildScheduledMetricInput(source, { targetDate: "2026-08-01", watermark: "2026-08-11T00:00:00.000Z", definitionDigest: source.definition_digest });
      input.metric_evaluations[0].metric_run_id_prefix = "synthetic-competing-replay";
      input.metric_evaluations[0].supersedes_metric_run_id = selected.source_metric_run_id;
      await computeSqlMetricRuns(appPool, input, true, { tenant_id: tenantId, app_id: appId });
      await assert.rejects(replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request,
        preview_digest: preview.preview_digest, supersessions: [{ source_metric_run_id: selected.source_metric_run_id, calculation_key_digest: selected.calculation_key_digest }] }, clock), /source_key_conflict/);
      const count = await withTenant(readerPool, tenantId, async client => (await client.query("SELECT count(*)::int AS count FROM control.metric_schedules WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId])).rows[0].count);
      assert.equal(count, 1);
    });

    it("serializes replacement with a date claim and refuses to cancel in-flight work", async () => {
      const source = await fresh(false);
      const request = { mode: "new_series", schedule: body };
      const preview = await previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, request, clock);
      const [replacement, claim] = await Promise.allSettled([
        replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request, preview_digest: preview.preview_digest }, clock),
        claimNextScheduledDate(appPool, source, clock),
      ]);
      assert.equal(claim.status, "fulfilled");
      if (replacement.status === "fulfilled") {
        assert.equal((claim as PromiseFulfilledResult<unknown>).value, undefined);
      } else {
        assert.match(String(replacement.reason), /date_in_flight/);
        const blocked = await previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, request, clock);
        assert.equal(blocked.in_flight.can_replace, false); assert.equal(blocked.in_flight.pending_target_date, "2026-08-01");
        await processMetricSchedules(appPool, tenantId, { now: clock });
        const refreshed = await previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, request, clock);
        await replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request, preview_digest: refreshed.preview_digest }, clock);
      }
      assert.equal(await claimNextScheduledDate(appPool, source, clock), undefined, "the disabled source cannot claim another date");
    });

    it("revalidates a handoff after confirmation and rolls back the date when its source acquires a competing successor", async () => {
      const source = await fresh();
      const nextClock = new Date("2026-08-11T12:00:00.000Z");
      const request = { mode: "same_meaning", schedule: body };
      const preview = await previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, request, nextClock);
      const selected = preview.source_runs[0];
      const replacement = await replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request,
        preview_digest: preview.preview_digest, supersessions: [{ source_metric_run_id: selected.source_metric_run_id,
          calculation_key_digest: selected.calculation_key_digest }] }, nextClock);
      const competitor = buildScheduledMetricInput(source, { targetDate: "2026-08-01", watermark: "2026-08-11T00:00:00.000Z", definitionDigest: source.definition_digest });
      competitor.metric_evaluations[0].metric_run_id_prefix = "synthetic-post-confirmation-replay";
      competitor.metric_evaluations[0].supersedes_metric_run_id = selected.source_metric_run_id;
      await computeSqlMetricRuns(appPool, competitor, true, { tenant_id: tenantId, app_id: appId });
      await assert.rejects(processMetricSchedules(appPool, tenantId, { now: nextClock }), /cycle_failed/);
      assert.equal((await metricReport(readerPool, reportIdentity, report(replacement.metric_schedule_id, "all"))).data.length, 0);
      const checkpoint = await withTenant(readerPool, tenantId, async client => (await client.query("SELECT last_target_date::text,pending_target_date::text,safe_reason FROM control.metric_schedule_checkpoints WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3", [tenantId, appId, replacement.metric_schedule_id])).rows[0]);
      assert.equal(checkpoint.last_target_date, null); assert.equal(checkpoint.pending_target_date, "2026-08-01");
      assert.equal(checkpoint.safe_reason, "calculation_unavailable");
    });

    it("serializes disablement with a claim without deleting a claimed checkpoint", async () => {
      const source = await fresh(false);
      const [, claimed] = await Promise.all([
        disableMetricSchedule({ pool: appPool, identity: reportIdentity, metricScheduleId: source.metric_schedule_id, now: clock }),
        claimNextScheduledDate(appPool, source, clock),
      ]);
      assert.equal(await claimNextScheduledDate(appPool, source, clock), undefined);
      const checkpoint = await withTenant(readerPool, tenantId, async client => (await client.query("SELECT pending_target_date::text FROM control.metric_schedule_checkpoints WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3", [tenantId, appId, source.metric_schedule_id])).rows[0]);
      assert.equal(checkpoint.pending_target_date, claimed?.targetDate ?? null);
    });

    it("adopts a pre-provenance historical run only through its complete deterministic schedule identity", async () => {
      const source = await fresh(false);
      const input = buildScheduledMetricInput(source, { targetDate: "2026-08-01", watermark: "2026-08-10T00:00:00.000Z", definitionDigest: source.definition_digest });
      delete input.metric_evaluations[0].metric_schedule;
      const [run] = await computeSqlMetricRuns(appPool, input, true, { tenant_id: tenantId, app_id: appId });
      await withTenant(appPool, tenantId, client => client.query("UPDATE control.metric_schedule_checkpoints SET last_target_date='2026-08-01' WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3", [tenantId, appId, source.metric_schedule_id]));
      assert.equal((await metricReport(readerPool, reportIdentity, report(source.metric_schedule_id))).data.length, 0);
      const request = { mode: "new_series", schedule: body };
      const preview = await previewMetricScheduleReplacement(readerPool, reportIdentity, source.metric_schedule_id, request, clock);
      assert.deepEqual(preview.source_runs.map(row => row.source_metric_run_id), [run.metric_run_id]);
      await replaceMetricSchedule(appPool, reportIdentity, source.metric_schedule_id, { ...request, preview_digest: preview.preview_digest }, clock);
      assert.deepEqual((await metricReport(readerPool, reportIdentity, report(source.metric_schedule_id, "all"))).data.map(row => row.metric_run_id), [run.metric_run_id]);
      assert.equal(jcs(await stored(run.metric_run_id)), jcs(run));
    });
  });

  it("dated_FX_schedule_executes_captured_multi_currency_rates_and_checkpoint_replay_without_latest_lookup", async () => {
    const scope = { tenantId: "tenant-fx-schedule", appId: "app-fx-schedule", keyId: "synthetic-fx-schedule", role: "admin" as const };
    const source = JSON.parse(readFileSync("fixtures/v0.4/69-dated-fx-cohorts/input.json", "utf8"),
      (key, value) => key === "tenant_id" ? scope.tenantId : key === "app_id" ? scope.appId : value);
    await ingestFixture("fx69-schedule", source, appPool, seedPool);
    const body = JSON.parse(readFileSync("examples/synthetic/metric-dated-fx-schedule.json", "utf8"));
    const now = new Date("2026-08-13T06:00:00.000Z");
    const registered = await registerMetricSchedule({ pool: appPool, identity: scope, body, now });
    assert.deepEqual(registered.definition.fx_policy, source.fx_policy);
    assert.deepEqual(await processMetricSchedules(appPool, scope.tenantId, { now, maximumCatchupDates: 1 }),
      { schedules: 1, completedDates: 1, replayedDates: 0, failedSchedules: 0 });
    const query = { tenantId: scope.tenantId, appId: scope.appId, metricScheduleId: registered.metric_schedule_id,
      supersession: "all" as const, limit: 200 };
    const page = await metricReport(readerPool, scope, query);
    assert.deepEqual(Object.fromEntries(page.data.map(row => [row.metric_name, row.value_unscaled])), {
      d0_roas: "1000000", d7_roas: "1681819", cohort_ltv_d1_usd: "3700004", retention_d1: "1000000", cohort_install_count: "1",
    });
    for (const row of page.data) {
      assert.equal(row.input_received_at_watermark, "2026-08-13T00:00:00.000Z");
      assert.equal(row.grouping?.cohort_date, "2026-08-06");
      if (row.fx_conversion_snapshot) {
        assert.equal(row.fx_conversion_snapshot.snapshot_id, sha256Jcs(source.fx_policy));
        assert.deepEqual(row.comparison_context!.fx, source.fx_policy);
      }
    }
    // A later caller mutation is not a replacement of the registered immutable schedule.
    body.fx_policy.rates[0].rate_unscaled = "24";
    assert.equal((await processMetricSchedules(appPool, scope.tenantId, { now, maximumCatchupDates: 1 })).completedDates, 0);
    assert.equal(jcs(await metricReport(readerPool, scope, query)), jcs(page));
    await disableMetricSchedule({ pool: appPool, identity: scope, metricScheduleId: registered.metric_schedule_id, now });
  });

  it("calendar_schedule_captures_local_cohort_date_and_midnight_watermark_and_replays_without_changes", async () => {
    const scope = { tenantId: "tenant-calendar", appId: "app-calendar", keyId: "synthetic-calendar-schedule", role: "admin" as const };
    const source = JSON.parse(readFileSync("fixtures/v0.4/68-calendar-acquisition-cohorts/input.json","utf8"),
      (key,value) => key === "tenant_id" ? scope.tenantId : key === "app_id" ? scope.appId : value);
    await ingestFixture("calendar68-schedule",source,appPool,seedPool);
    await persistSyntheticPlatformResults(appPool,source);
    const body = JSON.parse(readFileSync("examples/synthetic/metric-calendar-schedule.json","utf8"));
    body.lag_days = 11;
    const now = new Date("2026-08-17T06:00:00.000Z");
    const registered = await registerMetricSchedule({pool:appPool,identity:scope,body,now});
    assert.equal(registered.definition.cohort_time_zone,"America/New_York");
    assert.deepEqual(await processMetricSchedules(appPool,scope.tenantId,{now,maximumCatchupDates:1}),
      {schedules:1,completedDates:1,replayedDates:0,failedSchedules:0});
    const query = {tenantId:scope.tenantId,appId:scope.appId,metricScheduleId:registered.metric_schedule_id,
      supersession:"all" as const,limit:200};
    const report = await metricReport(readerPool,scope,query);
    assert.equal(report.data.length,3);
    assert.deepEqual(Object.fromEntries(report.data.map(row=>[row.metric_name,row.value_unscaled])),{
      calendar_ny_d7_roas:"15500000",calendar_ny_cohort_ltv_d7_usd:"31000000",calendar_ny_retention_d7:"1000000",
    });
    for (const row of report.data) {
      assert.equal(row.aggregation_time_zone,"America/New_York");
      assert.equal(row.grouping?.cohort_date,"2026-08-06");
      assert.equal(row.input_received_at_watermark,"2026-08-17T04:00:00.000Z");
    }
    const before = jcs(report);
    assert.equal((await processMetricSchedules(appPool,scope.tenantId,{now,maximumCatchupDates:1})).completedDates,0);
    assert.equal(jcs(await metricReport(readerPool,scope,query)),before);
    await disableMetricSchedule({pool:appPool,identity:scope,metricScheduleId:registered.metric_schedule_id,now});
  });
});
