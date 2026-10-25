import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash,randomBytes } from "node:crypto";
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after,describe,it } from "node:test";
import { jcs } from "@openmasu/attribution-core/canonical";
import { appendDurableBatch,applyRetention,assertMetricRetentionAvailable,createAppPool,createReaderPool,
  EncryptedFilePayloadStore,PayloadNotFoundError,previewRetention,withTenant,type PayloadStore } from "@openmasu/runtime";
import { uuidV7 } from "@openmasu/runtime";
import { payloadCapacity } from "../../runtime/src/capacity.js";
import { ensureAdminKeys,verifyAdminKey } from "../../api/src/admin-auth.js";
import { executePrivacyRequest,privacySubjectDigest } from "../../api/src/privacy.js";
import { metricReport,encodeMetricReport } from "../../api/src/reporting.js";
import { parseMetricQuery } from "../../api/src/report-query.js";
import { metricExplanation } from "../../api/src/metric-explanation.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { processSdkInbox } from "./sdk-worker.js";
import { processMaxInbox } from "./import/max-worker.js";
import { persistRawWithClient } from "./ingestion/record-repository.js";

const pool=createAppPool(),reader=createReaderPool();
const root=mkdtempSync(join(tmpdir(),"openmasu-retention-synthetic-"));
const master="synthetic-retention-master-key-000000000000000000000";
const store=new EncryptedFilePayloadStore(root,master);
const fixture=JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json","utf8"));
const now=()=>new Date("2026-08-12T00:00:00.000Z");
const policy={version:1,enabled:true,as_of:"2026-08-10T00:00:00.000Z",layers:{protected_payload:{keep_days:7},expired_request_nonces:{grace_seconds:0}}};
type Any=Record<string,any>;
after(async()=>{await Promise.all([pool.end(),reader.end()]);rmSync(root,{recursive:true,force:true});});

