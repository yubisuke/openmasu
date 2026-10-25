import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, it } from "node:test";
import { createAppPool, createReaderPool, createSeedPool, withTenant, type PayloadStore } from "@openmasu/runtime";
import { processRecurringComparisons, readComparisonRun, registerComparison } from "@openmasu/runtime/recurring-comparisons";
import { jcs } from "@openmasu/attribution-core/canonical";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { createRequestHandler } from "../../api/src/router.js";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { issueDashboardSession, csrfToken } from "../../api/src/session.js";
import { syntheticComparisonRegistration, syntheticRecurringSnapshot } from "../../../tools/synthetic-recurring-comparison.js";

const pool = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
const scope = { tenantId:"tenant-a",appId:"app-a" };
const key = `synthetic-comparison-${randomBytes(32).toString("hex")}`, readKey = `synthetic-comparison-reader-${randomBytes(32).toString("hex")}`;
let base = "", cookie = "", csrf = "";
const server = createServer(createRequestHandler({ pool,readerPool:reader,payloadStore:{} as PayloadStore,
  maxConfig:{ ...scope,pathSecret:"synthetic-path",eventKey:"synthetic-key",tokenMode:"all_with_event_fallback",maxParameters:40,maxQueryBytes:8192 },
  publicBaseUrl:"http://localhost:8080",redirectorBaseUrl:"http://localhost:8090",
  dashboard:{ enabled:true,publicBaseUrl:"http://localhost:8080",tenantId:scope.tenantId,sessionTtlSeconds:43200 } }));
