import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomBytes, sign } from "node:crypto";
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
  processPrivacyDeletionJobs,
  type PayloadStore,
  uuidV7,
  withTenant,
} from "@openmasu/runtime";
import { listRuntimeWorkTenants, processSdkInbox } from "../../worker/src/sdk-worker.js";
import { processIntegrityVerifications } from "../../worker/src/integrity-verifier.js";
import {
  processGooglePlayProductVerifications,
  queueGooglePlayProductVerification,
} from "../../worker/src/google-play-product-verifier.js";
import { processCommerceReadbacks } from "../../worker/src/commerce-readback-worker.js";
import { createRequestHandler } from "./router.js";
import { executePrivacyRequest } from "./privacy.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { parseMetricQuery } from "./report-query.js";
import { encodeMetricReport, metricReport } from "./reporting.js";
import { ensureSdkKeys, installationIdDigest, signSdkRequest } from "./sdk-auth.js";
import { createTrackingLink } from "./tracking-links.js";
import { SDK_INSTALLATION_PRIVACY_PATH } from "./routes.js";
import { verifyCompactJws } from "@openmasu/commerce-lifecycle";
import { nonFraudBundleHash } from "@openmasu/contracts";

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
let legacyPrivacyTargetRecordId = "";
let legacyPrivacyRefundRecordId = "";
let legacyPrivacyPayloadRefs: string[] = [];
const integrityBinding = randomBytes(32).toString("base64url");
const playPackageName = `dev.openmasu.synthetic${run}`;
const playSubscriptionToken = `synthetic-google-play-subscription-token-${run}`;
const playSubscriptionProductId = `subscription.synthetic.${run}`;
const playSubscriptionStartTime = "2026-08-24T02:03:04.000Z";
const verifiedRenewalOrderId = `order:subscription:renewal:synthetic:${run}`;
const rtdnAudience = "https://synthetic.invalid/v1/google-play/rtdn";
const rtdnEmail = "synthetic-rtdn@synthetic-project.iam.gserviceaccount.com";
const rtdnKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rtdnJwk = { ...rtdnKeyPair.publicKey.export({ format: "jwk" }), kid: "synthetic-rtdn-key", alg: "RS256", use: "sig" };
const appleCommerceKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const appleBundleId = `dev.openmasu.synthetic.${run}`;
const appleAppId = 900000000 + Number.parseInt(run.slice(0, 6), 16);

function appleCommerceJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "synthetic-commerce" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), {
    key: appleCommerceKeyPair.privateKey, dsaEncoding: "ieee-p1363",
  });
  return `${header}.${body}.${signature.toString("base64url")}`;
}

function rtdnToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "synthetic-rtdn-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com", aud: rtdnAudience, email: rtdnEmail,
    email_verified: true, iat: now - 30, exp: now + 3_000, ...overrides,
  })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(rtdnKeyPair.privateKey).toString("base64url")}`;
}

function rtdnEnvelopeFor(messageId: string, arm: Record<string, unknown>): string {
  const notification = {
    version: "1.0",
    packageName: playPackageName,
    eventTimeMillis: String(Date.now()),
    ...arm,
  };
  return JSON.stringify({
    message: { messageId, publishTime: new Date().toISOString(), data: Buffer.from(JSON.stringify(notification)).toString("base64") },
    subscription: "projects/synthetic-project/subscriptions/openmasu-renewals",
  });
}

function rtdnEnvelope(messageId: string): string {
  return rtdnEnvelopeFor(messageId, {
    subscriptionNotification: { version: "1.0", notificationType: 2, purchaseToken: playSubscriptionToken },
  });
}

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
    await withTenant(pool, tenantId, async (client) => client.query(
      `INSERT INTO control.apple_app_registrations (
         tenant_id, app_id, apple_app_adam_id, apple_bundle_id, registered_at, artifact
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
      [tenantId, appId, appleAppId, appleBundleId, new Date().toISOString(), JSON.stringify({
        tenant_id: tenantId, app_id: appId, apple_app_adam_id: String(appleAppId),
        apple_bundle_id: appleBundleId, registered_at: new Date().toISOString(),
      })],
    ));
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
      googlePlayRtdn: {
        pool,
        payloadStore,
        expectedAudience: rtdnAudience,
        expectedServiceAccountEmail: rtdnEmail,
        maximumBytes: 16 * 1024,
        fetch: async () => new Response(JSON.stringify({ keys: [rtdnJwk] }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
      },
      appleStoreNotifications: {
        pool,
        payloadStore,
        trustedRootFingerprints: new Set(),
        maximumBytes: 512 * 1024,
        verifySignedData: (value) => verifyCompactJws(value, appleCommerceKeyPair.publicKey),
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

  it("WO19 accepts a fully verified App Store notification once and queues bounded read-back", async () => {
    const transaction = appleCommerceJws({
      transactionId: `apple-transaction-${run}`, originalTransactionId: `apple-original-${run}`,
      bundleId: appleBundleId, environment: "Sandbox", purchaseDate: Date.now(),
    });
    const renewal = appleCommerceJws({ environment: "Sandbox", autoRenewStatus: 1 });
    const notificationUuid = `00000000-0000-4000-8000-${run.padEnd(12, "0").slice(0, 12)}`;
    const signedPayload = appleCommerceJws({
      notificationType: "DID_RENEW", notificationUUID: notificationUuid, signedDate: Date.now(),
      data: { bundleId: appleBundleId, environment: "Sandbox",
        signedTransactionInfo: transaction, signedRenewalInfo: renewal },
    });
    const send = () => fetch(`${baseUrl}/v1/apple/app-store/notifications`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload }),
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const tamperedParts = signedPayload.split(".");
    tamperedParts[1] = Buffer.from(JSON.stringify({
      notificationType: "DID_RENEW", notificationUUID: `${notificationUuid}-tampered`, signedDate: Date.now(),
      data: { bundleId: appleBundleId, environment: "Sandbox",
        signedTransactionInfo: transaction, signedRenewalInfo: renewal },
    })).toString("base64url");
    assert.equal((await fetch(`${baseUrl}/v1/apple/app-store/notifications`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: tamperedParts.join(".") }),
    })).status, 200, "invalid signatures must be non-enumerating and must not persist");
    const stored = await withTenant(pool, tenantId, async (client) => ({
      notifications: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control.commerce_provider_notifications WHERE tenant_id=$1 AND app_id=$2 AND provider='app_store'",
        [tenantId, appId],
      )).rows[0].count),
      facts: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.commerce_lifecycle_facts WHERE tenant_id=$1 AND app_id=$2 AND provider='app_store'",
        [tenantId, appId],
      )).rows[0].count),
      readbacks: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ephemeral.commerce_provider_readbacks WHERE tenant_id=$1 AND app_id=$2 AND provider='app_store'",
        [tenantId, appId],
      )).rows[0].count),
    }));
    assert.deepEqual(stored, { notifications: 1, facts: 1, readbacks: 1 });
    assert.equal(await payloadStore.scanFor(`apple-transaction-${run}`), false);

    let page = 0;
    const readback = async () => processCommerceReadbacks(pool, payloadStore, tenantId, {
      now: new Date(Date.now() + 60_000 + page),
      verifyAppleSignedData: (value) => verifyCompactJws(value, appleCommerceKeyPair.publicKey),
      appleClient: async () => {
        page += 1;
        const signed = appleCommerceJws({
          transactionId: `apple-history-${page}-${run}`, originalTransactionId: `apple-original-${run}`,
          bundleId: appleBundleId, environment: "Sandbox", purchaseDate: Date.now(),
          ...(page === 2 ? { revocationDate: Date.now() + 1_000 } : {}),
        });
        return { status: 200, body: Buffer.from(JSON.stringify({
          signedTransactions: [signed], hasMore: page === 1, ...(page === 1 ? { revision: "synthetic-revision-1" } : {}),
        })) };
      },
    });
    assert.deepEqual(await readback(), { processed: 1, deferred: 0, failed: 0 });
    assert.deepEqual(await readback(), { processed: 1, deferred: 0, failed: 0 });
    const afterReadback = await withTenant(pool, tenantId, async (client) => ({
      facts: (await client.query<{ event_kind: string; financial_effect: string }>(
        `SELECT event_kind, financial_effect FROM ledger.commerce_lifecycle_facts
          WHERE tenant_id=$1 AND app_id=$2 AND provider='app_store' ORDER BY event_kind`, [tenantId, appId],
      )).rows,
      pending: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ephemeral.commerce_provider_readbacks WHERE tenant_id=$1 AND app_id=$2 AND provider='app_store'",
        [tenantId, appId],
      )).rows[0].count),
    }));
    assert.equal(afterReadback.pending, 0);
    assert.deepEqual(afterReadback.facts.map((value) => value.financial_effect).sort(), ["none", "purchase", "refund"]);
  });

  it("F-A-14 rejects parsed integrity claims and protects accepted raw tokens", async () => {
    const integrityInstallationId = `installation:m2a-integrity-${run}`;
    const enrollment = await signed("/v1/installations", { installation_id: integrityInstallationId });
    assert.equal(enrollment.status, 201);
    const integrityCredential = await enrollment.json() as {
      installation_key_id: string;
      installation_secret: string;
    };
    const parsedClaim = sourceEvent(`event:integrity-claim:${run}`, "install", {
      installation_id: installationId,
      install_type: "first_install",
      referrer_status: "unavailable",
      integrity_verdict: { provider: "play_integrity", verdict: "verified", evidence_ref: `protected:${run}` },
    });
    const rejected = await signed("/v1/events/batch", { records: [parsedClaim] }, {
      secret: installationSecret,
      installationKeyId,
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json() as { error: string }).error, "device_integrity_claim_forbidden");

    const rawToken = `synthetic-integrity-token-${run}`;
    const accepted = sourceEvent(`event:integrity-token:${run}`, "install", {
      installation_id: integrityInstallationId,
      install_type: "first_install",
      referrer_status: "unavailable",
      extensions: {
        integrity_token_protected: rawToken,
        integrity_provider: "play_integrity",
        integrity_binding_mode: "challenge",
        integrity_binding: integrityBinding,
      },
    });
    assert.equal((await signed("/v1/events/batch", { records: [accepted] }, {
      secret: integrityCredential.installation_secret,
      installationKeyId: integrityCredential.installation_key_id,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const evidence = await withTenant(pool, tenantId, async (client) => ({
      queued: (await client.query<{ token_ref: string }>(
        `SELECT token_ref FROM ephemeral.integrity_verifications
         WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id IN (
           SELECT record_id FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3
         )`,
        [tenantId, appId, accepted.event_id],
      )).rows,
      raw: (await client.query<{ artifact: unknown }>(
        "SELECT artifact FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3",
        [tenantId, appId, accepted.event_id],
      )).rows,
    }));
    assert.equal(evidence.queued.length, 1);
    assert.match(evidence.queued[0].token_ref, /^encrypted:/);
    assert.doesNotMatch(JSON.stringify(evidence.raw), new RegExp(rawToken));
    assert.equal(await payloadStore.scanFor(rawToken), false, "encrypted store leaked a plaintext integrity token");
  });

  it("F-A-15 maps provider outages to unavailable without evidence or metric effects", async () => {
    const before = await withTenant(pool, tenantId, async (client) => ({
      fraud: (await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM ledger.fraud_decisions WHERE tenant_id=$1 AND app_id=$2",
        [tenantId, appId],
      )).rows[0].count,
      metrics: (await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2",
        [tenantId, appId],
      )).rows[0].count,
    }));
    const result = await processIntegrityVerifications(pool, payloadStore, tenantId, {
      providerMode: "play_integrity",
      playEndpoint: "http://127.0.0.1:9999/verify",
      client: async () => ({ status: 503, body: Buffer.from("synthetic provider outage") }),
    });
    assert.ok(result.unavailable >= 1);
    const after = await withTenant(pool, tenantId, async (client) => ({
      verdicts: (await client.query<{ verdict: string; evidence_ref: string | null }>(
        `SELECT verdict, evidence_ref FROM ledger.integrity_verification_results
         WHERE tenant_id=$1 AND app_id=$2 ORDER BY decided_at DESC`,
        [tenantId, appId],
      )).rows,
      fraud: (await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM ledger.fraud_decisions WHERE tenant_id=$1 AND app_id=$2",
        [tenantId, appId],
      )).rows[0].count,
      metrics: (await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2",
        [tenantId, appId],
      )).rows[0].count,
    }));
    assert.ok(after.verdicts.some((row) => row.verdict === "unavailable" && row.evidence_ref === null));
    assert.equal(after.fraud, before.fraud);
    assert.equal(after.metrics, before.metrics);
  });

  it("verifies a protected Google Play product token before emitting settled revenue and stays idempotent", async () => {
    const packageName = `dev.openmasu.synthetic${run}`;
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO control.app_link_identities (
        tenant_id, app_id, android_package_name, registered_at, artifact
      ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [tenantId, appId, packageName, "2026-08-24T00:00:00.000Z",
        JSON.stringify({ tenant_id: tenantId, app_id: appId, android_package_name: packageName })],
    ));
    const rawToken = `synthetic-google-play-token-${run}`;
    const productId = `product.synthetic.${run}`;
    const providerOrderId = `order:synthetic:${run}`;
    const event = sourceEvent(`event:google-play-product:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:client-google-play:${run}`,
      amount_unscaled: "12990000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "pending",
      extensions: {
        google_play_purchase_token_protected: rawToken,
        google_play_product_id_protected: productId,
      },
    });
    assert.equal((await signed("/v1/events/batch", { records: [event] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const before = await withTenant(pool, tenantId, async (client) => ({
      queue: (await client.query<{ token_ref: string; subject_record_id: string }>(
        `SELECT token_ref, subject_record_id FROM ephemeral.google_play_product_verifications
          WHERE tenant_id=$1 AND app_id=$2`, [tenantId, appId],
      )).rows,
      facts: (await client.query<{ financial_status: string }>(
        `SELECT fact.financial_status FROM ledger.purchase_facts fact
          JOIN ledger.raw_records raw ON raw.tenant_id=fact.tenant_id AND raw.app_id=fact.app_id AND raw.record_id=fact.record_id
          WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, event.event_id],
      )).rows,
      rawArtifacts: (await client.query<{ artifact: unknown }>(
        `SELECT artifact FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
        [tenantId, appId, event.event_id],
      )).rows,
    }));
    assert.equal(before.queue.length, 1);
    assert.ok((await listRuntimeWorkTenants(pool)).includes(tenantId),
      "the worker must rediscover a tenant whose only due work is purchase verification");
    assert.match(before.queue[0].token_ref, /^encrypted:/);
    assert.deepEqual(before.facts, [{ financial_status: "pending" }]);
    assert.doesNotMatch(JSON.stringify(before.rawArtifacts), new RegExp(rawToken));
    assert.equal(await payloadStore.scanFor(rawToken), false);

    const providerCalls: Array<Record<string, string | undefined>> = [];
    const completed = await processGooglePlayProductVerifications(pool, payloadStore, tenantId, {
      enabled: true,
      client: async (input) => {
        providerCalls.push(input);
        return input.operation === "product"
          ? { status: 200, body: Buffer.from(JSON.stringify({
            purchaseStateContext: { purchaseState: "PURCHASED" },
            purchaseCompletionTime: "2026-08-24T01:02:03.000Z",
            orderId: providerOrderId,
            productLineItem: [{ productId }],
          })) }
          : { status: 200, body: Buffer.from(JSON.stringify({
            orderId: providerOrderId,
            purchaseToken: rawToken,
            state: "PROCESSED",
            lineItems: [{
              productId,
              total: { currencyCode: "EUR", units: "7", nanos: 125_000_000 },
              oneTimePurchaseDetails: { quantity: 1 },
            }],
          })) };
      },
      now: () => new Date(Date.now() + 60_000),
    });
    assert.deepEqual(completed, { verified: 1, failed: 0, unavailable: 0, deferred: 0 });
    assert.equal(providerCalls[0].packageName, packageName);
    assert.equal(providerCalls[0].purchaseToken, rawToken);
    assert.deepEqual(providerCalls.map((call) => call.operation), ["product", "order"]);
    assert.equal(providerCalls[1].orderId, providerOrderId);
    const after = await withTenant(pool, tenantId, async (client) => ({
      results: (await client.query<{ verdict: string; verified_record_id: string; artifact: unknown }>(
        `SELECT verdict, verified_record_id, artifact
           FROM ledger.google_play_purchase_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3`,
        [tenantId, appId, before.queue[0].subject_record_id],
      )).rows,
      verified: (await client.query<{
        financial_status: string; producer: string; amount_unscaled: string;
        amount_scale: number; currency: string; artifact: unknown;
      }>(
        `SELECT fact.financial_status, raw.producer, fact.amount_unscaled,
                fact.amount_scale, fact.currency, fact.artifact
           FROM ledger.purchase_facts fact
           JOIN ledger.raw_records raw ON raw.tenant_id=fact.tenant_id AND raw.app_id=fact.app_id AND raw.record_id=fact.record_id
          WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND raw.producer='adapter:google-play'`,
        [tenantId, appId],
      )).rows,
      queued: (await client.query(
        `SELECT 1 FROM ephemeral.google_play_product_verifications WHERE tenant_id=$1 AND app_id=$2`,
        [tenantId, appId],
      )).rowCount,
    }));
    assert.equal(after.results.length, 1);
    assert.equal(after.results[0].verdict, "verified");
    assert.deepEqual(after.verified.map(({ financial_status, producer }) => ({ financial_status, producer })), [
      { financial_status: "settled", producer: "adapter:google-play" },
    ]);
    assert.deepEqual(after.verified.map(({ amount_unscaled, amount_scale, currency }) => ({
      amount_unscaled, amount_scale, currency,
    })), [{ amount_unscaled: "7125000000", amount_scale: 9, currency: "EUR" }],
    "provider order money must replace the client-declared USD amount without rounding");
    assert.match(JSON.stringify(after.results[0].artifact), /google_play_order_line_total/);
    assert.equal(after.queued, 0);
    assert.doesNotMatch(JSON.stringify(after), new RegExp(rawToken));
    assert.doesNotMatch(JSON.stringify(after), new RegExp(providerOrderId));
    assert.deepEqual(await processGooglePlayProductVerifications(pool, payloadStore, tenantId, {
      enabled: true, client: async () => { throw new Error("idempotent replay called provider"); },
    }), { verified: 0, failed: 0, unavailable: 0, deferred: 0 });

    const otherTenant = `tenant-google-play-other-${run}`;
    const otherApp = `app-google-play-other-${run}`;
    await ensureSdkKeys(pool, payloadStore, { tenantId: otherTenant, appId: otherApp }, [{
      keyId: `sdk-key-google-play-other-${run}`,
      secret: `sdk-secret-${randomBytes(32).toString("base64url")}`,
    }]);
    await queueGooglePlayProductVerification(pool, {
      tenantId: otherTenant,
      appId: otherApp,
      subjectRecordId: `record:google-play-discovery-${run}`,
      tokenRef: before.queue[0].token_ref,
      purchaseToken: `synthetic-google-play-discovery-${run}`,
      productId: `product.discovery.${run}`,
      requestedAt: "2026-08-24T01:03:30.000Z",
    });
    assert.ok((await listRuntimeWorkTenants(pool)).includes(otherTenant),
      "a tenant with only pending Google Play verification work must be discoverable");
    await assert.rejects(queueGooglePlayProductVerification(pool, {
      tenantId: otherTenant,
      appId: otherApp,
      subjectRecordId: `record:google-play-reuse-${run}`,
      tokenRef: before.queue[0].token_ref,
      purchaseToken: rawToken,
      productId,
      requestedAt: "2026-08-24T01:04:00.000Z",
    }), /google_play_purchase_token_reused/);
  });

  it("verifies only the initial Google Play subscription order and replaces the client amount", async () => {
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO control.app_link_identities (
        tenant_id, app_id, android_package_name, registered_at, artifact
      ) VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [tenantId, appId, playPackageName, "2026-08-24T02:00:00.000Z",
        JSON.stringify({ tenant_id: tenantId, app_id: appId, android_package_name: playPackageName })],
    ));
    const providerOrderId = `order:subscription:synthetic:${run}`;
    const event = sourceEvent(`event:google-play-subscription:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:client-subscription:${run}`,
      amount_unscaled: "99990000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "pending",
      extensions: {
        google_play_purchase_token_protected: playSubscriptionToken,
        google_play_product_id_protected: playSubscriptionProductId,
        google_play_purchase_kind: "subscription_initial",
      },
    });
    assert.equal((await signed("/v1/events/batch", { records: [event] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const operations: string[] = [];
    const outcome = await processGooglePlayProductVerifications(pool, payloadStore, tenantId, {
      enabled: true,
      enabledKinds: ["subscription_initial"],
      now: () => new Date(Date.now() + 60_000),
      client: async (input) => {
        operations.push(input.operation);
        if (input.operation === "subscription") return { status: 200, body: Buffer.from(JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          startTime: playSubscriptionStartTime,
          lineItems: [{ productId: playSubscriptionProductId, latestSuccessfulOrderId: providerOrderId }],
        })) };
        return { status: 200, body: Buffer.from(JSON.stringify({
          orderId: providerOrderId,
          purchaseToken: playSubscriptionToken,
          state: "PROCESSED",
          lineItems: [{
            productId: playSubscriptionProductId,
            total: { currencyCode: "JPY", units: "850", nanos: 0 },
            subscriptionDetails: {
              servicePeriodStartTime: playSubscriptionStartTime,
              servicePeriodEndTime: "2026-09-24T02:03:04.000Z",
            },
          }],
        })) };
      },
    });
    assert.deepEqual(outcome, { verified: 1, failed: 0, unavailable: 0, deferred: 0 });
    assert.deepEqual(operations, ["subscription", "order"]);
    const stored = await withTenant(pool, tenantId, async (client) => ({
      result: (await client.query<{ artifact: unknown; purchase_kind: string; verified_record_id: string }>(
        `SELECT artifact, purchase_kind, verified_record_id FROM ledger.google_play_purchase_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id IN (
            SELECT record_id FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3
          )`, [tenantId, appId, event.event_id],
      )).rows[0],
      fact: (await client.query<{ amount_unscaled: string; amount_scale: number; currency: string; artifact: unknown }>(
        `SELECT fact.amount_unscaled, fact.amount_scale, fact.currency, fact.artifact
           FROM ledger.purchase_facts fact
          WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND fact.record_id=(
            SELECT verified_record_id FROM ledger.google_play_purchase_verification_results
             WHERE tenant_id=$1 AND app_id=$2 AND purchase_kind='subscription_initial'
             ORDER BY decided_at DESC LIMIT 1
          )`, [tenantId, appId],
      )).rows[0],
    }));
    assert.equal(stored.result.purchase_kind, "subscription_initial");
    assert.match(JSON.stringify(stored.result.artifact), /subscription_initial/);
    assert.deepEqual({
      amount_unscaled: stored.fact.amount_unscaled,
      amount_scale: stored.fact.amount_scale,
      currency: stored.fact.currency,
    }, { amount_unscaled: "850000000000", amount_scale: 9, currency: "JPY" });
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(playSubscriptionToken));
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(providerOrderId));
  });

  it("ingests an authenticated RTDN renewal once and settles only provider order money", async () => {
    const messageId = `synthetic-rtdn-message-${run}`;
    const request = () => fetch(`${baseUrl}/v1/google-play/rtdn`, {
      method: "POST",
      headers: { authorization: `Bearer ${rtdnToken()}`, "content-type": "application/json" },
      body: rtdnEnvelope(messageId),
    });
    assert.equal((await request()).status, 204);
    assert.equal((await request()).status, 204, "Pub/Sub redelivery must be idempotent");
    const renewalOrderId = verifiedRenewalOrderId;
    const renewalStart = new Date(Date.now() - 120_000).toISOString();
    const renewalEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const operations: string[] = [];
    const outcome = await processGooglePlayProductVerifications(pool, payloadStore, tenantId, {
      enabled: true,
      enabledKinds: ["subscription_renewal"],
      now: () => new Date(Date.now() + 60_000),
      client: async (input) => {
        operations.push(input.operation);
        if (input.operation === "subscription") return { status: 200, body: Buffer.from(JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          startTime: playSubscriptionStartTime,
          lineItems: [{ productId: playSubscriptionProductId, latestSuccessfulOrderId: renewalOrderId }],
        })) };
        return { status: 200, body: Buffer.from(JSON.stringify({
          orderId: renewalOrderId,
          purchaseToken: playSubscriptionToken,
          state: "PROCESSED",
          lineItems: [{
            productId: playSubscriptionProductId,
            total: { currencyCode: "JPY", units: "920", nanos: 0 },
              subscriptionDetails: {
                servicePeriodStartTime: renewalStart,
                servicePeriodEndTime: renewalEnd,
            },
          }],
        })) };
      },
    });
    assert.deepEqual(outcome, { verified: 1, failed: 0, unavailable: 0, deferred: 0 });
    assert.deepEqual(operations, ["subscription", "order"]);
    const stored = await withTenant(pool, tenantId, async (client) => ({
      facts: (await client.query<{ amount_unscaled: string; amount_scale: number; currency: string; artifact: unknown }>(
        `SELECT fact.amount_unscaled, fact.amount_scale, fact.currency, fact.artifact
           FROM ledger.purchase_facts AS fact
           JOIN ledger.google_play_purchase_verification_results AS result
             ON result.tenant_id=fact.tenant_id AND result.app_id=fact.app_id
            AND result.verified_record_id=fact.record_id
          WHERE fact.tenant_id=$1 AND fact.app_id=$2
            AND result.purchase_kind='subscription_renewal' AND result.verdict='verified'`,
        [tenantId, appId],
      )).rows,
      messages: (await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM control.google_play_rtdn_messages WHERE tenant_id=$1 AND app_id=$2",
        [tenantId, appId],
      )).rows[0].count,
      queue: (await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM ephemeral.google_play_product_verifications WHERE tenant_id=$1 AND app_id=$2 AND purchase_kind='subscription_renewal'",
        [tenantId, appId],
      )).rows[0].count,
    }));
    assert.equal(stored.messages, 1);
    assert.equal(stored.queue, 0);
    assert.equal(stored.facts.length, 1);
    assert.deepEqual({
      amount_unscaled: stored.facts[0].amount_unscaled,
      amount_scale: stored.facts[0].amount_scale,
      currency: stored.facts[0].currency,
    }, { amount_unscaled: "920000000000", amount_scale: 9, currency: "JPY" });
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(playSubscriptionToken));
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(renewalOrderId));

    const secondMessage = await fetch(`${baseUrl}/v1/google-play/rtdn`, {
      method: "POST",
      headers: { authorization: `Bearer ${rtdnToken()}`, "content-type": "application/json" },
      body: rtdnEnvelope(`${messageId}-second-provider-delivery`),
    });
    assert.equal(secondMessage.status, 204);
    const duplicate = await processGooglePlayProductVerifications(pool, payloadStore, tenantId, {
      enabled: true,
      enabledKinds: ["subscription_renewal"],
      now: () => new Date(Date.now() + 120_000),
      client: async (input) => input.operation === "subscription"
        ? { status: 200, body: Buffer.from(JSON.stringify({
            subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", startTime: playSubscriptionStartTime,
            lineItems: [{ productId: playSubscriptionProductId, latestSuccessfulOrderId: renewalOrderId }],
          })) }
        : { status: 200, body: Buffer.from(JSON.stringify({
            orderId: renewalOrderId, purchaseToken: playSubscriptionToken, state: "PROCESSED",
            lineItems: [{ productId: playSubscriptionProductId, total: { currencyCode: "JPY", units: "920", nanos: 0 },
              subscriptionDetails: { servicePeriodStartTime: renewalStart, servicePeriodEndTime: renewalEnd } }],
          })) },
    });
    assert.deepEqual(duplicate, { verified: 0, failed: 1, unavailable: 0, deferred: 0 });
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT 1 FROM ledger.purchase_facts AS fact
        JOIN ledger.google_play_purchase_verification_results AS result
          ON result.tenant_id=fact.tenant_id AND result.app_id=fact.app_id
         AND result.verified_record_id=fact.record_id
       WHERE fact.tenant_id=$1 AND fact.app_id=$2
         AND result.purchase_kind='subscription_renewal' AND result.verdict='verified'`,
      [tenantId, appId],
    )).rowCount), 1);
    assert.deepEqual(await processCommerceReadbacks(pool, payloadStore, tenantId, {
      now: new Date(Date.now() + 150_000),
      googleClient: async ({ operation }) => {
        assert.equal(operation, "subscription");
        return { status: 200, body: Buffer.from(JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        })) };
      },
    }), { processed: 2, deferred: 0, failed: 0 },
    "each distinct authenticated RTDN delivery must complete its own state read-back");
  });

  it("WO19 reads a voided order authoritatively and records its exact refund once", async () => {
    const partialRefundAt = new Date(Date.now() - 60_000).toISOString();
    const fullRefundAt = new Date(Date.now() - 30_000).toISOString();
    const messageId = `synthetic-rtdn-void-${run}`;
    const envelope = rtdnEnvelopeFor(messageId, {
      voidedPurchaseNotification: {
        purchaseToken: playSubscriptionToken,
        orderId: verifiedRenewalOrderId,
        productType: 1,
        refundType: 2,
      },
    });
    const send = () => fetch(`${baseUrl}/v1/google-play/rtdn`, {
      method: "POST",
      headers: { authorization: `Bearer ${rtdnToken()}`, "content-type": "application/json" },
      body: envelope,
    });
    assert.equal((await send()).status, 204);
    assert.equal((await send()).status, 204);
    const outcome = await processCommerceReadbacks(pool, payloadStore, tenantId, {
      now: new Date(Date.now() + 180_000),
      googleClient: async ({ operation, orderId }) => {
        if (operation === "subscription") return { status: 200, body: Buffer.from(JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        })) };
        assert.equal(orderId, verifiedRenewalOrderId);
        return { status: 200, body: Buffer.from(JSON.stringify({
          orderId: verifiedRenewalOrderId,
          orderHistory: { partialRefundEvents: [{
            state: "PROCESSED_SUCCESSFULLY",
            processTime: partialRefundAt,
            refundDetails: { total: { currencyCode: "JPY", units: "120", nanos: 0 } },
          }] },
        })) };
      },
    });
    assert.deepEqual(outcome, { processed: 1, deferred: 0, failed: 0 });
    assert.deepEqual(await processCommerceReadbacks(pool, payloadStore, tenantId, {
      now: new Date(Date.now() + 240_000), googleClient: async () => { throw new Error("must not repeat"); },
    }), { processed: 0, deferred: 0, failed: 0 });
    const refunds = await withTenant(pool, tenantId, async (client) => (await client.query<{
      amount_unscaled: string; amount_scale: number; currency: string;
    }>(
      `SELECT amount_unscaled, amount_scale, currency FROM ledger.refund_facts
        WHERE tenant_id=$1 AND app_id=$2 AND transaction_id LIKE 'refund:google-play:%'`, [tenantId, appId],
    )).rows);
    assert.deepEqual(refunds, [{ amount_unscaled: "120000000000", amount_scale: 9, currency: "JPY" }]);
    assert.equal(await payloadStore.scanFor(verifiedRenewalOrderId), false);

    const excessiveMessage = `synthetic-rtdn-over-refund-${run}`;
    assert.equal((await fetch(`${baseUrl}/v1/google-play/rtdn`, {
      method: "POST", headers: { authorization: `Bearer ${rtdnToken()}`, "content-type": "application/json" },
      body: rtdnEnvelopeFor(excessiveMessage, { voidedPurchaseNotification: {
        purchaseToken: playSubscriptionToken, orderId: verifiedRenewalOrderId, productType: 1, refundType: 1,
      } }),
    })).status, 204);
    const excessive = await processCommerceReadbacks(pool, payloadStore, tenantId, {
      now: new Date(Date.now() + 300_000),
      googleClient: async () => ({ status: 200, body: Buffer.from(JSON.stringify({
        orderId: verifiedRenewalOrderId,
        orderHistory: { refundEvent: { eventTime: fullRefundAt,
          refundDetails: { total: { currencyCode: "JPY", units: "920", nanos: 0 } } } },
      })) }),
    });
    assert.deepEqual(excessive, { processed: 0, deferred: 0, failed: 1 },
      "cumulative refunds above the verified purchase must fail closed");
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT 1 FROM ledger.refund_facts WHERE tenant_id=$1 AND app_id=$2
        AND transaction_id LIKE 'refund:google-play:%'`, [tenantId, appId],
    )).rowCount), 1);
  });

  it("WO19 retains a terminal safe failure after a bounded provider outage", async () => {
    const messageId = `synthetic-rtdn-unavailable-${run}`;
    assert.equal((await fetch(`${baseUrl}/v1/google-play/rtdn`, {
      method: "POST", headers: { authorization: `Bearer ${rtdnToken()}`, "content-type": "application/json" },
      body: rtdnEnvelopeFor(messageId, { subscriptionNotification: {
        version: "1.0", notificationType: 3, purchaseToken: playSubscriptionToken,
      } }),
    })).status, 204);
    await withTenant(pool, tenantId, async (client) => client.query(
      `UPDATE ephemeral.commerce_provider_readbacks AS readback SET attempts=19
        FROM control.commerce_provider_notifications AS notification
       WHERE readback.provider=notification.provider AND readback.notification_digest=notification.notification_digest
         AND readback.tenant_id=$1 AND notification.event_kind='subscription_canceled'`, [tenantId],
    ));
    assert.deepEqual(await processCommerceReadbacks(pool, payloadStore, tenantId, {
      now: new Date(Date.now() + 360_000), googleClient: async () => ({ status: 503, body: Buffer.alloc(0) }),
    }), { processed: 0, deferred: 0, failed: 1 });
    const terminal = await withTenant(pool, tenantId, async (client) => ({
      failures: Number((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger.commerce_lifecycle_facts
          WHERE tenant_id=$1 AND app_id=$2 AND event_kind='readback_failed'`, [tenantId, appId],
      )).rows[0].count),
      queued: Number((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ephemeral.commerce_provider_readbacks
          WHERE tenant_id=$1 AND app_id=$2`, [tenantId, appId],
      )).rows[0].count),
    }));
    assert.equal(terminal.failures >= 1, true);
    assert.equal(terminal.queued, 0);
  });

  it("keeps pending, cancelled, mismatched, malformed, and unavailable Play responses out of settled revenue", async () => {
    const cases = ["pending", "cancelled", "mismatch", "malformed", "unavailable"] as const;
    const records = cases.map((kind, index) => sourceEvent(`event:google-play-${kind}:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:google-play-${kind}:${run}`,
      amount_unscaled: String(100 + index), amount_scale: 2, currency: "USD", financial_status: "pending",
      extensions: {
        google_play_purchase_token_protected: `synthetic-token-${kind}-${run}`,
        google_play_product_id_protected: `product.${kind}.${run}`,
      },
    }));
    assert.equal((await signed("/v1/events/batch", { records }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const outcome = await processGooglePlayProductVerifications(pool, payloadStore, tenantId, {
      enabled: true,
      maximumAttempts: 1,
      now: () => new Date(Date.now() + 60_000),
      client: async ({ productId }) => {
        const kind = cases.find((candidate) => productId.includes(`.${candidate}.`));
        if (kind === "unavailable") return { status: 503, body: Buffer.alloc(0) };
        if (kind === "malformed") return { status: 200, body: Buffer.from("{}") };
        return { status: 200, body: Buffer.from(JSON.stringify({
          purchaseStateContext: { purchaseState: kind === "pending" ? "PENDING" : kind === "cancelled" ? "CANCELLED" : "PURCHASED" },
          purchaseCompletionTime: "2026-08-24T01:59:00.000Z",
          productLineItem: [{ productId: kind === "mismatch" ? `product.other.${run}` : productId }],
        })) };
      },
    });
    assert.deepEqual(outcome, { verified: 0, failed: 3, unavailable: 2, deferred: 0 });
    const evidence = await withTenant(pool, tenantId, async (client) => ({
      results: (await client.query<{ verdict: string; verified_record_id: string | null }>(
        `SELECT verdict, verified_record_id FROM ledger.google_play_purchase_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id IN (
            SELECT record_id FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=ANY($3::text[])
          ) ORDER BY verdict, verification_result_id`,
        [tenantId, appId, records.map((record) => record.event_id)],
      )).rows,
      settled: (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ledger.purchase_facts fact
          JOIN ledger.raw_records raw ON raw.tenant_id=fact.tenant_id AND raw.app_id=fact.app_id AND raw.record_id=fact.record_id
          WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND raw.event_id=ANY($3::text[]) AND fact.financial_status='settled'`,
        [tenantId, appId, records.map((record) => record.event_id)],
      )).rows[0].count,
    }));
    assert.equal(evidence.results.length, 5);
    assert.ok(evidence.results.every((row) => row.verified_record_id === null));
    assert.equal(evidence.settled, 0);
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

  it("DL-A-15, DL-A-16, and DL-A-25 resolve signed deep-link opens only from tenant-scoped server state", async () => {
    const deepInstallationId = `installation:m7-${run}`;
    const enrollment = await signed("/v1/installations", { installation_id: deepInstallationId });
    assert.equal(enrollment.status, 201);
    const deepCredential = await enrollment.json() as {
      installation_key_id: string;
      installation_secret: string;
    };
    const deepSigned = (records: unknown[]) => signed("/v1/events/batch", { records }, {
      secret: deepCredential.installation_secret,
      installationKeyId: deepCredential.installation_key_id,
    });
    const link = await createTrackingLink({
      pool,
      tenantId,
      appId,
      actorRef: "admin_key:synthetic-m7",
      allowedOrigins: [],
      now: "2026-08-19T02:00:00.000Z",
      body: {
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic",
        play_package_name: "dev.openmasu.synthetic",
        campaign_id: `campaign-m7-${run}`,
        deep_link_value: "/synthetic/m7",
      },
    });
    const session = sourceEvent(`event:m7-session:${run}`, "session_start", {
      installation_id: deepInstallationId,
      session_id: `session:m7-${run}`,
    }, "2026-08-17T03:00:00.000Z");
    assert.equal((await deepSigned([session])).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const active = sourceEvent(`event:m7-active:${run}`, "deep_link_open", {
      installation_id: deepInstallationId,
      open_source: "android_app_link",
      destination_status: "delivered",
      link_slug: link.slug,
      deep_link_value: "/synthetic/m7",
    }, "2026-08-19T03:00:00.000Z");
    const unknown = sourceEvent(`event:m7-unknown:${run}`, "deep_link_open", {
      installation_id: deepInstallationId,
      open_source: "ios_universal_link",
      destination_status: "delivered",
      link_slug: "unknownM7slug",
      deep_link_value: "/synthetic/unknown",
    }, "2026-08-19T03:01:00.000Z");
    assert.equal((await deepSigned([active, unknown])).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const evidence = await withTenant(pool, tenantId, async (client) => ({
      projections: (await client.query<{
        event_id: string;
        tracking_link_id: string | null;
        campaign_id: string | null;
        days_since_last_session: number | null;
      }>(
        `SELECT raw.event_id, facts.tracking_link_id, facts.campaign_id, facts.days_since_last_session
           FROM ledger.deep_link_open_facts AS facts
           JOIN ledger.logical_events AS logical ON logical.logical_event_id=facts.logical_event_id
           JOIN ledger.raw_records AS raw ON raw.record_id=logical.record_id
          WHERE facts.tenant_id=$1 AND facts.app_id=$2 AND raw.event_id IN ($3,$4)
          ORDER BY raw.event_id COLLATE "C"`,
        [tenantId, appId, active.event_id, unknown.event_id],
      )).rows,
      attributions: (await client.query<{ event_id: string; subject_scope: string; subject_ref: string; reason_code: string }>(
        `SELECT raw.event_id, result.subject_scope, result.subject_ref, result.reason_code
           FROM ledger.attribution_results AS result
           JOIN ledger.raw_records AS raw ON raw.record_id = substring(result.subject_ref FROM '^engagement:(.*)$')
          WHERE result.tenant_id=$1 AND result.app_id=$2 AND raw.event_id IN ($3,$4)
          ORDER BY raw.event_id COLLATE "C"`,
        [tenantId, appId, active.event_id, unknown.event_id],
      )).rows,
      rejected: (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ledger.rejections AS rejection
          JOIN ledger.raw_records AS raw ON raw.record_id=rejection.record_id
         WHERE rejection.tenant_id=$1 AND rejection.app_id=$2 AND raw.event_id IN ($3,$4)`,
        [tenantId, appId, active.event_id, unknown.event_id],
      )).rows[0].count,
    }));
    assert.deepEqual(evidence.projections, [
      { event_id: active.event_id, tracking_link_id: link.tracking_link_id, campaign_id: `campaign-m7-${run}`, days_since_last_session: 2 },
      { event_id: unknown.event_id, tracking_link_id: null, campaign_id: null, days_since_last_session: 2 },
    ]);
    assert.deepEqual(evidence.attributions.map((row) => [row.event_id, row.subject_scope, row.reason_code]), [
      [active.event_id, "engagement_level", "deep_link_open_attributed"],
      [unknown.event_id, "engagement_level", "deep_link_unknown_link"],
    ]);
    assert.ok(evidence.attributions.every((row) => row.subject_ref.startsWith("engagement:record:")));
    assert.equal(evidence.rejected, 0);

    const otherTenant = `tenant-m7-other-${run}`;
    const otherApp = `app-m7-other-${run}`;
    await withTenant(pool, otherTenant, (client) => client.query(
      "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)",
      [otherTenant, otherApp, "2026-08-19T02:00:00.000Z"],
    ).then(() => undefined));
    const foreignLink = await createTrackingLink({
      pool,
      tenantId: otherTenant,
      appId: otherApp,
      actorRef: "admin_key:synthetic-m7-other",
      allowedOrigins: [],
      now: "2026-08-19T02:00:01.000Z",
      body: {
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic.other",
        play_package_name: "dev.openmasu.synthetic.other",
        campaign_id: `campaign-m7-other-${run}`,
      },
    });
    const foreign = sourceEvent(`event:m7-foreign:${run}`, "deep_link_open", {
      installation_id: deepInstallationId,
      open_source: "android_app_link",
      destination_status: "delivered",
      link_slug: foreignLink.slug,
    }, "2026-08-19T03:02:00.000Z");
    const forged = sourceEvent(`event:m7-forged:${run}`, "deep_link_open", {
      installation_id: deepInstallationId,
      open_source: "android_app_link",
      destination_status: "delivered",
      link_slug: link.slug,
      campaign_id: "device-claimed-campaign",
      tracking_link_id: "device-claimed-link",
      provider_campaign: "device-claimed-provider",
    }, "2026-08-19T03:03:00.000Z");
    assert.equal((await deepSigned([foreign])).status, 202);
    assert.equal((await deepSigned([forged])).status, 403);
    await processSdkInbox(pool, payloadStore, tenantId);
    const isolation = await withTenant(pool, tenantId, async (client) => ({
      foreign: (await client.query<{ tracking_link_id: string | null; campaign_id: string | null }>(
        `SELECT facts.tracking_link_id,facts.campaign_id FROM ledger.deep_link_open_facts AS facts
           JOIN ledger.logical_events AS logical ON logical.logical_event_id=facts.logical_event_id
           JOIN ledger.raw_records AS raw ON raw.record_id=logical.record_id
          WHERE facts.tenant_id=$1 AND facts.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, foreign.event_id],
      )).rows[0],
      foreignReason: (await client.query<{ reason_code: string }>(
        `SELECT result.reason_code FROM ledger.attribution_results AS result
           JOIN ledger.raw_records AS raw ON raw.record_id=substring(result.subject_ref FROM '^engagement:(.*)$')
          WHERE result.tenant_id=$1 AND result.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, foreign.event_id],
      )).rows[0]?.reason_code,
      forgedLogical: (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ledger.logical_events AS logical
           JOIN ledger.raw_records AS raw ON raw.record_id=logical.record_id
          WHERE logical.tenant_id=$1 AND logical.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, forged.event_id],
      )).rows[0].count,
      acceptedAudits: (await client.query<{ reason_code: string; request_digest: string; target_ref: string }>(
        `SELECT reason_code,request_digest,target_ref FROM ledger.audit_logs
          WHERE tenant_id=$1 AND app_id=$2 AND action='deep_link_device_claim_observed'
          ORDER BY occurred_at`, [tenantId, appId],
      )).rows,
      rejectedClaimAudits: (await client.query<{ reason_code: string; target_ref: string }>(
        `SELECT reason_code,target_ref FROM ledger.audit_logs
          WHERE tenant_id=$1 AND app_id=$2 AND action='deep_link_client_claim_rejected'
          ORDER BY occurred_at`, [tenantId, appId],
      )).rows,
    }));
    assert.deepEqual(isolation.foreign, { tracking_link_id: null, campaign_id: null });
    assert.equal(isolation.foreignReason, "deep_link_unknown_link");
    assert.equal(isolation.forgedLogical, 0);
    assert.ok(isolation.acceptedAudits.some((row) => row.reason_code === "device_claim_observed"));
    assert.ok(isolation.acceptedAudits.some((row) => row.reason_code === "deep_link_unknown_link"));
    assert.ok(isolation.acceptedAudits.every((row) => /^[a-f0-9]{64}$/.test(row.request_digest)));
    assert.ok(isolation.acceptedAudits.every((row) => /^record-digest:[a-f0-9]{64}$/.test(row.target_ref)));
    assert.ok(isolation.rejectedClaimAudits.some((row) =>
      row.reason_code === "device_deep_link_attribution_claim_forbidden"
      && /^request-digest:[a-f0-9]{32}$/.test(row.target_ref)));
  });

  it("assigns revenue purpose and resolves settled refunds without trusting a device target", async () => {
    const rejectedBefore = await withTenant(pool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger.rejections
        WHERE tenant_id=$1 AND app_id=$2 AND reason_code='refund_target_invalid'`,
      [tenantId, appId],
    )).rows[0].count));
    const originalTransactionId = `transaction:commerce-original-${run}`;
    const unscopedPurchase = sourceEvent(`event:commerce-purchase-unscoped:${run}`, "purchase", {
      transaction_id: `transaction:commerce-purchase-unscoped-${run}`,
      amount_unscaled: "1000",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    });
    const unscopedRefund = sourceEvent(`event:commerce-refund-unscoped:${run}`, "refund", {
      transaction_id: `transaction:commerce-refund-unscoped-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "250",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    });
    assert.equal((await signed("/v1/events/batch", { records: [unscopedPurchase] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202, "legacy analytics purchases remain accepted without an installation anchor");
    assert.equal((await signed("/v1/events/batch", { records: [unscopedRefund] }, {
      secret: installationSecret, installationKeyId,
    })).status, 403, "target-free refunds must carry their installation scope");

    const purchase = sourceEvent(`event:commerce-purchase:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-purchase-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "1000",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T01:00:00.000Z");
    assert.equal((await signed("/v1/events/batch", { records: [purchase] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const legacyPurchase = await withTenant(pool, tenantId, async (client) => (await client.query<{
      record_id: string; processing_purpose_id: string;
    }>(
      `SELECT raw.record_id, raw.processing_purpose_id
         FROM ledger.raw_records AS raw
        WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.event_id=$3`,
      [tenantId, appId, unscopedPurchase.event_id],
    )).rows[0]);
    assert.equal(legacyPurchase.processing_purpose_id, "analytics");
    const legacyRefund = sourceEvent(`event:commerce-refund-legacy:${run}`, "refund", {
      transaction_id: `transaction:commerce-refund-legacy-${run}`,
      original_transaction_id: "legacy-values-are-not-financially-reclassified",
      correction_target_record_id: legacyPurchase.record_id,
      amount_unscaled: "999999",
      amount_scale: 2,
      currency: "JPY",
      financial_status: "reversed",
    }, "2026-08-18T23:00:00.000Z");
    assert.equal((await signed("/v1/events/batch", { records: [legacyRefund] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const legacyEvidence = await withTenant(pool, tenantId, async (client) => ({
      purpose: (await client.query<{ processing_purpose_id: string }>(
        `SELECT processing_purpose_id FROM ledger.raw_records
          WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
        [tenantId, appId, legacyRefund.event_id],
      )).rows[0]?.processing_purpose_id,
      correction: (await client.query<{ corrects_record_id: string }>(
        `SELECT correction.corrects_record_id FROM ledger.corrections AS correction
           JOIN ledger.raw_records AS raw
             ON raw.tenant_id=correction.tenant_id AND raw.app_id=correction.app_id
            AND raw.record_id=substring(correction.correction_id FROM '^correction:(.*)$')
          WHERE correction.tenant_id=$1 AND correction.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, legacyRefund.event_id],
      )).rows[0],
      facts: (await client.query(
        `SELECT fact.logical_event_id FROM ledger.refund_facts AS fact
           JOIN ledger.logical_events AS logical USING (logical_event_id, tenant_id, app_id)
           JOIN ledger.raw_records AS raw USING (record_id, tenant_id, app_id)
          WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, legacyRefund.event_id],
      )).rowCount,
    }));
    assert.equal(legacyEvidence.purpose, "analytics");
    assert.deepEqual(legacyEvidence.correction, { corrects_record_id: legacyPurchase.record_id });
    assert.equal(legacyEvidence.facts, 0, "legacy explicit refunds must not enter financial facts");

    const acceptedRefund = sourceEvent(`event:commerce-refund:${run}`, "refund", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-refund-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "250",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T02:00:00.000Z");
    const mismatchedRefund = sourceEvent(`event:commerce-refund-mismatch:${run}`, "refund", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-refund-mismatch-${run}`,
      original_transaction_id: originalTransactionId,
      correction_target_record_id: `record:forged-commerce-target-${run}`,
      amount_unscaled: "100",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T02:30:00.000Z");
    const overRefund = sourceEvent(`event:commerce-refund-over:${run}`, "refund", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-refund-over-${run}`,
      original_transaction_id: originalTransactionId,
      // Exceeds the purchase on its own, so same-millisecond record-id tie
      // ordering cannot make this synthetic rejection depend on batch order.
      amount_unscaled: "1100",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T03:00:00.000Z");
    const precedingRefund = sourceEvent(`event:commerce-refund-precedes:${run}`, "refund", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-refund-precedes-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "100",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T00:30:00.000Z");
    assert.equal((await signed("/v1/events/batch", {
      records: [acceptedRefund, mismatchedRefund, overRefund, precedingRefund],
    }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const secondPurchase = sourceEvent(`event:commerce-purchase-ambiguous:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-purchase-ambiguous-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "500",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    });
    assert.equal((await signed("/v1/events/batch", { records: [secondPurchase] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const ambiguousRefund = sourceEvent(`event:commerce-refund-ambiguous:${run}`, "refund", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-refund-ambiguous-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "100",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    });
    const missingRefund = sourceEvent(`event:commerce-refund-missing:${run}`, "refund", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-refund-missing-${run}`,
      original_transaction_id: `transaction:commerce-missing-${run}`,
      amount_unscaled: "100",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    });
    assert.equal((await signed("/v1/events/batch", { records: [ambiguousRefund, missingRefund] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const evidence = await withTenant(pool, tenantId, async (client) => ({
      purchase: (await client.query<{
        record_id: string; processing_purpose_id: string; financial_status: string;
      }>(
        `SELECT raw.record_id, raw.processing_purpose_id, fact.financial_status
           FROM ledger.raw_records AS raw
           JOIN ledger.logical_events AS logical USING (record_id, tenant_id, app_id)
           JOIN ledger.purchase_facts AS fact USING (logical_event_id, tenant_id, app_id)
          WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, purchase.event_id],
      )).rows[0],
      refund: (await client.query<{
        processing_purpose_id: string; correction_target_record_id: string; financial_status: string;
      }>(
        `SELECT raw.processing_purpose_id, fact.correction_target_record_id, fact.financial_status
           FROM ledger.raw_records AS raw
           JOIN ledger.logical_events AS logical USING (record_id, tenant_id, app_id)
           JOIN ledger.refund_facts AS fact USING (logical_event_id, tenant_id, app_id)
          WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.event_id=$3`,
        [tenantId, appId, acceptedRefund.event_id],
      )).rows[0],
      correction: (await client.query<{ corrects_record_id: string }>(
        `SELECT correction.corrects_record_id
           FROM ledger.corrections AS correction
           JOIN ledger.raw_records AS target
             ON target.tenant_id=correction.tenant_id AND target.app_id=correction.app_id
            AND target.record_id=correction.corrects_record_id
          WHERE correction.tenant_id=$1 AND correction.app_id=$2
            AND correction.artifact->>'correction_reason'='refund' AND target.event_id=$3`,
        [tenantId, appId, purchase.event_id],
      )).rows,
      rejected: (await client.query<{ event_id: string }>(
        `SELECT raw.event_id
           FROM ledger.rejections AS rejection
           JOIN ledger.event_deliveries AS delivery
             ON delivery.tenant_id=rejection.tenant_id AND delivery.app_id=rejection.app_id
            AND delivery.record_id=rejection.record_id AND delivery.delivery_id=rejection.delivery_id
           LEFT JOIN ledger.raw_records AS raw
             ON raw.tenant_id=rejection.tenant_id AND raw.app_id=rejection.app_id
            AND raw.record_id=rejection.record_id
          WHERE rejection.tenant_id=$1 AND rejection.app_id=$2
            AND rejection.reason_code='refund_target_invalid'
          ORDER BY rejection.record_id`,
        [tenantId, appId],
      )).rows,
    }));
    assert.equal(evidence.purchase.processing_purpose_id, "revenue_measurement");
    assert.equal(evidence.purchase.financial_status, "settled");
    assert.equal(evidence.refund.processing_purpose_id, "revenue_measurement");
    assert.equal(evidence.refund.financial_status, "settled");
    assert.equal(evidence.refund.correction_target_record_id, evidence.purchase.record_id);
    assert.deepEqual(evidence.correction, [{ corrects_record_id: evidence.purchase.record_id }]);
    assert.equal(evidence.rejected.length - rejectedBefore, 5);
    assert.equal((await pool.query(
      "SELECT logical_event_id FROM ledger.refund_facts WHERE correction_target_record_id=$1",
      [evidence.purchase.record_id],
    )).rowCount, 0, "refund facts must be hidden when the tenant GUC is unset");
    assert.equal((await withTenant(pool, `${tenantId}-other`, (client) => client.query(
      "SELECT logical_event_id FROM ledger.refund_facts WHERE correction_target_record_id=$1",
      [evidence.purchase.record_id],
    ))).rowCount, 0, "refund facts must be hidden from another tenant");

    const repeatedPurchase = sourceEvent(`event:commerce-purchase-repeat:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-purchase-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "1000",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T01:00:00.000Z");
    assert.equal((await signed("/v1/events/batch", { records: [repeatedPurchase] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    assert.equal((await withTenant(pool, tenantId, (client) => client.query(
      `SELECT delivery_attempt_id FROM ledger.event_deliveries
        WHERE tenant_id=$1 AND app_id=$2 AND canonical_record_id=$3
          AND duplicate_resolution='duplicate_delivery'`,
      [tenantId, appId, evidence.purchase.record_id],
    ))).rowCount, 1, "equivalent business transaction IDs must count once");

    const conflictingPurchase = sourceEvent(`event:commerce-purchase-conflict:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-purchase-${run}`,
      original_transaction_id: originalTransactionId,
      amount_unscaled: "1001",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T01:00:00.000Z");
    assert.equal((await signed("/v1/events/batch", { records: [conflictingPurchase] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const conflictEvidence = await withTenant(pool, tenantId, async (client) => ({
      rejection: (await client.query(
        `SELECT rejection.rejection_seq FROM ledger.rejections AS rejection
          JOIN ledger.raw_records AS raw
            ON raw.tenant_id=rejection.tenant_id AND raw.app_id=rejection.app_id
           AND raw.record_id=rejection.record_id
         WHERE rejection.tenant_id=$1 AND rejection.app_id=$2 AND raw.event_id=$3
           AND rejection.reason_code='event_id_conflict'`,
        [tenantId, appId, conflictingPurchase.event_id],
      )).rowCount,
      facts: (await client.query(
        `SELECT logical_event_id FROM ledger.purchase_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
        [tenantId, appId, `transaction:commerce-purchase-${run}`],
      )).rowCount,
    }));
    assert.equal(conflictEvidence.rejection, 1, "conflicting business transaction must fail closed");
    assert.equal(conflictEvidence.facts, 1, "conflicting business transaction must not add a fact");

    const privacyTarget = sourceEvent(`event:commerce-privacy-target:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:commerce-privacy-target-${run}`,
      amount_unscaled: "1000",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-19T04:00:00.000Z");
    assert.equal((await signed("/v1/events/batch", { records: [privacyTarget] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    legacyPrivacyTargetRecordId = await withTenant(pool, tenantId, async (client) => (await client.query<{ record_id: string }>(
      `SELECT record_id FROM ledger.raw_records
        WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
      [tenantId, appId, privacyTarget.event_id],
    )).rows[0].record_id);

    const privacyLegacyRefund = sourceEvent(`event:commerce-privacy-legacy-refund:${run}`, "refund", {
      transaction_id: `transaction:commerce-privacy-legacy-refund-${run}`,
      original_transaction_id: "legacy-correction-only",
      correction_target_record_id: legacyPrivacyTargetRecordId,
      amount_unscaled: "1",
      amount_scale: 2,
      currency: "JPY",
      financial_status: "reversed",
    }, "2026-08-19T04:01:00.000Z");
    assert.equal((await signed("/v1/events/batch", { records: [privacyLegacyRefund] }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);
    const privacyLegacyEvidence = await withTenant(pool, tenantId, async (client) => {
      const refundRecord = (await client.query<{ record_id: string }>(
        `SELECT record_id FROM ledger.raw_records
          WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
        [tenantId, appId, privacyLegacyRefund.event_id],
      )).rows[0].record_id;
      const bodyRefs = (await client.query<{ body_ref: string }>(
        `SELECT DISTINCT batch.body_ref
           FROM ledger.ingest_batches AS batch
           JOIN ledger.ingest_batch_records AS member
             ON member.ingest_batch_id=batch.ingest_batch_id
            AND member.tenant_id=batch.tenant_id AND member.app_id=batch.app_id
          WHERE batch.tenant_id=$1 AND batch.app_id=$2
            AND member.record_id=ANY($3::text[])
          ORDER BY batch.body_ref`,
        [tenantId, appId, [legacyPrivacyTargetRecordId, refundRecord]],
      )).rows.map((row) => row.body_ref);
      const correction = (await client.query<{ corrects_record_id: string }>(
        `SELECT corrects_record_id FROM ledger.corrections
          WHERE tenant_id=$1 AND app_id=$2 AND correction_id=$3`,
        [tenantId, appId, `correction:${refundRecord}`],
      )).rows[0];
      const refundFacts = (await client.query(
        `SELECT fact.logical_event_id FROM ledger.refund_facts AS fact
          JOIN ledger.logical_events AS logical USING (logical_event_id, tenant_id, app_id)
         WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND logical.record_id=$3`,
        [tenantId, appId, refundRecord],
      )).rowCount;
      return { refundRecord, bodyRefs, correction, refundFacts };
    });
    legacyPrivacyRefundRecordId = privacyLegacyEvidence.refundRecord;
    legacyPrivacyPayloadRefs = privacyLegacyEvidence.bodyRefs;
    assert.deepEqual(privacyLegacyEvidence.correction, { corrects_record_id: legacyPrivacyTargetRecordId });
    assert.equal(privacyLegacyEvidence.refundFacts, 0, "legacy refund must remain correction-only");
    assert.equal(legacyPrivacyPayloadRefs.length, 2);
    for (const reference of legacyPrivacyPayloadRefs) await payloadStore.read(reference);
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

  it("keeps server-recognised withdrawal effective after the encrypted SDK batch is purged", async () => {
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

    const withdrawalState = await withTenant(pool, tenantId, async (client) => ({
      count: (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM control.installation_withdrawals
          WHERE tenant_id=$1 AND app_id=$2 AND installation_key_id=$3`,
        [tenantId, appId, installationKeyId],
      )).rows[0].count,
      bodyRef: (await client.query<{ body_ref: string }>(
        `SELECT batch.body_ref
           FROM ledger.ingest_batches AS batch
           JOIN ledger.ingest_batch_records AS member
             ON member.ingest_batch_id=batch.ingest_batch_id
            AND member.tenant_id=batch.tenant_id AND member.app_id=batch.app_id
           JOIN ledger.raw_records AS raw
             ON raw.tenant_id=member.tenant_id AND raw.app_id=member.app_id
            AND raw.record_id=member.record_id
          WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.event_id=$3
          ORDER BY batch.inbox_seq DESC LIMIT 1`,
        [tenantId, appId, withdrawal.event_id],
      )).rows[0]?.body_ref,
    }));
    assert.equal(withdrawalState.count, 3);
    assert.ok(withdrawalState.bodyRef);
    await payloadStore.purge(withdrawalState.bodyRef);
    await assert.rejects(payloadStore.read(withdrawalState.bodyRef), /ENOENT|no such file/);

    const eventId = `event:post-withdrawal:${run}`;
    const postWithdrawal = sourceEvent(eventId, "custom_event", {
      installation_id: installationId,
      event_key: "post_withdrawal",
      attributes: { source: "synthetic" },
    }, "2026-08-18T00:00:00.000Z");
    const rejectedPurchase = sourceEvent(`event:post-withdrawal-purchase:${run}`, "purchase", {
      installation_id: installationId,
      transaction_id: `transaction:post-withdrawal-purchase-${run}`,
      amount_unscaled: "1000",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-18T00:00:01.000Z");
    const rejectedRefund = sourceEvent(`event:post-withdrawal-refund:${run}`, "refund", {
      installation_id: installationId,
      transaction_id: `transaction:post-withdrawal-refund-${run}`,
      original_transaction_id: `transaction:post-withdrawal-purchase-${run}`,
      amount_unscaled: "100",
      amount_scale: 2,
      currency: "USD",
      financial_status: "settled",
    }, "2026-08-18T00:00:02.000Z");
    // A client cannot bypass the server-owned purpose mapping.
    postWithdrawal.processing_purpose_id = "fraud_prevention";
    assert.equal((await signed("/v1/events/batch", {
      records: [postWithdrawal, rejectedPurchase, rejectedRefund],
    }, {
      secret: installationSecret, installationKeyId,
    })).status, 202);
    // Base-policy rejection must remain a record-level outcome; an unresolved
    // refund in the same batch must not fail the worker transaction.
    await processSdkInbox(pool, payloadStore, tenantId);

    const after = await withTenant(pool, tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.rejections
       WHERE tenant_id=$1 AND app_id=$2 AND reason_code='consent_withdrawn'`,
      [tenantId, appId],
    )).rows[0].count);
    assert.equal(after, before + 3);
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT event_id FROM ledger.logical_events
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`, [tenantId, appId, eventId],
    )).rowCount), 0);
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT logical.logical_event_id FROM ledger.logical_events AS logical
       JOIN ledger.purchase_facts AS purchase USING (logical_event_id, tenant_id, app_id)
       WHERE logical.tenant_id=$1 AND logical.app_id=$2 AND logical.event_id=$3`,
      [tenantId, appId, rejectedPurchase.event_id],
    )).rowCount), 0);
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT logical.logical_event_id FROM ledger.logical_events AS logical
       JOIN ledger.refund_facts AS refund USING (logical_event_id, tenant_id, app_id)
       WHERE logical.tenant_id=$1 AND logical.app_id=$2 AND logical.event_id=$3`,
      [tenantId, appId, rejectedRefund.event_id],
    )).rowCount), 0);
  });

  it("WO20 returns a subject-scoped portable response without protected payload material", async () => {
    const dsarInstallationId = `installation:dsar-${run}`;
    const enrollment = await signed("/v1/installations", { installation_id: dsarInstallationId });
    assert.equal(enrollment.status, 201);
    const dsarCredential = await enrollment.json() as {
      installation_key_id: string;
      installation_secret: string;
    };
    const dsarSigned = (path: string, body: unknown) => signed(path, body, {
      secret: dsarCredential.installation_secret,
      installationKeyId: dsarCredential.installation_key_id,
    });
    const open = sourceEvent(`event:dsar-deep-link:${run}`, "deep_link_open", {
      installation_id: dsarInstallationId,
      open_source: "android_app_link",
      destination_status: "delivered",
      link_slug: "unknownDsarSlug",
      deep_link_value: "/synthetic/dsar",
    }, "2026-08-19T05:00:00.000Z");
    assert.equal((await dsarSigned("/v1/events/batch", { records: [open] })).status, 202);
    await processSdkInbox(pool, payloadStore, tenantId);

    const before = await withTenant(pool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger.privacy_requests WHERE tenant_id=$1 AND app_id=$2",
      [tenantId, appId],
    )).rows[0].count));
    const response = await dsarSigned("/v1/privacy/access", {
      installation_id: dsarInstallationId,
      request_type: "portability",
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const artifact = JSON.parse(text) as Record<string, any>;
    assert.equal(artifact.request_type, "portability");
    assert.equal(artifact.subject_scope, "installation");
    assert.ok(artifact.records.length > 0);
    assert.match(JSON.stringify(artifact), /device_reported_unverified/);
    for (const forbidden of [
      "raw_payload_ref", "raw_query_ref", "body_ref", "installation_id", "transaction_id",
      "purchase_token", "tracking_link_id", "deep_link_value",
    ]) assert.doesNotMatch(JSON.stringify(artifact), new RegExp(forbidden));

    const other = await dsarSigned("/v1/privacy/access", {
      installation_id: `installation:other-dsar-${run}`,
      request_type: "access",
    });
    assert.equal(other.status, 403);
    const evidence = await withTenant(pool, tenantId, async (client) => ({
      privacyRows: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.privacy_requests WHERE tenant_id=$1 AND app_id=$2",
        [tenantId, appId],
      )).rows[0].count),
      audits: (await client.query<{ outcome: string; reason_code: string | null }>(
        `SELECT outcome,reason_code FROM ledger.audit_logs
          WHERE tenant_id=$1 AND app_id=$2 AND action='privacy_access'
          ORDER BY occurred_at`, [tenantId, appId],
      )).rows,
    }));
    assert.equal(evidence.privacyRows, before, "subject access must not reuse the deletion ledger");
    assert.deepEqual(evidence.audits.slice(-2), [
      { outcome: "succeeded", reason_code: null },
      { outcome: "failed", reason_code: "installation_scope_mismatch" },
    ]);
  });

  it("authorises on-device deletion only for the credential's own installation", async () => {
    const secondId = `installation:other-${run}`;
    const secondResponse = await signed("/v1/installations", { installation_id: secondId });
    assert.equal(secondResponse.status, 201);
    const secondCredential = await secondResponse.json() as {
      installation_key_id: string;
      installation_secret: string;
    };
    assert.equal((await signed(SDK_INSTALLATION_PRIVACY_PATH, { installation_id: secondId }, {
      secret: installationSecret,
      installationKeyId,
    })).status, 403);
    assert.equal((await signed("/v1/privacy/on-device", { installation_id: secondId }, {
      secret: secondCredential.installation_secret,
      installationKeyId: secondCredential.installation_key_id,
    })).status, 201, "the legacy on-device alias must remain functional");
    const priorMetricId = `metric:before-delete:${run}`;
    const priorMetric = {
      metric_run_id: priorMetricId, metric_name: "d0_install_to_24h_ad_revenue_usd",
      metric_definition_version: "0.3.0", input_snapshot_id: "1".repeat(64),
      input_received_at_watermark: "2026-08-19T02:00:00.000Z", input_ledger_position: "2026-08-19T02:00:00.000Z|record:before-delete",
      computed_at: "2026-08-19T02:01:00.000Z", data_freshness: "complete", aggregation_time_zone: "UTC",
      rule_bundle_id: "metric-default", rule_bundle_version: "0.3.0",
      rule_bundle_hash: nonFraudBundleHash("metric-default"),
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
    const deletionToken = `synthetic-google-play-delete-${run}`;
    const deletionProductId = `product.delete.${run}`;
    const deletionTokenRef = await payloadStore.write({
      tenantId, appId, objectId: `google-play-delete-${run}`,
    }, Buffer.from(JSON.stringify({ records: [{
      record_id: legacyPrivacyTargetRecordId,
      event_name: "purchase",
      payload: {
        event_name: "purchase",
        installation_id: installationId,
        amount_unscaled: "2500000",
        amount_scale: 6,
        currency: "USD",
        financial_status: "pending",
        extensions: {
          google_play_purchase_token_protected: deletionToken,
          google_play_product_id_protected: deletionProductId,
        },
      },
    }] }), "utf8"));
    assert.match(legacyPrivacyTargetRecordId, /^record:[A-Za-z0-9._:-]+$/,
      "the deletion fixture must retain its synthetic purchase record from the prior lifecycle test");
    await queueGooglePlayProductVerification(pool, {
      tenantId,
      appId,
      subjectRecordId: legacyPrivacyTargetRecordId,
      tokenRef: deletionTokenRef,
      purchaseToken: deletionToken,
      productId: deletionProductId,
      requestedAt: new Date().toISOString(),
    });
    assert.match((await payloadStore.read(deletionTokenRef)).toString("utf8"), new RegExp(deletionToken));
    const secretRef = await withTenant(pool, tenantId, async (client) => (await client.query<{ secret_ref: string }>(
      `SELECT secret_ref FROM control.installation_credentials WHERE installation_key_id=$1`, [installationKeyId],
    )).rows[0].secret_ref);
    const response = await signed(SDK_INSTALLATION_PRIVACY_PATH, { installation_id: installationId }, { secret: installationSecret, installationKeyId });
    const responseText = await response.text();
    assert.equal(response.status, 201, responseText);
    const artifact = JSON.parse(responseText) as Record<string, unknown>;
    assert.equal(artifact.deletion_subject_ref, undefined);
    assert.match(String(artifact.requester_auth_ref), /^sdk_auth:/);
    const legacyPrivacyTombstones = await withTenant(pool, tenantId, async (client) => (await client.query<{ record_id: string }>(
      `SELECT record_id FROM ledger.privacy_tombstones
        WHERE tenant_id=$1 AND app_id=$2 AND privacy_request_id=$3
          AND record_id=ANY($4::text[])
        ORDER BY record_id`,
      [tenantId, appId, artifact.privacy_request_id,
        [legacyPrivacyTargetRecordId, legacyPrivacyRefundRecordId]],
    )).rows.map((row) => row.record_id));
    assert.deepEqual(legacyPrivacyTombstones,
      [legacyPrivacyTargetRecordId, legacyPrivacyRefundRecordId].sort(),
      "installation deletion must include a legacy correction-only refund and its anchored purchase target");
    for (const reference of legacyPrivacyPayloadRefs) {
      await assert.rejects(payloadStore.read(reference));
    }
    await assert.rejects(payloadStore.read(deletionTokenRef));
    assert.equal(await withTenant(pool, tenantId, async (client) => (await client.query(
      `SELECT 1 FROM ephemeral.google_play_product_verifications
        WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3`,
      [tenantId, appId, legacyPrivacyTargetRecordId],
    )).rowCount), 0);
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

  it("recovers idempotently when a payload purge succeeds before its queue acknowledgement", async () => {
    const crashInstallationId = `installation:privacy-crash-${run}`;
    const enrollment = await signed("/v1/installations", { installation_id: crashInstallationId });
    assert.equal(enrollment.status, 201);
    const credential = await enrollment.json() as {
      installation_key_id: string;
      installation_secret: string;
    };
    const eventId = `event:privacy-crash-${run}`;
    const batch = await signed("/v1/events/batch", { records: [sourceEvent(
      eventId,
      "session_start",
      { installation_id: crashInstallationId, session_id: `session:privacy-crash-${run}` },
    )] }, {
      secret: credential.installation_secret,
      installationKeyId: credential.installation_key_id,
    });
    assert.equal(batch.status, 202, await batch.text());
    await processSdkInbox(pool, payloadStore, tenantId);

    const secretRef = await withTenant(pool, tenantId, async (client) => (await client.query<{ secret_ref: string }>(
      "SELECT secret_ref FROM control.installation_credentials WHERE installation_key_id=$1",
      [credential.installation_key_id],
    )).rows[0].secret_ref);
    let injected = false;
    const purgeThenThrow: PayloadStore = {
      write: (scope, plaintext) => payloadStore.write(scope, plaintext),
      read: (reference) => payloadStore.read(reference),
      scanFor: (value) => payloadStore.scanFor(value),
      purge: async (reference) => {
        await payloadStore.purge(reference);
        if (!injected) {
          injected = true;
          throw new Error("synthetic_crash_after_payload_purge");
        }
      },
    };
    const processing = await executePrivacyRequest(pool, {
      tenantId,
      appId,
      actorType: "sdk_installation",
      actorRef: `sdk_installation:${credential.installation_key_id}`,
      requesterAuthRef: "sdk_auth:synthetic-crash-recovery",
      installationKeyId: credential.installation_key_id,
      deletionSubjectDigest: installationIdDigest(authConfig, crashInstallationId),
    }, {
      tenant_id: tenantId,
      app_id: appId,
      requested_via: "on_device_sdk",
      deletion_scope: "installation",
      deletion_subject_ref: crashInstallationId,
    }, purgeThenThrow);
    assert.equal(processing.status, "processing");
    assert.equal(processing.deletion_subject_ref, crashInstallationId);
    assert.equal(processing.deletion_subject_digest, undefined);

    const prepared = await withTenant(pool, tenantId, async (client) => ({
      jobStatus: (await client.query<{ status: string }>(
        "SELECT status FROM control.privacy_deletion_jobs WHERE privacy_request_id=$1",
        [processing.privacy_request_id],
      )).rows[0]?.status,
      credentialStatus: (await client.query<{ status: string }>(
        "SELECT status FROM control.installation_credentials_current WHERE installation_key_id=$1",
        [credential.installation_key_id],
      )).rows[0]?.status,
      completedRows: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.privacy_requests WHERE privacy_request_id=$1",
        [processing.privacy_request_id],
      )).rows[0].count),
      tombstones: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.privacy_tombstones WHERE privacy_request_id=$1",
        [processing.privacy_request_id],
      )).rows[0].count),
      references: (await client.query<{ payload_ref: string }>(
        "SELECT payload_ref FROM control.privacy_payload_purges WHERE privacy_request_id=$1 ORDER BY reference_digest",
        [processing.privacy_request_id],
      )).rows.map((row) => row.payload_ref),
    }));
    assert.equal(prepared.jobStatus, "processing");
    assert.equal(prepared.credentialStatus, "deleted");
    assert.equal(prepared.completedRows, 0, "completion must wait for every protected reference to become unreadable");
    assert.ok(prepared.tombstones >= 1, "the DB-first deletion boundary must remain fail closed");
    assert.ok(prepared.references.includes(secretRef));
    assert.ok((await listRuntimeWorkTenants(pool)).includes(tenantId),
      "the tenant discovery boundary must expose durable privacy work to the worker");
    assert.equal((await signed("/v1/events/batch", { records: [sourceEvent(
      `event:privacy-crash-rejected-${run}`,
      "session_start",
      { installation_id: crashInstallationId, session_id: `session:privacy-crash-rejected-${run}` },
    )] }, {
      secret: credential.installation_secret,
      installationKeyId: credential.installation_key_id,
    })).status, 401, "credential revocation must commit before physical purge retries");

    const recovered = await processPrivacyDeletionJobs({ pool, payloadStore, tenantId });
    assert.equal(recovered.completed, 1);
    assert.ok(recovered.payloadsPurged >= 1);
    for (const reference of prepared.references) await assert.rejects(payloadStore.read(reference));
    const completed = await withTenant(pool, tenantId, async (client) => ({
      jobs: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control.privacy_deletion_jobs WHERE privacy_request_id=$1 AND status='completed'",
        [processing.privacy_request_id],
      )).rows[0].count),
      artifacts: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.privacy_requests WHERE privacy_request_id=$1 AND status='completed'",
        [processing.privacy_request_id],
      )).rows[0].count),
      audits: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE action='privacy_delete' AND target_ref=$1",
        [processing.privacy_request_id],
      )).rows[0].count),
    }));
    assert.deepEqual(completed, { jobs: 1, artifacts: 1, audits: 1 });
    assert.deepEqual(await processPrivacyDeletionJobs({ pool, payloadStore, tenantId }), {
      jobs: 0,
      completed: 0,
      processing: 0,
      payloadsPurged: 0,
    });
  });

  it("serializes a verified SDK append against installation deletion recognition", async () => {
    const racedInstallationId = `installation:privacy-race-${run}`;
    const enrollment = await signed("/v1/installations", { installation_id: racedInstallationId });
    assert.equal(enrollment.status, 201);
    const credential = await enrollment.json() as {
      installation_key_id: string;
      installation_secret: string;
    };
    const subjectDigest = installationIdDigest(authConfig, racedInstallationId);
    let writeStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let racedReference: string | undefined;
    const blockingStore: PayloadStore = {
      read: (reference) => payloadStore.read(reference),
      purge: (reference) => payloadStore.purge(reference),
      scanFor: (value) => payloadStore.scanFor(value),
      write: async (scope, plaintext) => {
        const reference = await payloadStore.write(scope, plaintext);
        if (scope.objectId.startsWith("ingest-batch-")) {
          racedReference = reference;
          writeStarted();
          await released;
        }
        return reference;
      },
    };
    const append = appendDurableBatch(pool, blockingStore, {
      tenantId,
      appId,
      producer: "sdk-android",
      body: Buffer.from(JSON.stringify({ records: [sourceEvent(
        `event:privacy-race-${run}`,
        "session_start",
        { installation_id: racedInstallationId, session_id: `session:privacy-race-${run}` },
      )] }), "utf8"),
      eventCount: 1,
      receivedAt: new Date().toISOString(),
      sdkKeyId,
      installationKeyId: credential.installation_key_id,
      subjectDigest,
    });
    await started;
    try {
      const deletion = await executePrivacyRequest(pool, {
        tenantId,
        appId,
        actorType: "sdk_installation",
        actorRef: `sdk_installation:${credential.installation_key_id}`,
        requesterAuthRef: "sdk_auth:synthetic-race",
        installationKeyId: credential.installation_key_id,
        deletionSubjectDigest: subjectDigest,
      }, {
        tenant_id: tenantId,
        app_id: appId,
        requested_via: "on_device_sdk",
        deletion_scope: "installation",
        deletion_subject_ref: racedInstallationId,
      }, payloadStore);
      assert.equal(deletion.status, "completed");
    } finally {
      releaseWrite();
    }
    await assert.rejects(append, /privacy_subject_inactive|installation_credential_inactive/);
    assert.ok(racedReference);
    await assert.rejects(payloadStore.read(racedReference));
    assert.equal(await withTenant(pool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger.ingest_batches WHERE body_ref=$1",
      [racedReference],
    )).rows[0].count)), 0, "the post-recognition batch must never enter the durable inbox");
  });
});
