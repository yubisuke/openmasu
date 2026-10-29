import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { jcs, type CandidateAttempt } from "@openmasu/attribution-core";
import { createAppPool, createReaderPool, createSeedPool, withTenant } from "@openmasu/runtime";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { requestMetricRecalculation } from "../../api/src/metric-recalculations.js";
import { metricReport } from "../../api/src/reporting.js";
import { createRequestHandler } from "../../api/src/router.js";
import { csrfToken, issueDashboardSession } from "../../api/src/session.js";
import { persistCostImport, type CostInput } from "./import/cost.js";
import { ingestRuntimeBatch } from "./ingestion.js";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { processMetricSchedules } from "./metric-schedule-worker.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { costJoinabilityReport } from "../../api/src/cost-joinability.js";

type Any = Record<string, any>;

describe("selected acquisition detail operator workflow", { concurrency: false }, () => {
  const app = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
  const origin = "http://localhost:8080";
  let key: string, input: Any, costs: Any[], base: string, cookie: string, csrf: string;
  let identity: { tenantId: string; appId: string; keyId: string; role: "admin" };
  let server: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    const tenantId = `tenant-detail-${randomBytes(5).toString("hex")}`;
    key = `synthetic-acquisition-detail-${randomBytes(32).toString("base64url")}`;
    input = JSON.parse(readFileSync("fixtures/v0.4/63-selected-acquisition-detail/input.json", "utf8")
      .replaceAll('"tenant-a"', JSON.stringify(tenantId)));
    costs = input.cost_records;
    // Both original and corrected costs use the importer's scoped dimension keys.
    await ingestFixture(`synthetic-detail-${tenantId}`, { ...input, cost_records: [], metric_evaluations: [] }, app, seed);
    await persistCostImport(app, "synthetic-detail-original", costs as any);
    const [keyId] = await ensureAdminKeys(app, { tenantId, appId: "app-a" }, [key]);
    identity = { tenantId, appId: "app-a", keyId: keyId!, role: "admin" };
    const session = await issueDashboardSession(app, tenantId, keyId!, 43_200);
    cookie = `openmasu_dashboard=${session.token}`; csrf = csrfToken(session.token);
    server = createServer(createRequestHandler({
      pool: app, readerPool: reader,
      payloadStore: { write: async () => "encrypted:synthetic", read: async () => Buffer.alloc(32), purge: async () => {}, scanFor: async () => false },
      maxConfig: { tenantId, appId: "app-a", pathSecret: "synthetic-detail-path", eventKey: "synthetic-detail-event",
        tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
      publicBaseUrl: origin, redirectorBaseUrl: "http://localhost:8090",
      trackingDestinationAllowlist: ["https://example.invalid"],
      dashboard: { enabled: true, publicBaseUrl: origin, tenantId, sessionTtlSeconds: 43_200 },
    }));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { if (server?.listening) { server.close(); await once(server, "close"); } });
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

  it("reader_cost_joinability_uses_selected_native_keys_cutoff_and_current_privacy_without_rewriting_metrics", async () => {
    await computeSqlMetricRuns(app, input, true);
    const original = jcs(await saved());
    const query = { date_from: "2026-08-06", date_to: "2026-08-07", watermark_at_most: "2026-08-13T00:00:00.000Z" };
    const report = await costJoinabilityReport(reader, identity, query);
    assert.equal(report.acquisition_basis, "selected_first_party_click");
    assert.equal(report.upstream_completeness, "unknown");
    assert.equal(report.dimensions.find(row => row.dimension === "creative_id")!.both_observed_exact_key, 2);
    assert.equal(report.dimensions.find(row => row.dimension === "creative_id")!.missing_acquisition_dimension, 0,
      "both selected clicks in fixture 63 have complete synthetic creative dimensions");
    assert.equal((await costJoinabilityReport(reader, identity, { ...query, watermark_at_most: "2026-08-01T00:00:00.000Z" })).current_cost_rows, 0);
    const parent: CostInput = { ...(costs[0] as CostInput), ad_group_id: undefined, creative_id: undefined,
      as_of: "2026-08-12T12:00:00.000Z", amount_unscaled: "30000000" };
    await persistCostImport(app, "synthetic-parent-observation", [parent]);
    const withParent = await costJoinabilityReport(reader, identity, query);
    assert.equal(withParent.coverage.parent_grain, 1);
    assert.equal(withParent.coverage.overlapping_unrestricted_grains, true);
    const readKey = `synthetic-cost-diagnostic-reader-${randomBytes(32).toString("base64url")}`;
    await ensureAdminKeys(app, identity, [{ key: readKey, role: "read_only" }]);
    const counts = () => withTenant(reader, identity.tenantId, async client => (await client.query(
      `SELECT (SELECT count(*)::integer FROM ledger.cost_records WHERE tenant_id=$1) AS costs,
        (SELECT count(*)::integer FROM ledger.metric_runs WHERE tenant_id=$1) AS metrics,
        (SELECT count(*)::integer FROM ledger.audit_logs WHERE tenant_id=$1) AS audits`, [identity.tenantId])).rows[0]);
    const before = await counts();
    const route = `/v1/admin/apps/app-a/cost-joinability?${new URLSearchParams(query)}`;
    assert.equal((await fetch(`${base}${route}`)).status, 401);
    const response = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${readKey}` } });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), withParent);
    const htmlResponse = await page(`/dashboard/apps/app-a/cost-joinability?${new URLSearchParams(query)}`);
    assert.equal(htmlResponse.status, 200); const html = await htmlResponse.text();
    assert.match(html, /parent_grain/); assert.match(html, /not historical cutoff evidence/);
    assert.equal((await admin(`${route}&installation_id=forbidden`)).status, 400);
    assert.equal((await admin(route.replace("apps/app-a", "apps/another-app"))).status, 404);
    assert.equal((await costJoinabilityReport(reader, { ...identity, tenantId: "tenant-unrelated" }, query)).native_installations, 0);
    assert.deepEqual(await counts(), before); assert.equal(jcs(await saved()), original);
    const selectedClick = input.records.find((row: Any) => row.event_name === "click" && row.payload.creative_id === "synthetic-creative-a");
    assert.ok(selectedClick);
    await withTenant(app, identity.tenantId, client => client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at) VALUES ($1,$2,$3,'redacted',$4)`,
      [identity.tenantId, identity.appId, selectedClick.record_id, "2026-08-14T00:00:00.000Z"]));
    const afterPrivacy = await costJoinabilityReport(reader, identity, query);
    assert.ok(afterPrivacy.dimensions.find(row => row.dimension === "creative_id")!.both_observed_exact_key
      < withParent.dimensions.find(row => row.dimension === "creative_id")!.both_observed_exact_key);
    assert.equal(jcs(await saved()), original, "current privacy removes selected source semantics without rewriting historical artifacts");
  });

  it("preserves detail selection across API, HTML and identical CSV, and captures link dimensions in the existing form", async () => {
    await computeSqlMetricRuns(app, input, true);
    const query = new URLSearchParams({ app_id: "app-a", grouping_ad_group_id: "synthetic-group-a", grouping_creative_id: "synthetic-creative-a",
      grouping_cohort_date: "2026-08-06", metric_definition_version: "0.4.16", limit: "200" });
    const response = await admin(`/v1/reports/metrics?${query}`);
    assert.equal(response.status, 200);
    const report = await response.json() as { data: Any[] };
    assert.equal(report.data.length, 5);
    assert.ok(report.data.every(row => row.grouping.ad_group_id === "synthetic-group-a"
      && row.grouping.creative_id === "synthetic-creative-a"));
    assert.equal(report.data.find(row => row.metric_name === "d30_total_net_roas")?.value_unscaled, "2600000");
    const htmlResponse = await page(`/dashboard/apps/app-a?${query}`);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, /name="grouping_ad_group_id"[^>]*value="synthetic-group-a"/);
    assert.match(html, /name="grouping_creative_id"[^>]*value="synthetic-creative-a"/);
    for (const row of report.data) assert.ok(html.includes(`data-metric-run-id="${row.metric_run_id}"`));
    assert.doesNotMatch(html, /data-metric-run-id="detail63-b:/);
    query.set("format", "csv"); query.set("export", "true");
    const apiCsv = await admin(`/v1/reports/metrics?${query}`);
    const dashboardCsv = await page(`/dashboard/apps/app-a/cohorts.csv?${query}`);
    assert.equal(apiCsv.status, 200); assert.equal(dashboardCsv.status, 200);
    assert.equal(await dashboardCsv.text(), await apiCsv.text());

    // Raw daily counts have no saved selected-acquisition detail meaning. They
    // must reject this filter instead of returning an unrelated count as zero.
    const raw = await admin("/v1/reports/records?app_id=app-a&grouping_creative_id=synthetic-creative-a&watermark_at_most=2026-08-12T00%3A00%3A00.000Z");
    assert.equal(raw.status, 400); assert.deepEqual(await raw.json(), { error: "raw_metric_unsupported" });
    const unknownApp = new URLSearchParams(query); unknownApp.set("app_id", "app-unrelated");
    assert.equal((await admin(`/v1/reports/metrics?${unknownApp}`)).status, 404);
    assert.equal((await metricReport(reader, { ...identity, tenantId: "tenant-unrelated" }, {
      tenantId: "tenant-unrelated", appId: "app-a", supersession: "latest", limit: 200,
    })).data.length, 0);

    const created = await fetch(`${base}/dashboard/apps/app-a/tracking-links`, {
      method: "POST", headers: { cookie, origin }, redirect: "manual",
      body: new URLSearchParams({ csrf_token: csrf, destination_kind: "custom_https", destination_url: "https://example.invalid/measure",
        campaign_id: "synthetic-ui-campaign", network: "synthetic-network", ad_group_id: "synthetic-ui-group", creative_id: "synthetic-ui-creative" }),
    });
    assert.equal(created.status, 201, await created.text());
    const links = await page("/dashboard/apps/app-a/tracking-links");
    assert.equal(links.status, 200);
    const linkHtml = await links.text();
    assert.match(linkHtml, /synthetic-ui-group/); assert.match(linkHtml, /synthetic-ui-creative/);
    assert.match(linkHtml, /name="ad_group_id"/); assert.match(linkHtml, /name="creative_id"/);
  });

  it("schedules explicit detail profiles and recalculates only affected creative and campaign grains without rewriting history", async () => {
    const registration = await admin("/v1/admin/apps/app-a/metric-schedules", {
      lag_days: 6, start_date: "2026-08-06", fx_policy: input.fx_policy, metric_definitions: input.metric_definitions,
      evaluations: input.metric_evaluations.map((evaluation: Any) => {
        const { cohort_date: _date, ...grouping } = evaluation.grouping;
        return { metric_names: evaluation.metric_names, date_dimension: "cohort_date", grouping };
      }),
    });
    assert.equal(registration.status, 201, await registration.text());
    const now = new Date("2026-08-12T00:00:00.000Z");
    assert.deepEqual(await processMetricSchedules(app, identity.tenantId, { now }),
      { schedules: 1, completedDates: 1, replayedDates: 0, failedSchedules: 0 });
    assert.equal((await processMetricSchedules(app, identity.tenantId, { now })).completedDates, 0);
    const originals = await saved(); assert.equal(originals.length, 15);
    const manifests = await withTenant(app, identity.tenantId, async client => (await client.query<{ artifact: Any }>(
      "SELECT artifact FROM control.metric_replay_manifests WHERE tenant_id=$1 AND app_id=$2", [identity.tenantId, identity.appId],
    )).rows);
    assert.equal(manifests.length, 15);
    assert.ok(manifests.every(row => row.artifact.metric_definition.acquisition_dimension_policy === "selected_link_ad_group_creative"));

    const correction = await persistCostImport(app, "synthetic-detail-correction", [{ ...costs[0],
      amount_unscaled: "20000000", as_of: "2026-08-13T00:00:00.000Z" } as any]);
    const range = { date_from: "2026-08-06", date_to: "2026-08-06", metric_names: ["d7_roas", "d30_total_net_roas"] };
    const costRequest = { ...range, cost_import_run_id: correction.import_run_id, watermark: "2026-08-13T00:00:00.000Z" };
    const revised = await metricReport(reader, identity, { ...identity, supersession: "latest", limit: 200 });
    assert.equal(revised.data.filter(row => row.cost_update_state === "input_revised").length, 4);
    assert.ok(revised.data.filter(row => row.grouping?.creative_id === "synthetic-creative-b")
      .every(row => row.cost_update_state !== "input_revised"));
    assert.equal((await requestMetricRecalculation(app, identity, costRequest)).selected_runs, 4);
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 4);
    const latestValues = async () => (await metricReport(reader, identity, {
      ...identity, supersession: "latest", limit: 200, metricNames: range.metric_names,
    })).data.map(row => [row.grouping?.creative_id ?? "campaign", row.metric_name, row.value_unscaled]).sort();
    assert.deepEqual(await latestValues(), [
      ["campaign", "d30_total_net_roas", "1950000"], ["campaign", "d7_roas", "1500000"],
      ["synthetic-creative-a", "d30_total_net_roas", "1300000"], ["synthetic-creative-a", "d7_roas", "1000000"],
      ["synthetic-creative-b", "d30_total_net_roas", "2600000"], ["synthetic-creative-b", "d7_roas", "2000000"],
    ]);

    const history: CandidateAttempt[] = input.records.map((record: Any) => ({ server: input.server_context, record, batch_id: "synthetic-detail-initial" }));
    const revenue = input.records.find((record: Any) => record.record_id === "revenue-63-a");
    const receivedAt = "2026-08-14T00:00:00.000Z";
    const attempt: CandidateAttempt = {
      server: { ...input.server_context, received_at: receivedAt }, batch_id: "synthetic-detail-late",
      record: { ...structuredClone(revenue), record_id: "synthetic-detail-late", delivery_id: "synthetic-detail-late",
        event_id: "synthetic-detail-late", received_at: receivedAt, payload: { ...revenue.payload, amount_unscaled: "10000000" } },
    };
    assert.equal((await ingestRuntimeBatch([attempt], app, history)).rejections.length, 0);
    const lateRequest = { ...range, trigger_kind: "late_events", source_record_ids: [attempt.record.record_id], watermark: receivedAt };
    assert.equal((await requestMetricRecalculation(app, identity, lateRequest)).selected_runs, 4);
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 4);
    assert.deepEqual(await latestValues(), [
      ["campaign", "d30_total_net_roas", "2200000"], ["campaign", "d7_roas", "1750000"],
      ["synthetic-creative-a", "d30_total_net_roas", "1800000"], ["synthetic-creative-a", "d7_roas", "1500000"],
      ["synthetic-creative-b", "d30_total_net_roas", "2600000"], ["synthetic-creative-b", "d7_roas", "2000000"],
    ]);
    assert.equal((await requestMetricRecalculation(app, identity, lateRequest)).replayed, true);
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 0);
    const all = await saved(); assert.equal(all.length, 23);
    for (const original of originals) assert.equal(jcs(all.find(row => row.metric_run_id === original.metric_run_id)), jcs(original));
    assert.ok(all.filter(row => row.supersedes_metric_run_id)
      .every(row => row.grouping.dimensions.creative_id !== "synthetic-creative-b"));
  });
});
