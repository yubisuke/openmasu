import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after,beforeEach,describe,it } from "node:test";
import { jcs,sha256,type CandidateAttempt } from "@openmasu/attribution-core";
import { basisAcquisitionKpiDefinitions, horizonAcquisitionKpiDefinitions } from "@openmasu/contracts/definitions";
import { createAppPool,createReaderPool,createSeedPool,withTenant } from "@openmasu/runtime";
import { saveMetricCorrectionPolicy,metricCorrectionStatus } from "../../api/src/metric-correction-policy.js";
import { listMetricRecalculations, requestMetricRecalculation } from "../../api/src/metric-recalculations.js";
import { metricReport } from "../../api/src/reporting.js";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { ingestRuntimeBatch } from "./ingestion.js";
import { persistAttributionWithClient } from "./ingestion/derived-repository.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { persistCostImport } from "./import/cost.js";
import { planAutomaticMetricCorrections } from "./automatic-metric-corrections.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";

type Any=Record<string,any>;
describe("opt-in receipt-driven bounded automatic metric corrections",{concurrency:false},()=>{
  const app=createAppPool(),reader=createReaderPool(),seed=createSeedPool();
  let identity:{tenantId:string;appId:string;keyId:string;role:"admin"},input:Any,initial:Any,originals:Any[],history:CandidateAttempt[];
  const policy={enabled:true,date_from:"2026-08-06",date_to:"2026-08-07",runs_per_page:2,receipts_per_cycle:2,maximum_runs_per_receipt:200};
  beforeEach(async()=>{
    const tenant=`tenant-auto-${randomBytes(5).toString("hex")}`;
    identity={tenantId:tenant,appId:"app-a",keyId:"synthetic-auto-admin",role:"admin"};
    input=JSON.parse(readFileSync("fixtures/v0.4/60-selected-commerce/input.json","utf8").replaceAll('"tenant-a"',JSON.stringify(tenant)));
    initial=structuredClone(input); initial.records=[initial.records[0],initial.records[1],initial.records[3]];
    const install=structuredClone(initial.records[1]),purchase=structuredClone(initial.records[2]);
    for (const row of [install,purchase]) {
      for (const key of ["record_id","event_id","delivery_id"]) row[key]+="-synthetic-day2";
      row.occurred_at=row.occurred_at.replace("2026-08-06","2026-08-07");
      row.payload.installation_id="installation:synthetic-day2";
    }
    install.payload.install_begin_at_server=install.payload.install_begin_at_server.replace("2026-08-06","2026-08-07");
    purchase.payload.transaction_id+="-synthetic-day2";purchase.payload.original_transaction_id+="-synthetic-day2";
    initial.records.push(install,purchase); initial.metric_evaluations=[];
    await ingestFixture(`synthetic-auto-${tenant}`,initial,app,seed);
    await persistCostImport(app,"synthetic-auto-day2-cost",[{tenant_id:tenant,app_id:"app-a",network:"synthetic-network",campaign_id:"campaign-a",
      date:"2026-08-07",amount_unscaled:"10000000",amount_scale:6,currency:"USD",source:"imported_reported",as_of:"2026-08-12T00:00:00.000Z"}]);
    input.metric_evaluations=["2026-08-06","2026-08-07"].map((day,index)=>({...input.metric_evaluations[0],
      metric_run_id_prefix:`synthetic-auto-original-${index}`,privacy_state:"after",metric_names:["d30_total_net_roas"],
      grouping:{campaign_id:"campaign-a",network:"synthetic-network",cohort_date:day}}));
    originals=await computeSqlMetricRuns(app,{...initial,metric_evaluations:input.metric_evaluations},true);
    await computeSqlMetricRuns(app,{...initial,metric_evaluations:[{...input.metric_evaluations[0],
      metric_run_id_prefix:"synthetic-auto-unrelated",grouping:{...input.metric_evaluations[0].grouping,campaign_id:"synthetic-unrelated"}}]},true);
    history=initial.records.map((record:Any)=>({server:initial.server_context,record,batch_id:"synthetic-auto-initial"}));
    assert.deepEqual(originals.map(r=>r.value_unscaled),["1000000","1000000"]);
  });
  after(async()=>{await Promise.all([app.end(),reader.end(),seed.end()]);});
  const artifacts=()=>withTenant(app,identity.tenantId,async client=>(await client.query("SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id",[identity.tenantId,identity.appId])).rows.map(r=>r.artifact));
  async function revenue(id:string,day=0,received="2026-08-13T00:00:00.000Z") {
    const record={...structuredClone(input.records[2]),record_id:id,delivery_id:`delivery:${id}`,event_id:`event:${id}`,received_at:received};
    if (day) {record.occurred_at=record.occurred_at.replace("2026-08-06","2026-08-07");record.payload.installation_id="installation:synthetic-day2";}
    const attempt:CandidateAttempt={server:{...input.server_context,received_at:received},record,batch_id:`batch:${id}`};
    const result=await ingestRuntimeBatch([attempt],app,history);assert.equal(result.rejections.length,0);history.push(attempt);return attempt;
  }
  async function drain(maximum=200) {
    for (let i=0;i<maximum;i++) {
      await planAutomaticMetricCorrections(app,identity.tenantId);
      await processMetricRecalculations(app,identity.tenantId,10);
      const remaining=await withTenant(app,identity.tenantId,async client=>(await client.query(`SELECT
        (SELECT count(*) FROM control.metric_correction_receipts WHERE tenant_id=$1 AND app_id=$2 AND state IN ('queued','retry'))+
        (SELECT count(*) FROM control.metric_recalculation_items WHERE tenant_id=$1 AND app_id=$2 AND state IN ('queued','processing','retry')) AS count`,[identity.tenantId,identity.appId])).rows[0].count);
      if (remaining==="0") return;
      // Advance only test checkpoints, not clocks or source evidence; no sleep/retry masking.
      await withTenant(app,identity.tenantId,client=>client.query(`UPDATE control.metric_correction_receipts
        SET next_attempt_at=clock_timestamp() WHERE tenant_id=$1 AND app_id=$2 AND safe_reason='waiting_for_predecessor'`,[identity.tenantId,identity.appId]));
    }
    throw Error("synthetic_auto_drain_exceeded");
  }

  it("corrects two days of late revenue then cost and selected attribution revisions once without touching unrelated runs",async()=>{
    assert.equal((await metricCorrectionStatus(reader,identity)).policy,null);
    await saveMetricCorrectionPolicy(app,identity,policy);
    await revenue("synthetic-auto-revenue-1");await drain();
    await revenue("synthetic-auto-revenue-2",1,"2026-08-14T00:00:00.000Z");await drain();
    let latest=(await metricReport(reader,identity,{tenantId:identity.tenantId,appId:identity.appId,supersession:"latest",limit:100})).data;
    assert.deepEqual(latest.filter(r=>r.grouping.campaign_id==="campaign-a").map(r=>r.value_unscaled),["3000000","3000000"]);
    await persistCostImport(app,"synthetic-auto-cost-revision",["2026-08-06","2026-08-07"].map(date=>({tenant_id:identity.tenantId,app_id:identity.appId,
      network:"synthetic-network",campaign_id:"campaign-a",date,amount_unscaled:"20000000",amount_scale:6,currency:"USD",
      source:"imported_reported" as const,as_of:"2026-08-15T00:00:00.000Z"})));
    await drain();
    latest=(await metricReport(reader,identity,{tenantId:identity.tenantId,appId:identity.appId,supersession:"latest",limit:100})).data;
    assert.deepEqual(latest.filter(r=>r.grouping.campaign_id==="campaign-a").map(r=>r.value_unscaled),["1500000","1500000"]);
    const revision=await withTenant(app,identity.tenantId,async client=>{
      const previous=(await client.query(`SELECT artifact FROM ledger.attribution_results WHERE tenant_id=$1 AND app_id=$2
        AND subject_ref='installation:install-1' ORDER BY decided_at DESC,attribution_id DESC LIMIT 1`,[identity.tenantId,identity.appId])).rows[0].artifact;
      const value={...previous,attribution_id:"attr:synthetic-auto-organic-revision",supersedes_attribution_id:previous.attribution_id,
        status:"organic",method:"none",model:"none",reason_code:"no_referrer",decided_at:"2026-08-16T00:00:00.000Z",
        input_cutoff_at:"2026-08-16T00:00:00.000Z",evidence_refs:previous.evidence_refs.filter((e:Any)=>e.ref!=="click-1")};
      await persistAttributionWithClient(client,value);return value;
    });
    await drain();
    const jobs=await listMetricRecalculations(reader,identity);
    assert.equal(jobs.filter(j=>j.trigger_kind==="attribution_revision" && j.state==="completed").length,1);
    assert.equal(jobs.filter(j=>j.trigger_kind==="cost_revision" && j.state==="completed").length,2);
    assert.equal(jobs.filter(j=>j.trigger_kind==="late_events" && j.state==="completed").length,2);
    const saved=await artifacts();
    assert.equal(saved.filter(r=>r.supersedes_metric_run_id).length,5);
    for (const old of originals) assert.equal(jcs(saved.find(r=>r.metric_run_id===old.metric_run_id)),jcs(old));
    assert.equal(saved.filter(r=>r.metric_run_id==="synthetic-auto-unrelated:d30_total_net_roas").length,1);
    assert.ok(!saved.some(r=>r.supersedes_metric_run_id==="synthetic-auto-unrelated:d30_total_net_roas"));
    await withTenant(app,identity.tenantId,client=>persistAttributionWithClient(client,revision));await drain();
    assert.equal((await artifacts()).length,saved.length);
    const status=await metricCorrectionStatus(reader,identity);
    assert.equal(status.upstream_completeness,"unknown");
    assert.doesNotMatch(JSON.stringify(status),/source_ref|installation:|payload_sha256|lease_token|root_id|transaction_id/);
    assert.equal((await metricCorrectionStatus(reader,{...identity,tenantId:"tenant-unrelated"})).policy,null);
  });

  it("corrects the complete imported acquisition KPI set for manual cost and automatic late receipts at one saved cutoff", async () => {
    const fixture = JSON.parse(readFileSync("fixtures/v0.4/67-imported-provider-acquisition/input.json", "utf8")
      .replaceAll('"tenant-a"', JSON.stringify(identity.tenantId)));
    const definitions = basisAcquisitionKpiDefinitions("selected_imported_provider", "synthetic-export");
    const names = definitions.map(d => d.metric_name), originalCost = fixture.cost_records[0];
    const evaluation = { ...fixture.metric_evaluations[0], metric_names: names,
      metric_run_id_prefix: `synthetic-basis-${identity.tenantId}`, privacy_state: "after" };
    fixture.metric_definitions = definitions; fixture.metric_evaluations = []; fixture.cost_records = [];
    await ingestFixture(`synthetic-basis-${identity.tenantId}`, fixture, app, seed);
    await persistCostImport(app, "synthetic-basis-original-cost", [originalCost]);
    const before = await computeSqlMetricRuns(app, { ...fixture, metric_evaluations: [evaluation] }, true);
    assert.equal(before.length, 8); assert.equal(new Set(before.map(r => r.input_snapshot_id)).size, 1);
    const revision = await persistCostImport(app, "synthetic-basis-revised-cost", [{ ...originalCost,
      amount_unscaled: "8000000", as_of: "2026-08-16T00:00:00.000Z" }]);
    const manual = await requestMetricRecalculation(app, identity, { cost_import_run_id: revision.import_run_id,
      date_from: "2026-08-06", date_to: "2026-08-06", watermark: "2026-08-17T00:00:00.000Z",
      metric_names: ["imported_acquisition_d7_ad_roas"] });
    assert.equal(manual.selected_runs, 8);
    assert.deepEqual(await processMetricRecalculations(app, identity.tenantId, 10), { completed: 8, skipped: 0, fenced: 0, failed: 0 });
    const current = () => metricReport(reader, identity, { tenantId: identity.tenantId, appId: identity.appId,
      metricNames: names, supersession: "latest", limit: 100 });
    const costCorrected = (await current()).data;
    assert.equal(costCorrected.length, 8);
    assert.equal(costCorrected.find(r => r.metric_name === "imported_acquisition_d7_cost")!.value_unscaled, "8000000");
    assert.equal(costCorrected.find(r => r.metric_name === "imported_acquisition_d7_cpi")!.value_unscaled, "8000000");
    assert.equal(costCorrected.find(r => r.metric_name === "imported_acquisition_d7_ad_roas")!.value_unscaled, "250000");
    assert.equal(new Set(costCorrected.map(r => r.input_snapshot_id)).size, 1);
    assert.ok(costCorrected.every(r => r.input_received_at_watermark === "2026-08-17T00:00:00.000Z"));
    await saveMetricCorrectionPolicy(app, identity, { ...policy, date_to: "2026-08-06", runs_per_page: 8,
      metric_names: ["imported_acquisition_d7_ad_roas"] });
    const record = { ...structuredClone(fixture.records.find((r: Any) => r.record_id === "revenue-paid-67")),
      record_id: "synthetic-basis-late", event_id: "synthetic-basis-late", delivery_id: "synthetic-basis-late",
      received_at: "2026-08-18T00:00:00.000Z" };
    const attempts = fixture.records.map((record: Any) => ({ record, server: fixture.server_context, batch_id: "synthetic-basis-original" }));
    const admitted = await ingestRuntimeBatch([{ record, server: { ...fixture.server_context, received_at: record.received_at },
      batch_id: "synthetic-basis-late" }], app, attempts);
    assert.equal(admitted.rejections.length, 0);
    await drain();
    const corrected = (await current()).data;
    assert.equal(corrected.length, 8);
    assert.equal(corrected.find(r => r.metric_name === "imported_acquisition_d7_ad_roas")!.value_unscaled, "500000");
    assert.equal(new Set(corrected.map(r => r.input_snapshot_id)).size, 1);
    assert.equal(new Set(corrected.map(r => r.input_received_at_watermark)).size, 1);
    assert.equal(new Set(corrected.map(r => r.acquisition_kpi_set_key)).size, 1);
    assert.ok(corrected.every(r => r.acquisition_kpi_set_key && r.comparison_context?.privacy_state === "after"
      && r.comparison_context.definition.import_provider === "synthetic-export"
      && r.comparison_context.fx_digest === costCorrected[0].comparison_context!.fx_digest));
    assert.equal((await listMetricRecalculations(reader, identity)).filter(j => j.trigger_kind === "late_events" && j.state === "completed").length, 8);
    const stored = await artifacts();
    for (const original of before) assert.equal(jcs(stored.find(r => r.metric_run_id === original.metric_run_id)), jcs(original));
  });

  it("corrects only in-window horizon companions for late revenue and explicitly selected cost horizons without rewriting native D7", async () => {
    const fixture = JSON.parse(readFileSync("fixtures/v0.4/70-saved-acquisition-kpis/input.json", "utf8")
      .replaceAll('"tenant-a"', JSON.stringify(identity.tenantId)));
    const d0 = horizonAcquisitionKpiDefinitions(0), d30 = horizonAcquisitionKpiDefinitions(30);
    const names = [...d0, ...d30].map(d => d.metric_name), costs = fixture.cost_records;
    const native = { ...fixture.metric_evaluations[0], metric_run_id_prefix: "synthetic-horizon-frozen-d7", privacy_state: "after" };
    const horizon = { ...native, metric_run_id_prefix: "synthetic-horizon-initial", metric_names: names,
      input_received_at_watermark: "2026-09-07T00:00:00.000Z", computed_at: "2026-09-07T00:00:00.000Z" };
    fixture.metric_definitions.push(...d0, ...d30); fixture.metric_evaluations = []; fixture.cost_records = [];
    await ingestFixture(`synthetic-horizon-${identity.tenantId}`, fixture, app, seed);
    for (const cost of costs) await persistCostImport(app, "synthetic-horizon-original-cost", [cost]);
    const before = await computeSqlMetricRuns(app, { ...fixture, metric_evaluations: [native, horizon] }, true);
    assert.equal(before.length, 24);
    const record = { ...structuredClone(fixture.records.find((r: Any) => r.record_id === "kpi70-ad-a")),
      record_id: "synthetic-horizon-late", event_id: "synthetic-horizon-late", delivery_id: "synthetic-horizon-late",
      occurred_at: "2026-08-08T00:00:00.000Z", received_at: "2026-09-08T00:00:00.000Z" };
    const attempts = fixture.records.map((record: Any) => ({ record, server: fixture.server_context, batch_id: "synthetic-horizon-original" }));
    const admitted = await ingestRuntimeBatch([{ record, server: { ...fixture.server_context, received_at: record.received_at },
      batch_id: "synthetic-horizon-late" }], app, attempts);
    assert.equal(admitted.rejections.length, 0);
    const late = await requestMetricRecalculation(app, identity, { trigger_kind: "late_events", source_record_ids: [record.record_id],
      date_from: "2026-08-06", date_to: "2026-08-06", watermark: record.received_at,
      metric_names: ["acquisition_d0_ad_roas", "acquisition_d30_ad_roas"] });
    assert.equal(late.selected_runs, 8);
    assert.deepEqual(await processMetricRecalculations(app, identity.tenantId, 10), { completed: 8, skipped: 0, fenced: 0, failed: 0 });
    const afterLate = await artifacts(), replacements = afterLate.filter(r => r.supersedes_metric_run_id);
    assert.equal(replacements.length, 8); assert.ok(replacements.every(r => r.metric_name.startsWith("acquisition_d30_")));
    assert.equal(new Set(replacements.map(r => r.input_snapshot_id)).size, 1);
    assert.ok(replacements.every(r => r.input_received_at_watermark === record.received_at));
    for (const run of before) assert.equal(jcs(afterLate.find(r => r.metric_run_id === run.metric_run_id)), jcs(run));
    const revised = await persistCostImport(app, "synthetic-horizon-cost-revision", [{ ...costs[0],
      amount_unscaled: "20", as_of: "2026-09-09T00:00:00.000Z" }]);
    const corrected = await requestMetricRecalculation(app, identity, { cost_import_run_id: revised.import_run_id,
      date_from: "2026-08-06", date_to: "2026-08-06", watermark: "2026-09-10T00:00:00.000Z",
      metric_names: ["acquisition_d0_cost", "acquisition_d30_cost"] });
    assert.equal(corrected.selected_runs, 16);
    assert.equal((await processMetricRecalculations(app, identity.tenantId, 10)).completed, 10);
    assert.equal((await processMetricRecalculations(app, identity.tenantId, 10)).completed, 6);
    const latest = (await metricReport(reader, identity, { tenantId: identity.tenantId, appId: identity.appId,
      metricNames: names, supersession: "latest", limit: 100 })).data;
    assert.equal(latest.length, 16); assert.equal(new Set(latest.map(r => r.acquisition_kpi_set_key)).size, 2);
    assert.ok(latest.every(r => r.acquisition_kpi_set_key && r.input_received_at_watermark === "2026-09-10T00:00:00.000Z"));
    const final = await artifacts();
    assert.ok(!final.some(r => r.supersedes_metric_run_id?.startsWith("synthetic-horizon-frozen-d7:")));
    for (const run of before) assert.equal(jcs(final.find(r => r.metric_run_id === run.metric_run_id)), jcs(run));
  });

  it("drains more than 100 committed inputs and a paged run manifest across pause, resume and concurrent workers without duplicates",async()=>{
    const extra={...input,metric_evaluations:Array.from({length:103},(_,i)=>({...input.metric_evaluations[0],metric_run_id_prefix:`synthetic-auto-many-${i}`}))};
    await computeSqlMetricRuns(app,extra,true);
    await saveMetricCorrectionPolicy(app,identity,{...policy,enabled:false,runs_per_page:20,receipts_per_cycle:5});
    const batch:CandidateAttempt[]=[];
    for (let i=0;i<105;i++) {
      const record={...structuredClone(input.records[2]),record_id:`synthetic-auto-many-input-${i}`,event_id:`event:synthetic-auto-many-${i}`,
        delivery_id:`delivery:synthetic-auto-many-${i}`,received_at:"2026-08-13T00:00:00.000Z"};
      batch.push({record,server:{...input.server_context,received_at:record.received_at},batch_id:`synthetic-auto-many-${i}`});
    }
    const admitted=await ingestRuntimeBatch(batch,app,history);assert.equal(admitted.rejections.length,0);
    const paused=await metricCorrectionStatus(reader,identity);
    assert.equal(paused.states.find(r=>r.source_kind==="late_events" && r.state==="queued")?.receipts,"105");
    assert.equal((await planAutomaticMetricCorrections(app,identity.tenantId)).completed,0);
    await saveMetricCorrectionPolicy(app,identity,{...policy,runs_per_page:20,receipts_per_cycle:5});
    await planAutomaticMetricCorrections(app,identity.tenantId,1);
    const partial=await withTenant(app,identity.tenantId,async client=>(await client.query(`SELECT targets,continuation FROM control.metric_correction_receipts
      WHERE tenant_id=$1 AND app_id=$2 AND continuation>0 LIMIT 1`,[identity.tenantId,identity.appId])).rows[0]);
    assert.equal(partial.continuation,20);assert.equal(partial.targets.length,106);
    await saveMetricCorrectionPolicy(app,identity,{...policy,enabled:false,runs_per_page:20,receipts_per_cycle:5});
    assert.equal((await processMetricRecalculations(app,identity.tenantId,10)).completed,0);
    await saveMetricCorrectionPolicy(app,identity,{...policy,runs_per_page:20,receipts_per_cycle:5});
    const raced=await Promise.all([processMetricRecalculations(app,identity.tenantId,10),processMetricRecalculations(app,identity.tenantId,10)]);
    assert.equal(raced.reduce((n,r)=>n+r.completed,0),20);
    await drain();
    const saved=await artifacts();
    assert.equal(saved.filter(r=>r.supersedes_metric_run_id).length,104);
    const successors=saved.filter(r=>r.supersedes_metric_run_id).map(r=>r.supersedes_metric_run_id);
    assert.equal(new Set(successors).size,104);
    const done=await metricCorrectionStatus(reader,identity);
    assert.equal(done.states.find(r=>r.source_kind==="late_events" && r.state==="completed")?.receipts,"105");
    await ingestRuntimeBatch(batch,app,[...history,...batch]);await drain();
    assert.equal((await artifacts()).length,saved.length);
  });

  it("keeps redacted source receipts unavailable and rolls back job plus cursor on publication failure",async()=>{
    await saveMetricCorrectionPolicy(app,identity,policy);
    await revenue("synthetic-auto-redacted");
    await withTenant(app,identity.tenantId,client=>client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id)
      VALUES ($1,$2,'synthetic-auto-redacted','redacted','2026-08-14T00:00:00.000Z','privacy:synthetic-auto')`,[identity.tenantId,identity.appId]));
    assert.equal((await planAutomaticMetricCorrections(app,identity.tenantId)).unavailable,1);
    assert.equal((await listMetricRecalculations(reader,identity)).length,0);
    assert.equal((await metricCorrectionStatus(reader,identity)).states[0].safe_reason,"input_unavailable");
    await revenue("synthetic-auto-atomic");
    const connect=app.connect.bind(app);let injected=false;
    const failing={connect:async()=>{
      const client=await connect(),query=client.query.bind(client);
      return new Proxy(client,{get(target,key){if(key==="query")return async(...args:any[])=>{
        if(!injected && typeof args[0]==="string" && args[0].includes("INSERT INTO control.metric_recalculation_items")){
          injected=true;throw Error("synthetic_auto_after_job_before_cursor");
        }
        return (query as any)(...args);
      };const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
    }} as typeof app;
    assert.equal((await planAutomaticMetricCorrections(failing,identity.tenantId)).deferred,1);assert.equal(injected,true);
    assert.equal((await listMetricRecalculations(reader,identity)).length,0);
    await withTenant(app,identity.tenantId,client=>client.query(`UPDATE control.metric_correction_receipts SET next_attempt_at=clock_timestamp()
      WHERE tenant_id=$1 AND app_id=$2 AND source_ref='synthetic-auto-atomic'`,[identity.tenantId,identity.appId]));
    await drain();
    assert.equal((await listMetricRecalculations(reader,identity)).filter(r=>r.state==="completed").length,1);
    assert.equal((await metricCorrectionStatus(reader,identity)).states.find(r=>r.safe_reason==="input_unavailable")?.receipts,"1");
    assert.ok((await artifacts()).filter(r=>r.supersedes_metric_run_id).every(r=>r.reproducibility_status==="redaction_affected"));
    await revenue("synthetic-auto-deletion-race",1);
    await planAutomaticMetricCorrections(app,identity.tenantId);
    await withTenant(app,identity.tenantId,client=>client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id)
      VALUES ($1,$2,'synthetic-auto-deletion-race','redacted','2026-08-15T00:00:00.000Z','privacy:synthetic-auto-race')`,[identity.tenantId,identity.appId]));
    assert.equal((await processMetricRecalculations(app,identity.tenantId)).completed,0);
    assert.equal((await listMetricRecalculations(reader,identity)).find(r=>r.state==="unavailable")?.safe_reason,"input_unavailable");
  });
});
