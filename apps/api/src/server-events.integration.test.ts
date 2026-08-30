import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAppPool, EncryptedFilePayloadStore, withTenant } from "@openmasu/runtime";
import { processSdkInbox } from "../../worker/src/sdk-worker.js";
import { ensureAdminKeys } from "./admin-auth.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";
import { signServerRequest } from "./server-auth.js";

const run = randomBytes(6).toString("hex");
const tenantId = `tenant-server-${run}`;
const appId = `app-server-${run}`;
const adminKey = `synthetic-server-admin-${randomBytes(32).toString("base64url")}`;
const digestKey = `synthetic-server-digest-${randomBytes(32).toString("base64url")}`;
const payloadRoot = mkdtempSync(join(tmpdir(), "openmasu-server-events-"));
const payloadStore = new EncryptedFilePayloadStore(
  payloadRoot,
  `synthetic-server-master-${randomBytes(32).toString("base64url")}`,
);
const pool = createAppPool();
let server: ReturnType<typeof createServer>;
let baseUrl = "";
let activeKeyId = "";
let activeSecret = "";

function event(eventId: string, installationId: string, overrides: Record<string, unknown> = {}) {
  return {
    producer_version: "synthetic-backend-1",
    event_id: eventId,
    event_name: "custom_event",
    occurred_at: "2026-08-30T01:02:03.000Z",
    processing_sequence: 1,
    payload: {
      event_name: "custom_event",
      installation_id: installationId,
      event_key: "synthetic_backend_event",
      attributes: { source: "synthetic_server" },
    },
    ...overrides,
  };
}

async function signed(value: unknown, options: {
  keyId?: string;
  secret?: string;
  nonce?: string;
  timestampMs?: number;
  signature?: string;
  body?: Buffer;
} = {}): Promise<Response> {
  const body = options.body ?? Buffer.from(JSON.stringify(value), "utf8");
  const timestampMs = options.timestampMs ?? Date.now();
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  const keyId = options.keyId ?? activeKeyId;
  const signature = options.signature ?? signServerRequest(options.secret ?? activeSecret, {
    method: "POST",
    path: "/v1/events/server",
    appId,
    serverKeyId: keyId,
    timestampMs,
    nonce,
    body,
  });
  return fetch(`${baseUrl}/v1/events/server`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmasu-app-id": appId,
      "x-openmasu-server-key-id": keyId,
      "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce,
      "x-openmasu-signature": signature,
    },
    body: body.toString("utf8"),
  });
}

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

