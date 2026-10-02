import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, after, describe, it } from "node:test";
import { createAppPool, createReaderPool, createSeedPool, withTenant } from "@openmasu/runtime";
import { sha256 } from "@openmasu/attribution-core";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { costArtifact, persistCostImport } from "./import/cost.js";
import { requestMetricRecalculation, listMetricRecalculations } from "../../api/src/metric-recalculations.js";
import { metricReport } from "../../api/src/reporting.js";
import { buildDashboardView } from "../../api/src/dashboard/view.js";
import { renderDashboard } from "../../api/src/dashboard/render.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { reportToSnapshot } from "../../../tools/report-to-snapshot.js";
import { compareSnapshots } from "../../../tools/compare-cohorts.js";
import type { Pool } from "pg";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { createRequestHandler } from "../../api/src/router.js";

type Any = Record<string, any>;
const app = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
let input: Any, tenantId: string, identity: { tenantId: string; appId: string; keyId: string; role: "admin" };
let old: Any[], request: Any;
const oldId = "synthetic-correction-JP:d7_roas";
describe("bounded cost correction recalculation", { concurrency: false }, () => {
  beforeEach(async () => {
    tenantId = `tenant-correction-${randomBytes(6).toString("hex")}`;
    identity = { tenantId, appId: "app-a", keyId: "synthetic-correction", role: "admin" };
    input = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8").replaceAll('"tenant-a"', JSON.stringify(tenantId)));
    // These are copied synthetic inputs, not changed goldens. A new tenant is
    // part of the cost key; derive it rather than retaining the original key.
    for (const cost of input.cost_records) cost.dimension_digest = costArtifact(cost, cost.report_snapshot_digest).dimension_digest;
    const base = input.metric_evaluations[0];
    input.metric_evaluations = ["JP", "GB"].map(country => ({ ...structuredClone(base),
      metric_names: ["d7_roas"], metric_run_id_prefix: `synthetic-correction-${country}`,
      grouping: { ...base.grouping, country } }));
    await ingestFixture(`synthetic-correction-${tenantId}`, input, app, seed);
    old = await computeSqlMetricRuns(app, input, true);
    const cost = await persistCostImport(app, "synthetic-correction", [{ tenant_id: tenantId, app_id: "app-a",
      network: "synthetic-network", campaign_id: "provider-campaign-33", country: "JP", date: "2026-08-01",
      amount_unscaled: "200000000", amount_scale: 6, currency: "USD", source: "imported_reported", as_of: "2026-08-10T00:00:00.000Z" }]);
    request = { cost_import_run_id: cost.import_run_id, date_from: "2026-08-01", date_to: "2026-08-01",
      watermark: "2026-08-11T00:00:00.000Z", metric_names: ["d7_roas"] };
  });
  after(async () => { await Promise.all([app.end(), reader.end(), seed.end()]); });
  async function report(history: "latest" | "all" = "all", watermarkAtMost?: string) {
    return metricReport(reader, identity, { tenantId, appId: "app-a", metricNames: ["d7_roas"], supersession: history, limit: 200,
      ...(watermarkAtMost ? { watermarkAtMost } : {}) });
  }
  async function artifacts() { return withTenant(app, tenantId, async client =>
    (await client.query<{ artifact: Any }>("SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id", [tenantId, "app-a"])).rows.map(row => row.artifact)); }

  it("selects only affected cohorts, shows revised and pending states, and preserves old and new ROAS snapshots", async () => {
    const initial = await report();
    assert.equal(initial.data.find(row => row.metric_run_id === oldId)?.cost_update_state, "input_revised");
    assert.equal((await report("all", "2026-08-09T00:00:00.000Z")).data.find(row => row.metric_run_id === oldId)?.cost_update_state, "no_recorded_revision");
    const job = await requestMetricRecalculation(app, identity, request);
    assert.equal(job.selected_runs, 1);
    const pending = await report();
    assert.equal(pending.data.find(row => row.metric_run_id === oldId)?.cost_update_state, "recalculation_pending");
    const html = renderDashboard(buildDashboardView({ apps: [], selectedAppId: "app-a", metrics: pending, csrfToken: "synthetic" }));
    assert.match(html, /Cost input revised; recalculation pending/);
    assert.deepEqual(await processMetricRecalculations(app, tenantId), { completed: 1, skipped: 0, fenced: 0, failed: 0 });
    const history = await report(), changed = history.data.find(row => row.supersedes_metric_run_id === oldId)!;
    assert.equal(changed.value_unscaled, "750000");
    assert.equal(changed.data_freshness, "recalculated");
    assert.equal(changed.cost_update_state, "no_recorded_revision");
    assert.notEqual(changed.input_snapshot_id, old.find(row => row.metric_run_id === oldId)!.input_snapshot_id);
    assert.equal(history.data.find(row => row.metric_run_id === oldId)?.value_unscaled, "1500000");
    assert.equal(history.data.find(row => row.metric_run_id === oldId)?.superseded, true);
    assert.equal(history.data.find(row => row.metric_run_id === "synthetic-correction-GB:d7_roas")?.superseded, false);
    const stored = await artifacts();
    for (const prior of old) assert.equal(sha256(stored.find(row => row.metric_run_id === prior.metric_run_id)), sha256(prior));
    assert.equal((await report("latest")).data.length, 2);
    const statuses = await listMetricRecalculations(reader, identity);
    assert.equal(statuses[0].state, "completed"); assert.equal(statuses[0].replacement_metric_run_id, changed.metric_run_id);
    assert.doesNotMatch(JSON.stringify(statuses), /replay_digest|evidence_refs|installation_id|record_id|fx_policy|lease_token/);
  });

  it("makes duplicate requests, concurrent workers and committed replay produce exactly one replacement", async () => {
    const job = await requestMetricRecalculation(app, identity, request);
    assert.equal((await requestMetricRecalculation(app, identity, request)).recalculation_id, job.recalculation_id);
    const outcomes = await Promise.all([processMetricRecalculations(app, tenantId), processMetricRecalculations(app, tenantId)]);
    assert.equal(outcomes.reduce((sum, row) => sum + row.completed, 0), 1);
    assert.equal((await requestMetricRecalculation(app, identity, request)).replayed, true);
    assert.equal((await processMetricRecalculations(app, tenantId)).completed, 0);
    assert.equal((await artifacts()).filter(row => row.supersedes_metric_run_id === oldId).length, 1);
  });

  it("connects the authenticated operation and reader-only status routes without giving read-only keys write authority", async () => {
    const key = "synthetic-correction-api-key-at-least-thirty-two-bytes";
    const readKey = "synthetic-correction-read-key-at-least-thirty-two-bytes";
    await ensureAdminKeys(app, identity, [{ key, role: "operator" }, { key: readKey, role: "read_only" }]);
    const server = createServer(createRequestHandler({ pool: app, readerPool: reader,
      payloadStore: { write: async () => "encrypted:synthetic", read: async () => Buffer.alloc(32), purge: async () => {}, scanFor: async () => false },
      maxConfig: { tenantId, appId: "app-a", pathSecret: "synthetic-path", eventKey: "synthetic-event", tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43_200 } }));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/apps/app-a/metric-recalculations`;
    try {
      const submit = (token: string) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(request) });
      assert.equal((await submit(readKey)).status, 403);
      assert.equal((await submit(key)).status, 202);
      const result = await fetch(url, { headers: { authorization: `Bearer ${readKey}` } });
      assert.equal(result.status, 200); assert.match(await result.text(), /"state":"queued"/);
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url.replace("app-a", "app-unrelated"), { headers: { authorization: `Bearer ${readKey}` } })).status, 404);
      await assert.rejects(withTenant(reader, tenantId, client => client.query("UPDATE control.metric_recalculation_items SET attempts=0 WHERE tenant_id=$1", [tenantId])), /permission denied/);
    } finally { server.close(); await once(server, "close"); }
  });

  it("recovers an expired claim but never follows a different source revision on retry", async () => {
    const job = await requestMetricRecalculation(app, identity, request);
    await withTenant(app, tenantId, client => client.query(`UPDATE control.metric_recalculation_items SET state='processing',attempts=1,
      lease_token='01800000-0000-7000-8000-000000000000',lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND recalculation_id=$2`, [tenantId, job.recalculation_id]));
    assert.equal((await processMetricRecalculations(app, tenantId)).completed, 1);
    assert.equal((await listMetricRecalculations(reader, identity))[0].attempts, 2);
    assert.equal((await listMetricRecalculations(reader, identity))[0].cost_import_run_id, request.cost_import_run_id);
  });

  it("rolls back a failed publication and resumes the same bounded job without a duplicate run", async () => {
    const job = await requestMetricRecalculation(app, identity, request);
    let injected = false;
    const failingPool = { connect: async () => {
      const client = await app.connect(), execute = client.query.bind(client);
      return new Proxy(client, { get(target, key) {
        if (key === "query") return async (...args: any[]) => {
          if (!injected && typeof args[0] === "string" && args[0].includes("INSERT INTO control.metric_replay_manifests")) {
            injected = true; throw new Error("synthetic publication failure after run insertion");
          }
          return (execute as any)(...args);
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    } } as unknown as Pool;
    assert.equal((await processMetricRecalculations(failingPool, tenantId)).failed, 1);
    assert.equal(injected, true);
    assert.equal((await artifacts()).length, old.length);
    const checkpoint = (await listMetricRecalculations(reader, identity))[0];
    assert.equal(checkpoint.state, "retry"); assert.equal(checkpoint.safe_reason, "calculation_unavailable");
    await withTenant(app, tenantId, client => client.query(`UPDATE control.metric_recalculation_items
      SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND recalculation_id=$2`, [tenantId, job.recalculation_id]));
    assert.equal((await processMetricRecalculations(app, tenantId)).completed, 1);
    assert.equal((await artifacts()).filter(row => row.supersedes_metric_run_id === oldId).length, 1);
    assert.equal((await listMetricRecalculations(reader, identity))[0].attempts, 2);
  });

  it("refuses cross-tenant, premature-watermark and unavailable replay work without publishing a replacement", async () => {
    await assert.rejects(requestMetricRecalculation(app, { ...identity, tenantId: "tenant-other" }, request), /cost_revision_not_found/);
    await assert.rejects(requestMetricRecalculation(app, identity, { ...request, watermark: "2026-08-09T00:00:00.000Z" }), /watermark_before_revision/);
    const job = await requestMetricRecalculation(app, identity, request);
    await withTenant(app, tenantId, client => client.query("UPDATE control.metric_recalculation_items SET replay_digest=$3 WHERE tenant_id=$1 AND recalculation_id=$2", [tenantId, job.recalculation_id, "0".repeat(64)]));
    assert.equal((await processMetricRecalculations(app, tenantId)).failed, 1);
    assert.equal((await listMetricRecalculations(reader, identity))[0].safe_reason, "definition_changed");
    assert.equal((await artifacts()).length, old.length);
    assert.deepEqual(await listMetricRecalculations(reader, { ...identity, tenantId: "tenant-other" }), []);
  });

  it("retains redaction and retention boundaries and refuses an ordinary delta across changed privacy meaning", async () => {
    await requestMetricRecalculation(app, identity, request);
    await withTenant(app, tenantId, async client => {
      await client.query(`INSERT INTO ledger.raw_payload_states (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id)
        VALUES ($1,$2,'revenue-33-c','redacted','2026-08-10T12:00:00.000Z','privacy:synthetic-correction')`, [tenantId, "app-a"]);
      await client.query(`INSERT INTO ledger.raw_payload_states (tenant_id,app_id,record_id,lifecycle_status,changed_at)
        VALUES ($1,$2,'revenue-33-b','purged','2026-08-10T12:00:00.000Z')`, [tenantId, "app-a"]);
    });
    assert.equal((await processMetricRecalculations(app, tenantId)).completed, 1);
    const history = (await report()).data, replacement = history.find(row => row.supersedes_metric_run_id === oldId)!;
    assert.equal(replacement.reproducibility_status, "redaction_affected");
    assert.equal(replacement.value_unscaled, "250000"); // Per-event half-even: EUR 100.000001 * 0.5 => USD 50 / revised USD 200.
    const snapshot = (row: typeof replacement) => reportToSnapshot({ data: [row] }, { source: "synthetic-correction",
      conditions: { date_from: "2026-08-01", date_to: "2026-08-02", time_zone: "UTC", maturity: "unknown", aggregation: "cumulative",
        attribution_scope: "non_organic", metric_definition: "d7_roas@0.3.0", source_cutoff: row.input_received_at_watermark }, rows: [] });
    const comparison = compareSnapshots(snapshot(history.find(row => row.metric_run_id === oldId)!), snapshot(replacement));
    assert.equal(comparison.status, "incomparable");
    assert.equal((await artifacts()).find(row => row.metric_run_id === oldId)?.value_unscaled, "1500000");
  });
});
