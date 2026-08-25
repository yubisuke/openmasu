import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import {
  appendDurableBatch,
  createAppPool,
  EncryptedFilePayloadStore,
  uuidV7,
  withTenant,
} from "@openmasu/runtime";
import { processSdkInbox } from "../../worker/src/sdk-worker.js";
import { createRequestHandler } from "./router.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { parseMetricQuery } from "./report-query.js";
import { encodeMetricReport, metricReport } from "./reporting.js";
import { ensureSdkKeys, signSdkRequest } from "./sdk-auth.js";

const run = randomBytes(6).toString("hex");
const tenantId = `tenant-m2a-${run}`;
const appId = `app-m2a-${run}`;
const sdkKeyId = `sdk-key-${run}`;
const sdkSecret = `sdk-secret-${randomBytes(32).toString("base64url")}`;
const installationId = `installation:m2a-${run}`;
const masterKey = `master-${randomBytes(32).toString("base64url")}`;
const digestKey = `digest-${randomBytes(32).toString("base64url")}`;
const root = mkdtempSync(join(tmpdir(), "openmasu-m2a-"));
const pool = createAppPool();
const payloadStore = new EncryptedFilePayloadStore(root, masterKey);
const authConfig = { tenantId, appId, timestampSkewMs: 300_000, nonceTtlMs: 900_000, installationDigestKey: digestKey };
let baseUrl = "";
let server: ReturnType<typeof createServer>;
let installationKeyId = "";
let installationSecret = "";

function sourceEvent(eventId: string, eventName: string, payload: Record<string, unknown>, occurredAt = "2026-08-19T01:00:00.000Z") {
  return {
    producer_version: "synthetic-m2a",
    event_id: eventId,
    event_name: eventName,
    occurred_at: occurredAt,
    occurred_at_source: "device",
    processing_purpose_id: "analytics",
    processing_sequence: 1,
    payload: { event_name: eventName, ...payload },
  };
}

async function signed(path: string, value: unknown, options: {
  keyId?: string; secret?: string; installationKeyId?: string; nonce?: string; timestampMs?: number;
  bodyOverride?: Buffer; signatureOverride?: string;
} = {}): Promise<Response> {
  const body = options.bodyOverride ?? Buffer.from(JSON.stringify(value), "utf8");
  const timestampMs = options.timestampMs ?? Date.now();
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  const keyId = options.keyId ?? sdkKeyId;
  const installation = options.installationKeyId;
  const signature = options.signatureOverride ?? signSdkRequest(options.secret ?? sdkSecret, {
    method: "POST", path, sdkKeyId: keyId, installationKeyId: installation,
    timestampMs, nonce, body,
  });
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmasu-sdk-key-id": keyId,
      "x-openmasu-installation-key-id": installation ?? "-",
      "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce,
      "x-openmasu-signature": signature,
    },
    body: body.toString("utf8"),
  });
}

