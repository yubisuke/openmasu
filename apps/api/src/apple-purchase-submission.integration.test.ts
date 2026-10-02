import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { createAppPool, createReaderPool, createSeedPool, EncryptedFilePayloadStore, PayloadNotFoundError, withTenant, type PayloadStore } from "@openmasu/runtime";
import { sha256, verifyCompactJws } from "@openmasu/commerce-lifecycle";
import { jcs } from "@openmasu/attribution-core";
import { ensureSdkKeys, issueInstallationCredential, signSdkRequest } from "./sdk-auth.js";
import { registerAppleApp } from "./apple-admin.js";
import { createRequestHandler } from "./router.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { executePrivacyRequest, privacySubjectDigest, type PrivacyRequestBody } from "./privacy.js";
import type { SdkRouteDependencies } from "./sdk-routes.js";
import { processCommerceReadbacks } from "../../worker/src/commerce-readback-worker.js";
import { ingestFixture } from "../../worker/src/ingestion.js";
import { computeSqlMetricRuns } from "../../worker/src/metrics/cohort.js";
import { requestMetricRecalculation } from "./metric-recalculations.js";
import { processMetricRecalculations } from "../../worker/src/metric-recalculation-worker.js";
import { reapplyCompletedPrivacyRequests } from "../../worker/src/privacy-reapply.js";

