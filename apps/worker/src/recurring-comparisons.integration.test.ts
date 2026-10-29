import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, it } from "node:test";
import { createAppPool, createReaderPool, withTenant, type PayloadStore } from "@openmasu/runtime";
import { processRecurringComparisons, readComparisonRun, registerComparison, parseComparisonRegistration, recurringComparisonResult } from "@openmasu/runtime/recurring-comparisons";
import { jcs } from "@openmasu/attribution-core/canonical";
import { createRequestHandler } from "../../api/src/router.js";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { issueDashboardSession, csrfToken } from "../../api/src/session.js";
import { syntheticComparisonRegistration, syntheticRecurringSnapshot } from "../../../tools/synthetic-recurring-comparison.js";
import { comparisonDigest } from "@openmasu/runtime/cohort-comparison";
import { captureMetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import { registerMetricSchedule } from "../../api/src/metric-schedules.js";
import { fixedComparisonDownload } from "../../api/src/fixed-comparison.js";
import { persistMetricRun } from "./metrics/cohort.js";

const pool = createAppPool(), reader = createReaderPool();
const scope = { tenantId:`tenant-recurring-${randomBytes(6).toString("hex")}`,appId:"app-a" };
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
  const [id] = await ensureAdminKeys(pool,scope,[key,{ key:readKey,role:"read_only" }]);
  const session = await issueDashboardSession(pool,scope.tenantId,id!,43200);
  cookie=`openmasu_dashboard=${session.token}`; csrf=csrfToken(session.token);
  server.listen(0,"127.0.0.1"); await once(server,"listening"); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{ server.close(); await once(server,"close"); await Promise.all([pool.end(),reader.end()]); });