describe("authenticated server-to-server event ingestion", { concurrency: false }, () => {
  before(async () => {
    await ensureAdminKeys(pool, { tenantId, appId }, [adminKey]);
    server = createServer(createRequestHandler({
      pool,
      readerPool: pool,
      payloadStore,
      maxConfig: {
        tenantId,
        appId,
        pathSecret: "synthetic-server-max-path",
        eventKey: "synthetic-server-max-event-key",
        tokenMode: "all_with_event_fallback",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43200 },
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await once(server, "close");
    await pool.end();
    rmSync(payloadRoot, { recursive: true, force: true });
  });

  it("issues, lists, rotates, and retires server keys without returning stored secrets", async () => {
    const firstResponse = await admin(`/v1/admin/apps/${appId}/server-keys`, {
      method: "POST", body: JSON.stringify({ producer: "postback:first-party" }),
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json() as { server_key_id: string; server_key: string; producer: string };
    assert.equal(first.producer, "postback:first-party");
    assert.ok(first.server_key.length >= 32);
    const secondResponse = await admin(`/v1/admin/apps/${appId}/server-keys`, {
      method: "POST", body: JSON.stringify({ producer: "postback:first-party" }),
    });
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json() as { server_key_id: string; server_key: string };

    const listed = await admin(`/v1/admin/apps/${appId}/server-keys`);
    assert.equal(listed.status, 200);
    const listText = await listed.text();
    const list = JSON.parse(listText) as { data: Array<{ server_key_id: string; status: string }> };
    assert.equal(list.data.length, 2);
    assert.equal(list.data.every((key) => key.status === "active"), true);
    assert.equal(listText.includes(first.server_key), false);
    assert.equal(listText.includes(second.server_key), false);
    assert.equal(listText.includes("secret_ref"), false);

    const overlap = await admin(`/v1/admin/apps/${appId}/server-keys`, {
      method: "POST", body: JSON.stringify({ producer: "postback:first-party" }),
    });
    assert.equal(overlap.status, 409);
    assert.deepEqual(await overlap.json(), { error: "server_key_overlap_limit_reached" });
    const retired = await admin(`/v1/admin/apps/${appId}/server-keys/${encodeURIComponent(first.server_key_id)}/retire`, {
      method: "POST", body: "{}",
    });
    assert.equal(retired.status, 200);
    const oldCredential = await signed({ records: [event(`event:old-key:${run}`, `installation:old-key:${run}`)] }, {
      keyId: first.server_key_id,
      secret: first.server_key,
    });
    assert.equal(oldCredential.status, 401);
    const lastActive = await admin(`/v1/admin/apps/${appId}/server-keys/${encodeURIComponent(second.server_key_id)}/retire`, {
      method: "POST", body: "{}",
    });
    assert.equal(lastActive.status, 409);
    assert.deepEqual(await lastActive.json(), { error: "last_active_server_key" });
    activeKeyId = second.server_key_id;
    activeSecret = second.server_key;
  });

  it("authenticates the raw body, rejects replay and authority escalation, and projects valid events", async () => {
    const installationId = `installation:server-valid:${run}`;
    const value = { records: [event(`event:server-valid:${run}`, installationId)] };
    const nonce = randomBytes(18).toString("base64url");
    const timestampMs = Date.now();
    const accepted = await signed(value, { nonce, timestampMs });
    assert.equal(accepted.status, 202);
    assert.equal((await signed(value, { nonce, timestampMs })).status, 401);
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const changedTimestamp = Date.now();
    const changedNonce = randomBytes(18).toString("base64url");
    const originalSignature = signServerRequest(activeSecret, {
      method: "POST", path: "/v1/events/server", appId, serverKeyId: activeKeyId,
      timestampMs: changedTimestamp, nonce: changedNonce, body,
    });
    assert.equal((await signed(value, {
      body: Buffer.concat([body, Buffer.from(" ")]),
      timestampMs: changedTimestamp,
      nonce: changedNonce,
      signature: originalSignature,
    })).status, 401);
    assert.equal((await signed(value, { timestampMs: Date.now() - 360_000 })).status, 401);
    const escalated = { records: [event(`event:server-escalated:${run}`, installationId, {
      payload: {
        event_name: "custom_event", installation_id: installationId, event_key: "synthetic",
        integrity_verdict: { verdict: "verified" },
      },
    })] };
    assert.equal((await signed(escalated)).status, 403);

    await processSdkInbox(pool, payloadStore, tenantId);
    const projected = await withTenant(pool, tenantId, async (client) => (await client.query<{
      producer: string; event_name: string; installation_id: string; event_key: string;
    }>(
      `SELECT raw.producer, logical.event_name, fact.installation_id, fact.event_key
         FROM ledger.raw_records AS raw
         JOIN ledger.logical_events AS logical
           ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id AND logical.record_id=raw.record_id
         JOIN ledger.custom_event_facts AS fact
           ON fact.tenant_id=logical.tenant_id AND fact.app_id=logical.app_id
          AND fact.logical_event_id=logical.logical_event_id
        WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.event_id=$3`,
      [tenantId, appId, `event:server-valid:${run}`],
    )).rows);
    assert.deepEqual(projected, [{
      producer: "postback:first-party",
      event_name: "custom_event",
      installation_id: installationId,
      event_key: "synthetic_backend_event",
    }]);
  });

  it("turns schema-invalid payloads into rejections and preserves event idempotency", async () => {
    const installationId = `installation:server-validation:${run}`;
    const invalid = event(`event:server-invalid:${run}`, installationId, {
      payload: { event_name: "custom_event", installation_id: installationId },
    });
    assert.equal((await signed({ records: [invalid] })).status, 202);
    const duplicate = event(`event:server-duplicate:${run}`, installationId);
    assert.equal((await signed({ records: [duplicate] })).status, 202);
    assert.equal((await signed({ records: [duplicate] })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const evidence = await withTenant(pool, tenantId, async (client) => ({
      rejection: (await client.query<{ reason_code: string; payload_disposition: string }>(
        `SELECT rejection.reason_code, rejection.payload_disposition
           FROM ledger.rejections AS rejection
           JOIN ledger.raw_records AS raw
             ON raw.tenant_id=rejection.tenant_id AND raw.app_id=rejection.app_id AND raw.record_id=rejection.record_id
          WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, invalid.event_id],
      )).rows,
      deliveries: (await client.query<{ duplicate_resolution: string; count: number }>(
        `SELECT delivery.duplicate_resolution, count(*)::int AS count
           FROM ledger.event_deliveries AS delivery
           JOIN ledger.raw_records AS raw
             ON raw.tenant_id=delivery.tenant_id AND raw.app_id=delivery.app_id
            AND raw.record_id=delivery.canonical_record_id
          WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.event_id=$3
          GROUP BY delivery.duplicate_resolution ORDER BY delivery.duplicate_resolution`,
        [tenantId, appId, duplicate.event_id],
      )).rows,
    }));
    assert.deepEqual(evidence.rejection, [{ reason_code: "payload_schema_invalid", payload_disposition: "discarded" }]);
    assert.deepEqual(evidence.deliveries, [
      { duplicate_resolution: "duplicate_delivery", count: 1 },
      { duplicate_resolution: "unique", count: 1 },
    ]);
  });

  it("purges a pending single-subject body and rejects later events after an installation deletion", async () => {
    const installationId = `installation:server-privacy:${run}`;
    const eventId = `event:server-privacy:${run}`;
    const accepted = await signed({ records: [event(eventId, installationId)] });
    assert.equal(accepted.status, 202);
    const batch = await accepted.json() as { ingest_batch_id: string };
    const before = await withTenant(pool, tenantId, async (client) => (await client.query<{ body_ref: string; subject_digest: string }>(
      `SELECT body_ref, subject_digest FROM ledger.ingest_batches
        WHERE tenant_id=$1 AND app_id=$2 AND ingest_batch_id=$3`,
      [tenantId, appId, batch.ingest_batch_id],
    )).rows[0]);
    assert.match(before.subject_digest, /^[a-f0-9]{64}$/);
    await payloadStore.read(before.body_ref);

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
    await assert.rejects(() => payloadStore.read(before.body_ref));
    await processSdkInbox(pool, payloadStore, tenantId);
    const projected = await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT 1 FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
      [tenantId, appId, eventId],
    )).rowCount ?? 0);
    assert.equal(projected, 0);
    const afterDeletion = await signed({ records: [event(`event:server-privacy-after:${run}`, installationId)] });
    assert.equal(afterDeletion.status, 403);
    assert.deepEqual(await afterDeletion.json(), { error: "subject_withdrawn" });
  });
});
