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

    const disabled = await admin(
      `/v1/admin/apps/${appId}/operator-bulk-exports/${encodeURIComponent(destinationId)}/disable`,
      { method: "POST", body: "{}" },
    );
    assert.equal(disabled.status, 200);
  });
});
