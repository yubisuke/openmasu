import assert from "node:assert/strict";
import { readFileSync,mkdtempSync,rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after,it } from "node:test";
import { DEFAULT_FRAUD_BUNDLE,fraudBundleHash,type FraudBundle } from "@openmasu/fraud-rules";
import { evaluate,jcs } from "@openmasu/attribution-core";
import { createAppPool,createReaderPool,createSeedPool,EncryptedFilePayloadStore,uuidV7,withTenant } from "@openmasu/runtime";
import { ingestFixture,persistRaw,persistLogical } from "../../worker/src/test-support/fixture-ingestion.js";
import { ingestRuntimeBatch } from "../../worker/src/ingestion.js";
import { computeSqlMetricRuns } from "../../worker/src/metrics/cohort.js";
import { aggregateSourceDay } from "../../worker/src/fraud-worker.js";
import { ensureAdminKeys,verifyAdminKey,type AppAdminIdentity } from "./admin-auth.js";
import { createRequestHandler } from "./router.js";
import { previewFraudBundle } from "./fraud-preview.js";
import { activateRuleBundle } from "./rule-bundles.js";

const pool=createAppPool(),reader=createReaderPool(),seed=createSeedPool();
const root=mkdtempSync(join(tmpdir(),"openmasu-fraud-preview-"));
const store=new EncryptedFilePayloadStore(root,"synthetic-fraud-preview-master-key-0000000000");
after(async()=>{await Promise.all([pool.end(),reader.end(),seed.end()]);rmSync(root,{recursive:true,force:true});});
async function state(identity:AppAdminIdentity) {
  return withTenant(pool,identity.tenantId,async client=>(await client.query(`SELECT
    (SELECT count(*)::int FROM ledger.raw_records WHERE tenant_id=$1) AS raw,
    (SELECT count(*)::int FROM ledger.logical_events WHERE tenant_id=$1) AS logical,
    (SELECT count(*)::int FROM ledger.fraud_decisions WHERE tenant_id=$1) AS fraud,
    (SELECT count(*)::int FROM ledger.metric_runs WHERE tenant_id=$1) AS metrics,
    (SELECT count(*)::int FROM ledger.audit_logs WHERE tenant_id=$1) AS audit,
    (SELECT count(*)::int FROM control.rule_bundle_revisions WHERE tenant_id=$1) AS revisions`,[identity.tenantId])).rows[0]);
}
it("fraud_preview_uses_same_ledger_gross_net_blocks_substitution_and_stale_receipts_and_replays_recorded_revision_after_activation",{timeout:45_000},async()=>{
  const tenantId=`tenant-fraud-preview-${uuidV7().slice(-12)}`,appId="app-a",cutoff="2026-08-22T00:00:00.000Z";
  const input=JSON.parse(readFileSync("fixtures/v0.4/50-gross-net-metrics/input.json","utf8").replaceAll("tenant-a",tenantId));
  await ingestFixture(`preview-${tenantId}`,input,pool,seed);await computeSqlMetricRuns(pool,input);
  const key="synthetic-fraud-preview-admin-key-000000000000",readKey="synthetic-fraud-preview-read-key-000000000000";
  await ensureAdminKeys(pool,{tenantId,appId},[{key,role:"admin"},{key:readKey,role:"read_only"}]);
  const admin=await verifyAdminKey(pool,tenantId,`Bearer ${key}`);assert.ok(admin);
  const identity={...admin,appId};
  const candidate:FraudBundle={...structuredClone(DEFAULT_FRAUD_BUNDLE),version:"synthetic-preview-v2",
    rules:DEFAULT_FRAUD_BUNDLE.rules.map(rule=>({...rule,action:"flag"}))};
  const request={definition:candidate,watermark_at_most:cutoff};
  const server=createServer(createRequestHandler({pool,readerPool:reader,payloadStore:store,
    maxConfig:{tenantId,appId,pathSecret:"synthetic-preview-path",eventKey:"synthetic-preview-event",tokenMode:"all",maxParameters:40,maxQueryBytes:8192},
    publicBaseUrl:"http://localhost:8080",redirectorBaseUrl:"http://localhost:8090",
    dashboard:{enabled:true,publicBaseUrl:"http://localhost:8080",tenantId,sessionTtlSeconds:43_200}}));
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api=(path:string,body:unknown,authorization=key)=>fetch(base+path,{method:"POST",headers:{authorization:`Bearer ${authorization}`,"content-type":"application/json"},body:JSON.stringify(body)});
  try {
    const before=await state(identity),response=await api(`/v1/admin/apps/${appId}/rule-bundles/preview`,request);
    assert.equal(response.status,200);const preview=await response.json() as any;
    assert.equal(preview.can_activate,true,JSON.stringify(preview.issues));assert.equal(preview.writes,false);
    assert.equal(preview.active.by_action.exclude,1);assert.equal(preview.candidate.by_action.flag,1);assert.equal(preview.changed_decisions,1);
    const values=Object.fromEntries(preview.metrics.map((row:any)=>[row.fraud_policy,[row.active.value_unscaled,row.candidate.value_unscaled,row.delta_unscaled]]));
    assert.deepEqual(values,{gross:["1","1","0"],net:["0","1","1"]});
    assert.deepEqual(await state(identity),before,"valid preview writes no receipt, audit, capability or ledger state");
    for (const field of ["installation_id","record_id","payload_ref","raw_payload_ref"]) assert.equal(JSON.stringify(preview).includes(field),false);
    assert.equal((await api(`/v1/admin/apps/${appId}/rule-bundles/preview`,request,readKey)).status,403);
    assert.equal((await api("/v1/admin/apps/app-missing/rule-bundles/preview",request)).status,404);
    const activation=(definition:FraudBundle,receipt=preview)=>({rule_bundle_id:definition.id,rule_bundle_version:definition.version,
      rule_bundle_hash:fraudBundleHash(definition),definition,supersedes_rule_bundle_revision_id:receipt.baseline_revision_id,
      preview:{receipt:receipt.receipt,watermark_at_most:cutoff,baseline_revision_id:receipt.baseline_revision_id}});
    const missing=activation(candidate);delete (missing as any).preview;
    assert.equal((await api(`/v1/admin/apps/${appId}/rule-bundles`,missing)).status,400);
    const changed={...candidate,version:"synthetic-substitution"};
    assert.equal((await api(`/v1/admin/apps/${appId}/rule-bundles`,activation(changed))).status,409);
    assert.deepEqual(await state(identity),before);
    const click=structuredClone(input.records.find((record:any)=>record.event_name==="click"));
    click.record_id="click-preview-new";click.delivery_id="delivery-preview-new";click.event_id="event-preview-new";
    click.payload.click_id="synthetic_click_preview_new_0001";click.payload.bot_prefetch=false;
    const arrival=await ingestRuntimeBatch([{batch_id:"preview-new-arrival",server:input.server_context,record:click}],pool);
    assert.equal(arrival.validation_failures.length,0);assert.equal(arrival.rejections.length,0);
    assert.equal(arrival.logical_events.length,1,"the stale-receipt probe must actually add accepted evidence");
    const afterArrival=await state(identity);
    assert.equal(afterArrival.raw,before.raw+1);
    assert.equal((await api(`/v1/admin/apps/${appId}/rule-bundles`,activation(candidate))).status,409,"same values but different evidence requires a new receipt");
    assert.deepEqual(await state(identity),afterArrival);
    const fresh=await previewFraudBundle(pool,identity,request);assert.equal(fresh.can_activate,true);
    // Exercise the real session/form route as well as the bearer endpoint. The
    // login happens before the no-write snapshot; preview itself writes nothing.
    const login=await fetch(`${base}/dashboard/session`,{method:"POST",redirect:"manual",
      headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({admin_key:key})});
    assert.equal(login.status,303);
    const cookie=login.headers.get("set-cookie")!.split(";",1)[0];
    const appPage=await fetch(`${base}/dashboard/apps/${appId}`,{headers:{cookie}});
    const csrf=/name="csrf_token" value="([^"]+)"/.exec(await appPage.text())?.[1];assert.ok(csrf);
    const beforeHtml=await state(identity);
    const htmlResponse=await fetch(`${base}/dashboard/apps/${appId}/rule-bundles/preview`,{method:"POST",
      headers:{cookie,origin:"http://localhost:8080","content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({csrf_token:csrf,definition_json:JSON.stringify(candidate),watermark_at_most:cutoff})});
    assert.equal(htmlResponse.status,200);const html=await htmlResponse.text();
    assert.match(html,/Activate this reviewed candidate/);assert.ok(html.includes(fresh.receipt));
    assert.match(html,/not a fraud detection rate/);assert.doesNotMatch(html,/<script|javascript:|\son[a-z]+\s*=/i);
    assert.deepEqual(await state(identity),beforeHtml);
    const oldDecisions=await withTenant(pool,tenantId,client=>client.query("SELECT artifact FROM ledger.fraud_decisions WHERE tenant_id=$1 ORDER BY fraud_decision_id",[tenantId]));
    const accepted=await api(`/v1/admin/apps/${appId}/rule-bundles`,activation(candidate,fresh));
    assert.equal(accepted.status,201);const revision=await accepted.json() as any;
    assert.equal(revision.preview_receipt,fresh.receipt);
    const retained=await withTenant(pool,tenantId,client=>client.query("SELECT artifact FROM ledger.fraud_decisions WHERE tenant_id=$1 ORDER BY fraud_decision_id",[tenantId]));
    assert.equal(jcs(retained.rows),jcs(oldDecisions.rows),"activation never rewrites past decisions");
    const replay=await previewFraudBundle(pool,identity,{...request,baseline_revision_id:fresh.baseline_revision_id});
    assert.equal(replay.active.decision_digest,fresh.active.decision_digest,"saved revision replays the same fraud bytes");
    assert.equal(replay.candidate.decision_digest,fresh.candidate.decision_digest);
    assert.equal(replay.can_activate,false);assert.ok(replay.issues.includes("baseline_is_not_current"));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it("fraud_preview_reconstructs_retained_CTIT_inputs_for_threshold_and_negative_clock_arithmetic",async()=>{
  for (const negative of [false,true]) {
    const tenantId=`tenant-preview-ctit-${uuidV7().slice(-12)}`,appId="app-a";
    const input=JSON.parse(readFileSync("fixtures/v0.4/41-click-injection-suspected/input.json","utf8").replaceAll("tenant-a",tenantId));
    if (negative) input.records[0].payload.redirector_click_at="2026-08-19T02:00:11.000Z";
    const profiles=JSON.parse(readFileSync("fixtures/v0.4/50-gross-net-metrics/input.json","utf8"));
    input.metric_definitions=profiles.metric_definitions;
    input.metric_evaluations=profiles.metric_evaluations.map((evaluation:any)=>({...evaluation,grouping:{metric_date:"2026-08-19"}}));
    await ingestFixture(`preview-${tenantId}`,input,pool,seed);await computeSqlMetricRuns(pool,input);
    await aggregateSourceDay(pool,tenantId,"2026-08-19","2026-08-21T12:00:00.000Z");
    const key=`synthetic-ctit-admin-${tenantId}`;
    await ensureAdminKeys(pool,{tenantId,appId},[{key,role:"admin"}]);
    const admin=await verifyAdminKey(pool,tenantId,`Bearer ${key}`);assert.ok(admin);const identity={...admin,appId};
    const candidate={...structuredClone(DEFAULT_FRAUD_BUNDLE),version:"synthetic-one-second",
      layers:{...DEFAULT_FRAUD_BUNDLE.layers,base:{...DEFAULT_FRAUD_BUNDLE.layers.base,ctit_lower_bound_seconds:1}}};
    const before=await state(identity),result=await previewFraudBundle(pool,identity,{definition:candidate,watermark_at_most:"2026-08-22T00:00:00.000Z"});
    assert.equal(result.can_activate,true,JSON.stringify(result.issues));
    assert.equal(result.active.total,1);assert.equal(result.candidate.total,negative ? 1:0);
    assert.equal(result.changed_decisions,negative ? 0:1);
    if (negative) {assert.equal(result.active.by_decision?.clear,1);assert.equal(result.active.by_action?.allow,1);}
    assert.deepEqual(result.metrics.map(row=>[row.active.value_unscaled,row.candidate.value_unscaled]),[["1","1"],["1","1"]]);
    assert.deepEqual(await state(identity),before);
  }
});

it("fraud_preview_does_not_invent_missing_historical_rule_inputs_or_change_state_on_blocked_activation",async()=>{
  const tenantId=`tenant-preview-legacy-${uuidV7().slice(-12)}`,appId="app-a";
  const input=JSON.parse(readFileSync("fixtures/v0.4/50-gross-net-metrics/input.json","utf8").replaceAll("tenant-a",tenantId));
  // Stage accepted raw/logical evidence, then insert a synthetic old-format fact.
  // No UPDATE edits old immutable rows merely to manufacture the case.
  const old=evaluate(input),raw=old.raw_records.find(row=>row.event_name==="click")!,logical=old.logical_events.find(row=>row.record_id===raw.record_id)!;
  const key="synthetic-legacy-preview-admin-key-000000000000";
  await ensureAdminKeys(pool,{tenantId,appId},[{key,role:"admin"}]);
  const admin=await verifyAdminKey(pool,tenantId,`Bearer ${key}`);assert.ok(admin);const identity={...admin,appId};
  await activateRuleBundle({pool,identity,body:{rule_bundle_id:DEFAULT_FRAUD_BUNDLE.id,rule_bundle_version:DEFAULT_FRAUD_BUNDLE.version,definition:DEFAULT_FRAUD_BUNDLE}});
  await persistRaw(pool,raw,input.server_context.policy_digest);await persistLogical(pool,logical);
  await withTenant(pool,tenantId,c=>c.query(`INSERT INTO ledger.raw_payload_states
    (tenant_id,app_id,record_id,lifecycle_status,changed_at) VALUES($1,$2,$3,'available',$4)`,[tenantId,appId,raw.record_id,raw.received_at]));
  const payload=input.records.find((row:any)=>row.event_name==="click").payload;
  await withTenant(pool,tenantId,c=>c.query(`INSERT INTO ledger.click_facts
    (logical_event_id,tenant_id,app_id,click_id,redirector_click_at,artifact) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [logical.logical_event_id,tenantId,appId,payload.click_id,payload.redirector_click_at,JSON.stringify({click_id:payload.click_id,bot_prefetch:true})]));
  const before=await state(identity),request={definition:DEFAULT_FRAUD_BUNDLE,watermark_at_most:"2026-08-22T00:00:00.000Z"};
  const result=await previewFraudBundle(pool,identity,request);
  assert.equal(result.calculation_available,false);assert.equal(result.changed_decisions,null);assert.equal(result.active.total,undefined);
  assert.ok(result.issues.includes("historical_fraud_inputs_missing"));assert.equal(result.can_activate,false);
  await assert.rejects(activateRuleBundle({pool,identity,requirePreview:true,body:{rule_bundle_id:DEFAULT_FRAUD_BUNDLE.id,rule_bundle_version:DEFAULT_FRAUD_BUNDLE.version,
    definition:DEFAULT_FRAUD_BUNDLE,supersedes_rule_bundle_revision_id:result.baseline_revision_id,
    preview:{receipt:result.receipt,watermark_at_most:request.watermark_at_most}}}),/fraud_preview_blocked/);
  assert.deepEqual(await state(identity),before);
});