const now = new Date();
const endpoint = "/v1/admin/apps/app-a/comparisons";
const command = (body: unknown, selectedKey = key) => fetch(`${base}${endpoint}`, { method:"POST",headers:{ authorization:`Bearer ${selectedKey}`,"content-type":"application/json" },body:JSON.stringify(body) });
const list = async () => { const r=await fetch(`${base}${endpoint}`,{ headers:{ authorization:`Bearer ${key}` } }); assert.equal(r.status,200); return r.json() as Promise<any>; };
before(async()=>{
  await ingestFixture("synthetic-recurring-comparison",JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json","utf8")),pool,seed);
  await seed.query("TRUNCATE control.comparison_runs,control.comparison_snapshots,control.comparison_definitions CASCADE");
  const [id] = await ensureAdminKeys(pool,scope,[key,{ key:readKey,role:"read_only" }]);
  const session = await issueDashboardSession(pool,scope.tenantId,id!,43200);
  cookie=`openmasu_dashboard=${session.token}`; csrf=csrfToken(session.token);
  server.listen(0,"127.0.0.1"); await once(server,"listening"); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{ server.close(); await once(server,"close"); await Promise.all([pool.end(),reader.end(),seed.end()]); });

it("recurring_comparison_form_worker_saved_bytes_next_date_revisions_expiry_and_RLS",async()=>{
  const registration = syntheticComparisonRegistration();
  assert.equal((await command({ action:"register",registration },readKey)).status,403);
  const form = new URLSearchParams({ csrf_token:csrf,command:JSON.stringify({ action:"register",registration }) });
  const post = (origin:string) => fetch(`${base}/dashboard/apps/app-a/comparisons`,{ method:"POST",headers:{ cookie,origin },body:form,redirect:"manual" });
  assert.equal((await post("https://outside.example.invalid")).status,403);
  assert.equal((await post("http://localhost:8080")).status,303);
  const saved=(await list()).plans[0];
  const first=await processRecurringComparisons(pool,scope.tenantId,now); assert.equal(first.completed,3);
  let state=await list();
  const original=state.runs.find((r:any)=>r.target_date==="2026-08-01");
  assert.equal(original.state,"within_threshold");
  const download=()=>fetch(`${base}/dashboard/apps/app-a/comparison-runs/${original.run_id}.json`,{ headers:{ cookie } });
  const bytes=await (await download()).text();
  assert.equal(JSON.parse(bytes).comparison.rows[0].delta_right_minus_left,"250000");
  assert.equal((await processRecurringComparisons(pool,scope.tenantId,now)).completed,0);
  assert.equal(await (await download()).text(),bytes);
  const deposit=async(day:string,side:string,snapshot:unknown)=>{const r=await command({ action:"deposit",comparison_id:saved.comparison_id,target_date:day,side,snapshot });assert.equal(r.status,200,await r.text());};
  await deposit("2026-08-02","left",syntheticRecurringSnapshot("2026-08-02","1800000"));
  await processRecurringComparisons(pool,scope.tenantId,now);
  state=await list(); assert.ok(state.runs.some((r:any)=>r.target_date==="2026-08-02"&&r.state==="missing_input"));
  await deposit("2026-08-02","right",syntheticRecurringSnapshot("2026-08-02","2200000"));
  await deposit("2026-08-02","right",syntheticRecurringSnapshot("2026-08-02","2200000"));
  const conflict=await command({ action:"deposit",comparison_id:saved.comparison_id,target_date:"2026-08-02",side:"right",snapshot:syntheticRecurringSnapshot("2026-08-02","2300000") });
  assert.equal(conflict.status,400); assert.equal((await conflict.json() as any).error,"comparison_snapshot_conflict");
  await processRecurringComparisons(pool,scope.tenantId,now);
  state=await list(); const next=state.runs.find((r:any)=>r.target_date==="2026-08-02"&&r.state==="threshold_exceeded"); assert.ok(next);
  const nextResult=await readComparisonRun(reader,scope,next.run_id,now); assert.equal(nextResult.comparison.rows[0].delta_right_minus_left,"400000");
  await deposit("2026-08-03","left",syntheticRecurringSnapshot("2026-08-03"));
  const right=syntheticRecurringSnapshot("2026-08-03");
  await deposit("2026-08-03","right",{ source:right.source,conditions:{ ...right.conditions,metric_definition:"d7_roas@synthetic-next" },rows:right.rows });
  await processRecurringComparisons(pool,scope.tenantId,now);
  assert.ok((await list()).runs.some((r:any)=>r.target_date==="2026-08-03"&&r.state==="incomparable"));
  await assert.rejects(withTenant(reader,scope.tenantId,c=>c.query("DELETE FROM control.comparison_snapshots WHERE tenant_id=$1",[scope.tenantId])),{ code:"42501" });
  assert.equal(await withTenant(reader,"tenant-synthetic-other",async c=>(await c.query("SELECT * FROM control.comparison_definitions")).rowCount),0);
  const columns=await withTenant(reader,scope.tenantId,async c=>(await c.query("SELECT snapshot FROM control.comparison_snapshots WHERE comparison_id=$1",[saved.comparison_id])).rows);
  assert.doesNotMatch(jcs(columns),/installation_id|raw_payload|evidence_refs|csv_bytes/);
  const replacement=await command({ action:"register",registration:{ ...registration,supersedes_id:saved.comparison_id,name:"Synthetic replacement",threshold:{ value_unscaled:"1",scale:6 } } });
  assert.equal(replacement.status,200); await processRecurringComparisons(pool,scope.tenantId,now);
  assert.equal(await (await download()).text(),bytes,"replacing a definition must not overwrite its prior result");
  const page=await fetch(`${base}/dashboard/apps/app-a/comparisons`,{ headers:{ cookie } }); assert.equal(page.status,200);
  const html=await page.text(); assert.match(html,/threshold_exceeded/); assert.doesNotMatch(html,/<script|javascript:|\son\w+=/i);
  assert.equal((await command({ action:"delete",comparison_id:saved.comparison_id })).status,200);
  assert.equal((await download()).status,404);
  const expired=new Date(now.valueOf()+31*86400000); await processRecurringComparisons(pool,scope.tenantId,expired);
  assert.equal(await readComparisonRun(reader,scope,next.run_id,expired),null);
  assert.equal(await withTenant(reader,scope.tenantId,async c=>(await c.query("SELECT count(*)::int AS n FROM control.comparison_snapshots")).rows[0].n),0);
});

it("recurring_comparison_privacy_epoch_suppresses_old_values_and_purges_restored_aggregates",async()=>{
  const saved=await registerComparison(pool,scope,{ ...syntheticComparisonRegistration(),name:"Synthetic privacy case" },now);
  await processRecurringComparisons(pool,scope.tenantId,now);
  const backup=await withTenant(reader,scope.tenantId,async c=>(await c.query("SELECT * FROM control.comparison_runs WHERE comparison_id=$1 AND target_date='2026-08-01'",[saved.comparison_id])).rows[0]);
  assert.ok(await readComparisonRun(reader,scope,backup.run_id,now));
  await withTenant(pool,scope.tenantId,c=>c.query(`INSERT INTO ledger.privacy_requests(privacy_request_id,tenant_id,app_id,requested_at,completed_at,status,artifact)
    VALUES ($1,$2,$3,$4,$4,'completed',$5)`,["privacy:synthetic-recurring",scope.tenantId,scope.appId,now.toISOString(),{ deletion_scope:"app",status:"completed" }]));
  assert.equal(await readComparisonRun(reader,scope,backup.run_id,now),null);
  await processRecurringComparisons(pool,scope.tenantId,now);
  await withTenant(pool,scope.tenantId,c=>c.query(`INSERT INTO control.comparison_runs(run_id,tenant_id,app_id,comparison_id,target_date,left_digest,right_digest,result,created_at,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[backup.run_id,scope.tenantId,scope.appId,saved.comparison_id,backup.target_date,backup.left_digest,backup.right_digest,backup.result,backup.created_at,backup.expires_at]));
  assert.equal(await readComparisonRun(reader,scope,backup.run_id,now),null,"restoring stale numeric rows must not restore publication permission");
  await processRecurringComparisons(pool,scope.tenantId,now);
  assert.equal(await withTenant(reader,scope.tenantId,async c=>(await c.query("SELECT count(*)::int AS n FROM control.comparison_runs")).rows[0].n),0);
});
