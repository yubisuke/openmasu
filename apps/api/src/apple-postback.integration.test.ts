import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
} from "@openmasu/runtime";
import { processSdkInbox } from "../../worker/src/sdk-worker.js";
import { registerAppleApp, canonicalConversionSchema } from "./apple-admin.js";
import { ensureAdminKeys } from "./admin-auth.js";
import { HourlyLedgerQuota } from "./apple-postback-receiver.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";
import type { ApplePostbackReport } from "./apple-postback-reporting.js";
import { renderApplePostbackReport } from "./dashboard/apple-postback-report.js";

const run = randomBytes(6).toString("hex");
const tenantA = `tenant-m4-a-${run}`;
const tenantB = `tenant-m4-b-${run}`;
const appA = `app-m4-a-${run}`;
const appB = `app-m4-b-${run}`;
const adamA = 410_000_000 + Number.parseInt(run.slice(0, 5), 16) % 10_000_000;
const adamUnknown = adamA + 20_000_000;
const adminSecret = `m4-admin-${randomBytes(32).toString("base64url")}`;
const readerSecret = `m4-reader-${randomBytes(32).toString("base64url")}`;
const fixedNow = new Date("2026-08-20T12:00:00.000Z");
let currentNow = fixedNow;
const root = mkdtempSync(join(tmpdir(), "openmasu-m4-postback-"));
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
  readonly didWin?: boolean;
  readonly redownload?: boolean;
  readonly fine?: number;
  readonly coarse?: string;
} = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    version: "4.0",
    "ad-network-id": "synthetic.m4.skadnetwork",
    "source-identifier": input.sourceIdentifier ?? "4321",
    "app-id": input.adamId ?? adamA,
    "transaction-id": input.transactionId ?? `00000000-0000-4000-8000-${run.padEnd(12, "0").slice(0, 12)}`,
    redownload: input.redownload ?? false,
    "source-app-id": 123456789,
    "fidelity-type": 1,
    "did-win": input.didWin ?? true,
    "postback-sequence-index": input.sequence ?? 0,
    "country-code": "US",
  };
  if (input.fine !== undefined) body["conversion-value"] = input.fine;
  if (input.coarse !== undefined) body["coarse-conversion-value"] = input.coarse;
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