async function scenario() {
  const id=randomBytes(6).toString("hex"),scope={tenantId:`tenant-retention-${id}`,appId:`app-retention-${id}`};
  const sibling={...scope,appId:`${scope.appId}-other`},foreign={tenantId:`${scope.tenantId}-other`,appId:scope.appId};
  const key=`synthetic-retention-owner-${id}-${"k".repeat(32)}`;
  await ensureAdminKeys(pool,scope,[key]);
  const records: Any[]=[];
  const append=async(target:typeof scope,label:string,receivedAt:string,count=1)=>{
    const values=Array.from({length:count},(_,index)=>{
      const record=structuredClone(fixture.records.find((r:Any)=>r.record_id==="organic-install-33"));
      Object.assign(record,{tenant_id:target.tenantId,app_id:target.appId,producer:"sdk-android",producer_version:"synthetic-retention",
        record_id:`record:${id}:${label}:${index}`,delivery_id:`delivery:${id}:${label}:${index}`,event_id:`event:${id}:${label}:${index}`,
        processing_purpose_id:"attribution",occurred_at_source:"device",occurred_at:receivedAt,received_at:receivedAt});
      delete record.payload.import_context; record.payload.installation_id=`installation:${id}:${label}:${index}`;
      records.push(record);return record;
    });
    return appendDurableBatch(pool,store,{...target,producer:"sdk-android",body:Buffer.from(JSON.stringify({records:values})),eventCount:count,receivedAt});
  };
  const batches=[await append(scope,"old-a","2026-08-01T00:00:00.000Z",2),await append(scope,"old-b","2026-08-01T01:00:00.000Z"),
    await append(scope,"boundary","2026-08-03T00:00:00.000Z"),await append(sibling,"sibling","2026-08-01T00:00:00.000Z"),
    await append(foreign,"foreign","2026-08-01T00:00:00.000Z")];
  assert.equal(await processSdkInbox(pool,store,scope.tenantId),4);
  assert.equal(await processSdkInbox(pool,store,foreign.tenantId),1);
  await append(scope,"pending","2026-08-01T02:00:00.000Z");
  await withTenant(pool,scope.tenantId,async client=>{
    for(const [index,expires] of ["2026-08-09T00:00:00.000Z",policy.as_of,"2026-08-11T00:00:00.000Z"].entries())
      await client.query(`INSERT INTO ephemeral.request_nonces (tenant_id,app_id,principal_type,principal_key_id,nonce,timestamp_ms,created_at,expires_at)
        VALUES ($1,$2,'sdk_key','synthetic-retention-key',$3,1,'2026-08-01T00:00:00Z',$4)`,[scope.tenantId,scope.appId,`synthetic_nonce_${id}_${index}`,expires]);
  });
  const runs=await computeSqlMetricRuns(pool,{fx_policy:fixture.fx_policy,metric_definitions:fixture.metric_definitions,
    metric_evaluations:[{...fixture.metric_evaluations[0],metric_names:["cohort_install_count"],metric_run_id_prefix:`retention:${id}`,
      grouping:{cohort_date:"2026-08-01"}}]},true,{tenant_id:scope.tenantId,app_id:scope.appId});
  assert.equal(runs[0]!.value_unscaled,"3");
  const identity=await verifyAdminKey(pool,scope.tenantId,`Bearer ${key}`);assert.ok(identity);
  const scopedIdentity={...identity,appId:scope.appId};
  const rows=await withTenant(pool,scope.tenantId,client=>client.query<{ingest_batch_id:string;body_ref:string}>(
    "SELECT ingest_batch_id::text,body_ref FROM ledger.ingest_batches WHERE tenant_id=$1 AND ingest_batch_id=ANY($2::uuid[])",[scope.tenantId,batches.slice(0,4)]));
  const bodies=new Map(rows.rows.map(row=>[row.ingest_batch_id,row.body_ref]));
  const foreignBody=await withTenant(pool,foreign.tenantId,c=>c.query<{body_ref:string}>("SELECT body_ref FROM ledger.ingest_batches WHERE ingest_batch_id=$1",[batches[4]]));
  bodies.set(batches[4]!,foreignBody.rows[0]!.body_ref);
  const otherStates=async()=>jcs(await Promise.all([sibling,foreign].map(target=>withTenant(pool,target.tenantId,async c=>(await c.query(
    "SELECT record_id,payload_lifecycle_status FROM ledger.raw_records_current WHERE tenant_id=$1 AND app_id=$2 ORDER BY record_id",[target.tenantId,target.appId])).rows))));
  const file=join(root,`synthetic-policy-${id}.json`);writeFileSync(file,JSON.stringify(policy));
  const cli=(command:string,extra:string[]=[])=>{
    const env:NodeJS.ProcessEnv={...process.env,OPENMASU_ADMIN_KEY:key,OPENMASU_PAYLOAD_MASTER_KEY:master,OPENMASU_PAYLOAD_STORE_DIR:root};
    delete env.OPENMASU_ADMIN_KEY_FILE;delete env.OPENMASU_PAYLOAD_MASTER_KEY_FILE;
    const script=process.env.npm_execpath;
    const args=[command,`--tenant=${scope.tenantId}`,`--app=${scope.appId}`,`--policy=${file}`,...extra];
    return JSON.parse(execFileSync(process.execPath,script?[script,"run","--silent","ops:retention","--",...args]
      :["--import","tsx","apps/api/src/retention-cli.ts",...args],{env,encoding:"utf8"}));
  };
  const immutable=()=>withTenant(pool,scope.tenantId,async client=>{
    const output:Any={};
    for(const table of ["raw_records","event_deliveries","logical_events","attribution_results","metric_runs","privacy_requests","privacy_tombstones"])
      output[table]=(await client.query(`SELECT to_jsonb(item) AS row FROM ledger.${table} AS item WHERE tenant_id=$1 ORDER BY to_jsonb(item)::text`,[scope.tenantId])).rows;
    output.bundles=(await client.query("SELECT to_jsonb(item) AS row FROM control.rule_bundle_revisions AS item WHERE tenant_id=$1 ORDER BY to_jsonb(item)::text",[scope.tenantId])).rows;
    return jcs(output);
  });
  return {scope,sibling,foreign,key,runs,identity:scopedIdentity,bodies,batches,cli,immutable,otherStates};
}

