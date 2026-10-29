import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import { createAppPool, EncryptedFilePayloadStore, withTenant } from "@openmasu/runtime";
import {
  discoverOperatorBulkExports,
  processOperatorBulkExports,
} from "../../worker/src/operator-bulk-export-worker.js";
import { processSdkInbox } from "../../worker/src/sdk-worker.js";
import { ensureAdminKeys } from "./admin-auth.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";
import { signServerRequest } from "./server-auth.js";
import { rotateOperatorBulkExportCredentials } from "./operator-bulk-exports-admin.js";

const run = randomBytes(6).toString("hex");
const tenantId = `tenant-bulk-${run}`;
const appId = `app-bulk-${run}`;
const adminKey = `synthetic-bulk-admin-${randomBytes(32).toString("base64url")}`;
const digestKey = `synthetic-bulk-digest-${randomBytes(32).toString("base64url")}`;
const payloadRoot = mkdtempSync(join(tmpdir(), "openmasu-operator-bulk-"));
const payloadStore = new EncryptedFilePayloadStore(
  payloadRoot,
  `synthetic-bulk-master-${randomBytes(32).toString("base64url")}`,
);
const pool = createAppPool();
let api: ReturnType<typeof createServer>;
let storage: ReturnType<typeof createServer>;
let apiBaseUrl = "";
let storageOrigin = "";
let serverKeyId = "";
let serverSecret = "";
let destinationId = "";
const objects: Buffer[] = [];
const objectPaths: string[] = [];
const usedReplacement: boolean[] = [];
const hadSessionToken: boolean[] = [];
let responses = [500, 200, 200];

function event(eventId: string, installationId: string) {
  return {
    producer_version: "synthetic-backend-1",
    event_id: eventId,
    event_name: "custom_event",
    occurred_at: "2026-08-30T01:02:03.000Z",
    processing_sequence: 1,
    payload: {
      event_name: "custom_event",
      installation_id: installationId,
      event_key: "synthetic_bulk_export",
      attributes: { source: "synthetic_integration" },
    },
  };
}

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function submit(eventId: string, installationId: string): Promise<Response> {
  const body = Buffer.from(JSON.stringify({ records: [event(eventId, installationId)] }), "utf8");
  const timestampMs = Date.now();
  const nonce = randomBytes(18).toString("base64url");
  return fetch(`${apiBaseUrl}/v1/events/server`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmasu-app-id": appId,
      "x-openmasu-server-key-id": serverKeyId,
      "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce,
      "x-openmasu-signature": signServerRequest(serverSecret, {
        method: "POST", path: "/v1/events/server", appId, serverKeyId, timestampMs, nonce, body,
      }),
    },
    body,
  });
}

