import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAppPool, EncryptedFilePayloadStore, withTenant } from "@openmasu/runtime";
import {
  discoverOperatorWebhookDeliveries,
  processOperatorWebhookDeliveries,
} from "../../worker/src/operator-webhook-worker.js";
import { processSdkInbox } from "../../worker/src/sdk-worker.js";
import { ensureAdminKeys } from "./admin-auth.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";
import { signServerRequest } from "./server-auth.js";

const run = randomBytes(6).toString("hex");
const tenantId = `tenant-webhook-${run}`;
const appId = `app-webhook-${run}`;
const adminKey = `synthetic-webhook-admin-${randomBytes(32).toString("base64url")}`;
const digestKey = `synthetic-webhook-digest-${randomBytes(32).toString("base64url")}`;
const payloadRoot = mkdtempSync(join(tmpdir(), "openmasu-operator-webhooks-"));
const payloadStore = new EncryptedFilePayloadStore(
  payloadRoot,
  `synthetic-webhook-master-${randomBytes(32).toString("base64url")}`,
);
const pool = createAppPool();
let api: ReturnType<typeof createServer>;
let receiver: ReturnType<typeof createServer>;
let apiBaseUrl = "";
let receiverOrigin = "";
let serverKeyId = "";
let serverSecret = "";
let webhookSigningSecret = "";
const received: Array<{ path: string; body: Buffer; signature: string; deliveryId: string }> = [];
let deliverStatuses = [500, 204];
let raceGate: {
  entered: Promise<void>;
  release: Promise<void>;
  markEntered: () => void;
  releaseRequest: () => void;
} | undefined;

function deliveryRaceGate(): NonNullable<typeof raceGate> {
  let markEntered!: () => void;
  let releaseRequest!: () => void;
  return {
    entered: new Promise<void>((resolve) => { markEntered = resolve; }),
    release: new Promise<void>((resolve) => { releaseRequest = resolve; }),
    markEntered,
    releaseRequest,
  };
}

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
      event_key: "synthetic_operator_callback",
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
  const signature = signServerRequest(serverSecret, {
    method: "POST",
    path: "/v1/events/server",
    appId,
    serverKeyId,
    timestampMs,
    nonce,
    body,
  });
  return fetch(`${apiBaseUrl}/v1/events/server`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmasu-app-id": appId,
      "x-openmasu-server-key-id": serverKeyId,
      "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce,
      "x-openmasu-signature": signature,
    },
    body,
  });
}

