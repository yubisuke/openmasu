import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import {
  createAppPool,
  createReaderPool,
  EncryptedFilePayloadStore,
  appendDurableBatch,
  SDK_POST_PROCESSING_PENDING_REASON,
  withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys } from "./admin-auth.js";
import { KeyedTokenBucket, TokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";
import { executePrivacyRequest, privacySubjectDigest } from "./privacy.js";
import { ingestRuntimeBatch } from "../../worker/src/ingestion.js";
import type { CandidateAttempt } from "@openmasu/attribution-core";
import type { MeasurementHealth } from "./measurement-health.js";
import {
  csrfToken,
  issueDashboardSession,
  readDashboardToken,
  sweepExpiredDashboardSessions,
  verifyDashboardSession,
} from "./session.js";

const suffix = `${Date.now()}`;
const tenantId = `tenant-m3-${suffix}`;
const appId = `app-m3-${suffix}`;
const adminKeyA = `synthetic-m3-admin-key-a-${suffix}-${"a".repeat(32)}`;
const adminKeyB = `synthetic-m3-admin-key-b-${suffix}-${"b".repeat(32)}`;
const configuredOrigin = "http://localhost:8080";

describe("M3 dashboard identity and control plane", { concurrency: false }, () => {
  let appPool: Pool;
  let readerPool: Pool;
  let server: Server;
  let baseUrl: string;
  let payloadRoot: string;
  let payloadStore: EncryptedFilePayloadStore;

  function handler(options: {
    loginRate?: number;
    loginBurst?: number;
    trackingOrigins?: readonly string[];
  } = {}) {
    return createRequestHandler({
      pool: appPool,
      readerPool,
      payloadStore,
      maxConfig: {
        tenantId,
        appId,
        pathSecret: "synthetic-m3-max-path",
        eventKey: "synthetic-m3-max-event-key",
        tokenMode: "all",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: configuredOrigin,
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: true, publicBaseUrl: configuredOrigin, tenantId, sessionTtlSeconds: 43200 },
      dashboardLoginBucket: new KeyedTokenBucket(options.loginRate ?? 100, options.loginBurst ?? 100),
      dashboardLoginGlobalBucket: new TokenBucket(100, 100),
      trackingDestinationAllowlist: options.trackingOrigins ?? ["https://links.synthetic.example"],
      privacySubjectDigestKey: "synthetic-m3-tracking-list-cursor-key",
    });
  }

  async function start(candidate = handler()): Promise<{ server: Server; baseUrl: string }> {
    const instance = createServer(candidate);
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
    const address = instance.address();
    assert.ok(address && typeof address === "object");
    return { server: instance, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  async function close(instance: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }

  async function login(key: string, endpoint = baseUrl): Promise<Response> {
    return fetch(`${endpoint}/dashboard/session`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ admin_key: key }),
    });
  }

  function cookie(response: Response): string {
    const value = response.headers.get("set-cookie");
    assert.ok(value);
    return value.split(";", 1)[0];
  }

  before(async () => {
    appPool = createAppPool();
    readerPool = createReaderPool();
    payloadRoot = mkdtempSync(join(tmpdir(), "openmasu-m3-"));
    payloadStore = new EncryptedFilePayloadStore(payloadRoot, "synthetic-m3-master-key-000000000000000000000000");
    await ensureAdminKeys(appPool, { tenantId, appId }, [adminKeyA, adminKeyB]);
    ({ server, baseUrl } = await start());
  });

  after(async () => {
    if (server) await close(server);
    await appPool?.end();
    await readerPool?.end();
    if (payloadRoot) rmSync(payloadRoot, { recursive: true, force: true });
  });

  it("creates one-time disposable validation tokens through scoped API and CSRF-protected SSR without GET writes", async () => {
    const endpoint = `${baseUrl}/v1/admin/apps/${appId}/synthetic-validations`;
    const headers = { authorization: `Bearer ${adminKeyA}`, "content-type": "application/json" };
    assert.equal((await fetch(endpoint, { method: "POST", body: "{}" })).status, 401);
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ expected_events: ["install", "custom_event"], expected_custom_keys: ["synthetic_checkout"] }) });
    assert.equal(response.status, 201);
    const created = await response.json() as { session_id: string; session_token: string; expires_at: string };
    assert.match(created.session_token, /^[A-Za-z0-9_-]{43}$/);
    const read = await fetch(`${endpoint}/${created.session_id}`, { headers }); assert.equal(read.status, 200);
    const text = await read.text(); assert.equal(text.includes(created.session_token), false); assert.equal(text.includes("token_digest"), false);
    assert.equal((await fetch(`${endpoint}/${randomUUID()}`, { headers })).status, 404);
    const sessionCookie = cookie(await login(adminKeyA));
    const token = readDashboardToken(sessionCookie, configuredOrigin)!;
    const path = `${baseUrl}/dashboard/apps/${appId}/synthetic-validations`;
    const before = (await withTenant(readerPool, tenantId, client => client.query("SELECT * FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1 ORDER BY session_id", [tenantId]))).rows;
    for (const url of [path, `${path}/${created.session_id}`]) {
      const page = await fetch(url, { headers: { cookie: sessionCookie } }); assert.equal(page.status, 200);
      const html = await page.text(); assert.doesNotMatch(html, /<script\b|javascript:|\son[a-z]+=/i); assert.equal(html.includes(created.session_token), false);
    }
    assert.deepEqual((await withTenant(readerPool, tenantId, client => client.query("SELECT * FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1 ORDER BY session_id", [tenantId]))).rows, before);
    const form = new URLSearchParams({ csrf_token: csrfToken(token), ttl_seconds: "600", expected_events: "session_start", expected_custom_keys: "" });
    assert.equal((await fetch(path, { method: "POST", headers: { cookie: sessionCookie, origin: "https://untrusted.synthetic.invalid" }, body: form })).status, 403);
    const issued = await fetch(path, { method: "POST", headers: { cookie: sessionCookie, origin: configuredOrigin }, body: form });
    assert.equal(issued.status, 201); assert.match(await issued.text(), /Session token — shown once/);
    const readOnly = `synthetic-validation-reader-${suffix}-${"r".repeat(32)}`;
    await ensureAdminKeys(appPool, { tenantId, appId }, [{ key: readOnly, role: "read_only" }]);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${readOnly}`, "content-type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${endpoint}/${created.session_id}`, { headers: { authorization: `Bearer ${readOnly}` } })).status, 200);
    assert.equal((await fetch(`${endpoint}/${created.session_id}/close`, { method: "POST", headers })).status, 200);
    assert.equal((await fetch(`${endpoint}/${created.session_id}`, { headers })).status, 404);
  });

  it("reads safe deletion progress through API and SSR without changing jobs or crossing app scope", async () => {
    const privacyApp = `app-privacy-progress-${suffix}`, otherApp = `app-privacy-progress-other-${suffix}`;
    const foreignTenant = `tenant-privacy-progress-other-${suffix}`, foreignApp = `app-privacy-progress-foreign-${suffix}`;
    for (const [tenant, app] of [[tenantId, privacyApp], [tenantId, otherApp], [foreignTenant, foreignApp]]) {
      await withTenant(appPool, tenant, client => client.query(
        "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)", [tenant, app, new Date().toISOString()]));
    }
    const body = { tenant_id: tenantId, app_id: privacyApp, requested_via: "tenant_admin_api" as const,
      deletion_scope: "installation" as const, deletion_subject_ref: `installation:privacy-progress-${suffix}` };
    const deleted = await executePrivacyRequest(appPool, { tenantId, appId: privacyApp, keyId: "synthetic-privacy-progress-key",
      role: "admin", deletionSubjectDigest: privacySubjectDigest("synthetic-privacy-progress-digest-key", body) }, body, payloadStore);
    assert.equal(deleted.status, "completed");
    const endpoint = `${baseUrl}/v1/admin/apps/${privacyApp}/privacy-jobs`;
    const dashboard = `${baseUrl}/dashboard/apps/${privacyApp}/privacy-jobs`;
    const requestId = encodeURIComponent(deleted.privacy_request_id);
    const scopedKey = `synthetic-privacy-progress-reader-${suffix}-${"p".repeat(32)}`;
    await ensureAdminKeys(appPool, { tenantId, appId: privacyApp }, [{ key: scopedKey, role: "read_only", appScope: privacyApp }]);
    const headers = { authorization: `Bearer ${scopedKey}` }, sessionCookie = cookie(await login(scopedKey));
    const state = () => withTenant(appPool, tenantId, async client => ({
      jobs: (await client.query("SELECT * FROM control.privacy_deletion_jobs WHERE app_id=$1 ORDER BY privacy_request_id", [privacyApp])).rows,
      purges: (await client.query("SELECT * FROM control.privacy_payload_purges WHERE app_id=$1 ORDER BY reference_digest", [privacyApp])).rows,
      metrics: (await client.query("SELECT * FROM control.metric_recalculation_items WHERE app_id=$1 ORDER BY recalculation_id,source_metric_run_id", [privacyApp])).rows,
      audits: (await client.query("SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1", [tenantId])).rows,
    }));
    const beforeRead = await state();
    for (const path of [endpoint, `${endpoint}/${requestId}`]) {
      const response = await fetch(path, { headers }); assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text(), page = JSON.parse(text);
      assert.equal(page.data[0].request_id, deleted.privacy_request_id);
      assert.equal(page.data[0].payload.state, "completed");
      assert.equal(page.data[0].recalculation.state, "not_recorded");
      assert.equal(page.data[0].all_recorded_steps_completed, false);
      for (const forbidden of [body.deletion_subject_ref, "deletion_subject", "payload_ref", "record_id", scopedKey])
        assert.equal(text.includes(forbidden), false, forbidden);
    }
    for (const path of [dashboard, `${dashboard}/${requestId}`]) {
      const response = await fetch(path, { headers: { cookie: sessionCookie } }); assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const html = await response.text(); assert.match(html, /Not established/); assert.match(html, /not_recorded/);
      assert.doesNotMatch(html, /<form|<script\b|javascript:|\son[a-z]+=/i);
      assert.equal(html.includes(body.deletion_subject_ref), false); assert.equal(html.includes(scopedKey), false);
    }
    for (const other of [otherApp, foreignApp]) {
      assert.equal((await fetch(`${baseUrl}/v1/admin/apps/${other}/privacy-jobs/${requestId}`, { headers })).status, 404);
      assert.equal((await fetch(`${baseUrl}/dashboard/apps/${other}/privacy-jobs/${requestId}`, { headers: { cookie: sessionCookie } })).status, 404);
    }
    assert.equal((await fetch(`${endpoint}/unknown-synthetic`, { headers })).status, 404);
    assert.equal((await fetch(`${dashboard}/unknown-synthetic`, { headers: { cookie: sessionCookie } })).status, 404);
    assert.equal((await fetch(`${endpoint}?tenant=foreign`, { headers })).status, 400);
    assert.equal((await fetch(endpoint, { headers: { cookie: sessionCookie } })).status, 401);
    assert.equal((await fetch(dashboard, { headers })).status, 401);
    assert.deepEqual(await state(), beforeRead, "GET must not write privacy jobs, purge progress, recalculation or audit");
  });

  it("shows app-scoped measurement health from retained synthetic ingestion and metric metadata", async () => {
    const healthApp = `app-health-${suffix}`;
    const otherApp = `app-health-other-${suffix}`;
    const foreignTenant = `tenant-health-other-${suffix}`;
    const at = "2026-09-08T00:00:00.000Z";
    await withTenant(appPool, tenantId, (client) => client.query(
      "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)", [tenantId, healthApp, at],
    ));
    await withTenant(appPool, foreignTenant, async (client) => {
      await client.query("INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)", [foreignTenant, otherApp, at]);
    });
    const endpoint = `${baseUrl}/v1/admin/apps/${healthApp}/measurement-health`;
    const headers = { authorization: `Bearer ${adminKeyA}` };
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/admin/apps/${otherApp}/measurement-health`, { headers })).status, 404);
    const read = async () => {
      const response = await fetch(endpoint, { headers });
      assert.equal(response.status, 200);
      const text = await response.text();
      for (const forbidden of ["synthetic-private-value", "body_ref", "artifact", "secret_ref", "record_id", "installation_id", "source_id"])
        assert.equal(text.includes(forbidden), false, forbidden);
      return JSON.parse(text);
    };
    const initial = await read();
    assert.equal(initial.sdk.active_keys, "0");
    assert.equal(initial.sdk.batches, "0");
    assert.equal(initial.sdk.latest_received_at, null);
    const sessionCookie = cookie(await login(adminKeyA));
    const page = async () => (await fetch(`${baseUrl}/dashboard/apps/${healthApp}`, { headers: { cookie: sessionCookie } })).text();
    assert.match(await page(), /data-measurement-state="no_observations"/);

    await withTenant(appPool, tenantId, async (client) => {
      const batch = randomUUID();
      await client.query(`INSERT INTO ledger.ingest_batches
        (ingest_batch_id,tenant_id,app_id,producer,received_at,body_ref,body_digest,event_count,artifact)
        VALUES ($1,$2,$3,'android_sdk',$4,'synthetic-private-value',$5,1,'{}')`, [batch, tenantId, healthApp, at, "a".repeat(64)]);
      await client.query(`INSERT INTO ledger.ingest_batch_states
        (ingest_batch_id,tenant_id,app_id,status,changed_at,artifact) VALUES ($1,$2,$3,'pending',$4,'{}')`, [batch, tenantId, healthApp, at]);
      await client.query(`INSERT INTO control.import_runs
        (import_run_id,tenant_id,app_id,source_id,source_snapshot_digest,status,started_at)
        VALUES ($1,$2,$3,'synthetic-private-value',$4,'running',$5)`, [randomUUID(), tenantId, healthApp, "b".repeat(64), at]);
      for (const reason of ["payload_schema_invalid", "synthetic-private-value"]) {
        await client.query(`INSERT INTO ledger.rejections
          (tenant_id,app_id,delivery_id,record_id,reason_code,artifact) VALUES ($1,$2,$3,$3,$4,'{}')`, [tenantId, healthApp, `synthetic-${randomUUID()}`, reason]);
      }
    });
    const pending = await read();
    assert.equal(pending.sdk.pending, "1");
    assert.equal(pending.sdk.oldest_pending_at, at);
    assert.equal(pending.imports.running, "1");
    assert.deepEqual(pending.rejections, [
      { source: "event", reason: "other", count: "1" },
      { source: "event", reason: "payload_schema_invalid", count: "1" },
    ]);
    const pendingHtml = await page();
    assert.match(pendingHtml, /data-measurement-state="processing_wait"/);
    assert.match(pendingHtml, /data-measurement-state="rejections_observed"/);
    assert.doesNotMatch(pendingHtml, /synthetic-private-value/);
    const beforeRead = await withTenant(appPool, tenantId, (client) => client.query(
      "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1 AND app_id=$2", [tenantId, healthApp],
    ));
    const again = await read();
    const withoutObservationTime = (health: MeasurementHealth) => ({ ...health, observed_at: null,
      recent: { ...health.recent, received_from: null, received_to: null, previous_from: null } });
    assert.deepEqual(withoutObservationTime(again), withoutObservationTime(pending));
    const afterRead = await withTenant(appPool, tenantId, (client) => client.query(
      "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1 AND app_id=$2", [tenantId, healthApp],
    ));
    assert.deepEqual(afterRead.rows, beforeRead.rows);
    // Metadata-only synthetic ledger rows: this tests observation, not evaluator correctness.
    await withTenant(appPool, tenantId, async (client) => {
      const record = `synthetic-health-${randomUUID()}`;
      await client.query(`INSERT INTO ledger.raw_records
        (record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,schema_version,
         payload_sha256,occurred_at,occurred_at_source,received_at,raw_payload_ref,
         consent_evaluation_policy_version,consent_decision_reason_code,artifact)
        VALUES ($1,$2,$3,'android_sdk','synthetic',$1,$1,'install','0.4.0',$4,$5,'server',$5,
          'synthetic-private-value','synthetic','synthetic','{}')`, [record, tenantId, healthApp, "c".repeat(64), at]);
      await client.query(`INSERT INTO ledger.logical_events
        (logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,timeliness,artifact)
        VALUES ($1::text,$1::text::control.identifier,$2,$3,'android_sdk',$1::text::control.identifier,'install','on_time','{}')`, [record, tenantId, healthApp]);
    });
    assert.equal((await read()).events.logical_events, "1");
    assert.match(await page(), /data-measurement-state="not_computed"/);
    await withTenant(appPool, tenantId, (client) => client.query(`INSERT INTO ledger.metric_runs
      (metric_run_id,tenant_id,app_id,metric_name,metric_definition_version,grouping,grouping_digest,input_snapshot_id,
       input_received_at_watermark,input_ledger_position,computed_at,data_freshness,aggregation_time_zone,
       rule_bundle_id,rule_bundle_version,rule_bundle_hash,rounding_mode,reproducibility_status,value_type,value_unscaled,value_state,artifact)
      VALUES ($1,$2,$3,'synthetic_metric','synthetic','{"dimensions":{"cohort_date":"2026-09-07"}}',$4,$4,
       $5,'synthetic',$5,'complete','UTC','synthetic','synthetic',$4,'half_even','fully_reproducible','count','1','present','{}')`,
    [`synthetic-metric-${randomUUID()}`, tenantId, healthApp, "d".repeat(64), at]));
    const computed = await read();
    assert.equal(computed.metrics.runs, "1");
    assert.equal(computed.metrics.latest_computed_at, at);
    assert.equal(computed.metrics.latest_watermark, at);
    assert.equal(computed.metrics.latest_cohort_date, "2026-09-07");
  });

  it("diagnoses recent SDK-version receipts through single and bulk admission without turning old failures or local queues into alarms", async () => {
    const recentApp = `app-recent-${suffix}`;
    const source = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
    const prototype = source.records.find((record: { event_name: string }) => record.event_name === "session_start");
    const now = Date.now(), at = (hoursAgo: number) => new Date(now-hoursAgo*3600000).toISOString();
    const currentAt = at(0.5), previousAt = at(36), oldAt = at(72);
    const attempt = (label: string, version: string, receivedAt: string, valid = true): CandidateAttempt => {
      const recordId = `synthetic-recent-${label}-${suffix}`;
      return { batch_id: `batch:${recordId}`, server: { ...source.server_context, tenant_id: tenantId,
        app_id: recentApp, received_at: receivedAt, fraud_enabled: false },
        record: { ...prototype, tenant_id: tenantId, app_id: recentApp, record_id: recordId, event_id: `event:${recordId}`,
          delivery_id: `delivery:${recordId}`, producer_version: version, received_at: receivedAt, occurred_at: receivedAt,
          payload: valid ? { installation_id: `installation:synthetic-recent-${suffix}`, session_id: recordId } : {} } };
    };
    let accepted!: CandidateAttempt;
    for (const bulkPersistence of [false,true]) {
      const mode = bulkPersistence ? "bulk" : "single";
      const good = attempt(`${mode}-good`, "0.3.0-rc.2", currentAt);
      if (bulkPersistence) good.record.late = true;
      else accepted = good;
      const result = await ingestRuntimeBatch([
        attempt(`${mode}-previous`, "0.2.0", previousAt), good,
        attempt(`${mode}-rejected`, "0.3.0-rc.2", currentAt, false),
      ], appPool, [], { bulkPersistence });
      assert.equal(result.logical_events.length, 2, mode);
      assert.equal(result.rejections.length, 1, mode);
      assert.deepEqual(result.deliveries.map(row => row.ingestion_status).sort(), ["accepted","accepted","rejected"], mode);
      assert.ok(result.deliveries.every(row => !("diagnostic_event_name" in row)), "operational metadata must not alter artifacts");
    }
    const duplicateAt = at(0.25);
    const duplicate: CandidateAttempt = { ...accepted, server: { ...accepted.server, received_at: duplicateAt }, record: { ...accepted.record,
      record_id: `synthetic-recent-retry-${suffix}`, delivery_id: `delivery:synthetic-recent-retry-${suffix}`, received_at: duplicateAt } };
    const duplicateResult = await ingestRuntimeBatch([duplicate], appPool, [accepted]);
    assert.equal(duplicateResult.deliveries.length, 1);
    assert.equal(duplicateResult.deliveries[0].duplicate_resolution, "duplicate_delivery");
    const unknown = attempt("unknown-version", "synthetic-private-value", currentAt);
    const unknownEvent = attempt("unknown-event", "synthetic-private-value", currentAt);
    unknownEvent.record.event_name = "synthetic-private-value";
    await ingestRuntimeBatch([unknown, unknownEvent, attempt("old-rejection", "0.3.0-rc.2", oldAt, false)], appPool);
    const batch = await appendDurableBatch(appPool, payloadStore, { tenantId, appId: recentApp, producer: "sdk-ios",
      receivedAt: currentAt, eventCount: 2, body: Buffer.from(JSON.stringify({ records: [
        { producer_version: "0.3.0-rc.2", event_name: "session_start" },
        { producer_version: "synthetic-private-value", event_name: "synthetic-private-value" },
      ] })) });
    await withTenant(appPool, tenantId, client => client.query(`INSERT INTO ledger.ingest_batch_states
      (ingest_batch_id,tenant_id,app_id,status,changed_at,reason_code,artifact) VALUES ($1,$2,$3,'processed',$4,$5,'{}')`,
    [batch,tenantId,recentApp,currentAt,SDK_POST_PROCESSING_PENDING_REASON]));
    const endpoint = `${baseUrl}/v1/admin/apps/${recentApp}/measurement-health`;
    const headers = { authorization: `Bearer ${adminKeyA}` };
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const forbidden of ["synthetic-private-value", "installation:synthetic-recent", "session_id", "body_ref", "artifact", "sdk_key_id"])
      assert.equal(text.includes(forbidden), false, forbidden);
    const health = JSON.parse(text) as MeasurementHealth, recent = health.recent!;
    assert.equal(recent.window_hours, 24);
    assert.equal(recent.client_diagnostics, "on_device_only_not_received");
    const modern = recent.groups.find(group => group.producer === "sdk-android" && group.producer_version === "0.3.0-rc.2")!;
    assert.deepEqual([modern.current.accepted,modern.current.rejected,modern.current.duplicate,modern.current.late], ["2","2","1","1"]);
    assert.equal(modern.previous.rejected, "0", "older failures are outside both 24h windows");
    const earlierVersion = recent.groups.find(group => group.producer_version === "0.2.0")!;
    assert.equal(earlierVersion.current.accepted, "0");
    assert.equal(earlierVersion.previous.accepted, "2");
    assert.equal(recent.groups.find(group => group.producer_version === "other" && group.event_name === "session_start")!.current.accepted, "1");
    assert.equal(recent.groups.find(group => group.event_name === "other")!.current.rejected, "1");
    assert.deepEqual(recent.pending_groups.map(group => [group.event_name,group.pending,group.post_processing_pending,group.oldest_received_at]), [
      ["session_start","1","1",currentAt], ["other","1","1",currentAt],
    ]);
    const narrow = await (await fetch(`${endpoint}?window_hours=1`, { headers })).json() as MeasurementHealth;
    assert.ok(narrow.recent!.groups.every(group => group.producer_version !== "0.2.0"));
    const wide = await (await fetch(`${endpoint}?window_hours=168`, { headers })).json() as MeasurementHealth;
    assert.equal(wide.recent!.groups.find(group => group.producer_version === "0.3.0-rc.2")!.current.rejected, "3");
    for (const query of ["window_hours=25", "window_hours=1&window_hours=24", "installation_id=synthetic"])
      assert.equal((await fetch(`${endpoint}?${query}`, { headers })).status, 400);
    const cookieHeader = { cookie: cookie(await login(adminKeyA)) };
    assert.equal((await fetch(endpoint, { headers: cookieHeader })).status, 401);
    const dashboardPath = `${baseUrl}/dashboard/apps/${recentApp}/measurement-health`;
    assert.notEqual((await fetch(dashboardPath, { headers, redirect: "manual" })).status, 200);
    const page = await fetch(`${dashboardPath}?window_hours=24`, { headers: cookieHeader });
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const state of ["group_no_recent_receipts", "group_rejections_increased", "low_observed_volume", "recent_pending_work"])
      assert.match(html, new RegExp(`data-measurement-state="${state}"`));
    assert.doesNotMatch(html, /rejections_observed|synthetic-private-value|<script|javascript:/i);
    assert.match(html, /window_hours=168/);
  });

  it("C01 authenticates both overlap keys and keeps invalid responses byte-identical", async () => {
    for (const key of [adminKeyA, adminKeyB]) {
      const response = await login(key);
      assert.equal(response.status, 303);
      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /^openmasu_dashboard=[A-Za-z0-9_-]{43};/);
      for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(setCookie.includes(attribute));
      assert.equal(response.headers.get("location"), "/dashboard");
    }
    const wrong = await login(`synthetic-wrong-${"w".repeat(40)}`);
    const unknown = await login(`synthetic-unknown-${"u".repeat(40)}`);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(await wrong.text(), await unknown.text());
    const failures = await withTenant(appPool, tenantId, (client) => client.query<{ actor_ref: string }>(
      "SELECT actor_ref FROM ledger.audit_logs WHERE tenant_id=$1 AND action='dashboard_login' AND outcome='failed' ORDER BY occurred_at DESC LIMIT 2",
      [tenantId],
    ));
    assert.equal(failures.rows.length, 2);
    assert.equal(failures.rows.every((row) => row.actor_ref === "admin_key:unrecognized"), true);
  });

  it("C02 issues, verifies, revokes, rejects mutations, and sweeps absolute sessions", async () => {
    const beforeCount = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ephemeral.dashboard_sessions WHERE tenant_id=$1",
      [tenantId],
    )).rows[0].count));
    const response = await login(adminKeyA);
    const sessionCookie = cookie(response);
    const page = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: sessionCookie } });
    const html = await page.text();
    assert.match(html, /OpenMasu dashboard/);
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);

    const changedCookie = `${sessionCookie.slice(0, -1)}${sessionCookie.endsWith("A") ? "B" : "A"}`;
    assert.match(await (await fetch(`${baseUrl}/dashboard`, { headers: { cookie: changedCookie } })).text(), /Admin key/);

    const logout = await fetch(`${baseUrl}/dashboard/session/delete`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sessionCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    assert.equal(logout.status, 303);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.match(await (await fetch(`${baseUrl}/dashboard`, { headers: { cookie: sessionCookie } })).text(), /Admin key/);
    const afterCount = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ephemeral.dashboard_sessions WHERE tenant_id=$1",
      [tenantId],
    )).rows[0].count));
    assert.equal(afterCount, beforeCount);

    const expiredNow = new Date("2026-08-20T00:00:00.000Z");
    const activeKey = await withTenant(appPool, tenantId, async (client) => (await client.query<{ key_id: string }>(
      "SELECT key_id FROM control.admin_keys_current WHERE tenant_id=$1 AND status='active' ORDER BY key_id LIMIT 1",
      [tenantId],
    )).rows[0].key_id);
    const expired = await issueDashboardSession(
      appPool,
      tenantId,
      activeKey,
      60,
      new Date("2026-08-19T00:00:00.000Z"),
    );
    const expiredCookie = `openmasu_dashboard=${expired.token}`;
    assert.equal(await verifyDashboardSession(
      readerPool,
      tenantId,
      expiredCookie,
      configuredOrigin,
      expiredNow,
    ), undefined);
    assert.equal(await sweepExpiredDashboardSessions(appPool, tenantId, expiredNow), 1);
    const sweptCount = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ephemeral.dashboard_sessions WHERE tenant_id=$1",
      [tenantId],
    )).rows[0].count));
    assert.equal(sweptCount, beforeCount);
  });

  it("C03 proves reader RLS visibility and database-enforced write denial", async () => {
    const visible = await withTenant(readerPool, tenantId, (client) => client.query(
      "SELECT app_id FROM control.apps WHERE tenant_id=$1 AND app_id=$2",
      [tenantId, appId],
    ));
    assert.equal(visible.rowCount, 1);
    const unset = await readerPool.query("SELECT app_id FROM control.apps WHERE tenant_id=$1", [tenantId]);
    assert.equal(unset.rowCount, 0);
    await assert.rejects(
      () => withTenant(readerPool, tenantId, (client) => client.query(
        "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
        [tenantId, `reader-write-${suffix}`, "2026-08-20T00:00:00.000Z"],
      )),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "42501",
    );
  });

  it("C04 never accepts the other namespace credential", async () => {
    const anonymous = await fetch(`${baseUrl}/dashboard`);
    const bearerOnly = await fetch(`${baseUrl}/dashboard`, { headers: { authorization: `Bearer ${adminKeyA}` } });
    assert.equal(bearerOnly.status, anonymous.status);
    assert.equal(await bearerOnly.text(), await anonymous.text());
    const sessionResponse = await login(adminKeyA);
    const cookieOnly = await fetch(`${baseUrl}/v1/admin/apps`, { headers: { cookie: cookie(sessionResponse) } });
    assert.equal(cookieOnly.status, 401);
  });

  it("C05 rejects missing, cross-session, and cross-origin CSRF before accepting the bound token", async () => {
    const first = cookie(await login(adminKeyA));
    const second = cookie(await login(adminKeyB));
    const firstToken = readDashboardToken(first, configuredOrigin);
    const secondToken = readDashboardToken(second, configuredOrigin);
    assert.ok(firstToken && secondToken);
    const post = (csrf: string | undefined, origin = configuredOrigin) => fetch(`${baseUrl}/dashboard/session/delete`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: first, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(csrf ? { csrf_token: csrf } : {}),
    });
    assert.equal((await post(undefined)).status, 403);
    assert.equal((await post(csrfToken(secondToken))).status, 403);
    assert.equal((await post(csrfToken(firstToken), "https://cross-origin.invalid")).status, 403);
    assert.equal((await post(csrfToken(firstToken))).status, 303);
  });

  it("C06 throttles before audit insertion and never persists the source IP", async () => {
    const limited = await start(handler({ loginRate: 0.000001, loginBurst: 1 }));
    try {
      const before = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1",
        [tenantId],
      )).rows[0].count));
      assert.equal((await login(`synthetic-limited-${"l".repeat(40)}`, limited.baseUrl)).status, 401);
      const afterFailure = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1",
        [tenantId],
      )).rows[0].count));
      assert.equal(afterFailure, before + 1);
      assert.equal((await login(`synthetic-limited-${"m".repeat(40)}`, limited.baseUrl)).status, 429);
      const afterThrottle = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1",
        [tenantId],
      )).rows[0].count));
      assert.equal(afterThrottle, afterFailure);
      const leaked = await withTenant(appPool, tenantId, (client) => client.query(
        "SELECT 1 FROM ledger.audit_logs WHERE tenant_id=$1 AND row_to_json(audit_logs)::text LIKE '%127.0.0.1%'",
        [tenantId],
      ));
      assert.equal(leaked.rowCount, 0);
      const tables = await appPool.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type='BASE TABLE' AND table_schema IN ('control','ledger','ephemeral')
           AND has_table_privilege(
             quote_ident(table_schema) || '.' || quote_ident(table_name),
             'SELECT'
           )
         ORDER BY table_schema, table_name`,
      );
      for (const table of tables.rows) {
        const schema = `"${table.table_schema.replaceAll('"', '""')}"`;
        const name = `"${table.table_name.replaceAll('"', '""')}"`;
        const match = await withTenant(appPool, tenantId, (client) => client.query(
          `SELECT 1 FROM ${schema}.${name} AS candidate
           WHERE row_to_json(candidate)::text LIKE $1 LIMIT 1`,
          ["%127.0.0.1%"],
        ));
        assert.equal(match.rowCount, 0, `source IP leaked into ${table.table_schema}.${table.table_name}`);
      }
      assert.equal(await payloadStore.scanFor("127.0.0.1"), false);
    } finally {
      await close(limited.server);
    }
  });

  it("C08 registers an app, returns one SDK secret, audits IDs only, and hides app existence", async () => {
    const newAppId = `registered-${suffix}`;
    const headers = { authorization: `Bearer ${adminKeyA}`, "content-type": "application/json" };
    const registered = await fetch(`${baseUrl}/v1/admin/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({ app_id: newAppId }),
    });
    assert.equal(registered.status, 201);
    const issued = await registered.json() as { app_id: string; sdk_key_id: string; sdk_key: string };
    assert.equal(issued.app_id, newAppId);
    assert.ok(issued.sdk_key.length >= 32);
    assert.equal(await payloadStore.scanFor(issued.sdk_key), false);

    const listedBody = await (await fetch(`${baseUrl}/v1/admin/apps`, { headers })).text();
    assert.match(listedBody, new RegExp(newAppId));
    assert.equal(listedBody.includes(issued.sdk_key), false);
    const audits = await withTenant(appPool, tenantId, (client) => client.query<{ action: string; row_text: string }>(
      `SELECT action, row_to_json(audit_logs)::text AS row_text FROM ledger.audit_logs
       WHERE tenant_id=$1 AND app_id=$2 AND action IN ('app_registered','sdk_key_issued') ORDER BY action`,
      [tenantId, newAppId],
    ));
    assert.deepEqual(audits.rows.map((row) => row.action), ["app_registered", "sdk_key_issued"]);
    assert.equal(audits.rows.some((row) => row.row_text.includes(issued.sdk_key)), false);

    const dashboardCookie = cookie(await login(adminKeyA));
    const appPage = await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, { headers: { cookie: dashboardCookie } });
    const appHtml = await appPage.text();
    const blankFilterPage = await fetch(`${baseUrl}/dashboard/apps/${newAppId}?metric_name=&date_from=&date_to=&grouping_country=&supersession=latest`, { headers: { cookie: dashboardCookie } });
    assert.equal(blankFilterPage.status, 200);
    assert.match(await blankFilterPage.text(), /Analyze metrics/);
    const unknownFilterPage = await fetch(`${baseUrl}/dashboard/apps/${newAppId}?unknown=`, { headers: { cookie: dashboardCookie } });
    assert.equal(unknownFilterPage.status, 400);
    assert.match(await unknownFilterPage.text(), /unknown_filter/);
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(appHtml)?.[1];
    assert.ok(csrf);
    assert.match(appHtml, /Create a tracking link/);
    const missingMetricPath = `/v1/admin/apps/${newAppId}/metrics/missing-synthetic-run/explanation`;
    assert.equal((await fetch(`${baseUrl}${missingMetricPath}`, { headers: { cookie: dashboardCookie } })).status, 401);
    assert.equal((await fetch(`${baseUrl}${missingMetricPath}`, { headers })).status, 404);
    const missingDashboardMetric = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/metrics/missing-synthetic-run/explanation`, { headers: { cookie: dashboardCookie } });
    assert.equal(missingDashboardMetric.status, 404);
    assert.match(await missingDashboardMetric.text(), /Metric run not found/);
    assert.match(appHtml, new RegExp(`/dashboard/apps/${newAppId}/sdk-keys`));
    assert.match(appHtml, new RegExp(`/dashboard/apps/${newAppId}/apple-registration`));
    assert.match(appHtml, /Google Data Manager delivery health/);
    assert.match(appHtml, /No Google conversion deliveries are recorded/);
    assert.match(appHtml, /Operator delivery health/);
    assert.match(appHtml, /No operator webhook deliveries are recorded/);
    assert.match(appHtml, /No operator bulk-export batches are recorded/);
    assert.equal(appHtml.includes(issued.sdk_key), false);

    const operatorHealth = await fetch(
      `${baseUrl}/v1/admin/apps/${newAppId}/operator-delivery-health`,
      { headers },
    );
    assert.equal(operatorHealth.status, 200);
    assert.deepEqual(await operatorHealth.json(), {
      webhooks: {
        summary: {
          total: 0, due_now: 0, scheduled: 0,
          by_state: { queued: 0, retry: 0, succeeded: 0, failed: 0, suppressed: 0 },
        },
        deliveries: [],
      },
      bulk_exports: {
        summary: {
          total: 0, due_now: 0, scheduled: 0,
          by_state: { queued: 0, retry: 0, succeeded: 0, failed: 0, suppressed: 0 },
        },
        batches: [],
      },
      maximum_rows_per_channel: 50,
    });

    const deliveryHealth = await fetch(
      `${baseUrl}/v1/admin/apps/${newAppId}/google-data-manager/deliveries`,
      { headers },
    );
    assert.equal(deliveryHealth.status, 200);
    const deliveryHealthText = await deliveryHealth.text();
    assert.deepEqual(JSON.parse(deliveryHealthText), {
      destination: { configured: false, enabled: false, next_request_at: null },
      summary: {
        total: 0,
        due_now: 0,
        scheduled: 0,
        by_state: {
          queued: 0,
          http_accepted: 0,
          diagnostics_processing: 0,
          succeeded: 0,
          partial_success: 0,
          failed: 0,
          expired: 0,
        },
      },
      deliveries: [],
      maximum_rows: 50,
    });
    for (const forbidden of [
      "request_ref", "request_digest", "transaction_digest", "provider_request_id",
      "verification_result_id", "verified_record_id", "artifact", "claim_token", "claimed_until",
    ]) assert.equal(deliveryHealthText.includes(forbidden), false, forbidden);
    const missingHealth = await fetch(
      `${baseUrl}/v1/admin/apps/unknown-${suffix}/google-data-manager/deliveries`,
      { headers },
    );
    assert.equal(missingHealth.status, 404);
    assert.deepEqual(await missingHealth.json(), { error: "app_not_found" });
    const missingOperatorHealth = await fetch(
      `${baseUrl}/v1/admin/apps/unknown-${suffix}/operator-delivery-health`,
      { headers },
    );
    assert.equal(missingOperatorHealth.status, 404);
    assert.deepEqual(await missingOperatorHealth.json(), { error: "app_not_found" });

    await withTenant(appPool, tenantId, async (client) => {
      const destinationId = randomUUID();
      await client.query(`INSERT INTO control.google_data_manager_destinations (
        destination_id,tenant_id,app_id,operating_account_id,conversion_action_id,
        app_audience,enabled,registered_at,artifact,next_request_at
      ) VALUES ($1,$2,$3,'123456789','987654321','general',true,$4,$5::jsonb,$6)`, [
        destinationId,
        tenantId,
        newAppId,
        "2026-08-31T09:00:00.000Z",
        JSON.stringify({ synthetic: true }),
        "2026-08-31T10:00:00.000Z",
      ]);
      for (const [index, state, attempts, nextAttempt, deadline, reason] of [
        [0, "queued", 2, "2099-08-31T10:01:00.000Z", null, "rate_limited"],
        [1, "diagnostics_processing", 1, "2099-08-31T10:30:00.000Z", "2099-09-01T10:00:00.000Z", null],
        [2, "failed", 3, "2026-08-31T10:00:00.000Z", null, "provider_rejected"],
      ] as const) {
        const verificationResultId = randomUUID();
        const digest = randomUUID().replaceAll("-", "").repeat(2);
        await client.query(`INSERT INTO ledger.google_play_purchase_verification_results (
          verification_result_id,verification_id,tenant_id,app_id,subject_record_id,
          verified_record_id,token_digest,verdict,provider_purchase_state,product_matched,
          evidence_ref,response_digest,decided_at,artifact,purchase_kind
        ) VALUES ($1,$2,$3,$4,$5,NULL,$6,'unavailable',NULL,false,NULL,NULL,$7,$8::jsonb,'one_time_product')`, [
          verificationResultId,
          randomUUID(),
          tenantId,
          newAppId,
          `synthetic-record-${index}`,
          digest,
          "2026-08-31T09:00:00.000Z",
          JSON.stringify({ synthetic: true }),
        ]);
        const providerRequestId = state === "diagnostics_processing" ? "provider-request-synthetic-secret" : null;
        await client.query(`INSERT INTO ephemeral.google_conversion_deliveries (
          delivery_id,tenant_id,app_id,destination_id,verification_result_id,verified_record_id,
          request_ref,request_digest,transaction_digest,state,attempts,next_attempt_at,
          provider_request_id,diagnostics_deadline_at,safe_reason,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
          randomUUID(),
          tenantId,
          newAppId,
          destinationId,
          verificationResultId,
          `synthetic-verified-record-${index}`,
          `encrypted:synthetic-secret-${index}`,
          digest,
          digest,
          state,
          attempts,
          nextAttempt,
          providerRequestId,
          deadline,
          reason,
          `2026-08-31T09:0${index}:00.000Z`,
          `2026-08-31T09:1${index}:00.000Z`,
        ]);
      }
    });
    const populatedHealth = await fetch(
      `${baseUrl}/v1/admin/apps/${newAppId}/google-data-manager/deliveries`,
      { headers },
    );
    assert.equal(populatedHealth.status, 200);
    const populatedText = await populatedHealth.text();
    const populated = JSON.parse(populatedText) as {
      destination: { configured: boolean; enabled: boolean; next_request_at: string };
      summary: { total: number; scheduled: number; by_state: Record<string, number> };
      deliveries: Array<{ state: string; safe_reason: string | null }>;
    };
    assert.deepEqual(populated.destination, {
      configured: true,
      enabled: true,
      next_request_at: "2026-08-31T10:00:00.000Z",
    });
    assert.equal(populated.summary.total, 3);
    assert.equal(populated.summary.scheduled, 2);
    assert.equal(populated.summary.by_state.queued, 1);
    assert.equal(populated.summary.by_state.diagnostics_processing, 1);
    assert.equal(populated.summary.by_state.failed, 1);
    assert.deepEqual(populated.deliveries.map((row) => row.state), [
      "failed", "diagnostics_processing", "queued",
    ]);
    for (const forbidden of [
      "provider-request-synthetic-secret", "encrypted:synthetic-secret", "synthetic-verified-record",
      "request_ref", "request_digest", "transaction_digest", "provider_request_id",
      "verification_result_id", "verified_record_id", "artifact", "claim_token", "claimed_until",
    ]) assert.equal(populatedText.includes(forbidden), false, forbidden);
    const populatedDashboard = await (await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, {
      headers: { cookie: dashboardCookie },
    })).text();
    assert.match(populatedDashboard, /diagnostics_processing/);
    assert.match(populatedDashboard, /rate_limited/);
    assert.match(populatedDashboard, /provider_rejected/);
    assert.equal(populatedDashboard.includes("provider-request-synthetic-secret"), false);

    const rejectedRotation = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/sdk-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "wrong-session-token", platform: "ios" }),
    });
    assert.equal(rejectedRotation.status, 403);
    const dashboardRotation = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/sdk-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, platform: "ios" }),
    });
    assert.equal(dashboardRotation.status, 201);
    const rotationHtml = await dashboardRotation.text();
    const successorSecret = /<dt>SDK key<\/dt><dd><code>([^<]+)<\/code>/.exec(rotationHtml)?.[1];
    assert.ok(successorSecret);
    const refreshedApp = await (await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, {
      headers: { cookie: dashboardCookie },
    })).text();
    assert.equal(refreshedApp.includes(successorSecret), false);
    assert.match(refreshedApp, /secrets are never listed/);

    const firstServerIssue = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, producer: "postback:first-party" }),
    });
    assert.equal(firstServerIssue.status, 201);
    const firstServerHtml = await firstServerIssue.text();
    const firstServerKeyId = /<dt>Server key ID<\/dt><dd>([^<]+)<\/dd>/.exec(firstServerHtml)?.[1];
    const firstServerSecret = /<dt>Server key<\/dt><dd><code>([^<]+)<\/code>/.exec(firstServerHtml)?.[1];
    assert.ok(firstServerKeyId);
    assert.ok(firstServerSecret);
    const secondServerIssue = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, producer: "postback:first-party" }),
    });
    assert.equal(secondServerIssue.status, 201);
    const secondServerHtml = await secondServerIssue.text();
    const secondServerKeyId = /<dt>Server key ID<\/dt><dd>([^<]+)<\/dd>/.exec(secondServerHtml)?.[1];
    const secondServerSecret = /<dt>Server key<\/dt><dd><code>([^<]+)<\/code>/.exec(secondServerHtml)?.[1];
    assert.ok(secondServerKeyId);
    assert.ok(secondServerSecret);
    const serverMetadataPage = await (await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, {
      headers: { cookie: dashboardCookie },
    })).text();
    assert.match(serverMetadataPage, /Server-to-server keys/);
    assert.match(serverMetadataPage, new RegExp(firstServerKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(serverMetadataPage, new RegExp(secondServerKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(serverMetadataPage.includes(firstServerSecret), false);
    assert.equal(serverMetadataPage.includes(secondServerSecret), false);
    assert.equal(serverMetadataPage.includes("secret_ref"), false);
    const retiredServer = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys/${encodeURIComponent(firstServerKeyId)}/retire`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    assert.equal(retiredServer.status, 303);
    const lastServer = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys/${encodeURIComponent(secondServerKeyId)}/retire`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    assert.equal(lastServer.status, 409);
    assert.match(await lastServer.text(), /last_active_server_key/);

    const linkDomain = await fetch(`${baseUrl}/dashboard/link-domain`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, host: `wo18-${suffix}.synthetic.example` }),
    });
    assert.equal(linkDomain.status, 303);
    const trackingLink = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/tracking-links`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: csrf,
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic",
        play_package_name: "dev.openmasu.synthetic",
        campaign_id: "synthetic-campaign",
      }),
    });
    assert.equal(trackingLink.status, 201);
    const trackingLinkHtml = await trackingLink.text();
    assert.match(trackingLinkHtml, /Tracking link created/);
    assert.match(trackingLinkHtml, /http:\/\/localhost:8090\/r\/[A-Za-z0-9_-]+/);
    const trackingAudit = await withTenant(appPool, tenantId, (client) => client.query(
      `SELECT 1 FROM ledger.audit_logs
       WHERE tenant_id=$1 AND app_id=$2 AND action='tracking_link_created' AND outcome='succeeded'`,
      [tenantId, newAppId],
    ));
    assert.equal(trackingAudit.rowCount, 1);

    const dashboardLinks = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/tracking-links`, {
      headers: { cookie: dashboardCookie },
    });
    assert.equal(dashboardLinks.status, 200);
    const dashboardLinksHtml = await dashboardLinks.text();
    assert.match(dashboardLinksHtml, /Measurement links/);
    assert.match(dashboardLinksHtml, /http:\/\/localhost:8090\/r\/[A-Za-z0-9_-]+/);
    assert.match(dashboardLinksHtml, /synthetic-campaign/);
    assert.match(dashboardLinksHtml, /active/);

    const apiLinks = await fetch(`${baseUrl}/v1/admin/tracking-links?app_id=${newAppId}`, { headers });
    assert.equal(apiLinks.status, 200);
    const apiLinksBody = await apiLinks.json() as { data: readonly Record<string, unknown>[] };
    assert.equal(apiLinksBody.data.length, 1);
    assert.match(String(apiLinksBody.data[0].measurement_url), /^http:\/\/localhost:8090\/r\/[A-Za-z0-9_-]+$/);
    assert.equal(apiLinksBody.data[0].campaign_id, "synthetic-campaign");
    assert.equal(apiLinksBody.data[0].status, "active");
    assert.equal("tenant_id" in apiLinksBody.data[0], false);
    assert.equal("app_id" in apiLinksBody.data[0], false);
    assert.equal("artifact" in apiLinksBody.data[0], false);

    const linkId = encodeURIComponent(String(apiLinksBody.data[0].tracking_link_id));
    const previewUrl = `${baseUrl}/v1/admin/apps/${newAppId}/tracking-links/${linkId}/preview`;
    const previewReader = `synthetic-link-reader-${suffix}-${"p".repeat(32)}`;
    await ensureAdminKeys(appPool, { tenantId, appId }, [{ key: previewReader, role: "read_only" }]);
    const previewHeaders = { authorization: `Bearer ${previewReader}` };
    const counts = () => withTenant(readerPool, tenantId, async client => (await client.query(`SELECT
      (SELECT count(*) FROM ledger.ingest_batches WHERE tenant_id=$1) AS batches,
      (SELECT count(*) FROM ledger.raw_records WHERE tenant_id=$1) AS raw,
      (SELECT count(*) FROM ledger.event_deliveries WHERE tenant_id=$1) AS deliveries,
      (SELECT count(*) FROM ledger.click_facts WHERE tenant_id=$1) AS clicks,
      (SELECT count(*) FROM ledger.audit_logs WHERE tenant_id=$1) AS audits`, [tenantId])).rows[0]);
    const beforePreview = await counts();
    const androidPreview = await fetch(`${previewUrl}?platform=android`, { headers: previewHeaders });
    assert.equal(androidPreview.status, 200);
    const preview = await androidPreview.json() as { preview_only: boolean; destination: string; click_id_placeholder: string; fallback_reason: string | null };
    assert.equal(preview.preview_only, true); assert.equal(preview.fallback_reason, null);
    assert.match(preview.click_id_placeholder, /^synthetic_preview_/); assert.equal(preview.click_id_placeholder.length, 44);
    assert.equal((await fetch(`${previewUrl}?platform=ios`, { headers: previewHeaders }).then(response => response.json()) as { fallback_reason: string }).fallback_reason, "platform_not_supported");
    assert.equal((await fetch(`${previewUrl}?platform=android&path=%2F..%2Funsafe`, { headers: previewHeaders }).then(response => response.json()) as { fallback_reason: string }).fallback_reason, "invalid_deep_link_path");
    assert.equal((await fetch(`${previewUrl}?platform=android&next=https://unsafe.example`, { headers: previewHeaders })).status, 400);
    assert.equal((await fetch(`${previewUrl}?platform=android`)).status, 401);
    const previewHtml = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/tracking-links/${linkId}/preview?platform=android`, { headers: { cookie: dashboardCookie } });
    assert.equal(previewHtml.status, 200); assert.match(await previewHtml.text(), /Preview without recording a click/);
    assert.deepEqual(await counts(), beforePreview, "preview does not write receipt, click, delivery or audit evidence");

    const emptyReport = await fetch(`${baseUrl}/v1/reports/metrics?app_id=${newAppId}&format=json`, { headers });
    assert.equal(emptyReport.status, 200);
    assert.deepEqual(await emptyReport.json(), { data: [] });

    const otherTenant = `tenant-other-${suffix}`;
    const otherApp = `app-other-${suffix}`;
    await withTenant(appPool, otherTenant, (client) => client.query(
      "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
      [otherTenant, otherApp, "2026-08-20T00:00:00.000Z"],
    ));
    const unknown = await fetch(`${baseUrl}/v1/reports/metrics?app_id=missing-${suffix}&format=json`, { headers });
    const crossTenant = await fetch(`${baseUrl}/v1/reports/metrics?app_id=${otherApp}&format=json`, { headers });
    assert.equal(unknown.status, 404);
    assert.equal(crossTenant.status, 404);
    assert.equal(await unknown.text(), await crossTenant.text());
    const unknownLinks = await fetch(`${baseUrl}/v1/admin/tracking-links?app_id=missing-${suffix}`, { headers });
    const crossTenantLinks = await fetch(`${baseUrl}/v1/admin/tracking-links?app_id=${otherApp}`, { headers });
    assert.equal(unknownLinks.status, 404);
    assert.equal(crossTenantLinks.status, 404);
    assert.equal(await unknownLinks.text(), await crossTenantLinks.text());
    const previewUnknown = await fetch(`${baseUrl}/v1/admin/apps/missing-${suffix}/tracking-links/${linkId}/preview?platform=android`, { headers });
    const previewForeign = await fetch(`${baseUrl}/v1/admin/apps/${otherApp}/tracking-links/${linkId}/preview?platform=android`, { headers });
    assert.equal(previewUnknown.status, 404); assert.equal(previewForeign.status, 404);
    assert.equal(await previewUnknown.text(), await previewForeign.text());
  });

  it("pages 205 tracking links with scoped signed cursors and keeps older lifecycle controls reachable", async () => {
    const listApp = `app-link-pages-${suffix}`, otherApp = `app-link-other-${suffix}`;
    await withTenant(appPool, tenantId, async client => {
      await client.query("INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$4),($1,$3,$4)",
        [tenantId, listApp, otherApp, "2026-10-29T00:00:00.000Z"]);
      await client.query(`INSERT INTO control.tracking_links
        (tracking_link_id,tenant_id,app_id,slug,destination_kind,destination_url,campaign_id,created_at,artifact)
        SELECT 'link:pages:' || $3 || ':' || lpad(n::text,3,'0'),$1,$2,'pages_' || $3 || '_' || lpad(n::text,3,'0'),
          'custom_https','https://links.synthetic.example/',CASE WHEN n%2=0 THEN 'campaign-even' ELSE 'campaign-odd' END,
          CASE WHEN n<100 THEN '2026-10-29T00:00:00.000Z' ELSE '2026-10-28T00:00:00.000Z' END,'{}'::jsonb
        FROM generate_series(0,204) AS n`, [tenantId, listApp, suffix]);
      await client.query(`INSERT INTO control.tracking_link_states (tracking_link_id,tenant_id,app_id,status,changed_at,artifact)
        SELECT tracking_link_id,tenant_id,app_id,'active',created_at,'{}'::jsonb FROM control.tracking_links WHERE tenant_id=$1 AND app_id=$2`, [tenantId, listApp]);
    });
    const headers = { authorization: `Bearer ${adminKeyA}` };
    const api = `${baseUrl}/v1/admin/tracking-links`;
    const first = await fetch(`${api}?app_id=${listApp}`, { headers }); assert.equal(first.status, 200);
    type Page = { data: { tracking_link_id: string; status: string; campaign_id: string }[]; next_cursor?: string };
    const page = await first.json() as Page; assert.equal(page.data.length, 200); assert.ok(page.next_cursor);
    const oldLink = `link:pages:${suffix}:204`, lifecycle = `${baseUrl}/v1/admin/apps/${listApp}/tracking-links/${encodeURIComponent(oldLink)}`;
    assert.equal((await fetch(`${lifecycle}/pause`, { method: "POST", headers })).status, 200);
    const created = await fetch(api, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
      app_id: listApp, destination_kind: "custom_https", destination_url: "https://links.synthetic.example/", campaign_id: "campaign-new",
    }) }); assert.equal(created.status, 201);
    const continuation = new URLSearchParams({ app_id: listApp, cursor: page.next_cursor! });
    const lastResponse = await fetch(`${api}?${continuation}`, { headers }); assert.equal(lastResponse.status, 200);
    const last = await lastResponse.json() as Page; assert.equal(last.data.length, 5); assert.equal(last.next_cursor, undefined);
    const ids = [...page.data, ...last.data].map(row => row.tracking_link_id);
    assert.equal(new Set(ids).size, 205); assert.deepEqual(ids, Array.from({ length: 205 }, (_, n) => `link:pages:${suffix}:${String(n).padStart(3, "0")}`));
    assert.equal(last.data.find(row => row.tracking_link_id === oldLink)?.status, "active", "continuation retains the initial lifecycle boundary");
    for (const changes of [{ cursor: `x${page.next_cursor!.slice(1)}` }, { app_id: otherApp }, { status: "paused" }, { limit: "73" }]) {
      const invalid = new URLSearchParams(continuation); for (const [key, value] of Object.entries(changes)) invalid.set(key, value);
      assert.equal((await fetch(`${api}?${invalid}`, { headers })).status, 400);
    }
    const exact = await fetch(`${api}?${new URLSearchParams({ app_id: listApp, status: "paused", campaign_id: "campaign-even", slug: `pages_${suffix}_204` })}`, { headers });
    assert.equal(exact.status, 200); assert.deepEqual((await exact.json() as Page).data.map(row => row.tracking_link_id), [oldLink]);
    const empty = await fetch(`${api}?app_id=${listApp}&campaign_id=absent-campaign`, { headers }); assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { data: [] });
    const sessionCookie = cookie(await login(adminKeyA));
    const htmlFirst = await fetch(`${baseUrl}/dashboard/apps/${listApp}/tracking-links`, { headers: { cookie: sessionCookie } });
    assert.equal(htmlFirst.status, 200); assert.match(await htmlFirst.text(), /Next measurement-links page/);
    const htmlLast = await fetch(`${baseUrl}/dashboard/apps/${listApp}/tracking-links?${new URLSearchParams({ cursor: page.next_cursor! })}`, { headers: { cookie: sessionCookie } });
    assert.equal(htmlLast.status, 200); assert.match(await htmlLast.text(), new RegExp(`${encodeURIComponent(oldLink)}/pause`));
    const current = await fetch(`${baseUrl}/dashboard/apps/${listApp}/tracking-links?status=paused`, { headers: { cookie: sessionCookie } });
    assert.match(await current.text(), new RegExp(`${encodeURIComponent(oldLink)}/resume`));
    const reset = await fetch(`${baseUrl}/dashboard/apps/${listApp}/tracking-links/${encodeURIComponent(oldLink)}/resume`, {
      method: "POST", redirect: "manual", headers: { cookie: sessionCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrfToken(readDashboardToken(sessionCookie, configuredOrigin)!) }),
    }); assert.equal(reset.status, 303);
    const invalidHtml = await fetch(`${baseUrl}/dashboard/apps/${otherApp}/tracking-links?${new URLSearchParams({ cursor: page.next_cursor! })}`, { headers: { cookie: sessionCookie } });
    assert.equal(invalidHtml.status, 400);
  });

  it("WO13 creates tracking links for configured origins and rejects unconfigured origins", async () => {
    const dashboardCookie = cookie(await login(adminKeyA));
    const appPage = await fetch(`${baseUrl}/dashboard/apps/${appId}`, {
      headers: { cookie: dashboardCookie },
    });
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(await appPage.text())?.[1];
    assert.ok(csrf);
    const create = (destinationUrl: string) => fetch(`${baseUrl}/dashboard/apps/${appId}/tracking-links`, {
      method: "POST",
      headers: {
        cookie: dashboardCookie,
        origin: configuredOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf_token: csrf,
        destination_kind: "custom_https",
        destination_url: destinationUrl,
        campaign_id: "synthetic-allowlist-campaign",
      }),
    });

    const allowed = await create("https://links.synthetic.example/landing");
    assert.equal(allowed.status, 201);
    assert.match(await allowed.text(), /Tracking link created/);

    const rejected = await create("https://unlisted.synthetic.example/landing");
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /destination_origin_not_allowed/);

    const stored = await withTenant(appPool, tenantId, (client) => client.query<{ destination_url: string }>(
      `SELECT destination_url FROM control.tracking_links
       WHERE tenant_id=$1 AND app_id=$2 AND campaign_id='synthetic-allowlist-campaign'
       ORDER BY destination_url`,
      [tenantId, appId],
    ));
    assert.deepEqual(stored.rows.map((row) => row.destination_url), ["https://links.synthetic.example/landing"]);
  });

  it("WO18 rotates SDK keys and transitions tracking links with append-only audit history", async () => {
    const lifecycleApp = `lifecycle-${suffix}`;
    const headers = { authorization: `Bearer ${adminKeyA}`, "content-type": "application/json" };
    const registered = await fetch(`${baseUrl}/v1/admin/apps`, {
      method: "POST", headers, body: JSON.stringify({ app_id: lifecycleApp, sdk_platform: "android" }),
    });
    assert.equal(registered.status, 201);
    const first = await registered.json() as { sdk_key_id: string; sdk_key: string };

    const issued = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys`, {
      method: "POST", headers, body: JSON.stringify({ platform: "ios" }),
    });
    assert.equal(issued.status, 201);
    const second = await issued.json() as { sdk_key_id: string; sdk_key: string; platform: string };
    assert.equal(second.platform, "ios");
    assert.notEqual(second.sdk_key, first.sdk_key);

    const listed = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys`, { headers });
    assert.equal(listed.status, 200);
    const listText = await listed.text();
    const list = JSON.parse(listText) as { data: Array<{ sdk_key_id: string; status: string }> };
    assert.equal(list.data.length, 2);
    assert.equal(list.data.every((key) => key.status === "active"), true);
    assert.equal(listText.includes(first.sdk_key), false);
    assert.equal(listText.includes(second.sdk_key), false);
    assert.equal(listText.includes("secret_ref"), false);

    const overlap = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys`, {
      method: "POST", headers, body: JSON.stringify({ platform: "android" }),
    });
    assert.equal(overlap.status, 409);
    assert.deepEqual(await overlap.json(), { error: "sdk_key_overlap_limit_reached" });

    const retire = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys/${encodeURIComponent(first.sdk_key_id)}/retire`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(retire.status, 200);
    const lastActive = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys/${encodeURIComponent(second.sdk_key_id)}/retire`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(lastActive.status, 409);
    assert.deepEqual(await lastActive.json(), { error: "last_active_sdk_key" });

    const link = await fetch(`${baseUrl}/v1/admin/tracking-links`, {
      method: "POST", headers, body: JSON.stringify({
        app_id: lifecycleApp,
        destination_kind: "custom_https",
        destination_url: "https://links.synthetic.example/lifecycle",
        campaign_id: "synthetic-lifecycle",
      }),
    });
    assert.equal(link.status, 201);
    const linkBody = await link.json() as { tracking_link_id: string };
    const pause = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/pause`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(pause.status, 200);
    const resumePath = `/v1/admin/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/resume`;
    assert.equal((await fetch(`${baseUrl}${resumePath.replace(lifecycleApp, appId)}`, { method: "POST", headers, body: "{}" })).status, 404);
    const resumeReader = `synthetic-resume-reader-${suffix}-${"r".repeat(32)}`;
    await ensureAdminKeys(appPool, { tenantId, appId }, [{ key: resumeReader, role: "read_only" }]);
    assert.equal((await fetch(`${baseUrl}${resumePath}`, { method: "POST", headers: { authorization: `Bearer ${resumeReader}` } })).status, 403);
    const resumeCookie = cookie(await login(adminKeyA));
    const dashboardResume = `${baseUrl}/dashboard/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/resume`;
    const resumeForm = new URLSearchParams({ csrf_token: csrfToken(resumeCookie.slice(resumeCookie.indexOf("=") + 1)) });
    assert.equal((await fetch(dashboardResume, { method: "POST", headers: { cookie: resumeCookie, origin: "https://outside.synthetic.invalid" }, body: resumeForm })).status, 403);
    assert.equal((await fetch(dashboardResume, { method: "POST", headers: { cookie: resumeCookie, origin: configuredOrigin }, body: resumeForm, redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${baseUrl}${resumePath.replace(/resume$/, "pause")}`, { method: "POST", headers, body: "{}" })).status, 200);
    const race = await Promise.all([1, 2].map(() => fetch(`${baseUrl}${resumePath}`, { method: "POST", headers, body: "{}" })));
    assert.deepEqual(race.map(response => response.status).sort(), [200, 409], "one concurrent resume appends one transition");
    const archive = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/archive`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(archive.status, 200);
    const repeated = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/archive`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(repeated.status, 409);
    assert.equal((await fetch(`${baseUrl}${resumePath}`, { method: "POST", headers, body: "{}" })).status, 409);

    const history = await withTenant(appPool, tenantId, async (client) => {
      const states = await client.query<{ status: string }>(
        `SELECT status FROM control.tracking_link_states
          WHERE tenant_id=$1 AND app_id=$2 AND tracking_link_id=$3
          ORDER BY tracking_link_state_seq`,
        [tenantId, lifecycleApp, linkBody.tracking_link_id],
      );
      const audits = await client.query<{ action: string; row_text: string }>(
        `SELECT action, row_to_json(audit_logs)::text AS row_text FROM ledger.audit_logs
          WHERE tenant_id=$1 AND app_id=$2
            AND action IN ('sdk_key_issued','sdk_key_retired','tracking_link_paused','tracking_link_resumed','tracking_link_archived')
          ORDER BY occurred_at, audit_log_id`,
        [tenantId, lifecycleApp],
      );
      return { states: states.rows, audits: audits.rows };
    });
    assert.deepEqual(history.states.map((state) => state.status), ["active", "paused", "active", "paused", "active", "archived"]);
    assert.equal(history.audits.some((audit) => audit.row_text.includes(first.sdk_key) || audit.row_text.includes(second.sdk_key)), false);
    assert.equal(history.audits.some((audit) => audit.action === "sdk_key_retired"), true);
    assert.equal(history.audits.some((audit) => audit.action === "tracking_link_paused"), true);
    assert.equal(history.audits.filter((audit) => audit.action === "tracking_link_resumed").length, 2);
    assert.equal(history.audits.some((audit) => audit.action === "tracking_link_archived"), true);
  });
});
