import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import {
  createAppPool,
  createMigrationPool,
  createReaderPool,
  EncryptedFilePayloadStore,
  withTenant,
} from "@open-mmp/runtime";
import { processSdkInbox } from "../../worker/src/sdk-worker.js";
import { registerAppleApp } from "./apple-admin.js";
import { ensureAdminKeys } from "./admin-auth.js";
import { HourlyLedgerQuota } from "./apple-postback-receiver.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";

const run = randomBytes(6).toString("hex");
const tenantA = `tenant-m4-a-${run}`;
const tenantB = `tenant-m4-b-${run}`;
const appA = `app-m4-a-${run}`;
const appB = `app-m4-b-${run}`;
const adamA = 410_000_000 + Number.parseInt(run.slice(0, 5), 16) % 10_000_000;
const adamUnknown = adamA + 20_000_000;
const adminSecret = `m4-admin-${randomBytes(32).toString("base64url")}`;
const fixedNow = new Date("2026-08-20T12:00:00.000Z");
const root = mkdtempSync(join(tmpdir(), "open-mmp-m4-postback-"));
const pool = createAppPool();
const readerPool = createReaderPool();
const ownerPool = createMigrationPool();
const payloadStore = new EncryptedFilePayloadStore(root, `m4-master-${randomBytes(32).toString("base64url")}`);
const quota = new HourlyLedgerQuota(3);
let server: ReturnType<typeof createServer>;
let baseUrl = "";

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    ...pair,
    publicKeyBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const signingPair = keyPair();
const forgedPair = keyPair();

function skanMessage(body: Record<string, unknown>): string {
  return [
    body.version,
    body["ad-network-id"],
    body["source-identifier"],
    body["app-id"],
    body["transaction-id"],
    String(body.redownload),
    body["source-app-id"],
    body["fidelity-type"],
    String(body["did-win"]),
    body["postback-sequence-index"],
  ].join("\u2063");
}

function skanBody(input: {
  readonly adamId?: number;
  readonly transactionId?: string;
  readonly sequence?: number;
  readonly sourceIdentifier?: string;
  readonly privateKey?: typeof signingPair.privateKey;
} = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    version: "4.0",
    "ad-network-id": "synthetic.m4.skadnetwork",
    "source-identifier": input.sourceIdentifier ?? "4321",
    "app-id": input.adamId ?? adamA,
    "transaction-id": input.transactionId ?? `00000000-0000-4000-8000-${run.padEnd(12, "0").slice(0, 12)}`,
    redownload: false,
    "source-app-id": 123456789,
    "fidelity-type": 1,
    "did-win": true,
    "postback-sequence-index": input.sequence ?? 0,
    "country-code": "US",
  };
  body["attribution-signature"] = sign(
    "sha256",
    Buffer.from(skanMessage(body), "utf8"),
    input.privateKey ?? signingPair.privateKey,
  ).toString("base64");
  return body;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function aakBody(): Record<string, unknown> {
  const header = encodeJson({ alg: "ES256", kid: "apple-cas-identifier/0" });
  const claims = encodeJson({
    "postback-identifier": `00000000-0000-4000-9000-${run.padEnd(12, "1").slice(0, 12)}`,
    "impression-type": "app-impression",
    "ad-network-identifier": "synthetic.m4.adattributionkit",
    "advertised-item-identifier": adamA,
    "conversion-type": "download",
    "did-win": true,
    "postback-sequence-index": 0,
    "source-identifier": "4321",
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`, "ascii"), {
    key: signingPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    "jws-string": `${header}.${claims}.${signature}`,
    "conversion-value": 7,
    "ad-interaction-type": "click",
    "country-code": "US",
  };
}

async function post(path: string, body: unknown): Promise<{ response: Response; bytes: Buffer }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body instanceof Buffer ? body : JSON.stringify(body),
  });
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function scopedCount(table: string): Promise<number> {
  return withTenant(pool, tenantA, async (client) => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1 AND app_id=$2`,
    [tenantA, appA],
  )).rows[0].count);
}