describe("explicit synthetic retention expiry",{concurrency:false},()=>{
  it("retention_cli_dry_run_exact_boundaries_frozen_resume_storage_and_reader_status_without_history_rewrite",{timeout:30000},async()=>{
    const test=await scenario(),before=await test.immutable(),others=await test.otherStates();
    const oldCapacity=await payloadCapacity(root),preview=test.cli("preview");
    assert.deepEqual(preview.layers,{protected_payload:2,expired_request_nonces:1});assert.equal(preview.dependent_runs,1);
    assert.equal(preview.writes,false);assert.equal(preview.blocked,false);assert.equal(preview.has_more_candidates,false);
    assert.equal(await test.immutable(),before);
    assert.equal(await test.otherStates(),others);
    assert.equal((await withTenant(pool,test.scope.tenantId,c=>c.query("SELECT 1 FROM control.retention_receipts WHERE tenant_id=$1",[test.scope.tenantId]))).rowCount,0);
    for(const value of [...test.bodies.values(),test.runs[0]!.metric_run_id,"synthetic_nonce_"])assert.ok(!JSON.stringify(preview).includes(value));
    const broken:PayloadStore={write:store.write.bind(store),read:store.read.bind(store),scanFor:store.scanFor.bind(store),
      purge:async ref=>{await store.purge(ref);throw Error("synthetic interruption after physical deletion");}};
    const interrupted=await applyRetention({pool,payloadStore:broken,scope:test.scope,policy,receipt:preview.receipt,maximumItems:1,now});
    assert.equal(interrupted.remaining,3);assert.equal(interrupted.failed,1);assert.equal(interrupted.completed,0);
    await withTenant(pool,test.scope.tenantId,async client=>{
      await assertMetricRetentionAvailable(client,{tenant_id:test.scope.tenantId,app_id:test.scope.appId},test.runs[0]!.metric_run_id)
        .then(()=>assert.fail("expired evidence must not replay"),error=>assert.match(error.message,/input_unavailable/));
    });
    const bounded=test.cli("apply",[`--receipt=${preview.receipt}`,"--limit=1"]);
    assert.equal(bounded.processed,1);assert.equal(bounded.completed,1);assert.equal(bounded.remaining,2);
    const complete=test.cli("apply",[`--receipt=${preview.receipt}`,"--limit=100"]);
    assert.equal(complete.completed,3);assert.equal(complete.remaining,0);assert.equal(complete.skipped_changed,0);
    const repeated=test.cli("apply",[`--receipt=${preview.receipt}`,"--limit=100"]);
    assert.equal(repeated.processed,0);assert.equal(repeated.completed,3);
    assert.equal(await test.immutable(),before);
    const newCapacity=await payloadCapacity(root);
    for(const layer of ["objects","keys"]){
      const old=oldCapacity.layers.find(l=>l.layer.includes(layer))!,next=newCapacity.layers.find(l=>l.layer.includes(layer))!;
      assert.equal(old.count.state,"exact");assert.equal(next.count.state,"exact");
      assert.equal(BigInt(old.count.value)-BigInt(next.count.value),2n);
    }
    for(const batch of test.batches.slice(0,2))await assert.rejects(store.read(test.bodies.get(batch)!),PayloadNotFoundError);
    await store.read(test.bodies.get(test.batches[2]!)!);await store.read(test.bodies.get(test.batches[3]!)!);
    await store.read(test.bodies.get(test.batches[4]!)!);assert.equal(await test.otherStates(),others);
    const remaining=await withTenant(pool,test.scope.tenantId,c=>c.query("SELECT expires_at FROM ephemeral.request_nonces WHERE tenant_id=$1 AND app_id=$2 ORDER BY expires_at",[test.scope.tenantId,test.scope.appId]));
    assert.equal(remaining.rowCount,2);
    const query=parseMetricQuery({tenantId:test.scope.tenantId,appId:test.scope.appId,searchParams:new URLSearchParams()}).query;
    const report=await metricReport(reader,test.identity,query);
    assert.equal(report.data[0]!.value_unscaled,"3");assert.equal(report.data[0]!.reproducibility_status,"retention_affected");
    assert.match(encodeMetricReport(report,"csv").body,/retention_affected/);
    assert.equal((await metricExplanation(reader,test.identity,test.runs[0]!.metric_run_id))?.evidence_state,"retention_affected");
    const inventory=await withTenant(reader,test.scope.tenantId,c=>c.query("SELECT candidate_count,dependent_run_count FROM control.retention_receipts WHERE receipt_digest=$1",[preview.receipt]));
    assert.deepEqual(inventory.rows,[{candidate_count:3,dependent_run_count:1}]);
    const targets=await withTenant(pool,test.scope.tenantId,c=>c.query("SELECT target FROM control.retention_items WHERE receipt_digest=$1",[preview.receipt]));
    assert.ok(!JSON.stringify(targets.rows).includes("synthetic_nonce_"));
    await assert.rejects(withTenant(reader,test.scope.tenantId,c=>c.query("SELECT target FROM control.retention_items")),/permission denied/);
  });

  it("retention_receipt_refuses_policy_and_target_substitution_and_privacy_wins_during_physical_purge",{timeout:30000},async()=>{
    const test=await scenario(),preview=await previewRetention(pool,test.scope,policy,now());
    const disabled=await previewRetention(pool,test.scope,{...policy,enabled:false},now());assert.equal(disabled.candidates,0);
    await assert.rejects(applyRetention({pool,payloadStore:store,scope:test.scope,policy:{...policy,layers:{protected_payload:{keep_days:8}}},receipt:preview.receipt,now}),/receipt_mismatch/);
    let enter!:()=>void,resume!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
    const gated:PayloadStore={write:store.write.bind(store),read:store.read.bind(store),scanFor:store.scanFor.bind(store),purge:async ref=>{enter();await gate;await store.purge(ref);}};
    const execution=applyRetention({pool,payloadStore:gated,scope:test.scope,policy,receipt:preview.receipt,maximumItems:1,now});
    await Promise.race([entered,execution.then(()=>assert.fail("the synthetic purge must reach its interruption gate"))]);
    try{
      await assert.rejects(withTenant(pool,test.scope.tenantId,c=>c.query("UPDATE control.retention_items SET target='{}' WHERE receipt_digest=$1",[preview.receipt])),/immutable/);
      const body={tenant_id:test.scope.tenantId,app_id:test.scope.appId,requested_via:"tenant_admin_api" as const,deletion_scope:"app" as const,deletion_subject_ref:test.scope.appId};
      const privacy=await executePrivacyRequest(pool,{...test.identity,deletionSubjectDigest:privacySubjectDigest("synthetic-retention-privacy-digest",body)},body,store,now());
      assert.equal(privacy.status,"completed");
    }finally{resume();}
    const progress=await execution;assert.equal(progress.completed,1);
    const report=await metricReport(reader,test.identity,parseMetricQuery({tenantId:test.scope.tenantId,appId:test.scope.appId,searchParams:new URLSearchParams()}).query);
    assert.equal(report.data[0]!.reproducibility_status,"redaction_affected");assert.equal(report.data[0]!.value_state,"unavailable");
    assert.equal((await previewRetention(pool,test.scope,policy,now())).writes,false);
    await store.read(test.bodies.get(test.batches[3]!)!);
    await store.read(test.bodies.get(test.batches[4]!)!);
    const tombstones=await withTenant(reader,test.scope.tenantId,c=>c.query("SELECT 1 FROM ledger.privacy_tombstones WHERE tenant_id=$1",[test.scope.tenantId]));
    assert.ok(tombstones.rowCount!>0);
  });

  it("retention_frozen_nonce_replacement_and_new_raw_MAX_objects_require_a_new_preview",{timeout:30000},async()=>{
    const test=await scenario(),preview=await previewRetention(pool,test.scope,policy,now());
    const first=await applyRetention({pool,payloadStore:store,scope:test.scope,policy,receipt:preview.receipt,maximumItems:1,now});
    assert.equal(first.remaining,2);
    // Nonces deliberately have no UPDATE privilege. Replace with the same key
    // and a new lifetime, as an independent insertion would do.
    await withTenant(pool,test.scope.tenantId,async c=>{
      const old=(await c.query<any>("DELETE FROM ephemeral.request_nonces WHERE tenant_id=$1 AND app_id=$2 AND expires_at<'2026-08-10T00:00:00Z' RETURNING *",[test.scope.tenantId,test.scope.appId])).rows[0];
      await c.query(`INSERT INTO ephemeral.request_nonces (tenant_id,app_id,principal_type,principal_key_id,nonce,timestamp_ms,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'2027-08-01T00:00:00Z')`,[old.tenant_id,old.app_id,old.principal_type,old.principal_key_id,old.nonce,old.timestamp_ms,old.created_at]);
    });
    const direct=structuredClone(JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/expected_raw_records.json","utf8"))[0]);
    Object.assign(direct,{tenant_id:test.scope.tenantId,app_id:test.scope.appId,record_id:`direct:${uuidV7()}`,
      received_at:"2026-08-01T00:00:00.000Z",raw_payload_ref:await store.write({...test.scope,objectId:"synthetic-direct-raw"},Buffer.from("synthetic direct raw payload"))});
    const inboxId=uuidV7(),query=new URLSearchParams({revenue:"1.25",cc:"JP",network:"synthetic-network",ad_unit_id:"synthetic-ad-unit",ts:"1785542400"});
    const bytes=Buffer.from(query.toString()),maxRef=await store.write({...test.scope,objectId:`synthetic-max-${inboxId}`},bytes);
    await withTenant(pool,test.scope.tenantId,async c=>{
      await persistRawWithClient(c,direct,"synthetic-retention-policy");
      await c.query("INSERT INTO ledger.raw_payload_states (tenant_id,app_id,record_id,lifecycle_status,changed_at) VALUES ($1,$2,$3,'available','2026-08-01T00:00:00.000Z')",[test.scope.tenantId,test.scope.appId,direct.record_id]);
      await c.query(`INSERT INTO ledger.ingest_inbox (inbox_id,tenant_id,app_id,producer,event_id,token_mode,received_at,raw_query_ref,raw_query_digest,artifact)
        VALUES ($1,$2,$3,'import:applovin-max',$4,'all','2026-08-01T00:00:00.000Z',$5,$6,'{}')`,
      [inboxId,test.scope.tenantId,test.scope.appId,`synthetic-max:${inboxId}`,maxRef,createHash("sha256").update(bytes).digest("hex")]);
      await c.query(`INSERT INTO ledger.ingest_inbox_states (inbox_id,tenant_id,app_id,status,changed_at,artifact)
        VALUES ($1,$2,$3,'pending','2026-08-01T00:00:00.000Z','{}')`,[inboxId,test.scope.tenantId,test.scope.appId]);
    });
    assert.equal(await processMaxInbox(pool,store,test.scope.tenantId),1);
    const finished=await applyRetention({pool,payloadStore:store,scope:test.scope,policy,receipt:preview.receipt,maximumItems:100,now});
    assert.equal(finished.completed,2);assert.equal(finished.skipped_changed,1);assert.equal(finished.remaining,0);
    await store.read(direct.raw_payload_ref);await store.read(maxRef);
    const next=await previewRetention(pool,test.scope,policy,now());assert.equal(next.layers.protected_payload,2);assert.equal(next.layers.expired_request_nonces,0);
    assert.notEqual(next.receipt,preview.receipt);
    const done=await applyRetention({pool,payloadStore:store,scope:test.scope,policy,receipt:next.receipt,maximumItems:100,now});assert.equal(done.completed,2);
    await assert.rejects(store.read(direct.raw_payload_ref),PayloadNotFoundError);await assert.rejects(store.read(maxRef),PayloadNotFoundError);
    const nonces=await withTenant(pool,test.scope.tenantId,c=>c.query("SELECT 1 FROM ephemeral.request_nonces WHERE tenant_id=$1 AND app_id=$2",[test.scope.tenantId,test.scope.appId]));
    assert.equal(nonces.rowCount,3);
    await withTenant(pool,test.scope.tenantId,c=>c.query(`INSERT INTO ephemeral.request_nonces
      (tenant_id,app_id,principal_type,principal_key_id,nonce,timestamp_ms,created_at,expires_at)
      SELECT $1,$2,'sdk_key','synthetic-retention-key','synthetic_paged_nonce_'||lpad(value::text,8,'0'),1,
        '2026-08-01T00:00:00Z','2026-08-09T00:00:00Z' FROM generate_series(1,1001) AS value`,[test.scope.tenantId,test.scope.appId]));
    const page=await previewRetention(pool,test.scope,policy,now());assert.equal(page.candidates,1000);assert.equal(page.has_more_candidates,true);
  });
});