async function count(table: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM ledger.${table} WHERE tenant_id=$1 AND app_id=$2`, [tenantId, appId]);
    return result.rows[0].count;
  });
}

function workerProcess(delayMs: number) {
  const source = `
    import { createAppPool, EncryptedFilePayloadStore } from "@openmasu/runtime";
    import { processSdkInbox } from "./apps/worker/src/sdk-worker.ts";
    const pool = createAppPool();
    const store = new EncryptedFilePayloadStore(${JSON.stringify(root)}, ${JSON.stringify(masterKey)});
    await pool.query("SELECT 1");
    console.log("worker-ready");
    await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
    await processSdkInbox(pool, store, ${JSON.stringify(tenantId)});
    await pool.end();
  `;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForWorkerReady(child: ReturnType<typeof workerProcess>): Promise<void> {
  const [chunk] = await once(child.stdout, "data") as [Buffer];
  assert.match(chunk.toString("utf8"), /worker-ready/);
}

async function waitForWorkerExit(child: ReturnType<typeof workerProcess>): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 0, stderr);
}

describe("M2a signed SDK ingestion", () => {
  before(async () => {
    await ensureSdkKeys(pool, payloadStore, { tenantId, appId }, [{ keyId: sdkKeyId, secret: sdkSecret }]);
    server = createServer(createRequestHandler({
      pool,
      readerPool: pool,
      payloadStore,
      maxConfig: { tenantId, appId, pathSecret: "synthetic-path", eventKey: "synthetic-event-key", tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43200 },
      sdk: {
        pool, payloadStore, config: authConfig, maximumBytes: 64 * 1024, maximumEvents: 100,
        enrollmentBucket: new KeyedTokenBucket(100, 100),
        installationBucket: new KeyedTokenBucket(100, 100),
        appBucket: new KeyedTokenBucket(100, 100),
        privacyBucket: new KeyedTokenBucket(100, 100),
      },
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await once(server, "close");
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("authenticates before parsing and issues a one-time installation credential", async () => {
    const unsignedMalformed = await fetch(`${baseUrl}/v1/installations`, { method: "POST", body: "{" });
    assert.equal(unsignedMalformed.status, 401);
    const malformed = Buffer.from("{", "utf8");
    assert.equal((await signed("/v1/installations", {}, { bodyOverride: malformed })).status, 400);
    const response = await signed("/v1/installations", { installation_id: installationId });
    assert.equal(response.status, 201);
    const value = await response.json() as Record<string, string>;
    installationKeyId = value.installation_key_id;
    installationSecret = value.installation_secret;
    assert.match(installationKeyId, /^installation-key:/);
    assert.ok(installationSecret.length >= 43);
  });

  it("keeps a committed receipt across a worker process kill and restart", async () => {
    const eventId = `event:durable-restart:${run}`;
    const startedAt = performance.now();
    const response = await signed("/v1/events/batch", {
      records: [sourceEvent(eventId, "session_start", {
        installation_id: installationId,
        session_id: `session:durable-restart:${run}`,
      })],
    }, { secret: installationSecret, installationKeyId });
    assert.equal(response.status, 202);
    assert.ok(performance.now() - startedAt < 200, "durable 202 exceeded the local 200 ms acceptance budget");
    assert.ok(await withTenant(pool, tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.ingest_batches_current
       WHERE tenant_id=$1 AND app_id=$2 AND status='pending'`, [tenantId, appId],
    )).rows[0].count) >= 1);
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT record_id FROM ledger.raw_records
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`, [tenantId, appId, eventId],
    )).rowCount), 0);

    const stopped = workerProcess(60_000);
    const stoppedExit = once(stopped, "exit");
    await waitForWorkerReady(stopped);
    assert.equal(stopped.kill(), true);
    await stoppedExit;
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT record_id FROM ledger.raw_records
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`, [tenantId, appId, eventId],
    )).rowCount), 0);

    const restarted = workerProcess(0);
    const restartedExit = waitForWorkerExit(restarted);
    await waitForWorkerReady(restarted);
    await restartedExit;
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT record_id FROM ledger.raw_records
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`, [tenantId, appId, eventId],
    )).rowCount), 1);
  });

  it("rejects altered signatures, replay, stale timestamps, and limits before insertion", async () => {
    const bodyValue = { records: [sourceEvent(`event:session:${run}`, "session_start", { installation_id: installationId, session_id: `session:${run}` })] };
    const body = Buffer.from(JSON.stringify(bodyValue), "utf8");
    const nonce = randomBytes(18).toString("base64url");
    const timestampMs = Date.now();
    const startedAt = performance.now();
    const valid = await signed("/v1/events/batch", bodyValue, { secret: installationSecret, installationKeyId, nonce, timestampMs });
    assert.equal(valid.status, 202);
    assert.ok(performance.now() - startedAt < 200, "durable 202 exceeded the local 200 ms acceptance budget");
    const replay = await signed("/v1/events/batch", bodyValue, { secret: installationSecret, installationKeyId, nonce, timestampMs });
    assert.equal(replay.status, 401);
    for (const kind of ["key", "timestamp", "nonce", "signature", "body"] as const) {
      const baseNonce = randomBytes(18).toString("base64url");
      const baseTimestamp = Date.now();
      const baseSignature = signSdkRequest(installationSecret, {
        method: "POST", path: "/v1/events/batch", sdkKeyId, installationKeyId,
        timestampMs: baseTimestamp, nonce: baseNonce, body,
      });
      const result = await signed("/v1/events/batch", bodyValue, {
        secret: installationSecret,
        installationKeyId,
        keyId: kind === "key" ? `${sdkKeyId}x` : sdkKeyId,
        timestampMs: kind === "timestamp" ? baseTimestamp + 1 : baseTimestamp,
        nonce: kind === "nonce" ? `${baseNonce}x` : baseNonce,
        signatureOverride: kind === "signature" ? "0".repeat(64) : baseSignature,
        bodyOverride: kind === "body" ? Buffer.concat([body, Buffer.from(" ")]) : body,
      });
      assert.equal(result.status, 401);
    }
    assert.equal((await signed("/v1/events/batch", bodyValue, {
      secret: installationSecret, installationKeyId, timestampMs: Date.now() - 360_000,
    })).status, 401);
    const expiredNonce = `Expired_${randomBytes(18).toString("base64url")}`;
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO ephemeral.request_nonces (
        tenant_id, app_id, principal_type, principal_key_id, nonce,
        timestamp_ms, created_at, expires_at
      ) VALUES ($1,$2,'installation',$3,$4,0,clock_timestamp() - interval '20 minutes',clock_timestamp() - interval '1 minute')`,
      [tenantId, appId, installationKeyId, expiredNonce],
    ).then(() => undefined));
    assert.equal((await signed("/v1/events/batch", { records: [sourceEvent(
      `event:sweep:${run}`, "session_start", { installation_id: installationId, session_id: `session:sweep:${run}` },
    )] }, { secret: installationSecret, installationKeyId })).status, 202);
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      "SELECT nonce FROM ephemeral.request_nonces WHERE tenant_id=$1 AND app_id=$2 AND nonce=$3",
      [tenantId, appId, expiredNonce],
    )).rowCount), 0);
    assert.ok(await withTenant(pool, tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.audit_logs
       WHERE tenant_id=$1 AND app_id=$2 AND outcome='failed' AND actor_type IN ('sdk_key','sdk_installation')`,
      [tenantId, appId],
    )).rows[0].count) >= 7);
    const before = await count("ingest_batches");
    const oversized = Buffer.alloc(70 * 1024, 65);
    assert.equal((await signed("/v1/events/batch", {}, { secret: installationSecret, installationKeyId, bodyOverride: oversized })).status, 413);
    const tooMany = { records: Array.from({ length: 101 }, (_, index) => sourceEvent(`event:too-many:${run}:${index}`, "session_start", { installation_id: installationId, session_id: `session:${run}:${index}` })) };
    assert.equal((await signed("/v1/events/batch", tooMany, { secret: installationSecret, installationKeyId })).status, 400);
    assert.equal(await count("ingest_batches"), before);
  });

  it("drains durable batches with permanent event idempotency and conflict evidence", async () => {
    const eventId = `event:duplicate:${run}`;
    const event = sourceEvent(eventId, "custom_event", { installation_id: installationId, event_key: "synthetic_event", attributes: { source: "m2a" } });
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await signed("/v1/events/batch", { records: [event] }, { secret: installationSecret, installationKeyId })).status, 202);
    }
    await processSdkInbox(pool, payloadStore, tenantId);
    const delivery = await withTenant(pool, tenantId, (client) => client.query<{ duplicate_resolution: string; count: number }>(
      `SELECT delivery.duplicate_resolution, count(*)::int AS count
       FROM ledger.event_deliveries AS delivery
       JOIN ledger.raw_records AS raw
         ON raw.tenant_id=delivery.tenant_id AND raw.app_id=delivery.app_id
        AND raw.record_id=delivery.canonical_record_id
       WHERE delivery.tenant_id=$1 AND delivery.app_id=$2 AND raw.event_id=$3
       GROUP BY delivery.duplicate_resolution ORDER BY delivery.duplicate_resolution`, [tenantId, appId, eventId],
    ));
    assert.deepEqual(delivery.rows, [
      { duplicate_resolution: "duplicate_delivery", count: 4 },
      { duplicate_resolution: "unique", count: 1 },
    ]);
    const conflict = sourceEvent(eventId, "custom_event", { installation_id: installationId, event_key: "synthetic_event", attributes: { source: "changed" } });
    assert.equal((await signed("/v1/events/batch", { records: [conflict] }, { secret: installationSecret, installationKeyId })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const conflictCount = await withTenant(pool, tenantId, (client) => client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.rejections
       WHERE tenant_id=$1 AND app_id=$2 AND reason_code='event_id_conflict'`, [tenantId, appId],
    ));
    assert.equal(conflictCount.rows[0].count, 1);
  });

  it("creates an immutable superseding attribution when a redirect click arrives late", async () => {
    const clickId = `Click_${randomBytes(18).toString("base64url")}`;
    const installEventId = `event:late-install:${run}`;
    const install = sourceEvent(installEventId, "install", {
      installation_id: installationId, install_type: "first_install", referrer_status: "available",
      click_id: clickId, install_begin_at_server_status: "available",
      install_begin_at_server: "2026-08-19T01:00:00.000Z", protected_referrer_evidence_ref: `protected:${run}`,
    });
    assert.equal((await signed("/v1/events/batch", { records: [install] }, { secret: installationSecret, installationKeyId })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const initial = await withTenant(pool, tenantId, (client) => client.query<{ artifact: Record<string, unknown> }>(
      `SELECT artifact FROM ledger.attribution_results WHERE tenant_id=$1 AND app_id=$2 AND reason_code='unknown_click_id' ORDER BY decided_at DESC LIMIT 1`, [tenantId, appId],
    ));
    assert.equal(initial.rows.length, 1, `late install evidence: ${JSON.stringify(await withTenant(pool, tenantId, async (client) => ({
      attributions: (await client.query("SELECT reason_code, artifact FROM ledger.attribution_results WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId])).rows,
      rejections: (await client.query("SELECT reason_code, artifact FROM ledger.rejections WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId])).rows,
      batches: (await client.query("SELECT status, reason_code, artifact FROM ledger.ingest_batches_current WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId])).rows,
      logical: (await client.query("SELECT event_name, artifact FROM ledger.logical_events WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId])).rows,
    })))}`);
    const clickAt = "2026-08-18T01:00:00.000Z";
    const record = {
      contract_version: "0.4.0", record_id: `click:${uuidV7()}`, delivery_id: `delivery:${uuidV7()}`,
      tenant_id: tenantId, app_id: appId, producer: "redirector", producer_version: "synthetic-m2a",
      event_id: `event:late-click:${run}`, event_name: "click", schema_version: "0.4.0",
      occurred_at: clickAt, occurred_at_source: "server", received_at: clickAt,
      processing_purpose_id: "analytics", processing_sequence: 1,
      payload: { event_name: "click", click_id: clickId, tracking_link_id: `link:${run}`, campaign_id: `campaign:${run}`, redirector_click_at: clickAt, redirector_time_status: "available" },
    };
    await appendDurableBatch(pool, payloadStore, { tenantId, appId, producer: "redirector", body: Buffer.from(JSON.stringify({ records: [record] })), eventCount: 1, receivedAt: clickAt });
    await processSdkInbox(pool, payloadStore, tenantId);
    const replacement = await withTenant(pool, tenantId, (client) => client.query<{ artifact: Record<string, unknown> }>(
      `SELECT artifact FROM ledger.attribution_results WHERE tenant_id=$1 AND app_id=$2 AND reason_code='valid_install_referrer' AND artifact ? 'supersedes_attribution_id'`, [tenantId, appId],
    ));
    assert.equal(replacement.rows.length, 1);
    assert.deepEqual(initial.rows[0].artifact, (await withTenant(pool, tenantId, (client) => client.query<{ artifact: Record<string, unknown> }>(
      `SELECT artifact FROM ledger.attribution_results WHERE attribution_id=$1`, [initial.rows[0].artifact.attribution_id],
    ))).rows[0].artifact);
  });

  it("rejects consent-required events received after a server-recognised withdrawal", async () => {
    const before = await withTenant(pool, tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.rejections
       WHERE tenant_id=$1 AND app_id=$2 AND reason_code='consent_withdrawn'`,
      [tenantId, appId],
    )).rows[0].count);
    const withdrawal = sourceEvent(`event:withdrawal:${run}`, "consent_changed", {
      consent_state: "withdrawn",
      effective_at: "2026-08-19T00:00:00.000Z",
      consent_policy_version: "synthetic-consent-v1",
    });
    assert.equal((await signed("/v1/events/batch", { records: [withdrawal] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const eventId = `event:post-withdrawal:${run}`;
    const postWithdrawal = sourceEvent(eventId, "custom_event", {
      installation_id: installationId,
      event_key: "post_withdrawal",
      attributes: { source: "synthetic" },
    }, "2026-08-18T00:00:00.000Z");
    // A client cannot bypass the server-owned purpose mapping.
    postWithdrawal.processing_purpose_id = "fraud_prevention";
    assert.equal((await signed("/v1/events/batch", { records: [postWithdrawal] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const after = await withTenant(pool, tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.rejections
       WHERE tenant_id=$1 AND app_id=$2 AND reason_code='consent_withdrawn'`,
      [tenantId, appId],
    )).rows[0].count);
    assert.equal(after, before + 1);
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT event_id FROM ledger.logical_events
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`, [tenantId, appId, eventId],
    )).rowCount), 0);
  });

  it("authorises on-device deletion only for the credential's own installation", async () => {
    const secondId = `installation:other-${run}`;
    const secondResponse = await signed("/v1/installations", { installation_id: secondId });
    assert.equal(secondResponse.status, 201);
    assert.equal((await signed("/v1/privacy/on-device", { installation_id: secondId }, { secret: installationSecret, installationKeyId })).status, 403);
    const priorMetricId = `metric:before-delete:${run}`;
    const priorMetric = {
      metric_run_id: priorMetricId, metric_name: "d0_install_to_24h_ad_revenue_usd",
      metric_definition_version: "0.3.0", input_snapshot_id: "1".repeat(64),
      input_received_at_watermark: "2026-08-19T02:00:00.000Z", input_ledger_position: "2026-08-19T02:00:00.000Z|record:before-delete",
      computed_at: "2026-08-19T02:01:00.000Z", data_freshness: "complete", aggregation_time_zone: "UTC",
      rule_bundle_id: "metric-default", rule_bundle_version: "0.3.0", rule_bundle_hash: "0".repeat(64),
      rounding_mode: "half_even", reproducibility_status: "fully_reproducible", value_type: "money",
      value_state: "present", value_unscaled: "1", amount_scale: 6, currency: "USD",
    };
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO ledger.metric_runs (
        metric_run_id, tenant_id, app_id, metric_name, metric_definition_version,
        grouping, grouping_digest, input_snapshot_id, input_received_at_watermark,
        input_ledger_position, computed_at, data_freshness, aggregation_time_zone,
        rule_bundle_id, rule_bundle_version, rule_bundle_hash, rounding_mode,
        reproducibility_status, value_type, value_state, value_unscaled,
        amount_scale, currency, artifact
      ) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)`,
      [priorMetricId, tenantId, appId, priorMetric.metric_name, priorMetric.metric_definition_version,
        "0".repeat(64), priorMetric.input_snapshot_id, priorMetric.input_received_at_watermark,
        priorMetric.input_ledger_position, priorMetric.computed_at, priorMetric.data_freshness,
        priorMetric.aggregation_time_zone, priorMetric.rule_bundle_id, priorMetric.rule_bundle_version,
        priorMetric.rule_bundle_hash, priorMetric.rounding_mode, priorMetric.reproducibility_status,
        priorMetric.value_type, priorMetric.value_state, priorMetric.value_unscaled,
        priorMetric.amount_scale, priorMetric.currency, JSON.stringify(priorMetric)],
    ).then(() => undefined));
    const secretRef = await withTenant(pool, tenantId, async (client) => (await client.query<{ secret_ref: string }>(
      `SELECT secret_ref FROM control.installation_credentials WHERE installation_key_id=$1`, [installationKeyId],
    )).rows[0].secret_ref);
    const response = await signed("/v1/privacy/on-device", { installation_id: installationId }, { secret: installationSecret, installationKeyId });
    assert.equal(response.status, 201);
    const artifact = await response.json() as Record<string, unknown>;
    assert.equal(artifact.deletion_subject_ref, undefined);
    assert.match(String(artifact.requester_auth_ref), /^sdk_auth:/);
    assert.ok(await withTenant(pool, tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.privacy_tombstones
       WHERE tenant_id=$1 AND app_id=$2 AND privacy_request_id=$3`,
      [tenantId, appId, artifact.privacy_request_id],
    )).rows[0].count) >= 1);
    assert.ok(await withTenant(pool, tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.corrections
       WHERE tenant_id=$1 AND app_id=$2 AND artifact->>'correction_reason'='privacy_deletion'`,
      [tenantId, appId],
    )).rows[0].count) >= 1);
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT metric_run_id FROM ledger.metric_runs
       WHERE tenant_id=$1 AND app_id=$2 AND supersedes_metric_run_id=$3`, [tenantId, appId, priorMetricId],
    )).rowCount), 1);
    const parsed = parseMetricQuery({
      tenantId,
      appId,
      searchParams: new URLSearchParams({ metric_name: priorMetric.metric_name, limit: "20" }),
    });
    const page = await metricReport(pool, {
      keyId: "key:synthetic-m2a",
      tenantId,
      appId,
      role: "admin",
    }, parsed.query);
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0].reproducibility_status, "redaction_affected");
    assert.notEqual(page.data[0].metric_run_id, priorMetricId);
    for (const body of [
      encodeMetricReport(page, "json").body,
      encodeMetricReport(page, "csv").body,
    ]) {
      assert.equal(body.includes(installationId), false);
      assert.equal(body.includes("record_id"), false);
      assert.equal(body.includes("evidence_refs"), false);
    }
    await assert.rejects(payloadStore.read(secretRef));
    assert.equal((await signed("/v1/events/batch", { records: [sourceEvent(`event:after-delete:${run}`, "session_start", { installation_id: installationId, session_id: `session:after-delete:${run}` })] }, { secret: installationSecret, installationKeyId })).status, 401);
  });
});
