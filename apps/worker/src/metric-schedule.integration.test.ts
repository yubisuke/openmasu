import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createAppPool,
  createSeedPool,
  EncryptedFilePayloadStore,
  withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { buildDashboardView } from "../../api/src/dashboard/view.js";
import { parseMetricQuery } from "../../api/src/report-query.js";
import { metricReport } from "../../api/src/reporting.js";
import { createRequestHandler } from "../../api/src/router.js";
import { ingestFixture } from "./ingestion.js";
import { processMetricSchedules } from "./metric-schedule-worker.js";

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
    await ensureAdminKeys(appPool, { tenantId, appId }, [adminKey]);
    api = createServer(createRequestHandler({
      pool: appPool,
      readerPool: appPool,
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
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43_200 },
    }));
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  after(async () => {
    api.close();
    await once(api, "close");
    await Promise.all([appPool.end(), seedPool.end()]);
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
});
