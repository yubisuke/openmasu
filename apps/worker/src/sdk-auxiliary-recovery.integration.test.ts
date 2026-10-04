import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";
import {
  SDK_POST_PROCESSING_PENDING_REASON,
  appendDurableBatch,
  createAppPool,
  createReaderPool,
  createMigrationPool,
  EncryptedFilePayloadStore,
  type PayloadStore,
  uuidV7,
  PostgresSchedulerStore,
  withTenant,
} from "@openmasu/runtime";
import {
  processAdServicesLookups,
  queueAdServicesLookup,
} from "./adservices-worker.js";
import {
  processGooglePlayProductVerifications,
  queueGooglePlayProductVerification,
} from "./google-play-product-verifier.js";
import {
  processIntegrityVerifications,
  queueIntegrityVerification,
} from "./integrity-verifier.js";
import { processSdkInbox } from "./sdk-worker.js";
import { SELECTED_ACQUISITION_METRIC_DEFINITIONS } from "@openmasu/contracts";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { buildMetricDefinitionsInput } from "./metrics/run.js";
import { persistCostImport } from "./import/cost.js";
import { listIngestRecovery, requestIngestRecovery } from "../../api/src/ingest-recovery.js";
import { ensureAdminKeys, type AppAdminIdentity } from "../../api/src/admin-auth.js";
import { createRequestHandler } from "../../api/src/router.js";
import { csrfToken, readDashboardToken } from "../../api/src/session.js";

type Any = Record<string, any>;

const run = randomBytes(6).toString("hex");
const root = mkdtempSync(join(tmpdir(), "openmasu-sdk-recovery-"));
const pool = createAppPool();
const payloadStore = new EncryptedFilePayloadStore(
  root,
  `master-${randomBytes(32).toString("base64url")}`,
);

type Scope = {
  readonly tenantId: string;
  readonly appId: string;
  readonly producer: "sdk-android" | "sdk-ios" | "redirector";
  readonly receivedAt: string;
};

function scope(label: string, producer: Scope["producer"]): Scope {
  return {
    tenantId: `tenant-sdk-recovery-${label}-${run}`,
    appId: `app-sdk-recovery-${label}-${run}`,
    producer,
    receivedAt: new Date().toISOString(),
  };
}

function record(
  input: Scope,
  label: string,
  eventName: "click" | "install" | "ad_revenue" | "purchase" | "refund" | "consent_changed",
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contract_version: "0.4.0",
    record_id: `record:${uuidV7()}`,
    delivery_id: `delivery:${uuidV7()}`,
    tenant_id: input.tenantId,
    app_id: input.appId,
    producer: input.producer,
    producer_version: "synthetic-sdk-recovery",
    event_id: `event:sdk-recovery:${label}:${run}`,
    event_name: eventName,
    schema_version: "0.4.0",
    occurred_at: input.receivedAt,
    occurred_at_source: "device",
    received_at: input.receivedAt,
    processing_purpose_id: ["ad_revenue", "purchase", "refund"].includes(eventName) ? "revenue_measurement" : "attribution",
    processing_sequence: 1,
    payload: { event_name: eventName, ...payload },
  };
}

async function append(
  input: Scope,
  value: Record<string, unknown>,
  installationKeyId?: string,
): Promise<string> {
  return appendDurableBatch(pool, payloadStore, {
    tenantId: input.tenantId,
    appId: input.appId,
    producer: input.producer,
    body: Buffer.from(JSON.stringify({ records: [value] }), "utf8"),
    eventCount: 1,
    receivedAt: input.receivedAt,
    ...(installationKeyId ? { installationKeyId } : {}),
  });
}

async function batchState(input: Scope, batchId: string): Promise<{
  readonly status: string;
  readonly reason_code: string | null;
}> {
  return withTenant(pool, input.tenantId, async (client) => (await client.query<{
    status: string;
    reason_code: string | null;
  }>(
    `SELECT status, reason_code FROM ledger.ingest_batches_current
      WHERE tenant_id=$1 AND app_id=$2 AND ingest_batch_id=$3`,
    [input.tenantId, input.appId, batchId],
  )).rows[0]);
}

async function ledgerCount(input: Scope, recordId: string): Promise<number> {
  return withTenant(pool, input.tenantId, async (client) => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM ledger.raw_records raw
       JOIN ledger.logical_events logical
         ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id
        AND logical.record_id=raw.record_id
      WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=$3`,
    [input.tenantId, input.appId, recordId],
  )).rows[0].count);
}

function countingPayloadStore(reads: string[]): PayloadStore {
  return {
    write: (scope, plaintext) => payloadStore.write(scope, plaintext),
    read: async (reference) => {
      reads.push(reference);
      return payloadStore.read(reference);
    },
    purge: (reference) => payloadStore.purge(reference),
    scanFor: (value) => payloadStore.scanFor(value),
  };
}

async function purgeRecordEvidence(input: Scope, recordId: string): Promise<void> {
  const bodyRef = await withTenant(pool, input.tenantId, async (client) => (await client.query<{ body_ref: string }>(
    `SELECT batch.body_ref
       FROM ledger.ingest_batches AS batch
       JOIN ledger.ingest_batch_records AS member USING (ingest_batch_id, tenant_id, app_id)
      WHERE member.tenant_id=$1 AND member.app_id=$2 AND member.record_id=$3
      ORDER BY batch.inbox_seq DESC LIMIT 1`,
    [input.tenantId, input.appId, recordId],
  )).rows[0].body_ref);
  await payloadStore.purge(bodyRef);
  await withTenant(pool, input.tenantId, (client) => client.query(
    `INSERT INTO ledger.raw_payload_states (
       tenant_id, app_id, record_id, lifecycle_status, changed_at
     ) VALUES ($1,$2,$3,'purged',$4)
     ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
    [input.tenantId, input.appId, recordId, new Date().toISOString()],
  ).then(() => undefined));
}

