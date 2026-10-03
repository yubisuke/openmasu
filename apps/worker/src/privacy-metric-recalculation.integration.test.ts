import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { jcs, sha256 } from "@openmasu/attribution-core/canonical";
import { createAppPool, createReaderPool, createSeedPool, PayloadNotFoundError,
  processPrivacyDeletionJobs, uuidV7, withTenant } from "@openmasu/runtime";
import { parseCsv as readCsv } from "@openmasu/runtime/import-normalization";
import { executePrivacyRequest, privacySubjectDigest, type PrivacyRequestBody } from "../../api/src/privacy.js";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { createRequestHandler } from "../../api/src/router.js";
import { metricReport, encodeMetricReport } from "../../api/src/reporting.js";
import { metricExplanation } from "../../api/src/metric-explanation.js";
import { listMetricRecalculations } from "../../api/src/metric-recalculations.js";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns, persistMetricRun } from "./metrics/cohort.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { reapplyCompletedPrivacyRequests } from "./privacy-reapply.js";

type Any = Record<string, any>;
describe("privacy metric correction through the existing durable worker", { concurrency: false }, () => {
  const app = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
  let tenantId: string, input: Any, originals: Any[], foreign: Any[], payloadRef: string;
  let stalled: boolean, readable: boolean;
  const completedAt = "2026-08-25T00:00:00.000Z";
  const identity = () => ({ tenantId, appId: "app-a", keyId: "synthetic-privacy-admin", role: "admin" as const });
  const payloadStore = {
    write: async () => payloadRef,
    read: async (reference: string) => {
      if (reference === payloadRef && readable) return Buffer.from("synthetic privacy metric payload");
      throw new PayloadNotFoundError(reference);
    },
    purge: async (reference: string) => {
      if (stalled) throw new Error("synthetic purge interruption");
      if (reference === payloadRef) readable = false;
    },
    scanFor: async () => false,
  };
  const fixture = (name: string) => JSON.parse(readFileSync(`fixtures/v0.4/${name}/input.json`, "utf8")
    .replaceAll('"tenant-a"', JSON.stringify(tenantId)));
  beforeEach(async () => {
    tenantId = `tenant-privacy-metric-${randomBytes(5).toString("hex")}`;
    stalled = false; readable = true; payloadRef = `encrypted:synthetic-privacy-metric-${tenantId}`;
    const base = fixture("33-stage-b-cohort-metrics"), custom = fixture("61-custom-conversion"), engagement = fixture("64-first-party-engagement");
    const batches: Any[] = [];
    const evaluations: Any[] = [];
    for (const [day, date] of [[0, "2026-08-01"], [1, "2026-08-02"]] as const) for (const campaign of ["a", "b"]) {
      const suffix = `-synthetic-${day}-${campaign}`;
      const shift = (value: any): any => {
        if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(Date.parse(value) + day * 86400000).toISOString();
        if (Array.isArray(value)) return value.map(shift);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v)]));
        return value;
      };
      const records = shift(structuredClone(base.records));
      for (const record of records) {
        for (const key of ["record_id", "delivery_id", "event_id"]) record[key] += suffix;
        for (const key of ["installation_id", "session_id", "click_id", "view_id", "tracking_link_id"]) if (record.payload[key]) record.payload[key] += suffix;
        if (record.payload.campaign_id) record.payload.campaign_id = `synthetic-campaign-${campaign}`;
        if (record.payload.import_context?.provider_campaign_ref) record.payload.import_context.provider_campaign_ref = `synthetic-campaign-${campaign}`;
      }
      batches.push({ batch_id: `synthetic-cohort-${day}-${campaign}`, server_context: base.server_context, records });
      evaluations.push({ ...structuredClone(base.metric_evaluations[0]), metric_run_id_prefix: `synthetic-cohort-${day}-${campaign}`,
        input_received_at_watermark: "2026-08-13T00:00:00.000Z", computed_at: "2026-08-13T00:01:00.000Z",
        metric_names: ["cohort_install_count", "retention_d1"],
        grouping: { ...base.metric_evaluations[0].grouping, cohort_date: date, campaign_id: `synthetic-campaign-${campaign}` } });
    }
    const other = structuredClone(base.records.find((r: Any) => r.record_id === "organic-install-33"));
    for (const key of ["record_id", "delivery_id", "event_id"]) other[key] += "-synthetic-unrelated";
    other.app_id = "app-unrelated"; other.payload.installation_id = "installation:synthetic-unrelated";
    batches.push({ batch_id: "synthetic-unrelated", server_context: { ...base.server_context, app_id: other.app_id }, records: [other] });
    batches.push({ batch_id: "synthetic-custom", server_context: custom.server_context, records: custom.records }, ...engagement.batches);
    input = { ...base, records: undefined, batches, cost_records: [], metric_evaluations: [],
      metric_definitions: [...base.metric_definitions, ...custom.metric_definitions, ...engagement.metric_definitions] };
    await ingestFixture(`synthetic-privacy-${tenantId}`, input, app, seed);
    originals = [];
    for (const [fxPolicy, group] of [[base.fx_policy, evaluations], [custom.fx_policy, custom.metric_evaluations],
      [engagement.fx_policy, engagement.metric_evaluations]] as [Any, Any[]][]) {
      originals.push(...await computeSqlMetricRuns(app, { ...input, fx_policy: fxPolicy, metric_evaluations: group }, true,
        { tenant_id: tenantId, app_id: "app-a" }));
    }
    foreign = await computeSqlMetricRuns(app, { ...base, metric_evaluations: [{ ...base.metric_evaluations[0],
      metric_run_id_prefix: "synthetic-unrelated", metric_names: ["cohort_install_count"],
      grouping: { cohort_date: "2026-08-01", attribution_status: "organic" } }] }, true,
      { tenant_id: tenantId, app_id: "app-unrelated" });
    await withTenant(app, tenantId, client => client.query(`INSERT INTO ledger.ingest_inbox
      (inbox_id,tenant_id,app_id,producer,event_id,token_mode,received_at,raw_query_ref,raw_query_digest,artifact)
      VALUES ($1,$2,'app-a','import:synthetic-provider','synthetic-privacy-payload','all',$3,$4,$5,'{}'::jsonb)`,
    [uuidV7(), tenantId, "2026-08-23T00:00:00.000Z", payloadRef, sha256("synthetic privacy metric payload")]));
  });
  after(async () => { await Promise.all([app.end(), reader.end(), seed.end()]); });
  const report = (appId = "app-a", history: "latest" | "all" = "all", watermarkAtMost?: string) => metricReport(reader,
    { ...identity(), appId }, { tenantId, appId, supersession: history, limit: 200, ...(watermarkAtMost ? { watermarkAtMost } : {}) });
  const saved = () => withTenant(app, tenantId, async client => (await client.query<{ artifact: Any }>(
    "SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 ORDER BY metric_run_id", [tenantId],
  )).rows.map(row => row.artifact));
  const statuses = () => withTenant(reader, tenantId, async client => (await client.query<Any>(
    `SELECT item.* FROM control.metric_recalculation_items AS item JOIN control.metric_recalculation_jobs AS job
      USING (tenant_id,app_id,recalculation_id) WHERE job.tenant_id=$1 AND job.trigger_kind='privacy_deletion'
      ORDER BY item.source_metric_run_id`, [tenantId],
  )).rows);
  async function erase(scope: "app" | "tenant" = "app") {
    const body: PrivacyRequestBody = { tenant_id: tenantId, app_id: "app-a", deletion_scope: scope,
      deletion_subject_ref: scope === "app" ? "app-a" : tenantId, requested_via: "tenant_admin_api" };
    return executePrivacyRequest(app, { ...identity(), deletionSubjectDigest: privacySubjectDigest("synthetic-privacy-metric-key", body) },
      body, payloadStore, new Date(completedAt));
  }
  async function drain() {
    let completed = 0;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const result = await processMetricRecalculations(app, tenantId, 10);
      assert.equal(result.failed, 0);
      completed += result.completed;
      if (!result.completed && !result.skipped && !result.fenced) break;
    }
    return completed;
  }
  async function assertSuccessors() {
    const all = await saved();
    for (const prior of originals) {
      assert.equal(jcs(all.find(run => run.metric_run_id === prior.metric_run_id)), jcs(prior));
      const replacements = all.filter(run => run.supersedes_metric_run_id === prior.metric_run_id);
      assert.equal(replacements.length, 1, prior.metric_run_id);
      const next = replacements[0];
      assert.deepEqual(next.grouping, prior.grouping);
      assert.equal(next.input_received_at_watermark, prior.input_received_at_watermark);
      assert.equal(next.metric_definition_version, prior.metric_definition_version);
      assert.equal(next.rule_bundle_hash, prior.rule_bundle_hash);
      assert.equal(next.data_freshness, "recalculated");
      assert.ok(next.value_unscaled === "0" || next.undefined_reason === "empty_cohort", `${prior.metric_run_id}: ${jcs(next)}`);
    }
  }

  it("synthetic privacy_multi_group_recalculation updates two days times two campaigns plus retention/custom/engagement without touching unrelated runs", async () => {
    assert.equal(originals.length, 20);
    assert.equal(foreign[0].value_unscaled, "1");
    assert.equal(originals.filter(run => run.metric_name === "cohort_install_count" && run.value_unscaled === "1").length, 4);
    assert.ok(originals.some(run => run.metric_name === "retention_d1" && run.value_unscaled === "1000000"));
    assert.equal((await erase()).status, "completed");
    const pending = await report();
    assert.ok(pending.data.every(row => row.value_state === "unavailable" && row.value_unscaled === undefined
      && row.privacy_update_state === "recalculation_pending" && row.data_freshness === "complete"));
    assert.ok((await report("app-a", "all", "2026-08-23T00:00:00.000Z")).data.every(row => row.value_unscaled === undefined));
    assert.equal((await statuses()).length, originals.length);
    const csv = readCsv(encodeMetricReport(pending, "csv").body);
    assert.ok(csv.every(row => row.value_unscaled === "" && row.value_state === "unavailable" && row.privacy_update_state === "recalculation_pending"));
    const detail = await metricExplanation(reader, identity(), originals[0].metric_run_id);
    assert.equal(detail?.run.value_state, "unavailable"); assert.equal(detail?.run.value_unscaled, undefined);
    const key = "synthetic-privacy-report-key-at-least-thirty-two-bytes";
    await ensureAdminKeys(app, identity(), [key]);
    const server = createServer(createRequestHandler({ pool: app, readerPool: reader, payloadStore,
      maxConfig: { tenantId, appId: "app-a", pathSecret: "synthetic", eventKey: "synthetic", tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, tenantId, publicBaseUrl: "http://localhost:8080", sessionTtlSeconds: 43200 } }));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/reports/metrics?app_id=app-a&supersession=all`;
      const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), pending);
      const csvResponse = await fetch(`${url}&format=csv`, { headers: { authorization: `Bearer ${key}` } });
      assert.equal(csvResponse.status, 200); assert.equal(await csvResponse.text(), encodeMetricReport(pending, "csv").body);
    } finally { server.close(); await once(server, "close"); }
    assert.equal(await drain(), originals.length);
    await assertSuccessors();
    const latest = await report("app-a", "latest");
    assert.equal(latest.data.length, originals.length);
    assert.ok(latest.data.every(row => row.value_state !== "unavailable" && row.data_freshness === "recalculated"));
    assert.deepEqual((await report("app-unrelated")).data.map(row => row.value_unscaled), foreign.map(row => row.value_unscaled));
    assert.equal((await saved()).filter(run => run.supersedes_metric_run_id === foreign[0].metric_run_id).length, 0);
    assert.equal(await drain(), 0);
  });

  it("privacy_recalculation_crash_resume preserves pending values through purge, expired claim and publication rollback", async () => {
    stalled = true;
    const privacy = await erase();
    assert.equal(privacy.status, "processing");
    assert.equal(await drain(), 0); assert.ok((await statuses()).every(row => row.attempts === 0));
    assert.ok((await report()).data.every(row => row.value_unscaled === undefined));
    stalled = false;
    assert.equal((await processPrivacyDeletionJobs({ pool: app, payloadStore, tenantId })).completed, 1);
    assert.equal(readable, false);
    await withTenant(app, tenantId, client => client.query(`UPDATE control.metric_recalculation_items SET
      state='processing',attempts=1,lease_token='01800000-0000-7000-8000-000000000000',lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND source_metric_run_id=$2`, [tenantId, originals[0].metric_run_id]));
    let interrupt = true;
    const failingPool = { connect: async () => {
      const client = await app.connect();
      return new Proxy(client, { get(target, property) {
        if (property === "query") return (...args: any[]) => {
          if (interrupt && String(args[0]).includes("SET state=$6,replacement_metric_run_id")) {
            interrupt = false; return Promise.reject(new Error("synthetic publication interruption"));
          }
          return (target.query as any)(...args);
        };
        const value = (target as any)[property]; return typeof value === "function" ? value.bind(target) : value;
      } });
    } } as unknown as Pool;
    assert.equal((await processMetricRecalculations(failingPool, tenantId, 1)).failed, 1);
    assert.equal((await saved()).filter(run => run.supersedes_metric_run_id).length, 0);
    await withTenant(app, tenantId, client => client.query("UPDATE control.metric_recalculation_items SET next_attempt_at=clock_timestamp() WHERE tenant_id=$1 AND state='retry'", [tenantId]));
    const concurrent = await Promise.all([processMetricRecalculations(app, tenantId, 10), processMetricRecalculations(app, tenantId, 10)]);
    assert.ok(concurrent.every(row => row.failed === 0));
    await drain(); await assertSuccessors();
    assert.equal(await drain(), 0);
    const before = jcs(await saved());
    const restored = await reapplyCompletedPrivacyRequests({ pool: app, payloadStore, tenantId });
    assert.equal(restored.metrics_recalculated, originals.length); assert.equal(restored.unsupported_metric_runs, 0);
    assert.equal(jcs(await saved()), before);
  });

  it("privacy_normal_and_restore_share_the_same_affected_runs_and_actual_replay", async () => {
    await erase();
    const selected = (await statuses()).map(row => row.source_metric_run_id).sort();
    assert.deepEqual(selected, originals.map(row => row.metric_run_id).sort());
    const restored = await reapplyCompletedPrivacyRequests({ pool: app, payloadStore, tenantId });
    assert.equal(restored.metrics_recalculated, originals.length); assert.equal(restored.unsupported_metric_runs, 0);
    await assertSuccessors(); assert.equal(await drain(), 0);
    const before = jcs(await saved());
    assert.equal((await reapplyCompletedPrivacyRequests({ pool: app, payloadStore, tenantId })).metrics_recalculated, originals.length);
    assert.equal(jcs(await saved()), before);
  });

  it("privacy_missing_manifest_is_unavailable_not_a_copied_success_and_tenant_scope_includes_other_apps", async () => {
    const legacy = { ...originals[0], metric_run_id: "synthetic-legacy-no-manifest", value_unscaled: "999", evidence_refs: [],
      computed_at: "2026-09-01T00:00:00.000Z",
      grouping: { dimensions: { cohort_date: "2026-06-01" }, dimension_digest: sha256({ cohort_date: "2026-06-01" }) } };
    const legacyCount = 102;
    await withTenant(app, tenantId, async client => {
      for (let index = 0; index < legacyCount; index += 1) await persistMetricRun(client,
        { tenant_id: tenantId, app_id: "app-a" }, { ...legacy,
          metric_run_id: index === 0 ? legacy.metric_run_id : `${legacy.metric_run_id}-${index}` });
    });
    await erase("tenant");
    const otherAppPrivacy = () => withTenant(reader, tenantId, async client => (await client.query(
      `SELECT state.app_id,stone.artifact->>'app_id' AS tombstone_app,correction.artifact->>'app_id' AS correction_app
       FROM ledger.raw_payload_states AS state
       JOIN ledger.privacy_tombstones AS stone ON stone.tenant_id=state.tenant_id AND stone.record_id=state.record_id
       JOIN ledger.corrections AS correction ON correction.tenant_id=state.tenant_id AND correction.corrects_record_id=state.record_id
       WHERE state.tenant_id=$1 AND state.app_id='app-unrelated' AND state.lifecycle_status='purged'`, [tenantId])).rows);
    assert.deepEqual(await otherAppPrivacy(), [{ app_id: "app-unrelated", tombstone_app: "app-unrelated", correction_app: "app-unrelated" }]);
    assert.equal((await statuses()).length, originals.length + foreign.length + legacyCount);
    const history = await listMetricRecalculations(reader, identity());
    assert.equal(history.length, 100);
    assert.ok(history.every(row => row.selection_count === String(originals.length + legacyCount) && row.selection_truncated === true));
    assert.equal((await statuses()).find(row => row.source_metric_run_id === legacy.metric_run_id)?.safe_reason, "replay_unavailable");
    assert.equal(await drain(), originals.length + foreign.length);
    const unavailable = (await report("app-a", "latest")).data.find(row => row.metric_run_id === legacy.metric_run_id)!;
    assert.equal(unavailable.value_state, "unavailable"); assert.equal(unavailable.value_unscaled, undefined);
    assert.equal(unavailable.privacy_update_state, "unavailable");
    assert.equal(unavailable.data_freshness, "complete");
    assert.equal((await saved()).filter(run => run.supersedes_metric_run_id === legacy.metric_run_id).length, 0);
    assert.equal(jcs((await saved()).find(run => run.metric_run_id === legacy.metric_run_id)), jcs(legacy));
    assert.equal((await reapplyCompletedPrivacyRequests({ pool: app, payloadStore, tenantId })).unsupported_metric_runs, legacyCount);
    assert.deepEqual(await otherAppPrivacy(), [{ app_id: "app-unrelated", tombstone_app: "app-unrelated", correction_app: "app-unrelated" }]);
  });
});
