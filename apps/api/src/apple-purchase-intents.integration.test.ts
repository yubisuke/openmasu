import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { createAppPool, createReaderPool, EncryptedFilePayloadStore, PayloadNotFoundError, withTenant, type PayloadStore } from "@openmasu/runtime";
import { ensureSdkKeys, issueInstallationCredential, signSdkRequest, installationIdDigest } from "./sdk-auth.js";
import { registerAppleApp } from "./apple-admin.js";
import { createRequestHandler } from "./router.js";
import { KeyedTokenBucket } from "./rate-limit.js";
import { executePrivacyRequest, privacySubjectDigest, type PrivacyRequestBody } from "./privacy.js";
import { reapplyCompletedPrivacyRequests } from "../../worker/src/privacy-reapply.js";
import type { SdkRouteDependencies } from "./sdk-routes.js";

const pool = createAppPool(), reader = createReaderPool();
after(async () => { await pool.end(); await reader.end(); });
const path = "/v1/apple/purchases/prepare";

async function harness(t: TestContext, platform: "ios" | "android" = "ios") {
  const tag = randomBytes(6).toString("hex"), tenantId = `tenant-intent-${tag}`, appId = `app-intent-${tag}`;
  const root = mkdtempSync(join(tmpdir(), "openmasu-apple-intent-"));
  const payloadStore = new EncryptedFilePayloadStore(join(root, "payloads"), `synthetic-master-${tag}-0000000000000000`);
  const config = { tenantId, appId, installationDigestKey: `synthetic-digest-${tag}`, timestampSkewMs: 300_000, nonceTtlMs: 900_000 };
  const keyId = `sdk:${tag}`, secret = `synthetic-sdk-${tag}-00000000000000000000`, installationId = `installation:${tag}`;
  await ensureSdkKeys(pool, payloadStore, config, [{ keyId, secret, platform }]);
  const credential = await issueInstallationCredential({ pool, payloadStore, config, sdkKeyId: keyId, installationId });
  const dependencies: SdkRouteDependencies = { pool, payloadStore, config, applePurchaseEnvironment: "Sandbox", maximumBytes: 65536, maximumEvents: 100,
    enrollmentBucket: new KeyedTokenBucket(100,100), installationBucket: new KeyedTokenBucket(100,100),
    appBucket: new KeyedTokenBucket(100,100), privacyBucket: new KeyedTokenBucket(100,100) };
  const server = createServer(createRequestHandler({ pool, readerPool: reader, payloadStore, sdk: dependencies,
    dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 3600 },
    maxConfig: { tenantId, appId, pathSecret: "synthetic", eventKey: "synthetic", tokenMode: "all", maxParameters: 40, maxQueryBytes: 8192 },
    publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090" }));
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}${path}`;
  const value = { request_id: randomUUID(), installation_id: installationId, product_id: "synthetic.product", revenue_measurement_consent: true };
  async function post(bodyValue: unknown = value, signatureOverride?: string) {
    const body = Buffer.from(JSON.stringify(bodyValue)), timestampMs = Date.now(), nonce = randomUUID();
    const signature = signSdkRequest(credential.installation_secret, { method: "POST", path, sdkKeyId: keyId,
      installationKeyId: credential.installation_key_id, timestampMs, nonce, body });
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-openmasu-sdk-key-id": keyId,
      "x-openmasu-installation-key-id": credential.installation_key_id, "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce, "x-openmasu-signature": signatureOverride ?? signature }, body });
  }
  const register = () => registerAppleApp({ pool, identity: { tenantId, appId, keyId: "synthetic-admin", role: "admin" },
    appleAppAdamId: String(9_000_000_000 + Number.parseInt(tag,16)), appleBundleId: `dev.openmasu.synthetic.${tag}` });
  const rows = () => withTenant(pool, tenantId, client => client.query<Record<string, any>>(
    "SELECT * FROM control.apple_purchase_intents WHERE tenant_id=$1 AND app_id=$2", [tenantId,appId])).then(result => result.rows);
  async function remove(scope: "installation" | "app" | "tenant", store: PayloadStore = payloadStore) {
    const body: PrivacyRequestBody = { tenant_id: tenantId, app_id: appId, requested_via: "tenant_admin_api", deletion_scope: scope,
      deletion_subject_ref: scope === "installation" ? installationId : scope === "app" ? appId : tenantId };
    return executePrivacyRequest(pool, { keyId: "synthetic-admin", tenantId, appId, role: "admin",
      deletionSubjectDigest: privacySubjectDigest(config.installationDigestKey,body) }, body, store);
  }
  return { tenantId, appId, root, payloadStore, config, credential, dependencies, url, value, post, register, rows, remove };
}

describe("App Store installation-scoped purchase preparation", { concurrency: false }, () => {
  it("authenticates closed requests and replays one protected token without creating financial facts", async t => {
    const h = await harness(t);
    assert.equal((await fetch(h.url,{ method: "POST", body: "{" })).status,401);
    assert.equal((await h.post(h.value,"0".repeat(64))).status,401);
    assert.equal((await h.post()).status,409); // No registered Apple app.
    await h.register();
    h.dependencies.applePurchaseEnvironment = undefined;
    assert.equal((await h.post()).status,503);
    h.dependencies.applePurchaseEnvironment = "Sandbox";
    assert.equal((await h.post({ ...h.value, environment: "Production" })).status,400);
    assert.equal((await h.post({ ...h.value, installation_id: "installation:other" })).status,403);
    const responses = await Promise.all([h.post(),h.post()]);
    for (const response of responses) assert.equal(response.status,200);
    const [left,right] = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(left,right);
    assert.match(left.app_account_token,/^[a-f0-9-]{36}$/); assert.equal(left.state,"prepared");
    assert.equal(left.environment,"Sandbox");
    assert.equal((await h.post({ ...h.value, product_id: "different.product" })).status,409);
    h.dependencies.applePurchaseEnvironment = "Production";
    assert.equal((await h.post()).status,409);
    h.dependencies.applePurchaseEnvironment = "Sandbox";
    const rows = await h.rows(); assert.equal(rows.length,1);
    assert.equal(rows[0].installation_id_digest, installationIdDigest(h.config,h.value.installation_id));
    assert.equal(rows[0].bundle_id.startsWith("dev.openmasu.synthetic."),true);
    assert.equal(JSON.stringify(rows).includes(left.app_account_token),false);
    assert.equal(await h.payloadStore.scanFor(left.app_account_token),false);
    assert.equal(await h.payloadStore.scanFor(h.value.installation_id),false);
    assert.equal(JSON.parse((await h.payloadStore.read(rows[0].anchor_ref)).toString()).installation_id,h.value.installation_id);
    await assert.rejects(withTenant(reader,h.tenantId, client => client.query("SELECT * FROM control.apple_purchase_intents")), /permission denied/);
    assert.equal((await withTenant(pool,"tenant-synthetic-other",client => client.query("SELECT * FROM control.apple_purchase_intents WHERE intent_id=$1",[left.intent_id]))).rowCount,0);
    const financial = await withTenant(pool,h.tenantId,client => client.query(`SELECT
      (SELECT count(*) FROM ledger.purchase_facts WHERE tenant_id=$1)::int AS purchases,
      (SELECT count(*) FROM ledger.commerce_lifecycle_facts WHERE tenant_id=$1)::int AS lifecycle`,[h.tenantId]));
    assert.deepEqual(financial.rows[0], { purchases: 0, lifecycle: 0 });
    const android = await harness(t,"android"); await android.register();
    assert.equal((await android.post()).status,403);
  });

  it("purges preparation anchors for every deletion scope and reapplies restored objects and intent rows", async t => {
    for (const scope of ["installation","app","tenant"] as const) {
      const h = await harness(t); await h.register(); assert.equal((await h.post()).status,200);
      const [stored] = await h.rows();
      cpSync(join(h.root,"payloads"),join(h.root,"backup"),{ recursive: true });
      assert.equal((await h.remove(scope)).status,"completed");
      assert.equal((await h.rows()).length,0);
      await assert.rejects(h.payloadStore.read(stored.anchor_ref),PayloadNotFoundError);
      if (scope === "installation") assert.equal((await h.post()).status,401);
      cpSync(join(h.root,"backup"),join(h.root,"payloads"),{ recursive: true, force: true });
      assert.ok((await h.payloadStore.read(stored.anchor_ref)).length);
      // A restored DB row, or an object-only restore, must both be covered.
      if (scope !== "app") await withTenant(pool,h.tenantId,client => client.query(
        `INSERT INTO control.apple_purchase_intents SELECT * FROM jsonb_populate_record(NULL::control.apple_purchase_intents,$1::jsonb)`,[JSON.stringify(stored)]));
      const reapplied = await reapplyCompletedPrivacyRequests({ pool, payloadStore: h.payloadStore, tenantId: h.tenantId });
      assert.equal(reapplied.privacy_requests,1); assert.equal((await h.rows()).length,0);
      await assert.rejects(h.payloadStore.read(stored.anchor_ref),PayloadNotFoundError);
      if (scope === "installation") assert.equal((await h.post()).status,401);
    }
  });

  it("keeps preparation behind deletion recognition even while encrypted purge is pending", async t => {
    const h = await harness(t); await h.register(); assert.equal((await h.post()).status,200);
    const [stored] = await h.rows();
    const failingStore: PayloadStore = { write: h.payloadStore.write.bind(h.payloadStore), read: h.payloadStore.read.bind(h.payloadStore),
      scanFor: h.payloadStore.scanFor.bind(h.payloadStore), purge: async () => { throw new Error("synthetic storage outage"); } };
    assert.equal((await h.remove("installation",failingStore)).status,"processing");
    assert.ok((await h.payloadStore.read(stored.anchor_ref)).length);
    assert.equal((await h.post()).status,401);
    assert.equal((await h.rows()).length,0);
  });

  it("serializes an in-flight preparation before deletion without leaving its anchor readable", async t => {
    const h = await harness(t); await h.register();
    let entered!: () => void, resume!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    let reference = "";
    h.dependencies.payloadStore = { read: h.payloadStore.read.bind(h.payloadStore), purge: h.payloadStore.purge.bind(h.payloadStore),
      scanFor: h.payloadStore.scanFor.bind(h.payloadStore), write: async (scope,body) => {
        reference = await h.payloadStore.write(scope,body); entered(); await release; return reference;
      } };
    const preparation = h.post(); await writing;
    const deletion = h.remove("installation");
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks = await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
          AND classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid
          AND objid=(hashtextextended($1,0) & 4294967295)::oid`, [`openmasu:privacy-tenant:${h.tenantId}`]);
        if (locks.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve,20));
      }
      assert.equal(waiting,true,"deletion must wait for the shared preparation fence");
    } finally { resume(); }
    assert.equal((await preparation).status,200);
    assert.equal((await deletion).status,"completed");
    assert.equal((await h.rows()).length,0);
    await assert.rejects(h.payloadStore.read(reference),PayloadNotFoundError);
    assert.equal((await h.post()).status,401);
  });
});
