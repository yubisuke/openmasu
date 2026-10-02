import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { jcs } from "@openmasu/attribution-core";
import { createAppPool, createReaderPool, createSeedPool, withTenant } from "@openmasu/runtime";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { metricReport } from "../../api/src/reporting.js";
import { createRequestHandler } from "../../api/src/router.js";
import { issueDashboardSession } from "../../api/src/session.js";
import { ingestFixture } from "./ingestion.js";
import { processMetricSchedules } from "./metric-schedule-worker.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { runMetricDefinitionsFile } from "./metrics/run.js";

type Any = Record<string, any>;

describe("first-party engagement operator workflow", { concurrency: false }, () => {
  const app = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
  let key: string, input: Any, acquisition: Any, config: Any, base: string, cookie: string, temporary: string;
  let identity: { tenantId: string; appId: string; keyId: string; role: "admin" };
  let server: ReturnType<typeof createServer> | undefined;
  const watermark = "2026-08-23T00:00:00.000Z";

  beforeEach(async () => {
    const tenantId = `tenant-engagement-${randomBytes(5).toString("hex")}`;
    key = `synthetic-engagement-${randomBytes(32).toString("base64url")}`;
    const fixture = (name: string) => JSON.parse(readFileSync(`fixtures/v0.4/${name}/input.json`, "utf8")
      .replaceAll('"tenant-a"', JSON.stringify(tenantId)));
    acquisition = fixture("63-selected-acquisition-detail");
    input = JSON.parse(JSON.stringify(fixture("64-first-party-engagement"))
      .replaceAll("installation-64-x", "installation:install-63-a")
      .replaceAll("installation-64-y", "installation:install-63-b"));
    // A matching installation string in another app/tenant is not an identity
    // join. These otherwise eligible outcomes must never inflate this scope.
    const foreignBatches = ["app", "tenant"].map(kind => {
      const batch = structuredClone(input.batches.find((entry: Any) => entry.records[0].record_id === "revenue64-a"));
      batch.batch_id += `-foreign-${kind}`;
      const record = batch.records[0];
      for (const field of ["record_id", "delivery_id", "event_id"]) record[field] += `-foreign-${kind}`;
      const field = kind === "app" ? "app_id" : "tenant_id";
      record[field] = batch.server_context[field] = kind === "app" ? "app-unrelated" : `${tenantId}-foreign`;
      return batch;
    });
    await ingestFixture(`synthetic-engagement-${tenantId}`, {
      ...input, cost_records: acquisition.cost_records, metric_evaluations: [],
      batches: [{ batch_id: "synthetic-original-acquisition", server_context: acquisition.server_context,
        records: acquisition.records }, ...input.batches, ...foreignBatches],
    }, app, seed);
    config = {
      tenant_id: tenantId, app_id: "app-a", fx_policy: input.fx_policy, metric_definitions: input.metric_definitions,
      evaluations: input.metric_evaluations.map((evaluation: Any) => ({
        metric_names: evaluation.metric_names, grouping: evaluation.grouping,
      })),
    };
    temporary = mkdtempSync(join(tmpdir(), "openmasu-synthetic-engagement-"));
    writeFileSync(join(temporary, "definitions.json"), JSON.stringify(config));
    const [keyId] = await ensureAdminKeys(app, { tenantId, appId: "app-a" }, [key]);
    identity = { tenantId, appId: "app-a", keyId: keyId!, role: "admin" };
    const session = await issueDashboardSession(app, tenantId, keyId!, 43_200);
    cookie = `openmasu_dashboard=${session.token}`;
    server = createServer(createRequestHandler({
      pool: app, readerPool: reader, privacySubjectDigestKey: "synthetic-engagement-privacy-key",
      payloadStore: { write: async () => "encrypted:synthetic", read: async () => Buffer.alloc(32), purge: async () => {}, scanFor: async () => false },
      maxConfig: { tenantId, appId: "app-a", pathSecret: "synthetic-engagement-path", eventKey: "synthetic-engagement-event",
        tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: true, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43_200 },
    }));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    if (server?.listening) { server.close(); await once(server, "close"); }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });
  after(async () => { await Promise.all([app.end(), reader.end(), seed.end()]); });

  const admin = (path: string, body?: unknown) => fetch(`${base}${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  });
  const page = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  const saved = () => withTenant(reader, identity.tenantId, async client => (await client.query<{ artifact: Any }>(
    "SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id",
    [identity.tenantId, identity.appId],
  )).rows.map(row => row.artifact));
  const values = (runs: Any[]) => Object.fromEntries(runs.map(run => [
    `${run.grouping.dimensions.campaign_id ?? "all"}/${run.metric_name}`,
    run.value_unscaled ?? run.undefined_reason,
  ]));
  const money = "engagement_ad_revenue_24h_usd", converters = "engagement_custom_event_converters_24h";

  it("runs explicit CLI definitions into separated API, HTML and identical CSV without rewriting install acquisition", async () => {
    const originals = await computeSqlMetricRuns(app, acquisition, true);
    const options = { pool: app, date: "2026-08-21", definitionsPath: join(temporary, "definitions.json") };
    const runs = await runMetricDefinitionsFile(options);
    const actual = values(runs);
    assert.equal(runs.length, 10);
    assert.equal(actual[`synthetic-engagement-a/${money}`], "2000000");
    assert.equal(actual[`synthetic-engagement-b/${money}`], "3000000");
    assert.equal(actual[`all/${money}`], "5000000");
    assert.equal(actual[`all/${converters}`], "1");
    assert.equal(actual[`synthetic-engagement-c/${money}`], "0");
    assert.equal(actual[`synthetic-engagement-empty/${money}`], "empty_cohort");
    assert.ok(runs.every(run => run.input_received_at_watermark === watermark));
    assert.equal(jcs(await runMetricDefinitionsFile({ ...options, persist: false })), jcs(runs));
    for (const original of originals) {
      assert.equal(jcs((await saved()).find(run => run.metric_run_id === original.metric_run_id)), jcs(original));
    }

    const query = new URLSearchParams({ app_id: "app-a", metric_definition_version: "0.4.17", grouping_metric_date: "2026-08-21", limit: "200" });
    const response = await admin(`/v1/reports/metrics?${query}`);
    assert.equal(response.status, 200);
    const report = await response.json() as { data: Any[] };
    assert.equal(report.data.length, 10);
    assert.ok(report.data.every(row => row.measurement_series === "first_party_engagement"
      && row.engagement_evidence_trust === "device_reported_forgeable"));
    const allHtmlResponse = await page("/dashboard/apps/app-a?limit=200");
    assert.equal(allHtmlResponse.status, 200);
    const html = await allHtmlResponse.text();
    const section = html.match(/<section aria-label="First-party engagement outcomes">[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(section, /Device-reported opens are forgeable/);
    assert.doesNotMatch(section, /data-metric-run-id="detail63-/);
    for (const row of report.data) {
      assert.ok(section.includes(`/metrics/${encodeURIComponent(row.metric_run_id)}/explanation`), `missing saved run ${row.metric_run_id}`);
      assert.equal(section.includes(`data-metric-run-id="${row.metric_run_id}"`), row.value_state === "present",
        "Only present values may carry numeric HTML data attributes");
    }
    assert.match(section, /class="undefined-value">—<\/span><small>empty_cohort<\/small>/);
    assert.match(html, /data-metric-run-id="detail63-/);
    query.set("format", "csv"); query.set("export", "true");
    const apiCsv = await admin(`/v1/reports/metrics?${query}`), dashboardCsv = await page(`/dashboard/apps/app-a/cohorts.csv?${query}`);
    assert.equal(apiCsv.status, 200); assert.equal(dashboardCsv.status, 200);
    const csv = await apiCsv.text();
    assert.equal(await dashboardCsv.text(), csv);
    assert.match(csv, /measurement_series,engagement_evidence_trust/);
    assert.match(csv, /first_party_engagement,device_reported_forgeable/);
    assert.match(csv, /empty_cohort/);
    const raw = await admin(`/v1/reports/records?app_id=app-a&metric_name=${money}&watermark_at_most=${watermark}`);
    assert.equal(raw.status, 400); assert.deepEqual(await raw.json(), { error: "raw_metric_unsupported" });
    query.set("app_id", "app-unrelated");
    assert.equal((await admin(`/v1/reports/metrics?${query}`)).status, 404);
    assert.equal((await metricReport(reader, { ...identity, tenantId: "tenant-unrelated" }, {
      tenantId: "tenant-unrelated", appId: "app-a", supersession: "latest", limit: 200,
    })).data.length, 0);
  });

  it("retries scheduled engagement dates idempotently and recalculates after privacy removal without resurrection", async () => {
    const registration = await admin("/v1/admin/apps/app-a/metric-schedules", {
      lag_days: 2, start_date: "2026-08-21", fx_policy: input.fx_policy, metric_definitions: input.metric_definitions,
      evaluations: config.evaluations.map((evaluation: Any) => {
        const { metric_date: _date, ...grouping } = evaluation.grouping;
        return { metric_names: evaluation.metric_names, date_dimension: "metric_date", grouping };
      }),
    });
    assert.equal(registration.status, 201, await registration.text());
    const now = new Date(watermark);
    assert.deepEqual(await processMetricSchedules(app, identity.tenantId, { now }),
      { schedules: 1, completedDates: 1, replayedDates: 0, failedSchedules: 0 });
    assert.equal((await processMetricSchedules(app, identity.tenantId, { now })).completedDates, 0);
    const originals = await saved(); assert.equal(originals.length, 10);
    const manifests = await withTenant(app, identity.tenantId, async client => (await client.query<{ artifact: Any }>(
      "SELECT artifact FROM control.metric_replay_manifests WHERE tenant_id=$1 AND app_id=$2", [identity.tenantId, identity.appId],
    )).rows);
    assert.equal(manifests.length, 10);
    assert.ok(manifests.every(row => row.artifact.metric_definition.engagement_credit_policy === "latest_eligible_open_before_outcome"));
    const deletion = await admin("/v1/admin/privacy-requests", {
      tenant_id: identity.tenantId, app_id: identity.appId, requested_via: "tenant_admin_api",
      deletion_scope: "installation", deletion_subject_ref: "installation:install-63-a",
    });
    assert.equal(deletion.status, 201);
    const result = await deletion.json() as Any;
    assert.equal(result.status, "completed");
    assert.ok(result.affected_records.some((record: Any) => record.record_id === "open64-a"));
    assert.ok(result.affected_records.some((record: Any) => record.record_id === "open64-b"));
    const recalculated = await runMetricDefinitionsFile({ pool: app, date: "2026-08-21",
      definitionsPath: join(temporary, "definitions.json"), watermark: "2026-08-24T00:00:00.000Z" });
    const actual = values(recalculated);
    for (const metric of [money, converters]) {
      assert.equal(actual[`synthetic-engagement-a/${metric}`], "empty_cohort");
      assert.equal(actual[`synthetic-engagement-b/${metric}`], "empty_cohort");
      assert.equal(actual[`all/${metric}`], "0");
      assert.equal(actual[`synthetic-engagement-c/${metric}`], "0");
    }
    assert.ok(recalculated.every(run => run.reproducibility_status === "redaction_affected"));
    const all = await saved();
    assert.equal(all.length, 20);
    for (const original of originals) assert.equal(jcs(all.find(run => run.metric_run_id === original.metric_run_id)), jcs(original));
  });
});