function ndjson(body: Buffer): Record<string, unknown>[] {
  return gunzipSync(body).toString("utf8").trimEnd().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("operator-owned S3-compatible bulk event exports", { concurrency: false }, () => {
  before(async () => {
    storage = createServer(async (request, response) => {
      if (request.method === "HEAD") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.push(Buffer.concat(chunks));
      objectPaths.push(request.url!);
      usedReplacement.push(String(request.headers.authorization).includes("Credential=SYNTHETICREPLACEMENT/"));
      hadSessionToken.push(request.headers["x-amz-security-token"] !== undefined);
      response.writeHead(responses.shift() ?? 200).end();
    });
    storage.listen(0, "127.0.0.1");
    await once(storage, "listening");
    storageOrigin = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;

    await ensureAdminKeys(pool, { tenantId, appId }, [adminKey]);
    api = createServer(createRequestHandler({
      pool,
      readerPool: pool,
      payloadStore,
      maxConfig: {
        tenantId, appId, pathSecret: "synthetic-bulk-max-path", eventKey: "synthetic-bulk-max-event",
        tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43200 },
      operatorBulkExports: { destinationAllowlist: [storageOrigin], allowSyntheticLoopback: true },
      server: {
        pool,
        payloadStore,
        config: { tenantId, timestampSkewMs: 300_000, nonceTtlMs: 900_000 },
        installationDigestKey: digestKey,
        maximumBytes: 64 * 1024,
        maximumEvents: 100,
        keyBucket: new KeyedTokenBucket(1_000, 1_000),
        appBucket: new KeyedTokenBucket(1_000, 1_000),
      },
    }));
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    apiBaseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const keyResponse = await admin(`/v1/admin/apps/${appId}/server-keys`, {
      method: "POST", body: JSON.stringify({ producer: "postback:first-party" }),
    });
    assert.equal(keyResponse.status, 201);
    const key = await keyResponse.json() as { server_key_id: string; server_key: string };
    serverKeyId = key.server_key_id;
    serverSecret = key.server_key;
  });

  after(async () => {
    api.close();
    storage.close();
    await Promise.all([once(api, "close"), once(storage, "close")]);
    await pool.end();
    rmSync(payloadRoot, { recursive: true, force: true });
  });

  it("registers a protected destination without returning or listing credentials", async () => {
    const response = await admin(`/v1/admin/apps/${appId}/operator-bulk-exports`, {
      method: "POST",
      body: JSON.stringify({
        endpoint_url: storageOrigin,
        bucket_name: "synthetic-bucket",
        object_prefix: "openmasu/events",
        region: "auto",
        events: ["custom_event", "purchase"],
        start_at: "2020-01-01T00:00:00.000Z",
        access_key_id: "SYNTHETICACCESSKEY",
        secret_access_key: "synthetic/secret/access/key/0001",
        session_token: "synthetic-session-token",
      }),
    });
    assert.equal(response.status, 201);
    const registered = await response.json() as { destination_id: string; endpoint_url: string };
    destinationId = registered.destination_id;
    assert.equal(registered.endpoint_url, storageOrigin);
    const listed = await admin(`/v1/admin/apps/${appId}/operator-bulk-exports`);
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.equal(text.includes("SYNTHETICACCESSKEY"), false);
    assert.equal(text.includes("synthetic/secret"), false);
    assert.equal(text.includes("credential_ref"), false);
    assert.equal(text.includes(destinationId), true);
  });

  it("retries the exact gzip object and advances its keyset cursor only after storage confirms it", async () => {
    const eventId = `event:bulk-delivery:${run}`;
    const installationId = `installation:bulk-delivery:${run}`;
    assert.equal((await submit(eventId, installationId)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const now = new Date("2026-08-30T02:00:00.000Z");
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, { now }), 1);
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, { now }), 0);
    const before = await withTenant(pool, tenantId, async (client) => (await client.query<{
      event_received_at: string | null;
    }>(
      `SELECT event_received_at FROM control.operator_bulk_export_checkpoints
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
      [tenantId, appId, destinationId],
    )).rows[0]!.event_received_at);
    assert.equal(before, null);
    assert.deepEqual(await processOperatorBulkExports(pool, payloadStore, tenantId, {
      enabled: true, destinationAllowlist: [storageOrigin], allowSyntheticLoopback: true, now: () => now,
    }), { processed: 1 });
    assert.equal((await withTenant(pool, tenantId, async (client) => (await client.query<{
      event_received_at: string | null;
    }>(
      `SELECT event_received_at FROM control.operator_bulk_export_checkpoints
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
      [tenantId, appId, destinationId],
    )).rows[0]!.event_received_at)), null);
    assert.deepEqual(await processOperatorBulkExports(pool, payloadStore, tenantId, {
      enabled: true, destinationAllowlist: [storageOrigin], allowSyntheticLoopback: true,
      now: () => new Date(now.valueOf() + 61_000),
    }), { processed: 1 });
    assert.equal(objects.length, 2);
    assert.equal(objects[0]!.equals(objects[1]!), true);
    const lines = ndjson(objects[0]!);
    assert.equal(lines[0]!.schema, "openmasu.operator_event_export_manifest.v1");
    assert.equal(lines[1]!.record_kind, "event");
    const serialized = JSON.stringify(lines);
    for (const forbidden of [eventId, installationId, "record:", "attributes", serverSecret]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    const checkpoint = await withTenant(pool, tenantId, async (client) => (await client.query<{
      event_received_at: string | null; event_record_id: string | null;
    }>(
      `SELECT event_received_at,event_record_id FROM control.operator_bulk_export_checkpoints
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
      [tenantId, appId, destinationId],
    )).rows[0]!);
    assert.ok(checkpoint.event_received_at);
    assert.ok(checkpoint.event_record_id);

    const healthResponse = await admin(`/v1/admin/apps/${appId}/operator-delivery-health`);
    assert.equal(healthResponse.status, 200);
    const healthText = await healthResponse.text();
    const health = JSON.parse(healthText) as {
      bulk_exports: { summary: { total: number; by_state: Record<string, number> }; batches: Array<{ state: string; row_count: number }> };
    };
    assert.ok(health.bulk_exports.summary.total >= 1);
    assert.ok(health.bulk_exports.summary.by_state.succeeded >= 1);
    assert.equal(health.bulk_exports.batches.some((row) => row.state === "succeeded" && row.row_count >= 1), true);
    for (const forbidden of [
      eventId, installationId, "event_record_id", "object_key", "object_ref", "object_digest", "artifact",
    ]) assert.equal(healthText.includes(forbidden), false, forbidden);
  });

  it("replaces rejected credentials atomically and resumes the identical object without replaying earlier events", async () => {
    const scope = [tenantId, appId, destinationId];
    const before = await withTenant(pool, tenantId, async client => (await client.query(
      `SELECT destination.bucket_name,destination.object_prefix,destination.reference_secret_ref,
         checkpoint.event_received_at,checkpoint.event_record_id,checkpoint.deletion_seq::text
       FROM control.operator_bulk_export_destinations AS destination
       JOIN control.operator_bulk_export_checkpoints AS checkpoint USING(tenant_id,app_id,destination_id)
       WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`, scope)).rows[0]);
    const priorManifest = ndjson(objects[0]!)[0]!;
    const priorEvent = ndjson(objects[0]!)[1]!.event as Record<string, unknown>;
    assert.equal((await submit(`event:bulk-rotation:${run}`, `installation:bulk-delivery:${run}`)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const now = new Date();
    responses = [403, 200];
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, { now }), 1);
    const attempt = () => processOperatorBulkExports(pool, payloadStore, tenantId, {
      enabled: true, destinationAllowlist: [storageOrigin], allowSyntheticLoopback: true,
      now: () => new Date(now.valueOf() + 120_000),
    });
    const firstObject = objects.length;
    assert.deepEqual(await attempt(), { processed: 1 });
    assert.deepEqual(await attempt(), { processed: 0 });
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, { now }), 0);
    const pending = await withTenant(pool, tenantId, async client => (await client.query(
      `SELECT object_ref,state,safe_reason FROM ephemeral.operator_bulk_export_batches
       WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state='retry'`, scope)).rows[0]);
    assert.equal(pending.safe_reason, "credentials_rejected");
    assert.deepEqual(await payloadStore.read(pending.object_ref), objects[firstObject]);
    const credentialPath = `/v1/admin/apps/${appId}/operator-bulk-exports/${encodeURIComponent(destinationId)}/credentials`;
    assert.equal((await admin(credentialPath, { method: "POST", body: JSON.stringify({
      expected_revision: "0", access_key_id: "SYNTHETICREPLACEMENT",
    }) })).status, 400, "partial replacement is rejected");
    assert.equal((await admin(credentialPath, { method: "POST", body: JSON.stringify({
      expected_revision: "0", access_key_id: "SYNTHETICREPLACEMENT", secret_access_key: "synthetic/replacement/secret/0002",
      object_prefix: "must-not-change",
    }) })).status, 400, "immutable settings are rejected");
    const rotation = await admin(credentialPath, { method: "POST", body: JSON.stringify({
      expected_revision: "0", access_key_id: "SYNTHETICREPLACEMENT", secret_access_key: "synthetic/replacement/secret/0002",
    }) });
    const rotatedText = await rotation.text();
    const rotated = JSON.parse(rotatedText) as { credential_revision: string; error?: string };
    assert.equal(rotation.status, 200, typeof rotated.error === "string" && /^operator_bulk_[a-z_]+$/.test(rotated.error)
      ? rotated.error : "unexpected credential replacement response");
    assert.notEqual(rotated.credential_revision, "0");
    const after = await withTenant(pool, tenantId, async client => (await client.query(
      `SELECT destination.bucket_name,destination.object_prefix,destination.reference_secret_ref,
         checkpoint.event_received_at,checkpoint.event_record_id,checkpoint.deletion_seq::text
       FROM control.operator_bulk_export_destinations AS destination
       JOIN control.operator_bulk_export_checkpoints AS checkpoint USING(tenant_id,app_id,destination_id)
       WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`, scope)).rows[0]);
    assert.deepEqual(after, before);
    assert.equal((await admin(credentialPath, { method: "POST", body: JSON.stringify({
      expected_revision: "0", access_key_id: "SYNTHETICREPLACEMENT", secret_access_key: "synthetic/replacement/secret/0002",
    }) })).status, 409);
    assert.deepEqual(await attempt(), { processed: 1 });
    assert.equal(objectPaths[firstObject], objectPaths[firstObject + 1]);
    assert.deepEqual(objects[firstObject], objects[firstObject + 1]);
    assert.equal(usedReplacement[firstObject], false);
    assert.equal(usedReplacement[firstObject + 1], true);
    assert.equal(hadSessionToken[firstObject], true);
    assert.equal(hadSessionToken[firstObject + 1], false, "omitted token does not inherit the old tuple");
    const resumed = ndjson(objects[firstObject + 1]!);
    assert.deepEqual(resumed[0]!.cursor_before, priorManifest.cursor_after);
    assert.equal(resumed.length, 2, "only the new event is exported");
    const resumedEvent = resumed[1]!.event as Record<string, unknown>;
    assert.ok(priorEvent.subject_ref);
    assert.equal(resumedEvent.subject_ref, priorEvent.subject_ref);
    assert.notEqual(resumedEvent.event_ref, priorEvent.event_ref);
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, { now }), 0);
    const listedText = await (await admin(`/v1/admin/apps/${appId}/operator-bulk-exports`)).text();
    const audits = await withTenant(pool, tenantId, async client => (await client.query(
      `SELECT * FROM ledger.audit_logs WHERE tenant_id=$1 AND app_id=$2 AND target_ref=$3`, scope)).rows);
    const publicEvidence = rotatedText + listedText + JSON.stringify(audits);
    for (const forbidden of ["SYNTHETICREPLACEMENT", "synthetic/replacement/secret/0002", "credential_ref", "credential_digest"]) {
      assert.equal(publicEvidence.includes(forbidden), false);
    }
    responses = [200];
  });

  it("rolls back credential revision and batch wake-up together when the final audit write fails", async () => {
    assert.equal((await submit(`event:bulk-rollback:${run}`, `installation:bulk-rollback:${run}`)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const now = new Date();
    responses = [401, 200];
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, { now }), 1);
    const process = () => processOperatorBulkExports(pool, payloadStore, tenantId, {
      enabled: true, destinationAllowlist: [storageOrigin], allowSyntheticLoopback: true,
      now: () => new Date(now.valueOf() + 120_000),
    });
    assert.deepEqual(await process(), { processed: 1 });
    const batchState = () => withTenant(pool, tenantId, async client => (await client.query(
      `SELECT * FROM ephemeral.operator_bulk_export_batches
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state='retry'`,
      [tenantId, appId, destinationId])).rows);
    const pendingBefore = await batchState();
    assert.equal(pendingBefore[0].safe_reason, "credentials_rejected");
    const before = await (await admin(`/v1/admin/apps/${appId}/operator-bulk-exports`)).json() as {
      data: Array<{ destination_id: string; credential_revision: string }>;
    };
    const revision = before.data.find(row => row.destination_id === destinationId)!.credential_revision;
    let stagedRef = "";
    const failingPool = { connect: async () => {
      const client = await pool.connect();
      return {
        query: async (query: string, values?: unknown[]) => {
          if (query.includes("INSERT INTO ledger.audit_logs")) throw new Error("synthetic/replacement/secret/0003");
          return client.query(query, values);
        },
        release: () => client.release(),
      };
    } } as unknown as Pool;
    await assert.rejects(rotateOperatorBulkExportCredentials({ pool: failingPool,
      payloadStore: { write: async (scope, bytes) => { stagedRef = await payloadStore.write(scope, bytes); return stagedRef; },
        read: ref => payloadStore.read(ref), purge: ref => payloadStore.purge(ref), scanFor: value => payloadStore.scanFor(value) },
      identity: { keyId: "synthetic-admin", tenantId, appId, role: "admin" }, destinationId,
      body: { expected_revision: revision, access_key_id: "SYNTHETICFAILEDKEY", secret_access_key: "synthetic/replacement/secret/0003" },
    }), { message: "operator_bulk_credential_update_failed" });
    assert.ok(stagedRef);
    await assert.rejects(payloadStore.read(stagedRef));
    assert.deepEqual(await (await admin(`/v1/admin/apps/${appId}/operator-bulk-exports`)).json(), before);
    assert.deepEqual(await batchState(), pendingBefore);
    assert.deepEqual(await process(), { processed: 0 });
    const refs = await withTenant(pool, tenantId, async client => (await client.query(
      `SELECT credential_ref FROM control.operator_bulk_export_credential_revisions WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
      [tenantId, appId, destinationId])).rows);
    assert.equal(refs.some(row => row.credential_ref === stagedRef), false);
    await rotateOperatorBulkExportCredentials({ pool, payloadStore,
      identity: { keyId: "synthetic-admin", tenantId, appId, role: "admin" }, destinationId,
      body: { expected_revision: revision, access_key_id: "SYNTHETICREPLACEMENT", secret_access_key: "synthetic/replacement/secret/0002" },
    });
    assert.deepEqual(await process(), { processed: 1 });
    responses = [200];
  });

  it("suppresses a pending object at privacy recognition and emits a destination-scoped deletion next", async () => {
    const eventId = `event:bulk-privacy:${run}`;
    const installationId = `installation:bulk-privacy:${run}`;
    assert.equal((await submit(eventId, installationId)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const now = new Date("2026-08-30T03:00:00.000Z");
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, { now }), 1);
    const pending = await withTenant(pool, tenantId, async (client) => (await client.query<{
      batch_id: string; object_ref: string;
    }>(
      `SELECT batch_id::text,object_ref FROM ephemeral.operator_bulk_export_batches
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state='queued'`,
      [tenantId, appId, destinationId],
    )).rows[0]!);
    const privacy = await admin("/v1/admin/privacy-requests", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        app_id: appId,
        requested_via: "tenant_admin_api",
        deletion_scope: "installation",
        deletion_subject_ref: installationId,
      }),
    });
    assert.equal(privacy.status, 201);
    await assert.rejects(() => payloadStore.read(pending.object_ref));
    const state = await withTenant(pool, tenantId, async (client) => (await client.query<{
      state: string; safe_reason: string;
    }>(
      `SELECT state,safe_reason FROM ephemeral.operator_bulk_export_batches
        WHERE tenant_id=$1 AND batch_id=$2`,
      [tenantId, pending.batch_id],
    )).rows[0]!);
    assert.deepEqual(state, { state: "suppressed", safe_reason: "privacy_suppressed" });
    assert.equal(await discoverOperatorBulkExports(pool, payloadStore, tenantId, {
      now: new Date("2026-08-30T03:01:00.000Z"),
    }), 1);
    assert.deepEqual(await processOperatorBulkExports(pool, payloadStore, tenantId, {
      enabled: true, destinationAllowlist: [storageOrigin], allowSyntheticLoopback: true,
      now: () => new Date("2026-08-30T03:01:00.000Z"),
    }), { processed: 1 });
    const deletionLines = ndjson(objects.at(-1)!);
    assert.equal(deletionLines[1]!.record_kind, "privacy_deletion");
    assert.match(String(deletionLines[1]!.subject_ref), /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(deletionLines).includes(installationId), false);

    const credentialRefs = await withTenant(pool, tenantId, async client => (await client.query<{ credential_ref: string }>(
      `SELECT credential_ref FROM control.operator_bulk_export_destinations WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3
       UNION ALL SELECT credential_ref FROM control.operator_bulk_export_credential_revisions WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
      [tenantId, appId, destinationId])).rows);
    const disabled = await admin(
      `/v1/admin/apps/${appId}/operator-bulk-exports/${encodeURIComponent(destinationId)}/disable`,
      { method: "POST", body: "{}" },
    );
    assert.equal(disabled.status, 200);
    for (const { credential_ref: reference } of credentialRefs) await assert.rejects(payloadStore.read(reference));
  });
});