it("recurring_comparison_form_worker_saved_bytes_next_date_revisions_expiry_and_RLS",async()=>{
  const registration = syntheticComparisonRegistration();
  assert.equal((await command({ action:"register",registration },readKey)).status,403);
  const form = new FormData(); form.set("csrf_token",csrf); form.set("action","register");
  for (const name of ["name","first_date","last_date","watermark_lag_days","retention_days","mode"] as const) form.set(name,String(registration[name]));
  form.set("supersedes_id", ""); form.set("threshold_value_unscaled",registration.threshold.value_unscaled); form.set("threshold_scale",String(registration.threshold.scale));
  for (const side of ["left","right"] as const) form.set(`${side}_snapshot`,new Blob([jcs(registration[`${side}_snapshot`])]),`${side}.json`);
  const counts = () => withTenant(reader,scope.tenantId,async c=>(await c.query(`SELECT
    (SELECT count(*) FROM control.comparison_definitions) AS definitions,
    (SELECT count(*) FROM control.comparison_snapshots) AS snapshots,
    (SELECT count(*) FROM control.comparison_runs) AS runs`)).rows[0]);
  const beforePreview=await counts();
  const getPage=await fetch(`${base}/dashboard/apps/app-a/comparisons`,{headers:{cookie}});
  assert.equal(getPage.status,200); assert.match(await getPage.text(),/name="left_snapshot"/);
  assert.deepEqual(await counts(),beforePreview,"GET form must not write");
  const previewPost=(origin:string)=>fetch(`${base}/dashboard/apps/app-a/comparisons/preview`,{method:"POST",headers:{cookie,origin},body:form});
  assert.equal((await previewPost("https://outside.example.invalid")).status,403);
  const review=await previewPost("http://localhost:8080"); assert.equal(review.status,200);
  const reviewHtml=await review.text(); assert.match(reviewHtml,/within_threshold/);
  assert.deepEqual(await counts(),beforePreview,"preview uses reader role and does not save inputs or results");
  const confirmation=new FormData(); confirmation.set("csrf_token",csrf); confirmation.set("command",jcs({action:"register",registration}));
  confirmation.set("confirmation_digest",/name="confirmation_digest" value="([0-9a-f]{64})"/.exec(reviewHtml)![1]);
  const confirmed=await fetch(`${base}/dashboard/apps/app-a/comparisons`,{method:"POST",headers:{cookie,origin:"http://localhost:8080"},body:confirmation,redirect:"manual"});
  assert.equal(confirmed.status,303); assert.match(confirmed.headers.get("location")!,/#comparison-/);
  const saved=(await list()).plans[0];
  const first=await processRecurringComparisons(pool,scope.tenantId,now); assert.equal(first.completed,3);
  let state=await list();
  const original=state.runs.find((r:any)=>r.target_date==="2026-08-01");
  assert.equal(original.state,"within_threshold");
  const download=()=>fetch(`${base}/dashboard/apps/app-a/comparison-runs/${original.run_id}.json`,{ headers:{ cookie } });
  const bytes=await (await download()).text();
  assert.equal(JSON.parse(bytes).comparison.rows[0].delta_right_minus_left,"250000");
  const parsed=parseComparisonRegistration(registration);
  assert.equal(bytes,`${jcs(recurringComparisonResult(parsed.definition,parsed.definition.first_date,parsed.left,parsed.right))}\n`,"typed form and JSON service preserve the same stored result");
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
  const unsupported=await command({ action:"register",registration:{ ...registration,name:"Synthetic unsupported population",
    threshold:{ kind:"relative",baseline:"left",value_unscaled:"1",scale:6,minimum_population:"10" } } });
  assert.equal(unsupported.status,400); assert.deepEqual(await unsupported.json(),{error:"comparison_population_unsupported"});
  const replacementRegistration={ ...registration,supersedes_id:saved.comparison_id,name:"Synthetic replacement",
    threshold:{ kind:"relative",baseline:"right",value_unscaled:"1",scale:6 } };
  const replacement=await command({ action:"register",registration:replacementRegistration });
  assert.equal(replacement.status,200); const replaced=await replacement.json() as any;
  assert.equal(replaced.definition.version,2); assert.notEqual(replaced.definition_digest,saved.definition_digest);
  await processRecurringComparisons(pool,scope.tenantId,now);
  const v2run=(await list()).runs.find((run:any)=>run.comparison_id===replaced.comparison_id&&run.target_date==="2026-08-01");
  assert.ok(v2run); const v2=await readComparisonRun(reader,scope,v2run.run_id,now);
  const v2parsed=parseComparisonRegistration(replacementRegistration);
  assert.equal(v2.format,"scheduled-cohort-comparison-v2"); assert.equal(v2.state,"threshold_exceeded");
  assert.equal(jcs(v2),jcs(recurringComparisonResult(v2parsed.definition,v2parsed.definition.first_date,v2parsed.left,v2parsed.right)));
  assert.equal((await processRecurringComparisons(pool,scope.tenantId,now)).completed,0);
  assert.equal(jcs(await readComparisonRun(reader,scope,v2run.run_id,now)),jcs(v2));
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

async function localServerCase() {
  const local = { tenantId: `tenant-local-comparison-${randomBytes(5).toString("hex")}`, appId: "app-a" };
  const [keyId] = await ensureAdminKeys(pool, local, [`synthetic-local-comparison-${randomBytes(32).toString("hex")}`]);
  const identity = { ...local, keyId, role: "admin" as const };
  const fixture = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
  const definition = fixture.metric_definitions.find((d: any) => d.metric_name === "d7_roas");
  const source = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/expected_metric_runs.json", "utf8"))
    .find((row: any) => row.metric_name === "d7_roas");
  const grouping = { ...source.grouping.dimensions }; delete grouping.cohort_date;
  const schedule = await registerMetricSchedule({ pool, identity, body: { lag_days: 9, start_date: "2026-08-01",
    fx_policy: fixture.fx_policy, metric_definitions: [definition],
    evaluations: [{ metric_names: ["d7_roas"], date_dimension: "cohort_date", grouping }] }, now });
  const query = (day: string) => ({ ...identity, metricScheduleId: schedule.metric_schedule_id, metricNames: ["d7_roas"],
    metricDefinitionVersion: definition.metric_definition_version, grouping, dateFrom: day,
    dateTo: new Date(Date.parse(day) + 86400000).toISOString().slice(0,10),
    watermarkAtMost: new Date(Date.parse(day) + 9 * 86400000).toISOString(), supersession: "latest" as const, limit: 1000 });
  const store = async (day: string, lag = 9, changedDefinition = false) => {
    const run = { ...source, tenant_id: local.tenantId, app_id: local.appId, metric_run_id: `synthetic-local:${randomBytes(6).toString("hex")}:${day}`,
      input_snapshot_id: comparisonDigest([local,day,lag]), input_received_at_watermark: new Date(Date.parse(day) + lag * 86400000).toISOString(),
      evidence_refs: [], grouping: { ...source.grouping, dimensions: { ...grouping, cohort_date: day },
        dimension_digest: comparisonDigest({ ...grouping, cohort_date: day }) } };
    const context = captureMetricComparisonContext(run, changedDefinition ? { ...definition, rule_bundle_version: "synthetic-different" } : definition,
      fixture.fx_policy, "before", comparisonDigest);
    await withTenant(pool, local.tenantId, async client => {
      await persistMetricRun(client, { tenant_id: local.tenantId, app_id: local.appId }, run, context);
      await client.query(`INSERT INTO control.metric_schedule_runs(tenant_id,app_id,metric_run_id,metric_schedule_id,target_date,evaluation,definition_digest)
        VALUES($1,$2,$3,$4,$5,0,$6)`, [local.tenantId,local.appId,run.metric_run_id,schedule.metric_schedule_id,day,schedule.definition_digest]);
    });
  };
  await store("2026-08-01");
  const manual = async (day: string) => JSON.parse(await fixedComparisonDownload(reader, identity, query(day)));
  const { left_snapshot: _left, ...input } = syntheticComparisonRegistration();
  const registration = { ...input, local_selection: { metric_schedule_id: schedule.metric_schedule_id, metric_name: "d7_roas" },
    right_snapshot: await manual("2026-08-01") };
  return { local, identity, schedule, query, store, manual, registration };
}

it("recurring_local_capture_matches_manual_export_and_retries_new_saved_runs_without_forged_server_provenance", async () => {
  const setup = await localServerCase();
  const saved = await registerComparison(pool, setup.local, setup.registration, now);
  await processRecurringComparisons(pool, setup.local.tenantId, now);
  const first = await withTenant(reader, setup.local.tenantId, async client => (await client.query(`SELECT snapshot,provenance
    FROM control.comparison_snapshots WHERE comparison_id=$1 AND target_date='2026-08-01' AND side='left'`, [saved.comparison_id])).rows[0]);
  assert.equal(jcs(first.snapshot), jcs(await setup.manual("2026-08-01")));
  assert.equal(first.provenance.source, "server_saved_runs"); assert.equal(first.provenance.upstream_completeness, "unknown");
  const states = () => withTenant(reader, setup.local.tenantId, async client => (await client.query(`SELECT result FROM control.comparison_runs
    WHERE comparison_id=$1 ORDER BY target_date,created_at`, [saved.comparison_id])).rows.map(row => row.result));
  assert.ok((await states()).some(row => row.target_date === "2026-08-02" && row.state === "missing_input"
    && row.local_input.state === "comparison_local_missing_runs"));
  assert.equal((await processRecurringComparisons(pool, setup.local.tenantId, now)).completed, 0);
  await setup.store("2026-08-02");
  await processRecurringComparisons(pool, setup.local.tenantId, now);
  const second = await withTenant(reader, setup.local.tenantId, async client => (await client.query(`SELECT snapshot FROM control.comparison_snapshots
    WHERE comparison_id=$1 AND target_date='2026-08-02' AND side='left'`, [saved.comparison_id])).rows[0]);
  assert.equal(jcs(second.snapshot), jcs(await setup.manual("2026-08-02")));
  await assert.rejects(registerComparison(pool, setup.local, { ...setup.registration,
    expected_left_snapshot_digest: "0".repeat(64) }, now), /comparison_local_preview_changed/);
  const deposit = await import("@openmasu/runtime/recurring-comparisons");
  await assert.rejects(deposit.depositComparisonSnapshot(pool, setup.local, saved.comparison_id, "2026-08-02", "left", second.snapshot, now), /local_deposit_forbidden/);
  await deposit.depositComparisonSnapshot(pool, setup.local, saved.comparison_id, "2026-08-02", "right", second.snapshot, now);
  await processRecurringComparisons(pool, setup.local.tenantId, now);
  assert.ok((await states()).some(row => row.target_date === "2026-08-02" && row.state === "within_threshold"));
  const count = (await states()).length;
  await processRecurringComparisons(pool, setup.local.tenantId, now); assert.equal((await states()).length, count);
  const { local_selection: _selection, ...manualInput } = setup.registration;
  const uploaded = await registerComparison(pool, setup.local, { ...manualInput, left_snapshot: first.snapshot }, now);
  const provenance = await withTenant(reader, setup.local.tenantId, async client => (await client.query(`SELECT provenance
    FROM control.comparison_snapshots WHERE comparison_id=$1 AND side='left'`, [uploaded.comparison_id])).rows[0].provenance);
  assert.deepEqual(provenance, { source: "operator_uploaded" }, "an uploaded server-looking receipt cannot authenticate its origin");
  await assert.rejects(registerComparison(pool, { tenantId: scope.tenantId, appId: scope.appId }, setup.registration, now), /local_schedule_unavailable/);
});

it("recurring_local_capture_reports_immature_and_changed_definitions_instead_of_zero_or_older_values", async () => {
  const setup = await localServerCase();
  await setup.store("2026-08-02", 1);
  const immature = JSON.parse(await fixedComparisonDownload(reader, setup.identity, { ...setup.query("2026-08-02"),
    watermarkAtMost: "2026-08-03T00:00:00.000Z" }));
  await assert.rejects(registerComparison(pool, setup.local, { ...setup.registration, first_date: "2026-08-02", last_date: "2026-08-02",
    watermark_lag_days: 1, right_snapshot: immature }, now), /comparison_local_window_not_elapsed/);
  await setup.store("2026-08-03", 9, true);
  await assert.rejects(registerComparison(pool, setup.local, { ...setup.registration, first_date: "2026-08-03", last_date: "2026-08-03",
    right_snapshot: syntheticRecurringSnapshot("2026-08-03") }, now), /comparison_local_definition_changed/);
});

it("recurring_local_capture_rechecks_privacy_after_acquisition_before_publication", async () => {
  const setup = await localServerCase(); let changed = false;
  const wrapped = { connect: async () => {
    const client = await pool.connect(), execute = client.query.bind(client); let capture = false;
    return new Proxy(client, { get(target, key) {
      if (key === "query") return async (...args: any[]) => {
        if (args[0] === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") capture = true;
        const result = await (execute as any)(...args);
        if (capture && !changed && String(args[0]).includes("pg_advisory_unlock_shared")) {
          changed = true;
          await withTenant(pool, setup.local.tenantId, other => other.query(`INSERT INTO ledger.privacy_requests
            (privacy_request_id,tenant_id,app_id,requested_at,completed_at,status,artifact) VALUES($1,$2,$3,$4,$4,'completed',$5)`,
            [`privacy:synthetic-local:${randomBytes(5).toString("hex")}`,setup.local.tenantId,setup.local.appId,now.toISOString(),{deletion_scope:"app",status:"completed"}]));
        }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  } } as unknown as Pool;
  await assert.rejects(registerComparison(wrapped, setup.local, setup.registration, now), /comparison_privacy_changed/);
  assert.equal(changed, true);
  assert.equal(await withTenant(reader, setup.local.tenantId, async client => (await client.query("SELECT count(*)::int AS n FROM control.comparison_definitions")).rows[0].n), 0);
});