type Any = Record<string, any>;
const pool = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
after(async () => { await pool.end(); await reader.end(); await seed.end(); });
const pair = generateKeyPairSync("ec",{ namedCurve: "P-256" });
const verifier = (compact: string) => verifyCompactJws(compact,pair.publicKey);
function signed(value: Any) {
  const body = `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  return `${body}.${sign("sha256",Buffer.from(body),{ key: pair.privateKey,dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
async function harness(t: TestContext, cohort = false) {
  const tag = randomBytes(6).toString("hex"), tenantId = `tenant-apple-${tag}`, appId = `app-apple-${tag}`;
  const installationId = `installation:${tag}`, bundleId = `dev.openmasu.synthetic.${tag}`;
  const root = mkdtempSync(join(tmpdir(),"openmasu-apple-projection-"));
  const store = new EncryptedFilePayloadStore(join(root,"payloads"),`synthetic-master-${tag}-0000000000000000`);
  let measurement: Any | undefined, old: Any[] = [];
  if (cohort) {
    measurement = JSON.parse(readFileSync("fixtures/v0.4/60-selected-commerce/input.json","utf8")
      .replaceAll('"tenant-a"',JSON.stringify(tenantId)).replaceAll('"app-a"',JSON.stringify(appId))
      .replaceAll('"installation:install-1"',JSON.stringify(installationId)));
    measurement!.records = measurement!.records.filter((record: Any) => !["purchase","refund"].includes(record.event_name));
    measurement!.metric_evaluations[0].privacy_state = "after";
    await ingestFixture(`synthetic-apple-${tag}`,{ ...measurement,metric_evaluations: [] },pool,seed);
    old = await computeSqlMetricRuns(pool,measurement!,true);
  }
  const config = { tenantId,appId,installationDigestKey: `synthetic-digest-${tag}`,timestampSkewMs: 300_000,nonceTtlMs: 900_000 };
  const keyId = `sdk:${tag}`;
  await ensureSdkKeys(pool,store,config,[{ keyId,secret: `synthetic-sdk-${tag}-00000000000000000000`,platform: "ios" }]);
  const credential = await issueInstallationCredential({ pool,payloadStore: store,config,sdkKeyId: keyId,installationId });
  await registerAppleApp({ pool,identity: { tenantId,appId,keyId: "synthetic-admin",role: "admin" },appleBundleId: bundleId,
    appleAppAdamId: String(9_000_000_000 + Number.parseInt(tag,16)) });
  const dependencies: SdkRouteDependencies = { pool,payloadStore: store,config,applePurchaseEnvironment: "Sandbox",applePurchaseVerifier: verifier,
    maximumBytes: 262144,maximumEvents: 100,enrollmentBucket: new KeyedTokenBucket(100,100),installationBucket: new KeyedTokenBucket(100,100),
    appBucket: new KeyedTokenBucket(100,100),privacyBucket: new KeyedTokenBucket(100,100) };
  const server = createServer(createRequestHandler({ pool,readerPool: reader,payloadStore: store,sdk: dependencies,
    appleStoreNotifications: { pool,payloadStore: store,trustedRootFingerprints: new Set(),maximumBytes: 262144,verifySignedData: verifier },
    dashboard: { enabled: false,publicBaseUrl: "http://localhost:8080",tenantId,sessionTtlSeconds: 3600 },
    maxConfig: { tenantId,appId,pathSecret: "synthetic",eventKey: "synthetic",tokenMode: "all",maxParameters: 40,maxQueryBytes: 8192 },
    publicBaseUrl: "http://localhost:8080",redirectorBaseUrl: "http://localhost:8090" }));
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); rmSync(root,{ recursive: true,force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function post(path: string, value: Any) {
    const body = Buffer.from(JSON.stringify(value)),timestampMs = Date.now(),nonce = randomUUID();
    const signature = signSdkRequest(credential.installation_secret,{ method: "POST",path,sdkKeyId: keyId,
      installationKeyId: credential.installation_key_id,timestampMs,nonce,body });
    return fetch(`${base}${path}`,{ method: "POST",headers: { "content-type": "application/json","x-openmasu-sdk-key-id": keyId,
      "x-openmasu-installation-key-id": credential.installation_key_id,"x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce,"x-openmasu-signature": signature },body });
  }
  const prepared = await post("/v1/apple/purchases/prepare",{ request_id: randomUUID(),installation_id: installationId,
    product_id: "synthetic.product",revenue_measurement_consent: true });
  assert.equal(prepared.status,200); const intent = await prepared.json() as Any;
  const transaction: Any = { transactionId: `synthetic-transaction-${tag}`,originalTransactionId: `synthetic-original-${tag}`,
    bundleId,productId: "synthetic.product",environment: "Sandbox",appAccountToken: intent.app_account_token,
    purchaseDate: Date.parse("2026-08-06T02:00:00.000Z"),signedDate: Date.now(),quantity: 3,
    inAppOwnershipType: "PURCHASED",price: 10000,currency: "USD" };
  const submit = (value: Any = transaction, override: Any = {}) => post("/v1/apple/purchases/submit", {
    intent_id: intent.intent_id,installation_id: installationId,signed_transaction: signed(value),revenue_measurement_consent: true,...override });
  async function notify(value: Any, type = "DID_RENEW") {
    return fetch(`${base}/v1/apple/app-store/notifications`,{ method: "POST",headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: signed({ notificationType: type,notificationUUID: randomUUID(),signedDate: Date.now(),
        data: { bundleId,environment: "Sandbox",signedTransactionInfo: signed(value) } }) }) });
  }
  const work = (values: Any[], options: { now?: Date; store?: PayloadStore; body?: Any } = {}) => processCommerceReadbacks(pool,options.store ?? store,tenantId, {
    now: options.now ?? new Date(Date.now()+1000),verifyAppleSignedData: verifier,
    appleClient: async () => ({ status: 200,body: Buffer.from(JSON.stringify(options.body ?? { signedTransactions: values.map(signed),hasMore: false })) }) });
  const query = <T extends Any = Any>(text: string,values: unknown[] = [tenantId,appId]) => withTenant(pool,tenantId,client => client.query<T>(text,values)).then(result => result.rows);
  async function remove(scope: "installation" | "app" | "tenant") {
    const body: PrivacyRequestBody = { tenant_id: tenantId,app_id: appId,requested_via: "tenant_admin_api",deletion_scope: scope,
      deletion_subject_ref: scope === "installation" ? installationId : scope === "app" ? appId : tenantId };
    return executePrivacyRequest(pool,{ tenantId,appId,keyId: "synthetic-admin",role: "admin",
      deletionSubjectDigest: privacySubjectDigest(config.installationDigestKey,body) },body,store);
  }
  const facts = () => query(`SELECT 'purchase' AS kind,record_id,transaction_id,amount_unscaled,amount_scale FROM ledger.purchase_facts WHERE tenant_id=$1 AND app_id=$2
    UNION ALL SELECT 'refund',logical.record_id,refund.transaction_id,refund.amount_unscaled,refund.amount_scale
      FROM ledger.refund_facts AS refund JOIN ledger.logical_events AS logical USING (tenant_id,app_id,logical_event_id)
      WHERE refund.tenant_id=$1 AND refund.app_id=$2 ORDER BY kind,record_id`);
  return { tenantId,appId,installationId,root,store,dependencies,base,intent,transaction,submit,notify,work,query,remove,facts,measurement,old };
}

describe("installation-bound App Store monetary projection",{ concurrency: false },() => {
  it("admits only an authenticated signed transaction matching the prepared installation product app and environment",async t => {
    const h = await harness(t);
    assert.equal((await fetch(`${h.base}/v1/apple/purchases/submit`,{ method: "POST",body: "{" })).status,401);
    assert.equal((await h.submit(h.transaction,{ installation_id: "installation:another" })).status,403);
    assert.equal((await h.submit(h.transaction,{ intent_id: randomUUID() })).status,403);
    assert.equal((await h.submit({ ...h.transaction,appAccountToken: randomUUID() })).status,403);
    assert.equal((await h.submit({ ...h.transaction,productId: "synthetic.other" })).status,403);
    assert.equal((await h.submit({ ...h.transaction,bundleId: "dev.synthetic.other" })).status,400);
    assert.equal((await h.submit({ ...h.transaction,environment: "Production" })).status,400);
    assert.equal((await h.submit(h.transaction,{ signed_transaction: "invalid.signature.value" })).status,400);
    assert.equal((await h.submit(h.transaction,{ revenue_measurement_consent: false })).status,400);
    h.dependencies.applePurchaseVerifier = undefined; assert.equal((await h.submit()).status,503); h.dependencies.applePurchaseVerifier = verifier;
    const compact = signed(h.transaction);
    const results = await Promise.all([h.submit(h.transaction,{ signed_transaction: compact }),h.submit(h.transaction,{ signed_transaction: compact })]);
    for (const response of results) { assert.equal(response.status,202); assert.deepEqual(await response.json(),{ intent_id: h.intent.intent_id,state: "pending" }); }
    assert.equal((await h.query("SELECT * FROM ephemeral.commerce_provider_readbacks WHERE tenant_id=$1 AND app_id=$2")).length,1);
    assert.deepEqual(await h.facts(),[]);
    assert.deepEqual(await h.work([h.transaction]),{ processed: 1,deferred: 0,failed: 0 });
    const [purchase] = await h.facts(); assert.equal(purchase.amount_unscaled,"10000"); assert.equal(purchase.amount_scale,3);
    const [evidence] = await h.query("SELECT * FROM control.apple_purchase_evidence WHERE tenant_id=$1 AND app_id=$2");
    assert.equal(verifier((await h.store.read(evidence.evidence_ref)).toString()).transactionId,h.transaction.transactionId);
    assert.equal(await h.store.scanFor(h.transaction.transactionId),false);
    await assert.rejects(withTenant(reader,h.tenantId,client => client.query("SELECT * FROM control.apple_purchase_evidence")),/permission denied/);
  });

  it("binds a verified renewal only through the original purchase and deduplicates history pages and notifications",async t => {
    const h = await harness(t); assert.equal((await h.submit()).status,202);
    const renewal = { ...h.transaction,transactionId: "synthetic-renewal",appAccountToken: undefined,purchaseDate: h.transaction.purchaseDate+86400000 };
    assert.equal((await h.notify(renewal)).status,200);
    assert.deepEqual(await h.work([renewal,h.transaction]),{ processed: 2,deferred: 0,failed: 0 });
    assert.equal((await h.facts()).length,2);
    assert.equal((await h.notify(renewal)).status,200); await h.work([renewal,h.transaction]); assert.equal((await h.facts()).length,2);
    const refund = { ...renewal,revocationType: "REFUND_PRORATED",revocationPercentage: 40000,revocationDate: renewal.purchaseDate+1000 };
    await h.notify(refund,"REFUND"); await h.work([refund]);
    const facts = await h.facts(); assert.equal(facts.filter(row => row.kind === "refund").length,1);
    assert.equal(facts.find(row => row.kind === "refund")!.amount_unscaled,"4000000000000000000");
    const targets = await h.query(`SELECT refund.correction_target_record_id,purchase.transaction_id FROM ledger.refund_facts AS refund
      JOIN ledger.purchase_facts AS purchase ON purchase.record_id=refund.correction_target_record_id WHERE refund.tenant_id=$1 AND refund.app_id=$2`);
    assert.equal(targets.length,1);
    const [renewalBinding] = await h.query("SELECT purchase_record_id FROM control.commerce_purchase_bindings WHERE tenant_id=$1 AND app_id=$2 AND transaction_digest=$3",
      [h.tenantId,h.appId,sha256(renewal.transactionId)]);
    assert.equal(targets[0].correction_target_record_id,renewalBinding.purchase_record_id);
    await h.notify(refund,"REFUND"); await h.work([refund]); assert.equal((await h.facts()).length,3);
    const full = { ...refund,revocationType: "REFUND_FULL",revocationPercentage: 100000,revocationDate: refund.revocationDate+1 };
    await h.notify(full,"REFUND"); await h.work([full]);
    const refunds = (await h.facts()).filter(row => row.kind === "refund");
    assert.deepEqual(refunds.map(row => row.amount_unscaled).sort(),["4000000000000000000","6000000000000000000"]);
  });

  it("keeps missing money family access unknown tokens and refund reversals out of monetary facts",async t => {
    const h = await harness(t); await h.submit();
    const values = [
      { ...h.transaction,transactionId: "synthetic-family",inAppOwnershipType: "FAMILY_SHARED" },
      { ...h.transaction,transactionId: "synthetic-no-price",price: undefined },
      { ...h.transaction,transactionId: "synthetic-unbound",appAccountToken: randomUUID() },
      { ...h.transaction,transactionId: "synthetic-unbound-series",appAccountToken: undefined,originalTransactionId: "synthetic-unbound" },
    ];
    assert.deepEqual(await h.work(values),{ processed: 1,deferred: 0,failed: 0 }); assert.deepEqual(await h.facts(),[]);
    await h.notify(h.transaction,"REFUND_REVERSED"); await h.work([h.transaction]); assert.deepEqual(await h.facts(),[]);
    const kinds = (await h.query("SELECT event_kind FROM ledger.commerce_lifecycle_facts WHERE tenant_id=$1 AND app_id=$2")).map(row => row.event_kind);
    for (const kind of ["ownership_not_purchased","money_missing","transaction_unbound","refund_reversal_unprojected"]) assert.ok(kinds.includes(kind));
  });

  it("rolls back a whole invalid page or failed encrypted evidence write and retries without partial bindings",async t => {
    const h = await harness(t); await h.submit();
    assert.deepEqual(await h.work([h.transaction],{ body: { signedTransactions: [signed(h.transaction),"invalid.signature.value"],hasMore: true,revision: "synthetic-next" } }),{ processed: 0,deferred: 1,failed: 0 });
    assert.deepEqual(await h.facts(),[]);
    const written: string[] = [];
    const failing: PayloadStore = { read: h.store.read.bind(h.store),purge: h.store.purge.bind(h.store),scanFor: h.store.scanFor.bind(h.store),
      write: async (scope,body) => { if (written.length) throw new Error("synthetic storage interruption"); const ref = await h.store.write(scope,body); written.push(ref); return ref; } };
    const refund = { ...h.transaction,revocationType: "REFUND_FULL",revocationDate: h.transaction.purchaseDate+1000 };
    assert.deepEqual(await h.work([refund],{ now: new Date(Date.now()+120000),store: failing }),{ processed: 0,deferred: 1,failed: 0 });
    assert.deepEqual(await h.facts(),[]);
    assert.equal((await h.query("SELECT * FROM control.commerce_purchase_bindings WHERE tenant_id=$1 AND app_id=$2")).length,0);
    assert.equal(written.length,1); await assert.rejects(h.store.read(written[0]),PayloadNotFoundError);
    assert.deepEqual(await h.work([refund],{ now: new Date(Date.now()+360000) }),{ processed: 1,deferred: 0,failed: 0 });
    assert.equal((await h.facts()).length,2);
  });

  it("serializes competing notification projections for the same transaction",async t => {
    const h = await harness(t); await h.submit(); await h.notify(h.transaction);
    const outcomes = await Promise.all([h.work([h.transaction]),h.work([h.transaction])]);
    assert.equal(outcomes.reduce((sum,row) => sum+row.processed,0),2);
    assert.ok(outcomes.every(row => row.deferred === 0 && row.failed === 0));
    assert.equal((await h.facts()).length,1);
    assert.equal((await h.query("SELECT * FROM control.apple_purchase_evidence WHERE tenant_id=$1 AND app_id=$2")).length,1);
  });

  it("connects authenticated purchases and late refunds to immutable campaign revenue LTV and ROAS runs",async t => {
    const h = await harness(t,true); await h.submit(); await h.work([h.transaction]);
    const identity = { tenantId: h.tenantId,appId: h.appId,keyId: "synthetic-admin",role: "admin" as const };
    const allRuns = () => h.query("SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2").then(rows => rows.map(row => row.artifact));
    async function recalculate(recordIds: string[], watermark: string) {
      const job = await requestMetricRecalculation(pool,identity,{ trigger_kind: "late_events",source_record_ids: recordIds,
        date_from: "2026-08-06",date_to: "2026-08-06",watermark });
      assert.equal(job.selected_runs,4); assert.equal((await processMetricRecalculations(pool,h.tenantId)).completed,4);
    }
    await recalculate((await h.facts()).map(row => row.record_id),new Date(Date.now()+60000).toISOString());
    const purchaseRuns = (await allRuns()).filter(row => row.supersedes_metric_run_id);
    assert.equal(purchaseRuns.find(row => row.metric_name === "cohort_purchase_net_revenue_d30_usd").value_unscaled,"10000000");
    assert.equal(purchaseRuns.find(row => row.metric_name === "cohort_total_net_ltv_d30_usd").value_unscaled,"30000000");
    assert.equal(purchaseRuns.find(row => row.metric_name === "d30_total_net_roas").value_unscaled,"3000000");
    const refund = { ...h.transaction,revocationType: "REFUND_PRORATED",revocationPercentage: 40000,revocationDate: h.transaction.purchaseDate+3600000 };
    await h.notify(refund,"REFUND"); await h.work([refund],{ now: new Date(Date.now()+120000) });
    await recalculate((await h.facts()).filter(row => row.kind === "refund").map(row => row.record_id),new Date(Date.now()+180000).toISOString());
    const saved = await allRuns(), final = saved.filter(row => purchaseRuns.some(previous => row.supersedes_metric_run_id === previous.metric_run_id));
    assert.equal(final.find(row => row.metric_name === "cohort_purchase_net_revenue_d30_usd").value_unscaled,"6000000");
    assert.equal(final.find(row => row.metric_name === "cohort_total_net_ltv_d30_usd").value_unscaled,"26000000");
    assert.equal(final.find(row => row.metric_name === "d30_total_net_roas").value_unscaled,"2600000");
    for (const prior of [...h.old,...purchaseRuns]) assert.equal(jcs(saved.find(row => row.metric_run_id === prior.metric_run_id)),jcs(prior));
  });

  it("purges submitted and projected evidence in all privacy scopes and after an object-only restore",async t => {
    for (const scope of ["installation","app","tenant"] as const) {
      const h = await harness(t); await h.submit();
      assert.deepEqual(await h.work([h.transaction]),{ processed: 1,deferred: 0,failed: 0 });
      assert.equal((await h.facts()).length,1);
      await h.submit({ ...h.transaction,signedDate: h.transaction.signedDate+1 });
      const refs = (await h.query(`SELECT evidence_ref AS reference FROM control.apple_purchase_evidence WHERE tenant_id=$1 AND app_id=$2
        UNION SELECT evidence_ref FROM control.commerce_provider_notifications WHERE tenant_id=$1 AND app_id=$2`)).map(row => row.reference);
      assert.ok(refs.length >= 3,"submitted and projected evidence must exist before testing erasure");
      const backup = join(h.root,"backup"); cpSync(join(h.root,"payloads"),backup,{ recursive: true });
      assert.equal((await h.remove(scope)).status,"completed");
      for (const ref of refs) await assert.rejects(h.store.read(ref),PayloadNotFoundError);
      assert.deepEqual(await h.work([h.transaction]),{ processed: 0,deferred: 0,failed: 0 });
      assert.equal((await h.query("SELECT * FROM control.apple_purchase_intents WHERE tenant_id=$1 AND app_id=$2")).length,0);
      cpSync(backup,join(h.root,"payloads"),{ recursive: true }); await reapplyCompletedPrivacyRequests({ pool,payloadStore: h.store,tenantId: h.tenantId });
      for (const ref of refs) await assert.rejects(h.store.read(ref),PayloadNotFoundError);
      assert.ok([401,403].includes((await h.submit()).status));
    }
  });

  it("does not publish a provider response that completes after installation deletion",async t => {
    const h = await harness(t); await h.submit();
    let entered!: () => void,release!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const pending = processCommerceReadbacks(pool,h.store,h.tenantId,{ now: new Date(Date.now()+1000),verifyAppleSignedData: verifier,
      appleClient: async () => { entered(); await resume; return { status: 200,body: Buffer.from(JSON.stringify({ signedTransactions: [signed(h.transaction)],hasMore: false })) }; } });
    await requested;
    try { assert.equal((await h.remove("installation")).status,"completed"); } finally { release(); }
    assert.deepEqual(await pending,{ processed: 0,deferred: 0,failed: 0 }); assert.deepEqual(await h.facts(),[]);
  });
});