function aakBody(input: {
  readonly conversionType?: "download" | "redownload" | "re-engagement";
  readonly didWin?: boolean;
  readonly interactionType?: "view" | "click";
  readonly identifierSuffix?: string;
  readonly sequence?: number;
  readonly sourceIdentifier?: string | null;
  readonly fine?: number | null;
  readonly coarse?: string;
} = {}): Record<string, unknown> {
  const header = encodeJson({ alg: "ES256", kid: "apple-cas-identifier/0" });
  const claims = encodeJson({
    "postback-identifier": `00000000-0000-4000-${input.identifierSuffix ?? "9000"}-${run.padEnd(12, "1").slice(0, 12)}`,
    "impression-type": "app-impression",
    "ad-network-identifier": "synthetic.m4.adattributionkit",
    "advertised-item-identifier": adamA,
    "conversion-type": input.conversionType ?? "download",
    "did-win": input.didWin ?? true,
    "postback-sequence-index": input.sequence ?? 0,
    ...(input.sourceIdentifier === null ? {} : { "source-identifier": input.sourceIdentifier ?? "4321" }),
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`, "ascii"), {
    key: signingPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    "jws-string": `${header}.${claims}.${signature}`,
    ...(input.fine === null ? {} : { "conversion-value": input.fine ?? 7 }),
    ...(input.coarse ? { "coarse-conversion-value": input.coarse } : {}),
    "ad-interaction-type": input.interactionType ?? "click",
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
    await ensureAdminKeys(pool, { tenantId: tenantA, appId: appA }, [adminSecret, { key: readerSecret, role: "read_only" }]);
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
      dashboard: { enabled: true, publicBaseUrl: "http://localhost:8080", tenantId: tenantA, sessionTtlSeconds: 43_200 },
      applePostback: {
        pool,
        payloadStore,
        maximumBytes: 16 * 1024,
        acceptDevelopmentPostbacks: false,
        sourceBucket: new KeyedTokenBucket(10_000, 10_000),
        appBucket: new KeyedTokenBucket(10_000, 10_000),
        invalidLedgerQuota: quota,
        now: () => currentNow,
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
      body: JSON.stringify({ apple_app_adam_id: adamA, apple_bundle_id: "dev.openmasu.synthetic" }),
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

  it("accepts current re-engagement postbacks and rejects non-click or non-winning variants", async () => {
    const accepted = await post("/.well-known/appattribution/report-attribution/", aakBody({
      conversionType: "re-engagement",
      identifierSuffix: "9001",
    }));
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.bytes.length, 0);

    const beforeRejected = await scopedCount("ledger.ingest_batches");
    assert.equal((await post("/.well-known/appattribution/report-attribution/", aakBody({
      conversionType: "re-engagement",
      interactionType: "view",
      identifierSuffix: "9002",
    }))).response.status, 400);
    assert.equal((await post("/.well-known/appattribution/report-attribution/", aakBody({
      conversionType: "re-engagement",
      didWin: false,
      identifierSuffix: "9003",
    }))).response.status, 400);
    assert.equal(await scopedCount("ledger.ingest_batches"), beforeRejected);

    await processSdkInbox(pool, payloadStore, tenantA);
    const facts = await withTenant(pool, tenantA, (client) => client.query<{ conversion_type: string }>(
      `SELECT conversion_type FROM ledger.apple_postback_facts
       WHERE tenant_id=$1 AND app_id=$2 AND conversion_type='re-engagement'`,
      [tenantA, appA],
    ));
    assert.deepEqual(facts.rows, [{ conversion_type: "re-engagement" }]);
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

    currentNow = new Date(fixedNow.getTime() + 1);
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

  it("reports independent Apple windows, unsigned values, retries, quota failures and current privacy through the reader API and SSR", async () => {
    currentNow = new Date("2026-08-22T12:00:00.000Z");
    const skanPath = "/.well-known/skadnetwork/report-attribution/", aakPath = "/.well-known/appattribution/report-attribution/";
    const firstId = "00000000-0000-4000-8100-000000000000";
    const first = skanBody({ transactionId: firstId, fine: 0, sourceIdentifier: "12" });
    const bodies = [first,
      skanBody({ transactionId: "00000000-0000-4000-8100-000000000001", sequence: 1, coarse: "low", sourceIdentifier: "123", redownload: true }),
      skanBody({ transactionId: "00000000-0000-4000-8100-000000000002", sequence: 2 }),
      skanBody({ transactionId: "00000000-0000-4000-8100-000000000003", didWin: false })];
    for (const body of bodies) assert.equal((await post(skanPath, body)).response.status, 200);
    for (const body of [aakBody({ identifierSuffix: "9100", sourceIdentifier: null, fine: null }),
      aakBody({ identifierSuffix: "9101", conversionType: "redownload", sequence: 1, fine: null, coarse: "medium" }),
      aakBody({ identifierSuffix: "9102", conversionType: "re-engagement", sequence: 2, fine: null, coarse: "high" })]) {
      assert.equal((await post(aakPath, body)).response.status, 200);
    }
    for (let index = 0; index < 4; index++) assert.equal((await post(skanPath, skanBody({
      transactionId: `00000000-0000-4000-8101-${String(index).padStart(12, "0")}`, privateKey: forgedPair.privateKey,
    }))).response.status, 200);
    for (let index = 0; index < 2; index++) assert.equal((await post(skanPath, first)).response.status, 200);
    await processSdkInbox(pool, payloadStore, tenantA);
    currentNow = new Date("2026-08-22T12:00:00.001Z");
    assert.equal((await post(skanPath, skanBody({ transactionId: firstId, fine: 0, sourceIdentifier: "34" }))).response.status, 200);
    await processSdkInbox(pool, payloadStore, tenantA);
    assert.equal((await post(skanPath, skanBody({ transactionId: "00000000-0000-4000-8102-000000000000" }))).response.status, 200);
    assert.equal((await post(skanPath, {})).response.status, 400);

    const selection = { date_from: "2026-08-22", date_to: "2026-08-23", watermark_at_most: "2026-08-22T23:59:59.999999Z" };
    const endpoint = `${baseUrl}/v1/admin/apps/${appA}/apple-postbacks`;
    const headers = { authorization: `Bearer ${readerSecret}` };
    const read = async (values = selection): Promise<ApplePostbackReport> => {
      const response = await fetch(`${endpoint}?${new URLSearchParams(values)}`, { headers });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
      return body as ApplePostbackReport;
    };
    const report = await read(), total = (rows: { count: string }[]) => rows.reduce((sum, row) => sum + Number(row.count), 0);
    assert.equal(total(report.observations), 10); assert.equal(total(report.receipts), 14);
    assert.equal(total(report.deliveries), 13); assert.equal(total(report.quota_rejections), 1);
    const states = (rows: { state: string; count: string }[]) => Object.fromEntries([...new Set(rows.map(row => row.state))].sort().map(state => [state, total(rows.filter(row => row.state === state))]));
    assert.deepEqual(states(report.receipts), { pending: 1, processed: 13 });
    assert.deepEqual(states(report.deliveries), { accepted_unique: 10, duplicate_delivery: 2, event_id_conflict: 1 });
    assert.deepEqual(report.quota_rejections, [{ receipt_date: "2026-08-22", platform: "skadnetwork", reason: "signature_invalid", count: "1" }]);
    const observed = report.observations.map(row => [row.platform, row.verification, row.sequence, row.winner, row.conversion_type,
      row.source_state, row.conversion_value_state, row.conversion_value_coverage, row.verification_reason, row.count].join("|")).sort();
    assert.deepEqual(observed, [
      "skadnetwork|verified|0|winner|download|digits_2|fine|unsigned|verified|1",
      "skadnetwork|verified|1|winner|redownload|digits_3|coarse_low|unsigned|verified|1",
      "skadnetwork|verified|2|winner|download|digits_4|absent|not_applicable|verified|1",
      "skadnetwork|verified|0|nonwinner|download|digits_4|absent|not_applicable|verified|1",
      "skadnetwork|failed|0|winner|download|digits_4|absent|not_applicable|signature_invalid|3",
      "adattributionkit|verified|0|winner|download|absent|absent|not_applicable|verified|1",
      "adattributionkit|verified|1|winner|redownload|digits_4|coarse_medium|unsigned|verified|1",
      "adattributionkit|verified|2|winner|re-engagement|digits_4|coarse_high|unsigned|verified|1",
    ].sort());
    assert.equal(report.conversion_schema, "not_recorded", "the app's registered schema is not postback-bound evidence");
    assert.doesNotMatch(JSON.stringify(report), /transaction_id|postback_identifier|record_id|signature\"|4321|synthetic\.m4/);
    const earlier = await read({ ...selection, watermark_at_most: "2026-08-22T11:59:59.999999Z" });
    assert.deepEqual([earlier.observations, earlier.receipts, earlier.deliveries, earlier.quota_rejections], [[], [], [], []]);
    assert.equal((await fetch(`${baseUrl}/v1/admin/apps/${appB}/apple-postbacks?${new URLSearchParams(selection)}`, { headers })).status, 404);
    assert.equal((await fetch(`${endpoint}?${new URLSearchParams(selection)}&source_identifier=12`, { headers })).status, 400);
    const login = await fetch(`${baseUrl}/dashboard/session`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ admin_key: readerSecret }) });
    assert.equal(login.status, 303); const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const page = await fetch(`${baseUrl}/dashboard/apps/${appA}/apple-postbacks?${new URLSearchParams(selection)}`, { headers: { cookie } });
    assert.equal(page.status, 200); assert.equal(await page.text(), renderApplePostbackReport(appA, report));
    assert.equal((await fetch(`${endpoint}?${new URLSearchParams(selection)}`, { headers: { cookie } })).status, 401);
    assert.match(await (await fetch(`${baseUrl}/dashboard/apps/${appA}/apple-postbacks`, { headers })).text(), /Admin key/);

    // The same received evidence can have incompatible declared meanings. Never choose one implicitly.
    const { definition } = JSON.parse(readFileSync("sdk/ios/Tests/OpenMasuApplePostbackTests/Vectors/meaning.json", "utf8"));
    const register = async (definition: Record<string, unknown>, secret = adminSecret) => fetch(`${baseUrl}/v1/admin/apps/${appA}/conversion-schemas`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ schema_version: definition.schema_version, definition }),
    });
    assert.equal((await register(definition, readerSecret)).status, 403);
    const registration = await register(definition); assert.equal(registration.status, 201);
    const registered = await registration.json() as { schema_digest: string; canonical_definition: string };
    assert.equal(registered.schema_digest, "1f1d34137531516b47d84f489342966738e4a50d18110e9d3ced2dfc5202b5e0");
    assert.equal(registered.canonical_definition, canonicalConversionSchema(definition));
    assert.equal((await register(definition)).status, 409);
    assert.equal((await register({ ...definition, schema_version: "2.0.1", event_keys: ["tutorial_complete", "purchase"] })).status, 201);
    assert.equal((await read()).schema_resolution?.reason, "ambiguous_schema");
    const selectedQuery = new URLSearchParams({ ...selection, schema_version: "2.0.0", schema_digest: registered.schema_digest });
    const explainedResponse = await fetch(`${endpoint}?${selectedQuery}`, { headers }); assert.equal(explainedResponse.status, 200);
    const explained = await explainedResponse.json() as ApplePostbackReport;
    assert.equal(explained.conversion_schema, "not_recorded");
    assert.equal(explained.schema_resolution?.reason, "operator_selected_definition_not_postback_bound");
    assert.equal(explained.schema_resolution?.candidates.length, 3);
    const fine = explained.observations.find(row => row.conversion_bucket === "fine:0")!;
    assert.deepEqual(fine.meaning?.possible_meanings, [{ fine_value: 0, event_keys_observed: [],
      revenue_range: { lower_inclusive: "0", upper_exclusive: "100", currency: "USD", amount_scale: 2 } }]);
    const medium = explained.observations.find(row => row.conversion_bucket === "coarse:medium")!;
    assert.deepEqual(medium.meaning?.possible_meanings?.map(row => row.fine_value), [6, 7]);
    assert.ok(explained.observations.every(row => row.meaning?.state === "unverified"));
    assert.equal(explained.observations.find(row => row.conversion_type === "re-engagement")?.meaning?.reason, "unsupported_window_or_type");
    assert.equal(explained.observations.find(row => row.verification === "failed")?.meaning?.reason, "verification_failed");
    const explainedPage = await fetch(`${baseUrl}/dashboard/apps/${appA}/apple-postbacks?${selectedQuery}`, { headers: { cookie } });
    assert.equal(explainedPage.status, 200); assert.equal(await explainedPage.text(), renderApplePostbackReport(appA, explained));
    selectedQuery.set("schema_digest", "0".repeat(64));
    assert.equal((await fetch(`${endpoint}?${selectedQuery}`, { headers })).status, 404);
    const legacy = await withTenant(pool, tenantA, client => client.query<{ schema_digest: string }>(
      "SELECT schema_digest FROM control.conversion_schemas WHERE tenant_id=$1 AND app_id=$2 AND schema_version='1.0.0'", [tenantA, appA]));
    selectedQuery.set("schema_version", "1.0.0"); selectedQuery.set("schema_digest", legacy.rows[0].schema_digest);
    const old = await (await fetch(`${endpoint}?${selectedQuery}`, { headers })).json() as ApplePostbackReport;
    assert.equal(old.schema_resolution?.reason, "legacy_definition_unsupported");

    await withTenant(pool, tenantA, client => client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id,privacy_tombstone_id)
      SELECT tenant_id,app_id,record_id,'redacted','2026-08-23T00:00:00.000Z',$4,$5 FROM ledger.raw_records
      WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`, [tenantA, appA, `skan:${firstId}`, `privacy-apple-${run}`, `tombstone-apple-${run}`]));
    const redacted = await read();
    assert.deepEqual([total(redacted.observations), total(redacted.receipts), total(redacted.deliveries)], [9, 10, 9]);
    await withTenant(pool, tenantA, client => client.query(`INSERT INTO ledger.privacy_requests
      (privacy_request_id,tenant_id,app_id,requested_at,completed_at,status,artifact)
      VALUES ($1,$2,$3,'2026-08-23T00:00:00.000Z','2026-08-23T00:00:01.000Z','completed','{"deletion_scope":"app"}'::jsonb)`,
    [`privacy-apple-app-${run}`, tenantA, appA]));
    const deleted = await read();
    assert.deepEqual([deleted.observations, deleted.receipts, deleted.deliveries, deleted.quota_rejections], [[], [], [], []], "current deletion applies even at a pre-deletion cutoff");
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