describe("provider-neutral operator event webhooks", { concurrency: false }, () => {
  before(async () => {
    receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        path: request.url ?? "",
        body: Buffer.concat(chunks),
        signature: String(request.headers["x-openmasu-signature"] ?? ""),
        deliveryId: String(request.headers["x-openmasu-delivery-id"] ?? ""),
      });
      if (request.url === "/race" && raceGate) {
        raceGate.markEntered();
        await raceGate.release;
      }
      const status = request.url === "/deliver" ? (deliverStatuses.shift() ?? 204) : 204;
      response.writeHead(status);
      response.end();
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    receiverOrigin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    await ensureAdminKeys(pool, { tenantId, appId }, [adminKey]);
    api = createServer(createRequestHandler({
      pool,
      readerPool: pool,
      payloadStore,
      maxConfig: {
        tenantId,
        appId,
        pathSecret: "synthetic-webhook-max-path",
        eventKey: "synthetic-webhook-max-event",
        tokenMode: "all_with_event_fallback",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43200 },
      operatorWebhooks: { destinationAllowlist: [receiverOrigin], allowSyntheticLoopback: true },
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
      method: "POST",
      body: JSON.stringify({ producer: "postback:first-party" }),
    });
    assert.equal(keyResponse.status, 201);
    const key = await keyResponse.json() as { server_key_id: string; server_key: string };
    serverKeyId = key.server_key_id;
    serverSecret = key.server_key;
  });

  after(async () => {
    api.close();
    receiver.close();
    await Promise.all([once(api, "close"), once(receiver, "close")]);
    await pool.end();
    rmSync(payloadRoot, { recursive: true, force: true });
  });

  it("registers and lists an app-scoped destination while returning the signing secret once", async () => {
    assert.equal((await submit(
      `event:webhook-before-registration:${run}`,
      `installation:webhook-before-registration:${run}`,
    )).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await admin(`/v1/admin/apps/${appId}/operator-webhooks`, {
      method: "POST",
      body: JSON.stringify({
        endpoint_url: `${receiverOrigin}/deliver`,
        events: ["custom_event", "purchase"],
      }),
    });
    assert.equal(response.status, 201);
    const issued = await response.json() as {
      destination_id: string;
      signing_secret: string;
      endpoint_url: string;
      events: string[];
    };
    assert.ok(issued.signing_secret.length >= 32);
    webhookSigningSecret = issued.signing_secret;
    assert.deepEqual(issued.events, ["custom_event", "purchase"]);
    const listed = await admin(`/v1/admin/apps/${appId}/operator-webhooks`);
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.equal(text.includes(issued.signing_secret), false);
    assert.equal(text.includes("secret_ref"), false);
    assert.equal(text.includes(issued.destination_id), true);
    assert.equal(await discoverOperatorWebhookDeliveries(
      pool, payloadStore, tenantId, new Date("2026-08-30T01:30:00.000Z"),
    ), 0);
  });

  it("recovers a durable retry, preserves the exact signed body, and does not duplicate discovery", async () => {
    const installationId = `installation:webhook-delivery:${run}`;
    const eventId = `event:webhook-delivery:${run}`;
    assert.equal((await submit(eventId, installationId)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const emittedAt = new Date("2026-08-30T02:00:00.000Z");
    assert.equal(await discoverOperatorWebhookDeliveries(pool, payloadStore, tenantId, emittedAt), 1);
    assert.equal(await discoverOperatorWebhookDeliveries(pool, payloadStore, tenantId, emittedAt), 0);

    assert.deepEqual(await processOperatorWebhookDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      destinationAllowlist: [receiverOrigin],
      allowSyntheticLoopback: true,
      now: () => emittedAt,
    }), { processed: 1 });
    assert.deepEqual(await processOperatorWebhookDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      destinationAllowlist: [receiverOrigin],
      allowSyntheticLoopback: true,
      now: () => new Date(emittedAt.valueOf() + 61_000),
    }), { processed: 1 });

    const attempts = received.filter((entry) => entry.path === "/deliver");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0]!.body, attempts[1]!.body);
    assert.equal(attempts[0]!.deliveryId, attempts[1]!.deliveryId);
    const envelope = JSON.parse(attempts[0]!.body.toString("utf8")) as {
      event: { event_ref: string; subject_ref: string; details: Record<string, unknown> };
    };
    assert.match(envelope.event.event_ref, /^[a-f0-9]{64}$/);
    assert.match(envelope.event.subject_ref, /^[a-f0-9]{64}$/);
    assert.deepEqual(envelope.event.details, { event_key: "synthetic_operator_callback" });
    for (const forbidden of [installationId, eventId, "record:", "payload", "attributes", serverSecret]) {
      assert.equal(attempts[0]!.body.includes(Buffer.from(forbidden)), false, forbidden);
    }
    const metadata = await withTenant(pool, tenantId, async (client) => (await client.query<{
      state: string;
      reason_code: string | null;
      request_digest: string;
    }>(
      `SELECT state,reason_code,request_digest
         FROM ledger.operator_webhook_delivery_results
        WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY attempt`,
      [tenantId, attempts[0]!.deliveryId],
    )).rows);
    assert.deepEqual(metadata.map(({ state, reason_code }) => ({ state, reason_code })), [
      { state: "retry", reason_code: "receiver_unavailable" },
      { state: "succeeded", reason_code: null },
    ]);
    assert.equal(attempts[0]!.signature,
      `sha256=${createHmac("sha256", Buffer.from(webhookSigningSecret, "utf8"))
        .update(attempts[0]!.body).digest("hex")}`);
  });

  it("serializes an in-flight request before deletion recognition without deadlock", async () => {
    const destinationResponse = await admin(`/v1/admin/apps/${appId}/operator-webhooks`, {
      method: "POST",
      body: JSON.stringify({ endpoint_url: `${receiverOrigin}/race`, events: ["custom_event"] }),
    });
    assert.equal(destinationResponse.status, 201);
    const destination = await destinationResponse.json() as { destination_id: string };
    const installationId = `installation:webhook-race:${run}`;
    assert.equal((await submit(`event:webhook-race:${run}`, installationId)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const now = new Date("2026-08-30T02:30:00.000Z");
    assert.ok(await discoverOperatorWebhookDeliveries(pool, payloadStore, tenantId, now) >= 2);

    raceGate = deliveryRaceGate();
    const processing = processOperatorWebhookDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      destinationAllowlist: [receiverOrigin],
      allowSyntheticLoopback: true,
      now: () => now,
    });
    let deletionSettled = false;
    let deletion: Promise<Response> | undefined;
    try {
      await Promise.race([
        raceGate.entered,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("operator_webhook_race_receiver_not_reached")), 5_000,
        )),
      ]);
      deletion = admin("/v1/admin/privacy-requests", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId,
          app_id: appId,
          requested_via: "tenant_admin_api",
          deletion_scope: "installation",
          deletion_subject_ref: installationId,
        }),
      }).then((response) => {
        deletionSettled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(deletionSettled, false);
    } finally {
      raceGate.releaseRequest();
    }
    assert.ok((await processing).processed >= 2);
    assert.ok(deletion);
    assert.equal((await deletion).status, 201);
    assert.equal(received.filter((entry) => entry.path === "/race").length, 1);
    raceGate = undefined;

    const disabled = await admin(
      `/v1/admin/apps/${appId}/operator-webhooks/${encodeURIComponent(destination.destination_id)}/disable`,
      { method: "POST", body: "{}" },
    );
    assert.equal(disabled.status, 200);
  });

  it("suppresses and purges pending delivery after privacy deletion, then rejects later subject events", async () => {
    const installationId = `installation:webhook-privacy:${run}`;
    const eventId = `event:webhook-privacy:${run}`;
    assert.equal((await submit(eventId, installationId)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    assert.equal(await discoverOperatorWebhookDeliveries(
      pool, payloadStore, tenantId, new Date("2026-08-30T03:00:00.000Z"),
    ), 1);
    const pending = await withTenant(pool, tenantId, async (client) => (await client.query<{
      delivery_id: string;
      request_ref: string;
    }>(
      `SELECT delivery_id::text,request_ref FROM ephemeral.operator_webhook_deliveries
        WHERE tenant_id=$1 AND app_id=$2 AND record_id IN (
          SELECT record_id FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3
        )`,
      [tenantId, appId, eventId],
    )).rows[0]);
    const beforeCount = received.length;
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
    await assert.rejects(() => payloadStore.read(pending.request_ref));
    assert.deepEqual(await processOperatorWebhookDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      destinationAllowlist: [receiverOrigin],
      allowSyntheticLoopback: true,
      now: () => new Date("2026-08-30T03:01:00.000Z"),
    }), { processed: 0 });
    assert.equal(received.length, beforeCount);
    const state = await withTenant(pool, tenantId, async (client) => (await client.query<{
      state: string;
      reason_code: string;
    }>(
      `SELECT delivery.state,result.reason_code
         FROM ephemeral.operator_webhook_deliveries AS delivery
         JOIN ledger.operator_webhook_delivery_results AS result USING (delivery_id,tenant_id,app_id,destination_id)
        WHERE delivery.tenant_id=$1 AND delivery.delivery_id=$2`,
      [tenantId, pending.delivery_id],
    )).rows[0]);
    assert.deepEqual(state, { state: "suppressed", reason_code: "privacy_suppressed" });
    const after = await submit(`event:webhook-privacy-after:${run}`, installationId);
    assert.equal(after.status, 403);
  });

  it("disables a destination, suppresses its pending outbox, and purges its protected secret", async () => {
    const response = await admin(`/v1/admin/apps/${appId}/operator-webhooks`, {
      method: "POST",
      body: JSON.stringify({ endpoint_url: `${receiverOrigin}/disabled`, events: ["custom_event"] }),
    });
    assert.equal(response.status, 201);
    const destination = await response.json() as { destination_id: string; signing_secret: string };
    const protectedReference = await withTenant(pool, tenantId, async (client) => (await client.query<{ secret_ref: string }>(
      `SELECT secret_ref FROM control.operator_webhook_destinations
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
      [tenantId, appId, destination.destination_id],
    )).rows[0]!.secret_ref);
    assert.equal((await payloadStore.read(protectedReference)).toString("utf8"), destination.signing_secret);
    const eventId = `event:webhook-disable:${run}`;
    assert.equal((await submit(eventId, `installation:webhook-disable:${run}`)).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    assert.equal(await discoverOperatorWebhookDeliveries(
      pool, payloadStore, tenantId, new Date("2026-08-30T04:00:00.000Z"),
    ), 2);
    const pendingRef = await withTenant(pool, tenantId, async (client) => (await client.query<{ request_ref: string }>(
      `SELECT delivery.request_ref
         FROM ephemeral.operator_webhook_deliveries AS delivery
         JOIN ledger.raw_records AS raw
           ON raw.tenant_id=delivery.tenant_id AND raw.app_id=delivery.app_id AND raw.record_id=delivery.record_id
        WHERE delivery.tenant_id=$1 AND delivery.app_id=$2
          AND delivery.destination_id=$3 AND raw.event_id=$4`,
      [tenantId, appId, destination.destination_id, eventId],
    )).rows[0]!.request_ref);
    await payloadStore.read(pendingRef);
    const disabled = await admin(
      `/v1/admin/apps/${appId}/operator-webhooks/${encodeURIComponent(destination.destination_id)}/disable`,
      { method: "POST", body: "{}" },
    );
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), {
      destination_id: destination.destination_id,
      status: "disabled",
      changed_at: (await withTenant(pool, tenantId, async (client) => (await client.query<{ status_changed_at: string }>(
        `SELECT status_changed_at FROM control.operator_webhook_destinations_current
          WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
        [tenantId, appId, destination.destination_id],
      )).rows[0]!.status_changed_at)),
    });
    await assert.rejects(() => payloadStore.read(protectedReference));
    await assert.rejects(() => payloadStore.read(pendingRef));
    const suppressed = await withTenant(pool, tenantId, async (client) => (await client.query<{ state: string }>(
      `SELECT state FROM ephemeral.operator_webhook_deliveries
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND request_ref=$4`,
      [tenantId, appId, destination.destination_id, pendingRef],
    )).rows[0]!.state);
    assert.equal(suppressed, "suppressed");
    const listed = await admin(`/v1/admin/apps/${appId}/operator-webhooks`);
    const text = await listed.text();
    assert.equal(text.includes(destination.signing_secret), false);
    assert.match(text, /disabled/);
  });
});
