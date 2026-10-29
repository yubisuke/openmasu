import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAppPool, createReaderPool, EncryptedFilePayloadStore, withTenant } from "@openmasu/runtime";
import { registerComparison, processRecurringComparisons, depositComparisonSnapshot, discoverComparisonNotifications,
  readComparisons } from "@openmasu/runtime/recurring-comparisons";
import { syntheticComparisonRegistration, syntheticRecurringSnapshot } from "../../../tools/synthetic-recurring-comparison.js";
import {
  discoverOperatorWebhookDeliveries,
  processOperatorWebhookDeliveries,
} from "../../worker/src/operator-webhook-worker.js";
import { processSdkInbox } from "../../worker/src/sdk-worker.js";
import { ensureAdminKeys } from "./admin-auth.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";
import { signServerRequest } from "./server-auth.js";
import { rotateOperatorWebhookSigningKey, retireOperatorWebhookSigningKey } from "./operator-webhooks-admin.js";

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
const readerPool = createReaderPool();
const operatorKey = `synthetic-webhook-operator-${randomBytes(32).toString("base64url")}`;
let api: ReturnType<typeof createServer>;
let receiver: ReturnType<typeof createServer>;
let apiBaseUrl = "";
let receiverOrigin = "";
let serverKeyId = "";
let serverSecret = "";
let webhookSigningSecret = "";
const received: Array<{ path: string; body: Buffer; signature: string; deliveryId: string; signingRevision: string }> = [];
let deliverStatuses = [500, 204];
let comparisonStatuses = [500, 204];
let rotationStatuses = [500, 204];
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
        signingRevision: String(request.headers["x-openmasu-key-revision"] ?? ""),
      });
      if (request.url === "/race" && raceGate) {
        raceGate.markEntered();
        await raceGate.release;
      }
      const status = request.url === "/deliver" ? (deliverStatuses.shift() ?? 204)
        : request.url === "/comparison" ? (comparisonStatuses.shift() ?? 204)
        : request.url === "/rotation" ? (rotationStatuses.shift() ?? 204) : 204;
      response.writeHead(status);
      response.end();
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    receiverOrigin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    await ensureAdminKeys(pool, { tenantId, appId }, [adminKey,{ key:operatorKey,role:"operator" }]);
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
    await readerPool.end();
    rmSync(payloadRoot, { recursive: true, force: true });
  });

  it("comparison notifications reuse durable signed delivery, deduplicate state, coalesce cooldown, and suppress mute and privacy", async () => {
    const scope = { tenantId,appId }, commandPath = `/v1/admin/apps/${appId}/comparisons`;
    const clock = (day:number,seconds=0) => new Date(Date.parse(`2026-10-${String(day).padStart(2,"0")}T00:00:00Z`)+seconds*1000);
    const created = await admin(`/v1/admin/apps/${appId}/operator-webhooks`, { method:"POST",body:JSON.stringify({
      purpose:"comparison_notifications",endpoint_url:`${receiverOrigin}/comparison` }) });
    assert.equal(created.status,201);
    const destination=await created.json() as { destination_id:string;signing_secret:string;events:string[] };
    assert.deepEqual(destination.events,[]);
    const saved=await registerComparison(pool,scope,{ ...syntheticComparisonRegistration(),first_date:"2026-10-01",last_date:"2026-10-05",retention_days:90,
      left_snapshot:syntheticRecurringSnapshot("2026-10-01"),right_snapshot:syntheticRecurringSnapshot("2026-10-01","2000000") },clock(10));
    await processRecurringComparisons(pool,tenantId,clock(10));
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(10)),0,"off without explicit configuration");
    const settings={ action:"notifications",comparison_id:saved.comparison_id,destination_id:destination.destination_id,enabled:true,muted:false,cooldown_seconds:60 };
    const configure=(extra:Record<string,unknown>={})=>admin(commandPath,{method:"POST",body:JSON.stringify({...settings,...extra})});
    assert.equal((await admin(commandPath,{method:"POST",headers:{authorization:`Bearer ${operatorKey}`},body:JSON.stringify(settings)})).status,403);
    assert.equal((await configure({destination_id:"webhook:unavailable"})).status,400);
    assert.equal((await configure()).status,200);
    const comparisonSigning = await rotateOperatorWebhookSigningKey({ pool, payloadStore,
      identity: { ...scope, keyId: "synthetic-comparison-rotation", role: "admin" }, destinationId: destination.destination_id,
      body: { expected_revision: 1, overlap_seconds: 0 }, now: clock(10) });
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(10)),1);
    const queuedTimestamp=await withTenant(pool,tenantId,async c=>(await c.query<{
      next_attempt_at:Date;created_at:string;updated_at:string;signing_revision:string;
    }>(`SELECT next_attempt_at,created_at,updated_at,signing_revision::text FROM ephemeral.operator_webhook_deliveries
      WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3`,[tenantId,appId,saved.comparison_id])).rows);
    assert.equal(queuedTimestamp.length,1);
    assert.equal(queuedTimestamp[0].next_attempt_at.toISOString(),clock(10).toISOString());
    assert.equal(queuedTimestamp[0].created_at,clock(10).toISOString());
    assert.equal(queuedTimestamp[0].updated_at,clock(10).toISOString());
    assert.equal(queuedTimestamp[0].signing_revision,"2");
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(10)),0);
    const dispatch=(now:Date,extra:Record<string,unknown>={})=>processOperatorWebhookDeliveries(pool,payloadStore,tenantId,{
      enabled:true,destinationAllowlist:[receiverOrigin],allowSyntheticLoopback:true,now:()=>now,...extra });
    assert.equal((await dispatch(clock(10))).processed,1);
    assert.equal((await dispatch(clock(10,61))).processed,1);
    const attempts=received.filter(entry=>entry.path==="/comparison");
    assert.equal(attempts.length,2); assert.equal(attempts[0].deliveryId,attempts[1].deliveryId);
    assert.deepEqual(attempts[0].body,attempts[1].body);
    assert.equal(attempts[0].signingRevision,"2"); assert.equal(attempts[1].signingRevision,"2");
    assert.equal(attempts[0].signature,`sha256=${createHmac("sha256",Buffer.from(comparisonSigning.signing_secret)).update(attempts[0].body).digest("hex")}`);
    assert.equal(JSON.parse(attempts[0].body.toString()).state,"threshold_exceeded");
    assert.doesNotMatch(attempts[0].body.toString(),/value_unscaled|grouping|installation_id|record_id|payload|Synthetic daily/);
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(10,120)),0,"worker restart uses saved transition state");
    const readerState=await readComparisons(readerPool,scope,clock(10,120));
    assert.equal(readerState.notificationReceipts[0].state,"succeeded");
    assert.equal(readerState.notificationReceipts[0].attempts,2);
    assert.deepEqual(await readComparisons(readerPool,{...scope,appId:"unavailable"},clock(10)),{plans:[],runs:[],notifications:[],notificationReceipts:[]});
    await assert.rejects(withTenant(readerPool,tenantId,c=>c.query("UPDATE control.comparison_notifications SET muted=true WHERE comparison_id=$1",[saved.comparison_id])),{code:"42501"});

    await processRecurringComparisons(pool,tenantId,clock(11));
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(11)),1);
    assert.equal((await configure({muted:true})).status,200);
    const receivedBeforeMute=received.length;
    assert.equal((await dispatch(clock(11))).processed,1);
    assert.equal(received.length,receivedBeforeMute);
    assert.equal((await readComparisons(readerPool,scope,clock(11))).notificationReceipts[0].state,"suppressed");
    assert.equal((await configure()).status,200);
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(11,1)),0,"unmute is not a resend");
    for (const side of ["left","right"] as const) await depositComparisonSnapshot(pool,scope,saved.comparison_id,"2026-10-02",side,syntheticRecurringSnapshot("2026-10-02"),clock(11,1));
    await processRecurringComparisons(pool,tenantId,clock(11,1));
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(11,1)),0,"cooldown retains no extra outbox ID");
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(11,61)),1);
    await dispatch(clock(11,61));
    assert.equal(JSON.parse(received.at(-1)!.body.toString()).transition,"recovered");

    const altered=syntheticRecurringSnapshot("2026-10-03");
    await depositComparisonSnapshot(pool,scope,saved.comparison_id,"2026-10-03","left",altered,clock(12));
    await depositComparisonSnapshot(pool,scope,saved.comparison_id,"2026-10-03","right",{source:altered.source,conditions:{...altered.conditions,metric_definition:"d7_roas@synthetic-other"},rows:altered.rows},clock(12));
    await processRecurringComparisons(pool,tenantId,clock(12));
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(12)),1);
    comparisonStatuses=[400]; await dispatch(clock(12));
    const uncertain=JSON.parse(received.at(-1)!.body.toString());
    assert.equal(uncertain.state,"incomparable"); assert.equal(uncertain.transition,"attention");
    assert.equal((await readComparisons(readerPool,scope,clock(12))).notificationReceipts[0].state,"failed");
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(12,61)),0,"terminal receipt is not another notification");

    await processRecurringComparisons(pool,tenantId,clock(13));
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(13)),1);
    const pending=await withTenant(pool,tenantId,async c=>(await c.query<{request_ref:string}>("SELECT request_ref FROM ephemeral.operator_webhook_deliveries WHERE comparison_id=$1 AND state='queued'",[saved.comparison_id])).rows[0]);
    const privacy=await admin("/v1/admin/privacy-requests",{method:"POST",body:JSON.stringify({tenant_id:tenantId,app_id:appId,
      requested_via:"tenant_admin_api",deletion_scope:"installation",deletion_subject_ref:`installation:synthetic-comparison-privacy:${run}`})});
    assert.equal(privacy.status,201);
    const beforePrivacy=received.length;
    assert.equal((await dispatch(clock(13))).processed,1); assert.equal(received.length,beforePrivacy);
    await assert.rejects(payloadStore.read(pending.request_ref));
    assert.deepEqual((await readComparisons(readerPool,scope,clock(13))).notificationReceipts,[]);
    assert.equal(await discoverComparisonNotifications(pool,payloadStore,tenantId,clock(13)),0);
    assert.equal((await admin(`/v1/admin/apps/${appId}/operator-webhooks/${encodeURIComponent(destination.destination_id)}/disable`,{method:"POST",body:"{}"})).status,200);
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

    const healthResponse = await admin(`/v1/admin/apps/${appId}/operator-delivery-health`);
    assert.equal(healthResponse.status, 200);
    const healthText = await healthResponse.text();
    const health = JSON.parse(healthText) as {
      webhooks: { summary: { total: number; by_state: Record<string, number> }; deliveries: Array<{ state: string; event_name: string }> };
    };
    assert.ok(health.webhooks.summary.total >= 1);
    assert.ok(health.webhooks.summary.by_state.succeeded >= 1);
    assert.equal(health.webhooks.deliveries.some((row) => row.state === "succeeded" && row.event_name === "custom_event"), true);
    for (const forbidden of [
      installationId, eventId, "logical_event_id", "record_id", "request_ref", "request_digest", "artifact",
    ]) assert.equal(healthText.includes(forbidden), false, forbidden);
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
    const revisionReferences = await withTenant(pool, tenantId, async client => (await client.query<{ secret_ref: string }>(
      `SELECT secret_ref FROM control.operator_webhook_signing_revisions
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`, [tenantId, appId, destination.destination_id])).rows);
    assert.notEqual((await payloadStore.read(protectedReference)).toString("utf8"), destination.signing_secret,
      "reference identity key is not the returned transport signing key");
    assert.equal(revisionReferences.length, 1);
    assert.equal((await payloadStore.read(revisionReferences[0].secret_ref)).toString("utf8"), destination.signing_secret);
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
    for (const revision of revisionReferences) await assert.rejects(() => payloadStore.read(revision.secret_ref));
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

  it("preserves migrated shared-key references after rotation and retirement while new delivery uses the new key", async () => {
    const destinationId = `webhook:synthetic-legacy-${run}`, createdAt = new Date().toISOString();
    const sharedKey = Buffer.from(`synthetic-legacy-webhook-key-${randomBytes(32).toString("base64url")}`);
    const secretRef = await payloadStore.write({ tenantId, appId, objectId: `legacy-webhook-${run}` }, sharedKey);
    // This is the exact post-migration shape, not the new separate-key registration path.
    await withTenant(pool, tenantId, async client => {
      await client.query(`INSERT INTO control.operator_webhook_destinations
        (destination_id,tenant_id,app_id,endpoint_url,allowed_events,secret_ref,created_at,artifact)
        VALUES ($1,$2,$3,$4,ARRAY['custom_event']::text[],$5,$6,$7::jsonb)`,
      [destinationId, tenantId, appId, `${receiverOrigin}/legacy`, secretRef, createdAt, JSON.stringify({
        destination_id: destinationId, tenant_id: tenantId, app_id: appId, endpoint_url: `${receiverOrigin}/legacy`, events: ["custom_event"], created_at: createdAt })]);
      await client.query(`INSERT INTO control.operator_webhook_signing_revisions
        (tenant_id,app_id,destination_id,signing_revision,secret_ref,created_at,previous_valid_until)
        VALUES ($1,$2,$3,1,$4,$5,NULL)`, [tenantId, appId, destinationId, secretRef, createdAt]);
      await client.query(`INSERT INTO control.operator_webhook_destination_states
        (destination_id,tenant_id,app_id,status,changed_at,artifact) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
      [destinationId, tenantId, appId, createdAt, JSON.stringify({ destination_id: destinationId, status: "active", changed_at: createdAt })]);
    });
    const installationId = `installation:webhook-legacy:${run}`;
    const send = async (suffix: string, now: Date) => {
      const eventId = `event:webhook-legacy-${suffix}:${run}`;
      assert.equal((await submit(eventId, installationId)).status, 202);
      await processSdkInbox(pool, payloadStore, tenantId);
      await discoverOperatorWebhookDeliveries(pool, payloadStore, tenantId, now);
      const row = await withTenant(pool, tenantId, async client => (await client.query<{ delivery_id: string; logical_event_id: string }>(
        `SELECT q.delivery_id::text,q.logical_event_id FROM ephemeral.operator_webhook_deliveries q
        JOIN ledger.raw_records r USING(tenant_id,app_id,record_id)
        WHERE q.tenant_id=$1 AND q.app_id=$2 AND q.destination_id=$3 AND r.event_id=$4`, [tenantId, appId, destinationId, eventId])).rows[0]);
      assert.ok(row);
      await processOperatorWebhookDeliveries(pool, payloadStore, tenantId, {
        enabled: true, destinationAllowlist: [receiverOrigin], allowSyntheticLoopback: true, now: () => now });
      const delivery = received.find(entry => entry.deliveryId === row.delivery_id)!;
      assert.ok(delivery);
      return { delivery, logicalEventId: row.logical_event_id, event: JSON.parse(delivery.body.toString()).event };
    };
    const before = await send("before", new Date(Date.now() + 1000));
    assert.equal(before.delivery.signingRevision, "1");
    assert.equal(before.delivery.signature, `sha256=${createHmac("sha256", sharedKey).update(before.delivery.body).digest("hex")}`);
    const command = { pool, payloadStore, identity: { tenantId, appId, keyId: "synthetic-legacy-rotation", role: "admin" as const }, destinationId };
    const rotationAt = new Date(Date.now() + 2000);
    const rotated = await rotateOperatorWebhookSigningKey({ ...command, body: { expected_revision: 1 }, now: rotationAt });
    await retireOperatorWebhookSigningKey({ ...command, body: { expected_revision: 2, signing_revision: 1 }, now: rotationAt });
    const retainedKey = await payloadStore.read(secretRef);
    assert.deepEqual(retainedKey, sharedKey, "retirement cannot purge a migrated reference identity key");
    const after = await send("after", new Date(rotationAt.valueOf() + 1000));
    assert.equal(after.delivery.signingRevision, "2");
    assert.equal(after.delivery.signature, `sha256=${createHmac("sha256", Buffer.from(rotated.signing_secret)).update(after.delivery.body).digest("hex")}`);
    assert.equal(after.event.subject_ref, before.event.subject_ref);
    for (const value of [before, after]) {
      assert.equal(value.event.subject_ref, createHmac("sha256", retainedKey).update(`openmasu:subject_ref:v1\0${installationId}`).digest("hex"));
      assert.equal(value.event.event_ref, createHmac("sha256", retainedKey).update(`openmasu:event_ref:v1\0${value.logicalEventId}`).digest("hex"));
    }
    assert.equal(await discoverOperatorWebhookDeliveries(pool, payloadStore, tenantId, new Date(rotationAt.valueOf() + 2000)), 0,
      "rotation neither recreates old events nor changes their identity");
    assert.equal((await admin(`/v1/admin/apps/${appId}/operator-webhooks/${encodeURIComponent(destinationId)}/disable`,
      { method: "POST", body: "{}" })).status, 200);
    await assert.rejects(payloadStore.read(secretRef));
  });

  it("pins queued signing revisions, keeps references stable, and suppresses expired or retired keys without requests", async () => {
    const response = await admin(`/v1/admin/apps/${appId}/operator-webhooks`, { method: "POST",
      body: JSON.stringify({ endpoint_url: `${receiverOrigin}/rotation`, events: ["custom_event"] }) });
    assert.equal(response.status, 201);
    const destination = await response.json() as { destination_id: string; signing_revision: number; signing_secret: string };
    assert.equal(destination.signing_revision, 1);
    const destinationId = destination.destination_id, scope = { tenantId, appId };
    const identity = { ...scope, keyId: "synthetic-webhook-rotation-admin", role: "admin" as const };
    const command = { pool, payloadStore, identity, destinationId };
    const t0 = Date.now() + 1000, at = (seconds: number) => new Date(t0 + seconds * 1000);
    const baseRef = await withTenant(pool, tenantId, async client => (await client.query<{ secret_ref: string }>(
      `SELECT secret_ref FROM control.operator_webhook_destinations WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
      [tenantId, appId, destinationId])).rows[0].secret_ref);
    const referenceKey = await payloadStore.read(baseRef);
    assert.notEqual(referenceKey.toString(), destination.signing_secret);
    const installationId = `installation:webhook-rotation:${run}`;
    const queue = async (suffix: string, seconds: number) => {
      const eventId = `event:webhook-rotation-${suffix}:${run}`;
      assert.equal((await submit(eventId, installationId)).status, 202);
      await processSdkInbox(pool, payloadStore, tenantId);
      await discoverOperatorWebhookDeliveries(pool, payloadStore, tenantId, at(seconds));
      return withTenant(pool, tenantId, async client => (await client.query<{
        delivery_id: string; request_ref: string; request_digest: string; signing_revision: string; logical_event_id: string;
      }>(`SELECT q.delivery_id::text,q.request_ref,q.request_digest,q.signing_revision::text,q.logical_event_id
        FROM ephemeral.operator_webhook_deliveries q JOIN ledger.raw_records r USING(tenant_id,app_id,record_id)
        WHERE q.tenant_id=$1 AND q.app_id=$2 AND q.destination_id=$3 AND r.event_id=$4`,
      [tenantId, appId, destinationId, eventId])).rows[0]);
    };
    const dispatch = (seconds: number) => processOperatorWebhookDeliveries(pool, payloadStore, tenantId, {
      enabled: true, destinationAllowlist: [receiverOrigin], allowSyntheticLoopback: true, now: () => at(seconds) });
    const first = await queue("retry", 0), expires = await queue("expire", 0);
    assert.equal(first.signing_revision, "1"); assert.equal(expires.signing_revision, "1");
    const originalBody = await payloadStore.read(first.request_ref);
    // An independently queued delivery can become due only after the overlap.
    await withTenant(pool, tenantId, client => client.query(
      "UPDATE ephemeral.operator_webhook_deliveries SET next_attempt_at=$3 WHERE tenant_id=$1 AND delivery_id=$2",
      [tenantId, expires.delivery_id, at(121).toISOString()]));
    rotationStatuses = [500, 204];
    await dispatch(0);
    const rotatePath = `/v1/admin/apps/${appId}/operator-webhooks/${encodeURIComponent(destinationId)}/signing-keys`;
    assert.equal((await admin(rotatePath, { method: "POST", headers: { authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({ expected_revision: 1 }) })).status, 403);
    const rotated = await rotateOperatorWebhookSigningKey({ ...command, body: { expected_revision: 1, overlap_seconds: 120 }, now: at(1) });
    assert.equal(rotated.signing_revision, 2);
    await assert.rejects(rotateOperatorWebhookSigningKey({ ...command, body: { expected_revision: 2 }, now: at(2) }),
      /operator_webhook_signing_overlap_active/);
    await assert.rejects(retireOperatorWebhookSigningKey({ ...command, body: { expected_revision: 2, signing_revision: 2 }, now: at(2) }),
      /operator_webhook_signing_current_required/);
    await dispatch(61);
    const retry = received.filter(entry => entry.deliveryId === first.delivery_id);
    assert.equal(retry.length, 2);
    for (const attempt of retry) {
      assert.equal(attempt.signingRevision, "1");
      assert.deepEqual(attempt.body, originalBody);
      assert.equal(attempt.signature, `sha256=${createHmac("sha256", Buffer.from(destination.signing_secret)).update(originalBody).digest("hex")}`);
    }
    const afterRotation = await queue("current", 62);
    assert.equal(afterRotation.signing_revision, "2");
    await dispatch(62);
    const current = received.find(entry => entry.deliveryId === afterRotation.delivery_id)!;
    assert.equal(current.signingRevision, "2");
    assert.equal(current.signature, `sha256=${createHmac("sha256", Buffer.from(rotated.signing_secret)).update(current.body).digest("hex")}`);
    for (const [delivery, body] of [[first, originalBody], [afterRotation, current.body]] as const) {
      const envelope = JSON.parse(body.toString());
      assert.equal(envelope.event.subject_ref, createHmac("sha256", referenceKey)
        .update(`openmasu:subject_ref:v1\0${installationId}`).digest("hex"));
      assert.equal(envelope.event.event_ref, createHmac("sha256", referenceKey)
        .update(`openmasu:event_ref:v1\0${delivery.logical_event_id}`).digest("hex"));
    }
    const countBeforeExpiry = received.filter(entry => entry.path === "/rotation").length;
    await dispatch(121);
    assert.equal(received.filter(entry => entry.path === "/rotation").length, countBeforeExpiry);
    const state = (id: string) => withTenant(pool, tenantId, async client => (await client.query<{
      state: string; safe_reason: string | null; request_digest: string;
    }>("SELECT state,safe_reason,request_digest FROM ephemeral.operator_webhook_deliveries WHERE tenant_id=$1 AND delivery_id=$2",
    [tenantId, id])).rows[0]);
    assert.equal((await state(expires.delivery_id)).safe_reason, "signing_key_expired");
    await assert.rejects(payloadStore.read(expires.request_ref));
    const retired = await queue("retired", 122);
    assert.equal(retired.signing_revision, "2");
    const rotations = await Promise.allSettled([1, 2].map(() => rotateOperatorWebhookSigningKey({ ...command,
      body: { expected_revision: 2, overlap_seconds: 120 }, now: at(122) })));
    assert.equal(rotations.filter(result => result.status === "fulfilled").length, 1);
    const winner = rotations.find(result => result.status === "fulfilled")!;
    assert.equal(winner.status, "fulfilled");
    if (winner.status !== "fulfilled") throw Error("synthetic_rotation_missing");
    assert.equal(winner.value.signing_revision, 3);
    const loser = rotations.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.match(String(loser.reason), /operator_webhook_signing_revision_stale/);
    const retirement = await retireOperatorWebhookSigningKey({ ...command,
      body: { expected_revision: 3, signing_revision: 2 }, now: at(123) });
    assert.deepEqual(await retireOperatorWebhookSigningKey({ ...command,
      body: { expected_revision: 3, signing_revision: 2 }, now: at(124) }), retirement);
    assert.equal((await state(retired.delivery_id)).safe_reason, "signing_key_retired");
    const beforeRetiredDispatch = received.filter(entry => entry.path === "/rotation").length;
    await dispatch(124);
    assert.equal(received.filter(entry => entry.path === "/rotation").length, beforeRetiredDispatch);
    assert.deepEqual(await payloadStore.read(baseRef), referenceKey, "retirement does not rotate or purge reference identity");
    assert.equal((await state(first.delivery_id)).request_digest, first.request_digest, "stored request digest never changes");
    const receiptReasons = await withTenant(pool, tenantId, async client => (await client.query<{ reason_code: string }>(
      `SELECT reason_code FROM ledger.operator_webhook_delivery_results WHERE tenant_id=$1 AND destination_id=$2 AND state='suppressed'`,
      [tenantId, destinationId])).rows.map(row => row.reason_code));
    assert.deepEqual(receiptReasons.sort(), ["signing_key_expired", "signing_key_retired"]);
    const listed = await (await admin(`/v1/admin/apps/${appId}/operator-webhooks`)).text();
    const audit = await withTenant(pool, tenantId, async client => (await client.query(
      "SELECT action,request_digest FROM ledger.audit_logs WHERE tenant_id=$1 AND target_ref=$2", [tenantId, destinationId])).rows);
    for (const secret of [destination.signing_secret, rotated.signing_secret, winner.value.signing_secret, referenceKey.toString()]) {
      assert.equal(listed.includes(secret), false);
      assert.equal(JSON.stringify(audit).includes(secret), false);
    }
    const references = await withTenant(pool, tenantId, async client => (await client.query<{ secret_ref: string }>(
      "SELECT secret_ref FROM control.operator_webhook_signing_revisions WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3",
      [tenantId, appId, destinationId])).rows.map(row => row.secret_ref));
    assert.equal(references.length, 3);
    assert.equal((await admin(`/v1/admin/apps/${appId}/operator-webhooks/${encodeURIComponent(destinationId)}/disable`,
      { method: "POST", body: "{}" })).status, 200);
    for (const reference of [baseRef, ...references]) await assert.rejects(payloadStore.read(reference));
  });
});