after(async () => {
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

describe("SDK auxiliary queue recovery", () => {
  it("recovers one confirmed SDK/auxiliary attempt while refusing stale forms, active claims, invalid or deleted evidence and preserving admitted facts", async () => {
    const input = scope("operator", "sdk-ios");
    const admin = `synthetic-recovery-admin-${run}-${"a".repeat(32)}`;
    const readonly = `synthetic-recovery-read-${run}-${"b".repeat(32)}`;
    const keys = await ensureAdminKeys(pool,input,[{key:admin,role:"operator"},{key:readonly,role:"read_only"}]);
    const identity: AppAdminIdentity = { ...input,keyId:keys[0],role:"operator" };
    const reader = createReaderPool();
    const handler = createRequestHandler({pool,readerPool:reader,payloadStore,
      maxConfig:{tenantId:input.tenantId,appId:input.appId,pathSecret:"synthetic-recovery",eventKey:"synthetic-recovery-key",tokenMode:"all",maxParameters:40,maxQueryBytes:8192},
      publicBaseUrl:"http://localhost:8080",redirectorBaseUrl:"http://localhost:8090",
      dashboard:{enabled:true,tenantId:input.tenantId,publicBaseUrl:"http://localhost:8080",sessionTtlSeconds:43200}});
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`, api = `${base}/v1/admin/apps/${input.appId}/ingest-recovery`;
    const post = (body: unknown, key=admin) => fetch(api,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify(body)});
    const markFailed = async (id: string) => withTenant(pool,input.tenantId,client => client.query(
      `INSERT INTO ledger.ingest_batch_states (ingest_batch_id,tenant_id,app_id,status,changed_at,reason_code,artifact)
       VALUES ($1::uuid,$2,$3,'failed',$4,'synthetic_worker_failure','{}'::jsonb)`,[id,input.tenantId,input.appId,new Date().toISOString()]));
    try {
      const value = record(input,"operator-install","install",{
        installation_id:`installation:operator-${run}`,install_type:"first_install",referrer_status:"unavailable"});
      const batch = await append(input,value);
      const temporaryStore: PayloadStore = { ...countingPayloadStore([]),read:async () => { throw new Error("synthetic_worker_payload_configuration_unavailable"); } };
      await processSdkInbox(pool,temporaryStore,input.tenantId);
      assert.equal((await batchState(input,batch)).status,"failed");
      const list = await fetch(api,{headers:{authorization:`Bearer ${admin}`}});
      assert.equal(list.status,200);
      const initial = await list.json() as Awaited<ReturnType<typeof listIngestRecovery>>;
      const job = initial.items.find(item => item.job_id === batch)!; assert.ok(job);
      assert.equal(job.reason,"worker_failure_review_configuration");
      assert.equal(job.recovery,"validate_before_retry");
      assert.doesNotMatch(JSON.stringify(initial),/synthetic_worker_payload|encrypted:|protected:|installation:|token_ref|body_ref|subject_digest|record_id/);
      const request = {kind:"sdk_batch",job_id:batch,revision:job.revision,confirmation:"retry_once"};
      assert.equal((await post({...request,confirmation:""})).status,400);
      assert.equal((await post(request,readonly)).status,403);
      assert.equal((await fetch(`${base}/v1/admin/apps/app-unknown-${run}/ingest-recovery`,{headers:{authorization:`Bearer ${admin}`}})).status,404);
      const scheduler = new PostgresSchedulerStore(pool);
      const claim = await scheduler.claim(input.tenantId,"sdk_inbox",{intervalMs:1000,retryMs:1000,leaseMs:300000},new Date());
      assert.ok(claim);
      try {
        const refused = await post(request); assert.equal(refused.status,409); assert.equal((await refused.json() as Any).error,"worker_claim_active");
      } finally { await scheduler.complete(claim,new Date()); }
      const concurrent = await Promise.all([post(request),post(request)]);
      assert.deepEqual(concurrent.map(response => response.status).sort(),[202,409]);
      const receipt = await concurrent.find(response => response.status === 202)!.json() as Any;
      const savedReceipt = await withTenant(pool,input.tenantId,client => client.query(
        "SELECT target_ref FROM ledger.audit_logs WHERE tenant_id=$1 AND app_id=$2 AND audit_log_id=$3",[input.tenantId,input.appId,receipt.receipt_id]));
      assert.equal(savedReceipt.rows[0].target_ref,batch);
      assert.equal((await post(request)).status,409);
      assert.equal(await processSdkInbox(pool,payloadStore,input.tenantId),1,"fixed payload configuration must recover through the original worker");
      assert.equal(await ledgerCount(input,String(value.record_id)),1);
      // A failure receipt after partial admission must not create a second logical event/fact.
      const canonical = await withTenant(pool,input.tenantId,client => client.query(
        "SELECT artifact FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3",[input.tenantId,input.appId,value.record_id]));
      const originalFacts = await withTenant(pool,input.tenantId,client => client.query(
        `SELECT fact.artifact FROM ledger.install_facts AS fact JOIN ledger.logical_events AS event
          USING (tenant_id,app_id,logical_event_id)
          WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND event.record_id=$3`,[input.tenantId,input.appId,value.record_id]));
      assert.equal(originalFacts.rowCount,1);
      await markFailed(batch);
      const replay = (await listIngestRecovery(reader,identity)).items.find(item => item.job_id === batch)!;
      await requestIngestRecovery(pool,payloadStore,identity,{...request,revision:replay.revision});
      await processSdkInbox(pool,payloadStore,input.tenantId);
      assert.equal(await ledgerCount(input,String(value.record_id)),1);
      assert.deepEqual((await withTenant(pool,input.tenantId,client => client.query(
        "SELECT artifact FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3",[input.tenantId,input.appId,value.record_id]))).rows,canonical.rows);
      assert.deepEqual((await withTenant(pool,input.tenantId,client => client.query(
        `SELECT fact.artifact FROM ledger.install_facts AS fact JOIN ledger.logical_events AS event
          USING (tenant_id,app_id,logical_event_id)
          WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND event.record_id=$3`,[input.tenantId,input.appId,value.record_id]))).rows,originalFacts.rows);
      const invalid = await append(input,record(input,"operator-invalid","install",{install_type:"first_install",referrer_status:"unavailable"}));
      await markFailed(invalid);
      const invalidItem = (await listIngestRecovery(reader,identity)).items.find(item => item.job_id === invalid)!;
      const invalidResponse = await post({...request,job_id:invalid,revision:invalidItem.revision});
      assert.equal(invalidResponse.status,409); assert.equal((await invalidResponse.json() as Any).error,"recovery_input_invalid");
      assert.equal((await batchState(input,invalid)).status,"failed");
      const digest = randomBytes(32).toString("hex");
      const deletedValue = record(input,"operator-deleted","install",{installation_id:`installation:deleted-${run}`,install_type:"first_install",referrer_status:"unavailable"});
      const deleted = await appendDurableBatch(pool,payloadStore,{tenantId:input.tenantId,appId:input.appId,producer:input.producer,
        body:Buffer.from(JSON.stringify({records:[deletedValue]})),eventCount:1,receivedAt:input.receivedAt,subjectDigest:digest});
      await markFailed(deleted);
      await withTenant(pool,input.tenantId,client => client.query(`INSERT INTO ledger.privacy_requests
        (privacy_request_id,tenant_id,app_id,requested_at,completed_at,status,artifact)
        VALUES ($1,$2,$3,$4,$4,'completed',$5::jsonb)`,[`privacy:operator-${run}`,input.tenantId,input.appId,new Date().toISOString(),
          JSON.stringify({deletion_scope:"installation",deletion_subject_digest:digest})]));
      const deletedItem = (await listIngestRecovery(reader,identity)).items.find(item => item.job_id === deleted)!;
      const reads: string[] = [];
      await assert.rejects(requestIngestRecovery(pool,countingPayloadStore(reads),identity,{...request,job_id:deleted,revision:deletedItem.revision}),/privacy_subject_inactive/);
      assert.deepEqual(reads,[],"privacy must be checked before protected evidence is read");
      // Pending auxiliary retries keep their original immutable source and token.
      const tokenBody = { records:[{...value,payload:{...(value.payload as Any),
        extensions:{adservices_attribution_token_protected:`synthetic-operator-token-${run}`}}}] };
      const tokenRef = await payloadStore.write({tenantId:input.tenantId,appId:input.appId,objectId:`synthetic-operator-token-${run}`},Buffer.from(JSON.stringify(tokenBody)));
      await queueAdServicesLookup(pool,{tenantId:input.tenantId,appId:input.appId,installRecordId:String(value.record_id),tokenRef,tokenCreatedAt:input.receivedAt});
      await processAdServicesLookups(pool,payloadStore,input.tenantId,{client:async () => ({status:429,body:Buffer.from("synthetic temporary failure")})});
      const queued = (await listIngestRecovery(reader,identity)).items.find(item => item.kind === "adservices")!;
      assert.equal(queued.recovery,"expedite_existing_retry");
      const auxRequest = {kind:queued.kind,job_id:queued.job_id,revision:queued.revision,confirmation:"retry_once"};
      assert.equal((await post(auxRequest)).status,202); assert.equal((await post(auxRequest)).status,409);
      await processAdServicesLookups(pool,payloadStore,input.tenantId,{client:async () => ({status:400,body:Buffer.from("synthetic terminal response")})});
      assert.equal((await post(auxRequest)).status,404,"a consumed token/completed verdict must not be resurrected");
      for (const kind of ["integrity","google_play"] as const) {
        const id = uuidV7(), next = new Date(Date.now()+60000);
        await withTenant(pool,input.tenantId,client => kind === "integrity" ? client.query(
          `INSERT INTO ephemeral.integrity_verifications
            (verification_id,tenant_id,app_id,provider,token_ref,subject_record_id,attempts,next_attempt_at,challenge_digest)
            VALUES ($1::uuid,$2,$3,'play_integrity',$4,$5,1,$6,$7)`,
          [id,input.tenantId,input.appId,tokenRef,value.record_id,next,"0".repeat(64)]) : client.query(
          `INSERT INTO ephemeral.google_play_product_verifications
            (verification_id,tenant_id,app_id,subject_record_id,token_ref,token_digest,product_id,verified_record_id,attempts,next_attempt_at,requested_at)
            VALUES ($1::uuid,$2,$3,$4,$5,$6,'synthetic-product',$7,1,$8,$9)`,
          [id,input.tenantId,input.appId,value.record_id,tokenRef,randomBytes(32).toString("hex"),`verified:${id}`,next,input.receivedAt]));
        const item = (await listIngestRecovery(reader,identity)).items.find(item => item.job_id === id)!;
        assert.equal(item.kind,kind); assert.equal(item.recovery,"expedite_existing_retry");
        const queuedResponse = await post({kind,job_id:id,revision:item.revision,confirmation:"retry_once"});
        assert.equal(queuedResponse.status,202);
        const table = kind === "integrity" ? "ephemeral.integrity_verifications" : "ephemeral.google_play_product_verifications";
        const unchanged = await withTenant(pool,input.tenantId,client => client.query(
          `SELECT token_ref,attempts${kind === "integrity" ? ",challenge_digest" : ""} FROM ${table} WHERE tenant_id=$1 AND verification_id=$2::uuid`,[input.tenantId,id]));
        if (kind === "integrity") assert.deepEqual(unchanged.rows,[{token_ref:tokenRef,attempts:1,challenge_digest:"0".repeat(64)}]);
        else assert.deepEqual(unchanged.rows,[{token_ref:tokenRef,attempts:1}]);
        await withTenant(pool,input.tenantId,client => client.query(`UPDATE ${table} SET claim_token=$3::uuid,claimed_until=$4
          WHERE tenant_id=$1 AND verification_id=$2::uuid`,[input.tenantId,id,uuidV7(),new Date(Date.now()+60000)]));
        const active = (await listIngestRecovery(reader,identity)).items.find(item => item.job_id === id)!;
        assert.equal(active.recovery,"blocked");
        assert.equal((await post({kind,job_id:id,revision:active.revision,confirmation:"retry_once"})).status,409);
        await withTenant(pool,input.tenantId,client => client.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND verification_id=$2::uuid`,[input.tenantId,id]));
      }
      const sessionResponse = await fetch(`${base}/dashboard/session`,{method:"POST",redirect:"manual",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({admin_key:admin})});
      assert.equal(sessionResponse.status,303);
      const cookie = sessionResponse.headers.get("set-cookie")!.split(";",1)[0];
      const pageUrl = `${base}/dashboard/apps/${input.appId}/ingest-recovery`;
      const page = await fetch(pageUrl,{headers:{cookie}}); assert.equal(page.status,200);
      const html = await page.text(); assert.match(html,/Ingest recovery/); assert.doesNotMatch(html,/<script|javascript:|\son\w+=|encrypted:|protected:|installation:deleted/);
      assert.equal((await fetch(pageUrl,{headers:{authorization:`Bearer ${admin}`}})).status,401);
      assert.equal((await fetch(api,{headers:{cookie}})).status,401);
      const csrf = csrfToken(readDashboardToken(cookie,"http://localhost:8080")!);
      const csrfCases: Record<string,string>[] = [{cookie,"content-type":"application/x-www-form-urlencoded"},{cookie,"content-type":"application/x-www-form-urlencoded",origin:"https://mismatch.example.test"}];
      for (const headers of csrfCases) {
        const response = await fetch(pageUrl,{method:"POST",headers,body:new URLSearchParams({...request,csrf_token:headers.origin ? csrf : ""})});
        assert.equal(response.status,403);
      }
      assert.deepEqual((await withTenant(reader,input.tenantId,client => client.query("SELECT * FROM control.ingest_recovery_auxiliary_items($1)",["app-unknown"]))).rows,[]);
      await assert.rejects(withTenant(reader,input.tenantId,client => client.query("SELECT token_ref FROM ephemeral.integrity_verifications")),/permission denied/);
    } finally {
      await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
      await reader.end();
    }
  });
  it("connects native inbox attribution to campaign install count, ad revenue and ROAS without campaign claims", async () => {
    const clickScope = scope("selected-source", "redirector");
    const clickId = `click_${randomBytes(18).toString("base64url")}`;
    const campaign = `campaign-selected-${run}`;
    const click = record(clickScope, "selected-click", "click", {
      click_id: clickId, tracking_link_id: `link-selected-${run}`, campaign_id: campaign,
      network: "synthetic-network", redirector_click_at: clickScope.receivedAt, redirector_time_status: "available",
    });
    await append(clickScope, click);
    assert.equal(await processSdkInbox(pool, payloadStore, clickScope.tenantId), 1);
    const installAt = new Date(Date.parse(clickScope.receivedAt) + 60_000).toISOString();
    const installScope: Scope = { ...clickScope, producer: "sdk-android", receivedAt: installAt };
    const installationId = `installation:selected-${run}`;
    const install = record(installScope, "selected-install", "install", {
      installation_id: installationId, install_type: "first_install", referrer_status: "available", click_id: clickId,
      install_begin_at_server_status: "available", install_begin_at_server: installAt,
      protected_referrer_evidence_ref: `protected:selected-${run}`,
    });
    await append(installScope, install);
    assert.equal(await processSdkInbox(pool, payloadStore, installScope.tenantId), 1);
    const revenueScope: Scope = { ...installScope, receivedAt: new Date(Date.parse(installAt) + 3_600_000).toISOString() };
    const revenue = record(revenueScope, "selected-revenue", "ad_revenue", {
      installation_id: installationId, subject_scope: "installation_level", ad_network: "synthetic-ad-network",
      amount_unscaled: "20000000", amount_scale: 6, currency: "USD", revenue_source: "client_estimated",
    });
    await append(revenueScope, revenue);
    assert.equal(await processSdkInbox(pool, payloadStore, revenueScope.tenantId), 1);
    const watermark = new Date(Date.parse(installAt) + 2 * 86_400_000).toISOString();
    const tenantScope = { tenant_id: installScope.tenantId, app_id: installScope.appId };
    await persistCostImport(pool, `synthetic-selected-cost-${run}`, [{ ...tenantScope,
      campaign_id: campaign, network: "synthetic-network", date: installAt.slice(0, 10),
      amount_unscaled: "10000000", amount_scale: 6, currency: "USD", source: "imported_reported", as_of: watermark }]);
    const definitionInput = buildMetricDefinitionsInput({
      metric_definitions: SELECTED_ACQUISITION_METRIC_DEFINITIONS,
      fx_policy: { policy_version: "synthetic-selected-fx", target_currency: "USD", target_scale: 6,
        rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
          source: "synthetic-1-to-1", as_of: watermark }] },
      evaluations: [{ metric_names: ["cohort_install_count", "cohort_ltv_d0_usd", "d0_roas"],
        grouping: { campaign_id: campaign, network: "synthetic-network", cohort_date: installAt.slice(0, 10) } }],
    }, installAt.slice(0, 10), watermark);
    const runs = await computeSqlMetricRuns(pool, definitionInput, true, tenantScope);
    assert.deepEqual(runs.map((row) => row.value_unscaled), ["1", "20000000", "2000000"]);
    const evidence = await withTenant(pool, installScope.tenantId, async (client) => (await client.query(
      `SELECT install.campaign_id,install.network,attribution.reason_code FROM ledger.install_facts install
       JOIN ledger.attribution_results attribution ON attribution.tenant_id=install.tenant_id
        AND attribution.app_id=install.app_id AND attribution.subject_ref=install.installation_id
       WHERE install.tenant_id=$1 AND install.app_id=$2`, [tenantScope.tenant_id, tenantScope.app_id],
    )).rows);
    assert.deepEqual(evidence, [{ campaign_id: null, network: null, reason_code: "valid_install_referrer" }]);
    await append(revenueScope, { ...revenue, record_id: `record:${uuidV7()}`, delivery_id: `delivery:${uuidV7()}` });
    await processSdkInbox(pool, payloadStore, revenueScope.tenantId);
    assert.deepEqual(await computeSqlMetricRuns(pool, definitionInput, false, tenantScope), runs);
    await purgeRecordEvidence(clickScope, String(click.record_id));
    const after = await computeSqlMetricRuns(pool, definitionInput, false, tenantScope);
    assert.equal(after[0].value_unscaled, "0", "purged source must not resurrect campaign credit");
  });
  it("keeps a saved acquisition snapshot unchanged when a backdated attribution gains late click evidence", async () => {
    const input = scope("selected-late", "sdk-android");
    const clickId = `click_${randomBytes(18).toString("base64url")}`;
    const campaign = `campaign-late-${run}`;
    const install = record(input, "selected-late-install", "install", {
      installation_id: `installation:selected-late-${run}`, install_type: "first_install",
      referrer_status: "available", click_id: clickId, install_begin_at_server_status: "available",
      install_begin_at_server: input.receivedAt, protected_referrer_evidence_ref: `protected:selected-late-${run}`,
    });
    await append(input, install);
    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    const watermark = new Date(Date.parse(input.receivedAt) + 86_400_000).toISOString();
    const tenantScope = { tenant_id: input.tenantId, app_id: input.appId };
    const definitionInput = {
      metric_definitions: SELECTED_ACQUISITION_METRIC_DEFINITIONS,
      fx_policy: { policy_version: "synthetic-selected-fx", target_currency: "USD", target_scale: 6,
        rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
          source: "synthetic-1-to-1", as_of: watermark }] },
      metric_evaluations: [{ metric_run_id_prefix: `selected-late-${run}`, input_received_at_watermark: watermark,
        computed_at: watermark, data_freshness: "complete", privacy_state: "after",
        metric_names: ["cohort_install_count"], grouping: { campaign_id: campaign } }],
    };
    const original = await computeSqlMetricRuns(pool, definitionInput, true, tenantScope);
    assert.equal(original[0].value_unscaled, "0");
    const clickAt = new Date(Date.parse(input.receivedAt) - 60_000).toISOString();
    const lateScope: Scope = { ...input, producer: "redirector",
      receivedAt: new Date(Date.parse(watermark) + 86_400_000).toISOString() };
    const click = { ...record(lateScope, "selected-late-click", "click", {
      click_id: clickId, tracking_link_id: `link-late-${run}`, campaign_id: campaign,
      network: "synthetic-network", redirector_click_at: clickAt, redirector_time_status: "available",
    }), occurred_at: clickAt };
    await append(lateScope, click);
    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    const attributions = await withTenant(pool, input.tenantId, async (client) => (await client.query(
      `SELECT artifact FROM ledger.attribution_results WHERE tenant_id=$1 AND app_id=$2`,
      [input.tenantId, input.appId],
    )).rows.map((row) => row.artifact));
    assert.ok(attributions.some((item) => item.reason_code === "unknown_click_id"));
    assert.ok(attributions.some((item) => item.reason_code === "valid_install_referrer" && item.supersedes_attribution_id));
    assert.deepEqual(await computeSqlMetricRuns(pool, definitionInput, false, tenantScope), original);
    const laterInput = structuredClone(definitionInput);
    laterInput.metric_evaluations[0].input_received_at_watermark = lateScope.receivedAt;
    laterInput.metric_evaluations[0].computed_at = lateScope.receivedAt;
    const later = await computeSqlMetricRuns(pool, laterInput, false, tenantScope);
    assert.equal(later[0].value_unscaled, "1");
    assert.notEqual(later[0].input_snapshot_id, original[0].input_snapshot_id);
    const saved = await withTenant(pool, input.tenantId, async (client) => (await client.query(
      "SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id=$3",
      [input.tenantId, input.appId, original[0].metric_run_id],
    )).rows[0].artifact);
    assert.deepEqual(saved, original[0]);
  });

  it("recovers an AdServices queue failure after base persistence and stays terminal-idempotent", async () => {
    const input = scope("adservices", "sdk-ios");
    const token = `synthetic-adservices-recovery-${run}`;
    const value = record(input, "adservices", "install", {
      installation_id: `installation:sdk-recovery-adservices-${run}`,
      install_type: "first_install",
      install_origin: "ios_first_launch",
      referrer_status: "not_applicable",
      extensions: { adservices_attribution_token_protected: token },
    });
    const recordId = String(value.record_id);
    const batchId = await append(input, value);

    await assert.rejects(processSdkInbox(pool, payloadStore, input.tenantId, {
      auxiliaryQueues: { adServices: async () => { throw new Error("synthetic_adservices_queue_failure"); } },
    }), /synthetic_adservices_queue_failure/);
    assert.equal(await ledgerCount(input, recordId), 1);
    assert.deepEqual(await batchState(input, batchId), {
      status: "processed", reason_code: SDK_POST_PROCESSING_PENDING_REASON,
    });

    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 0);
    assert.deepEqual(await batchState(input, batchId), { status: "processed", reason_code: null });
    const pending = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      token_ref: string;
    }>(
      `SELECT token_ref FROM ephemeral.adservices_lookups
        WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3`,
      [input.tenantId, input.appId, recordId],
    )).rows);
    assert.equal(pending.length, 1);
    await processSdkInbox(pool, payloadStore, input.tenantId);
    assert.equal(await ledgerCount(input, recordId), 1);

    assert.deepEqual(await processAdServicesLookups(pool, payloadStore, input.tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async () => ({ status: 400, body: Buffer.from('{"error":"synthetic_terminal"}') }),
    }), { completed: 1, retried: 0 });
    await queueAdServicesLookup(pool, {
      tenantId: input.tenantId,
      appId: input.appId,
      installRecordId: recordId,
      tokenRef: pending[0].token_ref,
      tokenCreatedAt: input.receivedAt,
    });
    const terminal = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      pending: number;
      results: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ephemeral.adservices_lookups
          WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3) AS pending,
        (SELECT count(*)::int FROM ledger.adservices_lookup_results
          WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3) AS results`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.deepEqual(terminal, { pending: 0, results: 1 });
  });

  it("recovers an integrity queue failure after base persistence and stays terminal-idempotent", async () => {
    const input = scope("integrity", "sdk-android");
    const binding = randomBytes(32).toString("base64url");
    const value = record(input, "integrity", "install", {
      installation_id: `installation:sdk-recovery-integrity-${run}`,
      install_type: "first_install",
      install_origin: "play_first_launch",
      referrer_status: "unavailable",
      extensions: {
        integrity_token_protected: `synthetic-integrity-recovery-${run}`,
        integrity_provider: "play_integrity",
        integrity_binding_mode: "challenge",
        integrity_binding: binding,
      },
    });
    const recordId = String(value.record_id);
    const batchId = await append(input, value);
    await assert.rejects(processSdkInbox(pool, payloadStore, input.tenantId, {
      auxiliaryQueues: { integrity: async () => { throw new Error("synthetic_integrity_queue_failure"); } },
    }), /synthetic_integrity_queue_failure/);
    assert.equal(await ledgerCount(input, recordId), 1);
    assert.deepEqual(await batchState(input, batchId), {
      status: "processed", reason_code: SDK_POST_PROCESSING_PENDING_REASON,
    });

    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 0);
    const queued = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      token_ref: string;
      challenge_digest: string;
    }>(
      `SELECT token_ref, challenge_digest FROM ephemeral.integrity_verifications
        WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.equal(queued.challenge_digest, createHash("sha256").update(binding, "utf8").digest("hex"));
    assert.deepEqual(await processIntegrityVerifications(pool, payloadStore, input.tenantId, {
      providerMode: "play_integrity",
      playEndpoint: "http://127.0.0.1/play-integrity",
      client: async () => ({ status: 503, body: Buffer.from("synthetic outage") }),
    }), { completed: 1, unavailable: 1 });
    await queueIntegrityVerification(pool, {
      tenantId: input.tenantId,
      appId: input.appId,
      subjectRecordId: recordId,
      provider: "play_integrity",
      tokenRef: queued.token_ref,
      bindingDigest: queued.challenge_digest,
      requestedAt: input.receivedAt,
    });
    const terminal = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      pending: number;
      results: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ephemeral.integrity_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS pending,
        (SELECT count(*)::int FROM ledger.integrity_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS results`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.deepEqual(terminal, { pending: 0, results: 1 });
  });

  it("recovers a Google Play product queue failure after base persistence and stays terminal-idempotent", async () => {
    const input = scope("google-play", "sdk-android");
    const purchaseToken = `synthetic-google-play-recovery-${run}`;
    const productId = `product.synthetic.recovery.${run}`;
    const value = record(input, "google-play", "purchase", {
      installation_id: `installation:sdk-recovery-google-play-${run}`,
      transaction_id: `transaction:sdk-recovery-google-play-${run}`,
      amount_unscaled: "990000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "pending",
      extensions: {
        google_play_purchase_token_protected: purchaseToken,
        google_play_product_id_protected: productId,
      },
    });
    const recordId = String(value.record_id);
    const batchId = await append(input, value);
    await assert.rejects(processSdkInbox(pool, payloadStore, input.tenantId, {
      auxiliaryQueues: { googlePlayProduct: async () => { throw new Error("synthetic_google_play_queue_failure"); } },
    }), /synthetic_google_play_queue_failure/);
    assert.equal(await ledgerCount(input, recordId), 1);
    assert.deepEqual(await batchState(input, batchId), {
      status: "processed", reason_code: SDK_POST_PROCESSING_PENDING_REASON,
    });

    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 0);
    const queued = await withTenant(pool, input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO control.app_link_identities (
          tenant_id, app_id, android_package_name, registered_at, artifact
        ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [input.tenantId, input.appId, `dev.openmasu.synthetic.recovery${run}`, input.receivedAt,
          JSON.stringify({ tenant_id: input.tenantId, app_id: input.appId })],
      );
      return (await client.query<{
        token_ref: string;
      }>(
        `SELECT token_ref FROM ephemeral.google_play_product_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3`,
        [input.tenantId, input.appId, recordId],
      )).rows[0];
    });
    assert.deepEqual(await processGooglePlayProductVerifications(pool, payloadStore, input.tenantId, {
      enabled: true,
      client: async () => ({ status: 400, body: Buffer.from('{"error":"synthetic_terminal"}') }),
    }), { verified: 0, failed: 1, unavailable: 0, deferred: 0 });
    await queueGooglePlayProductVerification(pool, {
      tenantId: input.tenantId,
      appId: input.appId,
      subjectRecordId: recordId,
      tokenRef: queued.token_ref,
      purchaseToken,
      productId,
      purchaseKind: "one_time_product",
      requestedAt: input.receivedAt,
    });
    const terminal = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      pending: number;
      results: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ephemeral.google_play_product_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS pending,
        (SELECT count(*)::int FROM ledger.google_play_purchase_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS results`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.deepEqual(terminal, { pending: 0, results: 1 });
  });

  it("reconstructs an available click from the normalized ledger without reopening its processed batch", async () => {
    const clickScope = scope("ledger-click", "redirector");
    const clickId = `click_${randomBytes(18).toString("base64url")}`;
    const click = record(clickScope, "ledger-click", "click", {
      click_id: clickId,
      tracking_link_id: `link-ledger-${run}`,
      campaign_id: `campaign-ledger-${run}`,
      redirector_click_at: clickScope.receivedAt,
      redirector_time_status: "available",
    });
    await append(clickScope, click);
    assert.equal(await processSdkInbox(pool, payloadStore, clickScope.tenantId), 1);

    const installAt = new Date(Date.parse(clickScope.receivedAt) + 60_000).toISOString();
    const installScope: Scope = { ...clickScope, producer: "sdk-android", receivedAt: installAt };
    const install = record(installScope, "ledger-install", "install", {
      installation_id: `installation:ledger-click-${run}`,
      install_type: "first_install",
      referrer_status: "available",
      click_id: clickId,
      install_begin_at_server_status: "available",
      install_begin_at_server: installAt,
      protected_referrer_evidence_ref: `protected:ledger-click-${run}`,
    });
    await append(installScope, install);
    const reads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(reads), installScope.tenantId), 1);
    assert.equal(reads.length, 1, "only the new install body may be decrypted");
    const attribution = await withTenant(pool, installScope.tenantId, async (client) => (await client.query<{
      reason_code: string;
    }>(
      "SELECT reason_code FROM ledger.attribution_results WHERE attribution_id=$1",
      [`attr:${String(install.record_id)}`],
    )).rows[0]);
    assert.deepEqual(attribution, { reason_code: "valid_install_referrer" });
  });

  it("keeps tombstone idempotency while excluding purged click semantics", async () => {
    const input = scope("ledger-tombstone", "redirector");
    const clickId = `click_${randomBytes(18).toString("base64url")}`;
    const original = record(input, "ledger-tombstone", "click", {
      click_id: clickId,
      tracking_link_id: `link-tombstone-${run}`,
      campaign_id: `campaign-tombstone-${run}`,
      redirector_click_at: input.receivedAt,
      redirector_time_status: "available",
    });
    await append(input, original);
    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    await purgeRecordEvidence(input, String(original.record_id));

    const laterAt = new Date(Date.parse(input.receivedAt) + 60_000).toISOString();
    const duplicateScope: Scope = { ...input, receivedAt: laterAt };
    const duplicate: Any = {
      ...record(duplicateScope, "ledger-tombstone-duplicate", "click", structuredClone(original.payload as Any)),
      event_id: original.event_id,
    };
    await append(duplicateScope, duplicate);
    const duplicateReads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(duplicateReads), input.tenantId), 1);
    assert.equal(duplicateReads.length, 1);

    const conflictScope: Scope = {
      ...input,
      receivedAt: new Date(Date.parse(laterAt) + 60_000).toISOString(),
    };
    const conflictPayload = { ...(original.payload as Any), campaign_id: `campaign-conflict-${run}` };
    const conflict: Any = {
      ...record(conflictScope, "ledger-tombstone-conflict", "click", conflictPayload),
      event_id: original.event_id,
    };
    await append(conflictScope, conflict);
    const conflictReads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(conflictReads), input.tenantId), 1);
    assert.equal(conflictReads.length, 1);

    const installScope: Scope = {
      ...input,
      producer: "sdk-android",
      receivedAt: new Date(Date.parse(conflictScope.receivedAt) + 60_000).toISOString(),
    };
    const install = record(installScope, "ledger-tombstone-install", "install", {
      installation_id: `installation:ledger-tombstone-${run}`,
      install_type: "first_install",
      referrer_status: "available",
      click_id: clickId,
      install_begin_at_server_status: "available",
      install_begin_at_server: installScope.receivedAt,
      protected_referrer_evidence_ref: `protected:ledger-tombstone-${run}`,
    });
    await append(installScope, install);
    const installReads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(installReads), input.tenantId), 1);
    assert.equal(installReads.length, 1);

    const evidence = await withTenant(pool, input.tenantId, async (client) => ({
      duplicate: (await client.query<{ duplicate_resolution: string; ingestion_status: string }>(
        `SELECT duplicate_resolution, ingestion_status FROM ledger.event_deliveries
          WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3 ORDER BY ledger_seq DESC LIMIT 1`,
        [input.tenantId, input.appId, duplicate.delivery_id],
      )).rows[0],
      conflict: (await client.query<{ duplicate_resolution: string; ingestion_status: string }>(
        `SELECT duplicate_resolution, ingestion_status FROM ledger.event_deliveries
          WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3 ORDER BY ledger_seq DESC LIMIT 1`,
        [input.tenantId, input.appId, conflict.delivery_id],
      )).rows[0],
      attribution: (await client.query<{ reason_code: string }>(
        "SELECT reason_code FROM ledger.attribution_results WHERE attribution_id=$1",
        [`attr:${String(install.record_id)}`],
      )).rows[0],
    }));
    assert.deepEqual(evidence.duplicate, { duplicate_resolution: "duplicate_delivery", ingestion_status: "accepted" });
    assert.deepEqual(evidence.conflict, { duplicate_resolution: "event_id_conflict", ingestion_status: "rejected" });
    assert.deepEqual(evidence.attribution, { reason_code: "unknown_click_id" });
  });

  it("resolves a refund against an available purchase fact without reopening the purchase batch", async () => {
    const purchaseScope = scope("ledger-commerce", "sdk-android");
    const installationId = `installation:ledger-commerce-${run}`;
    const transactionId = `transaction:ledger-commerce-${run}`;
    const purchase = record(purchaseScope, "ledger-commerce-purchase", "purchase", {
      installation_id: installationId,
      transaction_id: transactionId,
      amount_unscaled: "2500000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "settled",
    });
    await append(purchaseScope, purchase);
    assert.equal(await processSdkInbox(pool, payloadStore, purchaseScope.tenantId), 1);

    const refundScope: Scope = {
      ...purchaseScope,
      receivedAt: new Date(Date.parse(purchaseScope.receivedAt) + 60_000).toISOString(),
    };
    const refund = record(refundScope, "ledger-commerce-refund", "refund", {
      installation_id: installationId,
      transaction_id: `transaction:ledger-commerce-refund-${run}`,
      original_transaction_id: transactionId,
      amount_unscaled: "500000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "settled",
    });
    await append(refundScope, refund);
    const reads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(reads), refundScope.tenantId), 1);
    assert.equal(reads.length, 1, "only the new refund body may be decrypted");
    const correction = await withTenant(pool, refundScope.tenantId, async (client) => (await client.query<{
      corrects_record_id: string;
    }>(
      "SELECT corrects_record_id FROM ledger.corrections WHERE correction_id=$1",
      [`correction:${String(refund.record_id)}`],
    )).rows[0]);
    assert.deepEqual(correction, { corrects_record_id: purchase.record_id });
  });

  it("fails closed on an unprojected legacy consent control without reopening its encrypted body", async () => {
    const input = scope("ledger-consent-upgrade", "sdk-android");
    const installationKeyId = `installation-key-ledger-consent-${run}`;
    const sdkKeyId = `sdk-key-ledger-consent-${run}`;
    const migrationPool = createMigrationPool();
    try {
      await migrationPool.query(
        `INSERT INTO control.apps (tenant_id, app_id, created_at)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [input.tenantId, input.appId, input.receivedAt],
      );
      await migrationPool.query(
        `INSERT INTO control.sdk_keys (
           sdk_key_id, tenant_id, app_id, secret_ref, created_at, artifact
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
        [sdkKeyId, input.tenantId, input.appId, `synthetic:${sdkKeyId}`, input.receivedAt,
          JSON.stringify({ sdk_key_id: sdkKeyId, synthetic: true })],
      );
      await migrationPool.query(
        `INSERT INTO control.installation_credentials (
           installation_key_id, tenant_id, app_id, installation_id_digest,
           sdk_key_id, secret_ref, created_at, artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
        [installationKeyId, input.tenantId, input.appId,
          createHash("sha256").update(`synthetic:${installationKeyId}`).digest("hex"),
          sdkKeyId, `synthetic:${installationKeyId}`, input.receivedAt,
          JSON.stringify({ installation_key_id: installationKeyId, synthetic: true })],
      );
    } finally {
      await migrationPool.end();
    }
    const consent = record(input, "ledger-consent-upgrade", "consent_changed", {
      consent_state: "withdrawn",
      effective_at: input.receivedAt,
      consent_policy_version: "synthetic-consent-v1",
    });
    const consentBatchId = await append(input, consent, installationKeyId);
    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    const cleanupPool = createMigrationPool();
    try {
      await cleanupPool.query(
        "DELETE FROM control.installation_withdrawal_backfill_states WHERE tenant_id=$1 AND app_id=$2",
        [input.tenantId, input.appId],
      );
      await cleanupPool.query(
        "DELETE FROM control.installation_withdrawals WHERE tenant_id=$1 AND app_id=$2",
        [input.tenantId, input.appId],
      );
    } finally {
      await cleanupPool.end();
    }
    const consentBodyRef = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      body_ref: string;
    }>(
      "SELECT body_ref FROM ledger.ingest_batches WHERE ingest_batch_id=$1",
      [consentBatchId],
    )).rows[0].body_ref);
    await payloadStore.purge(consentBodyRef);

    const later: Scope = {
      ...input,
      receivedAt: new Date(Date.parse(input.receivedAt) + 60_000).toISOString(),
    };
    const purchase = record(later, "ledger-consent-later", "purchase", {
      installation_id: `installation:ledger-consent-${run}`,
      transaction_id: `transaction:ledger-consent-${run}`,
      amount_unscaled: "1000000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "settled",
    });
    const batchId = await append(later, purchase, installationKeyId);
    const reads: string[] = [];
    await assert.rejects(
      processSdkInbox(pool, countingPayloadStore(reads), input.tenantId),
      /withdrawal_projection_upgrade_required/,
    );
    assert.equal(reads.length, 1, "the unavailable historical consent body must not be reopened");
    assert.deepEqual(await batchState(input, batchId), { status: "pending", reason_code: null });
  });

  it("reads only new work instead of any lifetime processed SDK batch", async () => {
    const input = scope("bounded-history", "sdk-android");
    const installationId = `installation:sdk-bounded-history-${run}`;
    for (let index = 0; index < 24; index += 1) {
      const value = {
        ...record(input, `irrelevant-${index}`, "purchase", {
          installation_id: `${installationId}-${index}`,
          transaction_id: `transaction:sdk-bounded-history-${index}-${run}`,
          amount_unscaled: "1000000",
          amount_scale: 6,
          currency: "USD",
          financial_status: "settled",
        }),
        processing_sequence: index + 1,
      };
      await append(input, value);
      assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    }

    const current = {
      ...record(input, "current", "purchase", {
        installation_id: installationId,
        transaction_id: `transaction:sdk-bounded-history-current-${run}`,
        amount_unscaled: "2000000",
        amount_scale: 6,
        currency: "USD",
        financial_status: "settled",
      }),
      processing_sequence: 100,
    };
    await append(input, current);
    const reads: string[] = [];
    const countingStore: PayloadStore = {
      write: (scope, plaintext) => payloadStore.write(scope, plaintext),
      read: async (reference) => {
        reads.push(reference);
        return payloadStore.read(reference);
      },
      purge: (reference) => payloadStore.purge(reference),
      scanFor: (value) => payloadStore.scanFor(value),
    };
    assert.equal(await processSdkInbox(pool, countingStore, input.tenantId), 1);
    assert.equal(reads.length, 1, "one new batch must not replay any processed body");
  });
});