describe("M4 Apple aggregate postback receiver", () => {
  before(async () => {
    await ensureAdminKeys(pool, { tenantId: tenantA, appId: appA }, [adminSecret]);
    await withTenant(pool, tenantB, (client) => client.query(
      "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [tenantB, appB, fixedNow.toISOString()],
    ).then(() => undefined));
    server = createServer(createRequestHandler({
      pool,
      readerPool,
      payloadStore,
      maxConfig: {
        tenantId: tenantA,
        appId: appA,
        pathSecret: "synthetic-m4-path",
        eventKey: "synthetic-m4-event-key",
        tokenMode: "all_with_event_fallback",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId: tenantA, sessionTtlSeconds: 43_200 },
      applePostback: {
        pool,
        payloadStore,
        maximumBytes: 16 * 1024,
        acceptDevelopmentPostbacks: false,
        sourceBucket: new KeyedTokenBucket(10_000, 10_000),
        appBucket: new KeyedTokenBucket(10_000, 10_000),
        invalidLedgerQuota: quota,
        now: () => fixedNow,
        verificationKeys: {
          skanPublicKeyBase64: signingPair.publicKeyBase64,
          aakKeySet: { "apple-cas-identifier/0": signingPair.publicKeyBase64 },
        },
      },
    }));
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await new Promise<void>((resolve) => server.once("close", () => resolve()));
    await pool.end();
    await readerPool.end();
    await ownerPool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("A04 registers a unique ADAM ID and keeps unregistered responses non-enumerable", async () => {
    const registration = await fetch(`${baseUrl}/v1/admin/apps/${appA}/apple-registration`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ apple_app_adam_id: adamA, apple_bundle_id: "dev.openmmp.synthetic" }),
    });
    assert.equal(registration.status, 201);
    assert.equal((await registration.json() as { apple_app_adam_id: string }).apple_app_adam_id, String(adamA));

    await assert.rejects(
      () => registerAppleApp({
        pool,
        identity: { keyId: "synthetic-admin-b", tenantId: tenantB, appId: appB, role: "admin" },
        appleAppAdamId: adamA,
        now: fixedNow,
      }),
      /apple_app_adam_id_already_registered/,
    );
    const resolved = await pool.query<{ tenant_id: string; app_id: string }>(
      "SELECT tenant_id, app_id FROM control.resolve_apple_app_adam_id($1::bigint)",
      [String(adamA)],
    );
    assert.deepEqual(resolved.rows, [{ tenant_id: tenantA, app_id: appA }]);

    const registered = await post("/.well-known/skadnetwork/report-attribution/", skanBody());
    const unregistered = await post("/.well-known/skadnetwork/report-attribution/", skanBody({
      adamId: adamUnknown,
      transactionId: "00000000-0000-4000-8000-000000009999",
    }));
    assert.equal(registered.response.status, 200);
    assert.equal(unregistered.response.status, 200);
    assert.deepEqual(registered.bytes, unregistered.bytes);
    assert.equal(registered.response.headers.get("content-length"), "0");
    assert.equal(await scopedCount("ledger.ingest_batches"), 1);

    const audits = await ownerPool.query<{ row_text: string }>(
      "SELECT row_to_json(audit)::text AS row_text FROM control.public_postback_audits AS audit WHERE reason_code='apple_app_not_registered' ORDER BY occurred_at DESC LIMIT 1",
    );
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].row_text.includes(String(adamUnknown)), false, "raw unregistered ADAM ID leaked into audit");
    await assert.rejects(
      () => pool.query("SELECT * FROM control.public_postback_audits"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "42501",
    );
    await assert.rejects(
      () => readerPool.query("SELECT * FROM control.public_postback_audits"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "42501",
    );
  });

  it("registers a deterministic conversion schema through the tenant admin route", async () => {
    const response = await fetch(`${baseUrl}/v1/admin/apps/${appA}/conversion-schemas`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0.0",
        definition: { rules: [{ fine: 1, coarse: "low" }], enabled: true },
      }),
    });
    assert.equal(response.status, 201);
    const value = await response.json() as { schema_digest: string; status: string };
    assert.match(value.schema_digest, /^[a-f0-9]{64}$/);
    assert.equal(value.status, "active");
  });

  it("A06 accepts both Apple routes and rejects malformed transport without a ledger write", async () => {
    const aak = await post("/.well-known/appattribution/report-attribution/", aakBody());
    assert.equal(aak.response.status, 200);
    assert.equal(aak.bytes.length, 0);
    const before = await scopedCount("ledger.ingest_batches");
    assert.equal((await post("/.well-known/appattribution/report-attribution/", {})).response.status, 400);
    assert.equal((await post("/.well-known/skadnetwork/report-attribution/", Buffer.from("{", "utf8"))).response.status, 400);
    assert.equal((await post("/.well-known/skadnetwork/report-attribution/", Buffer.alloc(17 * 1024, 65))).response.status, 400);
    assert.equal(await scopedCount("ledger.ingest_batches"), before);
  });

  it("A07 bounds invalid-signature ledger amplification and retains an audit counter", async () => {
    const before = await scopedCount("ledger.ingest_batches");
    const auditBefore = await scopedCount("ledger.audit_logs");
    for (let index = 0; index < 100; index += 1) {
      const suffix = index.toString().padStart(12, "0");
      const result = await post("/.well-known/skadnetwork/report-attribution/", skanBody({
        transactionId: `00000000-0000-4000-8001-${suffix}`,
        privateKey: forgedPair.privateKey,
      }));
      assert.equal(result.response.status, 200);
      assert.equal(result.bytes.length, 0);
    }
    assert.equal(await scopedCount("ledger.ingest_batches"), before + 3);
    assert.equal(await scopedCount("ledger.audit_logs"), auditBefore + 97);
    assert.equal(quota.count(tenantA, appA, fixedNow), 100);
    const finalCounter = await withTenant(pool, tenantA, (client) => client.query<{ target_ref: string }>(
      `SELECT target_ref FROM ledger.audit_logs
       WHERE tenant_id=$1 AND app_id=$2 AND action='apple_postback_invalid'
         AND target_ref='postback:skadnetwork:invalid:100'`,
      [tenantA, appA],
    ));
    assert.deepEqual(finalCounter.rows, [{ target_ref: "postback:skadnetwork:invalid:100" }]);
  });

  it("A05 uses permanent event idempotency for retries, windows, and conflicts", async () => {
    const retryTransactionId = `00000000-0000-4000-8003-${run.padEnd(12, "3").slice(0, 12)}`;
    const retryBody = skanBody({ transactionId: retryTransactionId });
    for (let index = 0; index < 9; index += 1) {
      assert.equal((await post("/.well-known/skadnetwork/report-attribution/", retryBody)).response.status, 200);
    }
    for (let sequence = 0; sequence < 3; sequence += 1) {
      assert.equal((await post("/.well-known/skadnetwork/report-attribution/", skanBody({
        transactionId: `00000000-0000-4000-8002-${String(sequence).padStart(12, "0")}`,
        sequence,
      }))).response.status, 200);
    }
    await processSdkInbox(pool, payloadStore, tenantA);
    const eventId = `skan:${retryTransactionId}`;
    const deliveries = await withTenant(pool, tenantA, (client) => client.query<{
      duplicate_resolution: string;
      count: number;
    }>(
      `SELECT delivery.duplicate_resolution, count(*)::int AS count
       FROM ledger.event_deliveries AS delivery
       JOIN ledger.raw_records AS raw
         ON raw.tenant_id=delivery.tenant_id AND raw.app_id=delivery.app_id
        AND raw.record_id=delivery.canonical_record_id
       WHERE delivery.tenant_id=$1 AND delivery.app_id=$2 AND raw.event_id=$3
       GROUP BY delivery.duplicate_resolution ORDER BY delivery.duplicate_resolution`,
      [tenantA, appA, eventId],
    ));
    assert.deepEqual(deliveries.rows, [
      { duplicate_resolution: "duplicate_delivery", count: 8 },
      { duplicate_resolution: "unique", count: 1 },
    ]);
    const windowEvents = await withTenant(pool, tenantA, (client) => client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.logical_events
       WHERE tenant_id=$1 AND app_id=$2 AND event_id LIKE 'skan:00000000-0000-4000-8002-%'`,
      [tenantA, appA],
    ));
    assert.equal(windowEvents.rows[0].count, 3);

    const changed = skanBody({ transactionId: retryTransactionId, sourceIdentifier: "1234" });
    assert.equal((await post("/.well-known/skadnetwork/report-attribution/", changed)).response.status, 200);
    await processSdkInbox(pool, payloadStore, tenantA);
    const conflicts = await withTenant(pool, tenantA, (client) => client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.rejections
       WHERE tenant_id=$1 AND app_id=$2 AND reason_code='event_id_conflict'`,
      [tenantA, appA],
    ));
    assert.equal(conflicts.rows[0].count, 1);
  });

  it("A06 returns 500 when the durable database path fails", async () => {
    const failingPool = {
      query: async () => { throw new Error("synthetic_database_failure"); },
    } as unknown as Pool;
    const failingServer = createServer(createRequestHandler({
      pool,
      readerPool,
      payloadStore,
      maxConfig: {
        tenantId: tenantA,
        appId: appA,
        pathSecret: "synthetic-m4-failure",
        eventKey: "synthetic-m4-failure-key",
        tokenMode: "all_with_event_fallback",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId: tenantA, sessionTtlSeconds: 43_200 },
      applePostback: {
        pool: failingPool,
        payloadStore,
        maximumBytes: 16 * 1024,
        acceptDevelopmentPostbacks: false,
        sourceBucket: new KeyedTokenBucket(10, 10),
        appBucket: new KeyedTokenBucket(10, 10),
        invalidLedgerQuota: new HourlyLedgerQuota(3),
        verificationKeys: { skanPublicKeyBase64: signingPair.publicKeyBase64 },
      },
    }));
    failingServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => failingServer.once("listening", () => resolve()));
    const failureUrl = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;
    const response = await fetch(`${failureUrl}/.well-known/skadnetwork/report-attribution/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(skanBody()),
    });
    assert.equal(response.status, 500);
    failingServer.close();
    await new Promise<void>((resolve) => failingServer.once("close", () => resolve()));
  });
});
