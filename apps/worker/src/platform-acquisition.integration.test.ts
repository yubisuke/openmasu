import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after,beforeEach,describe,it } from "node:test";
import { jcs,type CandidateAttempt } from "@openmasu/attribution-core";
import { createAppPool,createReaderPool,createSeedPool,withTenant } from "@openmasu/runtime";
import { VERIFIED_PLATFORM_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import { registerMetricSchedule } from "../../api/src/metric-schedules.js";
import { saveMetricCorrectionPolicy } from "../../api/src/metric-correction-policy.js";
import { metricReport } from "../../api/src/reporting.js";
import { renderMetricSchedules } from "../../api/src/dashboard/metric-schedules.js";
import { listMetricSchedules } from "../../api/src/metric-schedules.js";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { persistSyntheticPlatformResults } from "./test-support/platform-acquisition.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { processMetricSchedules } from "./metric-schedule-worker.js";
import { planAutomaticMetricCorrections } from "./automatic-metric-corrections.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { persistCostImport } from "./import/cost.js";
import { ingestRuntimeBatch } from "./ingestion.js";

type Any = Record<string,any>;
describe("verified platform acquisition operational workflow",{concurrency:false},()=>{
  const app=createAppPool(),seed=createSeedPool(),reader=createReaderPool();
  let input:Any,identity:{keyId:string;tenantId:string;appId:string;role:"admin"};
  beforeEach(async()=>{
    const tenant=`tenant-platform-${randomBytes(5).toString("hex")}`;
    identity={keyId:"synthetic-platform-admin",tenantId:tenant,appId:"app-a",role:"admin"};
    input=JSON.parse(readFileSync("fixtures/v0.4/66-verified-platform-acquisition/input.json","utf8").replaceAll('"tenant-a"',JSON.stringify(tenant)));
  });
  after(async()=>{await Promise.all([app.end(),seed.end(),reader.end()]);});
  const scope=()=>({tenant_id:identity.tenantId,app_id:identity.appId});
  const rows=()=>withTenant(reader,identity.tenantId,async client=>(await client.query(
    "SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id",[identity.tenantId,identity.appId])).rows.map(row=>row.artifact));
  async function drain() {
    for (let cycle=0;cycle<50;cycle++) {
      await planAutomaticMetricCorrections(app,identity.tenantId,20);
      await processMetricRecalculations(app,identity.tenantId,10);
      const remaining=await withTenant(app,identity.tenantId,async client=>(await client.query(`SELECT
        (SELECT count(*) FROM control.metric_correction_receipts WHERE tenant_id=$1 AND app_id=$2 AND state IN ('queued','retry'))+
        (SELECT count(*) FROM control.metric_recalculation_items WHERE tenant_id=$1 AND app_id=$2 AND state IN ('queued','processing','retry')) AS count`,
      [identity.tenantId,identity.appId])).rows[0].count);
      if (remaining==="0") return;
    }
    throw Error("synthetic_platform_correction_drain_exceeded");
  }
  it("discovers verified campaigns and negative outcomes in separate source namespaces without foreign cost targets",async()=>{
    const value={...input,metric_evaluations:[]};
    await ingestFixture("platform-operational-discovery",value,app,seed);
    await persistSyntheticPlatformResults(app,value);
    await persistCostImport(app,"synthetic-unrelated-platform-cost",[{...scope(),network:"synthetic-unrelated",campaign_id:"synthetic-unrelated",
      date:"2026-09-28",amount_unscaled:"1000000",amount_scale:6,currency:"USD",source:"imported_reported",as_of:"2026-09-29T00:00:00.000Z"}]);
    const now=new Date("2026-10-01T12:00:00.000Z");
    await registerMetricSchedule({pool:app,identity,now,body:{start_date:"2026-09-28",lag_days:3,fx_policy:input.fx_policy,
      metric_definitions:VERIFIED_PLATFORM_METRIC_DEFINITIONS,evaluations:[{metric_names:["platform_cohort_install_count","platform_d1_roas"],
        date_dimension:"cohort_date",grouping:{},campaign_discovery:{policy:"selected_acquisition_and_cost_v1",max_targets:10}}]}});
    const cycle=await processMetricSchedules(app,identity.tenantId,{now});
    assert.equal(cycle.failedSchedules,0);assert.equal(cycle.completedDates,1);
    const saved=await rows();assert.equal(saved.length,6);
    const counts=saved.filter((row:Any)=>row.metric_name==="platform_cohort_install_count");
    assert.deepEqual(counts.map((row:Any)=>[row.grouping.dimensions.network,row.grouping.dimensions.attribution_status,row.value_unscaled]).sort(),
      [["apple_adservices","non_organic","1"],["apple_adservices","unattributed","1"],["meta_install_referrer","non_organic","1"]]);
    assert.ok(saved.every((row:Any)=>row.grouping.dimensions.network!=="synthetic-unrelated"));
    const roas=saved.filter((row:Any)=>row.metric_name==="platform_d1_roas");
    assert.deepEqual(roas.map((row:Any)=>row.value_unscaled??row.undefined_reason).sort(),["2000000","500000","no_attributed_cost"].sort());
    const schedules=await listMetricSchedules(reader,identity);
    assert.match(renderMetricSchedules(identity.appId,schedules,"synthetic-csrf"),/Verified platform acquisition/);
    await processMetricSchedules(app,identity.tenantId,{now});
    assert.equal(jcs(await rows()),jcs(saved));
  });
  it("corrects late verified context revenue and cost with immutable lineage while first-party results stay separate",async()=>{
    const apple=input.platform_acquisition_inputs.find((proof:Any)=>proof.install_record_id==="apple-66");
    const initial={...input,metric_evaluations:[],platform_acquisition_inputs:input.platform_acquisition_inputs.filter((proof:Any)=>proof!==apple)};
    await ingestFixture("platform-operational-corrections",initial,app,seed);
    await persistSyntheticPlatformResults(app,initial);
    const evaluations=[{...input.metric_evaluations.find((evaluation:Any)=>evaluation.metric_run_id_prefix==="platform66-early"),
      metric_run_id_prefix:"synthetic-platform-original",metric_names:["platform_cohort_install_count","platform_d1_roas"]},
      {...input.metric_evaluations.find((evaluation:Any)=>evaluation.metric_run_id_prefix==="platform66-first-party"),
        metric_run_id_prefix:"synthetic-platform-first-party",input_received_at_watermark:"2026-09-29T12:00:00.000Z",computed_at:"2026-09-29T12:00:00.000Z"}];
    const originals=await computeSqlMetricRuns(app,{...initial,metric_evaluations:evaluations},true,scope());
    assert.ok(originals.every(row=>row.value_unscaled==="0"));
    await saveMetricCorrectionPolicy(app,identity,{enabled:true,date_from:"2026-09-28",date_to:"2026-09-29",runs_per_page:20,receipts_per_cycle:20,maximum_runs_per_receipt:200});
    await persistSyntheticPlatformResults(app,{...input,platform_acquisition_inputs:[apple]});await drain();
    const latest=async()=> (await metricReport(reader,identity,{tenantId:identity.tenantId,appId:identity.appId,supersession:"latest",limit:200})).data;
    let current=await latest();
    assert.equal(current.find(row=>row.metric_name==="platform_cohort_install_count")?.value_unscaled,"1");
    assert.equal(current.find(row=>row.metric_name==="platform_d1_roas")?.value_unscaled,"500000");
    const history:CandidateAttempt[]=input.batches.flatMap((batch:Any)=>batch.records.map((record:Any)=>({server:batch.server_context,record,batch_id:batch.batch_id})));
    const record={...structuredClone(history.find(attempt=>attempt.record.record_id==="apple-revenue-66")!.record),
      record_id:"synthetic-platform-late-revenue",event_id:"event:synthetic-platform-late-revenue",delivery_id:"delivery:synthetic-platform-late-revenue",
      received_at:"2026-09-30T04:00:00.000Z"};
    const result=await ingestRuntimeBatch([{server:{...history[0].server,received_at:record.received_at},record,batch_id:"synthetic-platform-late"}],app,history);
    assert.equal(result.rejections.length,0);await drain();
    current=await latest();assert.equal(current.find(row=>row.metric_name==="platform_d1_roas")?.value_unscaled,"1000000");
    await persistCostImport(app,"synthetic-platform-cost-revision",[{...scope(),network:"apple_adservices",campaign_id:"2066",date:"2026-09-28",
      amount_unscaled:"20000000",amount_scale:6,currency:"USD",source:"imported_reported",as_of:"2026-09-30T06:00:00.000Z"}]);await drain();
    current=await latest();assert.equal(current.find(row=>row.metric_name==="platform_d1_roas")?.value_unscaled,"500000");
    assert.equal(current.find(row=>row.metric_name==="cohort_install_count")?.value_unscaled,"0");
    const saved=await rows();
    for (const original of originals) assert.equal(jcs(saved.find((row:Any)=>row.metric_run_id===original.metric_run_id)),jcs(original));
    assert.equal(saved.filter((row:Any)=>row.supersedes_metric_run_id).length,4);
    assert.ok(!saved.some((row:Any)=>row.supersedes_metric_run_id==="synthetic-platform-first-party:cohort_install_count"));
    const jobs=await withTenant(reader,identity.tenantId,async client=>(await client.query(
      `SELECT job.trigger_kind,item.state,item.safe_reason,item.source_metric_run_id FROM control.metric_recalculation_jobs AS job
       JOIN control.metric_recalculation_items AS item USING (tenant_id,app_id,recalculation_id)
       WHERE job.tenant_id=$1 AND job.app_id=$2`,[identity.tenantId,identity.appId])).rows);
    assert.deepEqual([...new Set(jobs.map(job=>job.trigger_kind))].sort(),["attribution_revision","cost_revision","late_events"]);
    assert.equal(jobs.filter(job=>job.state==="completed").length,4);
    assert.ok(jobs.every(job=>job.state==="completed" || (job.state==="unavailable" && job.safe_reason==="unsupported_definition"
      && /:(?:platform_)?cohort_install_count$/.test(job.source_metric_run_id))),JSON.stringify(jobs));
    await drain();assert.equal(jcs(await rows()),jcs(saved));
  });
});
