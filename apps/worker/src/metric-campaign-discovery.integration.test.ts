import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { ACQUISITION_DETAIL_METRIC_DEFINITIONS, DISJOINT_COST_METRIC_DEFINITIONS } from "@openmasu/contracts";
import { jcs, sha256, type CandidateAttempt } from "@openmasu/attribution-core";
import { createAppPool, createReaderPool, createSeedPool, withTenant } from "@openmasu/runtime";
import { registerMetricSchedule, listMetricSchedules, disableMetricSchedule } from "../../api/src/metric-schedules.js";
import { requestMetricRecalculation } from "../../api/src/metric-recalculations.js";
import { ingestRuntimeBatch } from "./ingestion.js";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { claimNextScheduledDate, processMetricSchedules } from "./metric-schedule-worker.js";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
import { persistCostImportWithClient } from "./import/cost.js";
type Any = Record<string, any>;

describe("bounded campaign discovery in the existing daily worker", { concurrency: false }, () => {
  const app = createAppPool(), reader = createReaderPool(), seed = createSeedPool();
  let input: Any, identity: { tenantId: string; appId: string; keyId: string; role: "admin" }, history: CandidateAttempt[];
  const first = new Date("2026-08-12T12:00:00.000Z"), next = new Date("2026-08-13T12:00:00.000Z");
  beforeEach(async () => {
    identity = { tenantId: `tenant-discovery-${randomBytes(5).toString("hex")}`, appId: "app-a", keyId: "synthetic-discovery", role: "admin" };
    input = JSON.parse(readFileSync("fixtures/v0.4/60-selected-commerce/input.json", "utf8").replaceAll('"tenant-a"', JSON.stringify(identity.tenantId)));
    input.metric_evaluations = [];
    await ingestFixture(`discovery-${identity.tenantId}`, input, app, seed);
    history = input.records.map((record: Any) => ({ server: input.server_context, record, batch_id: "synthetic-initial" }));
  });
  after(async () => { await Promise.all([app.end(), reader.end(), seed.end()]); });
  const register = (max = 10, start_date = "2026-08-06") => registerMetricSchedule({ pool: app, identity, now: first,
    body: { lag_days: 6, start_date, fx_policy: input.fx_policy, metric_definitions: structuredClone(DISJOINT_COST_METRIC_DEFINITIONS),
      evaluations: [{ metric_names: ["d0_roas"], date_dimension: "cohort_date", grouping: {},
        campaign_discovery: { policy: "selected_acquisition_and_cost_v1", max_targets: max } }] } });
  const rows = () => withTenant(reader, identity.tenantId, async client => (await client.query<{ artifact: Any }>(
    `SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY metric_run_id`, [identity.tenantId, identity.appId])).rows.map(row => row.artifact));
  const listed = () => listMetricSchedules(reader, identity);
  async function cost(campaign: string | null, date = "2026-08-06") {
    const artifact: Any = { ...input.cost_records[0], cost_record_id: `synthetic-cost-${campaign ?? "unknown"}-${date}`,
      campaign_id: campaign, date, dimension_digest: sha256({ campaign, date }),
      as_of: date === "2026-08-06" ? "2026-08-12T00:00:00.000Z" : "2026-08-13T00:00:00.000Z" };
    if (campaign === null) delete artifact.campaign_id;
    await withTenant(app, identity.tenantId, client => client.query(`INSERT INTO ledger.cost_records
      (cost_record_id,tenant_id,app_id,network,campaign_id,country,cost_date,spend_unscaled,spend_scale,currency,
       source,as_of,report_snapshot_digest,cost_key_digest,import_run_id,artifact)
      SELECT $3::text,$1::text,$2::text,network,$4::text,country,$5::date,spend_unscaled,spend_scale,currency,
        source,$6::text::control.canonical_timestamp,report_snapshot_digest,$7::text,import_run_id,$8::jsonb
      FROM ledger.cost_records WHERE tenant_id=$1 AND app_id=$2 AND cost_record_id='cost-native-acquisition'`,
    [identity.tenantId, identity.appId, artifact.cost_record_id, campaign, date, artifact.as_of, artifact.dimension_digest, JSON.stringify(artifact)]));
  }
  async function campaign(label: string, campaignId: string, days = 1, mode?: "organic" | "unattributed" | "unknown_nonorganic",
    detail?: {ad_group_id:string;creative_id?:string}) {
    const shifted = (value: string) => new Date(Date.parse(value) + days * 86_400_000).toISOString();
    const receivedAt = days ? "2026-08-13T00:00:00.000Z" : "2026-08-12T00:00:00.000Z";
    const records = input.records.slice(0, 3).map((source: Any) => {
      const row = structuredClone(source);
      row.record_id = `${source.record_id}:${label}`; row.event_id = `${source.event_id}:${label}`; row.delivery_id = `${source.delivery_id}:${label}`;
      row.received_at = receivedAt; row.occurred_at = shifted(source.occurred_at);
      if (row.payload.installation_id) row.payload.installation_id = `installation:${label}`;
      if (row.payload.click_id) row.payload.click_id = `click-${label}_0000000000000000`;
      if (row.payload.campaign_id) row.payload.campaign_id = campaignId;
      if(detail && row.event_name==="click") {
        row.payload.ad_group_id=detail.ad_group_id;
        if(detail.creative_id)row.payload.creative_id=detail.creative_id;else delete row.payload.creative_id;
      }
      if (row.payload.redirector_click_at) row.payload.redirector_click_at = shifted(row.payload.redirector_click_at);
      if (row.payload.install_begin_at_server) row.payload.install_begin_at_server = shifted(row.payload.install_begin_at_server);
      if (mode && row.event_name === "install") {
        delete row.payload.click_id;
        row.payload.referrer_status = mode === "organic" ? "none" : "unavailable";
        if (mode === "unknown_nonorganic") {
          row.payload.meta_referrer_status = "decrypted";
          row.payload.meta_referrer_context = { attribution_model: "last_click" };
        }
      }
      return row;
    }).filter((row: Any) => !mode || row.event_name !== "click");
    const attempts: CandidateAttempt[] = records.map((record: Any) => ({ server: { ...input.server_context, received_at: receivedAt }, record, batch_id: `synthetic-${label}` }));
    const result = await ingestRuntimeBatch(attempts, app, history);
    assert.equal(result.rejections.length, 0);
    history.push(...attempts);
  }

  async function detailFixture() {
    input=JSON.parse(readFileSync("fixtures/v0.4/63-selected-acquisition-detail/input.json","utf8")
      .replaceAll('"tenant-a"',JSON.stringify(identity.tenantId)));
    input.metric_evaluations=[];
    await ingestFixture(`detail-discovery-${identity.tenantId}`,input,app,seed);
    history=input.records.map((record:Any)=>({server:input.server_context,record,batch_id:"synthetic-initial-detail"}));
  }
  const detailSchedule=(grain:"ad_group"|"creative",max=10,start_date="2026-08-06",clock=first)=>registerMetricSchedule({pool:app,identity,now:clock,
    body:{lag_days:6,start_date,fx_policy:input.fx_policy,metric_definitions:structuredClone(ACQUISITION_DETAIL_METRIC_DEFINITIONS),
      evaluations:[{metric_names:["d7_roas"],date_dimension:"cohort_date",grouping:{},
        campaign_discovery:{policy:"selected_acquisition_and_cost_v1",max_targets:max,grain}}]}});
  const detailCost=(date:string,as_of:string,detail?:{ad_group_id:string;creative_id?:string})=>withTenant(app,identity.tenantId,
    client=>persistCostImportWithClient(client,"synthetic-discovered-cost",[{
      tenant_id:identity.tenantId,app_id:identity.appId,network:"synthetic-network",campaign_id:"campaign-a",date,as_of,
      amount_unscaled:"10000000",amount_scale:6,currency:"USD",source:"imported_reported",...detail,
      ...(detail?{coverage_scope:"matching_detail_only" as const}:{})}]));

  it("detail_discovery_freezes_known_targets_restarts_identically_and_adds_a_new_creative_on_the_next_date",async()=>{
    await detailFixture();
    const schedule=await detailSchedule("creative");
    const pending=await claimNextScheduledDate(app,schedule,first); assert.ok(pending?.targetSet);
    assert.deepEqual(pending.targetSet.targets.map(row=>row.grouping.creative_id).sort(),["synthetic-creative-a","synthetic-creative-b"]);
    const added={ad_group_id:"synthetic-group-c",creative_id:"synthetic-creative-c"};
    await detailCost("2026-08-06","2026-08-12T00:00:00.000Z",added);
    await processMetricSchedules(app,identity.tenantId,{now:first});
    const original=await rows(); assert.equal(original.length,2); assert.ok(original.every(row=>row.value_unscaled==="2000000"));
    await withTenant(app,identity.tenantId,client=>client.query(`UPDATE control.metric_schedule_checkpoints SET last_target_date=NULL,
      pending_target_date=$3::date,pending_watermark=$4,pending_definition_digest=$5 WHERE tenant_id=$1 AND metric_schedule_id=$2`,
      [identity.tenantId,schedule.metric_schedule_id,pending.targetDate,pending.watermark,pending.definitionDigest]));
    assert.equal((await processMetricSchedules(app,identity.tenantId,{now:first})).replayedDates,1);
    assert.equal(jcs(await rows()),jcs(original));
    assert.equal((await listed())[0].latest_discovery?.target_digest,pending.targetSet.target_digest);
    await campaign("detail-next","campaign-a",1,undefined,added);
    await detailCost("2026-08-07","2026-08-13T00:00:00.000Z",added);
    await processMetricSchedules(app,identity.tenantId,{now:next});
    const daily=(await rows()).filter(row=>row.grouping.dimensions.cohort_date==="2026-08-07");
    assert.equal(daily.length,1); assert.equal(daily[0].grouping.dimensions.creative_id,added.creative_id);
    assert.equal(daily[0].value_unscaled,"2000000");
    for(const row of original)assert.equal(jcs((await rows()).find(saved=>saved.metric_run_id===row.metric_run_id)),jcs(row));
  });

  it("detail_discovery_reports_unknown_and_parent_only_cost_and_refuses_overflow_and_post_freeze_privacy_changes",async()=>{
    await detailFixture();
    await campaign("detail-unknown","campaign-a",2,undefined,{ad_group_id:"synthetic-group-unknown"});
    await detailCost("2026-08-08","2026-08-14T00:00:00.000Z");
    const unknown=await detailSchedule("creative",10,"2026-08-08",new Date("2026-08-14T12:00:00.000Z"));
    await processMetricSchedules(app,identity.tenantId,{now:new Date("2026-08-14T12:00:00.000Z")});
    const receipt=(await listed())[0].latest_discovery!;
    assert.equal(receipt.selection_state,"partial_unknown");
    assert.equal((receipt.counts as Any).unknown_detail,1); assert.equal((receipt.counts as Any).parent_only_cost,1);
    assert.equal((await rows()).length,0);
    await disableMetricSchedule({pool:app,identity,metricScheduleId:unknown.metric_schedule_id});
    const overflow=await detailSchedule("creative",1);
    await assert.rejects(processMetricSchedules(app,identity.tenantId,{now:first}),/cycle_failed/);
    assert.equal((await listed()).find(row=>row.metric_schedule_id===overflow.metric_schedule_id)?.safe_reason,"target_limit");
    assert.equal((await rows()).length,0);
    await disableMetricSchedule({pool:app,identity,metricScheduleId:overflow.metric_schedule_id});
    const privacy=await detailSchedule("ad_group"); await claimNextScheduledDate(app,privacy,first);
    await withTenant(app,identity.tenantId,client=>client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id)
      VALUES ($1,$2,'click-63-a','redacted','2026-08-12T10:00:00.000Z','privacy:synthetic-detail-discovery')`,[identity.tenantId,identity.appId]));
    await assert.rejects(processMetricSchedules(app,identity.tenantId,{now:first}),/cycle_failed/);
    assert.equal((await listed()).find(row=>row.metric_schedule_id===privacy.metric_schedule_id)?.safe_reason,"privacy_unavailable");
    assert.equal((await rows()).length,0);
  });

  it("connects daily campaign discovery, the next campaign and late-input correction without a duplicate total", async () => {
    await register();
    await processMetricSchedules(app, identity.tenantId, { now: first });
    const original = await rows(); assert.equal(original.length, 1); assert.equal(original[0].value_unscaled, "2000000");
    await campaign("day2-a", "campaign-a"); await campaign("day2-b", "synthetic-campaign-b");
    await cost("campaign-a", "2026-08-07"); await cost("synthetic-campaign-b", "2026-08-07");
    await processMetricSchedules(app, identity.tenantId, { now: next });
    const all = await rows(), daily = all.filter(row => row.grouping.dimensions.cohort_date === "2026-08-07");
    assert.equal(daily.length, 2); assert.ok(daily.every(row => row.value_unscaled === "2000000"));
    assert.deepEqual(daily.map(row => row.grouping.dimensions.campaign_id).sort(), ["campaign-a", "synthetic-campaign-b"]);
    assert.ok(all.every(row => row.grouping.dimensions.attribution_status === "non_organic"));
    assert.equal(jcs(all.find(row => row.metric_run_id === original[0].metric_run_id)), jcs(original[0]));
    const receivedAt = "2026-08-14T00:00:00.000Z";
    const late: CandidateAttempt = { server: { ...input.server_context, received_at: receivedAt }, batch_id: "synthetic-late-after-schedule",
      record: { ...input.records[2], record_id: "synthetic-late-after-schedule", event_id: "synthetic-late-after-schedule",
        delivery_id: "synthetic-late-after-schedule", received_at: receivedAt,
        payload: { ...input.records[2].payload, amount_unscaled: "10000000" } } };
    assert.equal((await ingestRuntimeBatch([late], app, history)).rejections.length, 0);
    const job = await requestMetricRecalculation(app, identity, { trigger_kind: "late_events",
      source_record_ids: [late.record.record_id], date_from: "2026-08-06", date_to: "2026-08-07", watermark: receivedAt });
    assert.equal(job.selected_runs, 1);
    assert.equal((await processMetricRecalculations(app, identity.tenantId)).completed, 1);
    const corrected = await rows();
    assert.equal(corrected.find(row => row.supersedes_metric_run_id === original[0].metric_run_id)?.value_unscaled, "3000000");
    assert.equal(jcs(corrected.find(row => row.metric_run_id === original[0].metric_run_id)), jcs(original[0]));
  });

  it("freezes targets before calculation and replays committed evidence with the same set after a crash", async () => {
    const schedule = await register();
    const pending = await claimNextScheduledDate(app, schedule, first); assert.ok(pending?.targetSet);
    await cost("synthetic-after-claim");
    await processMetricSchedules(app, identity.tenantId, { now: first });
    const before = await rows(); assert.equal(before.length, 1);
    await withTenant(app, identity.tenantId, client => client.query(`UPDATE control.metric_schedule_checkpoints
      SET last_target_date=NULL,pending_target_date=$3::date,pending_watermark=$4,pending_definition_digest=$5
      WHERE tenant_id=$1 AND metric_schedule_id=$2`, [identity.tenantId, schedule.metric_schedule_id,
      pending.targetDate, pending.watermark, pending.definitionDigest]));
    assert.equal((await processMetricSchedules(app, identity.tenantId, { now: first })).replayedDates, 1);
    assert.equal(jcs(await rows()), jcs(before));
    assert.equal((await listed())[0].latest_discovery?.target_digest, pending.targetSet.target_digest);
  });

  it("separates cost-only, organic and unattributed rows and reports unknown campaign inputs without guessing", async () => {
    await campaign("organic", "unused", 0, "organic");
    await campaign("unattributed", "unused", 0, "unattributed");
    await campaign("unknown", "unused", 0, "unknown_nonorganic");
    await cost("synthetic-cost-only"); await cost(null);
    await register(); await processMetricSchedules(app, identity.tenantId, { now: first });
    const all = await rows();
    assert.ok(all.some(row => row.grouping.dimensions.campaign_id === "synthetic-cost-only" && row.value_unscaled === "0"));
    const organic = all.find(row => row.grouping.dimensions.attribution_status === "organic");
    assert.ok(organic); assert.equal(organic.value_state, "undefined"); assert.equal(organic.undefined_reason, "no_attributed_cost");
    assert.ok(all.some(row => row.grouping.dimensions.attribution_status === "unattributed"));
    assert.ok(all.every(row => row.grouping.dimensions.attribution_status !== "non_organic" || row.grouping.dimensions.campaign_id));
    const discovery = (await listed())[0].latest_discovery!;
    assert.equal(discovery.selection_state, "partial_unknown"); assert.equal((discovery.counts as Any).unknown_cost, 1);
    assert.equal((discovery.counts as Any).unknown_nonorganic, 1);
    assert.equal((discovery.counts as Any).cost_only_targets, 1);
    assert.equal((await listMetricSchedules(reader, { ...identity, appId: "synthetic-other-app" })).length, 0);
    assert.equal((await listMetricSchedules(reader, { ...identity, tenantId: "synthetic-other-tenant" })).length, 0);
  });

  it("distinguishes known empty dates, bounded overflow and disablement without partial output", async () => {
    const schedule = await register(1, "2026-08-05");
    await cost("synthetic-overflow");
    await assert.rejects(processMetricSchedules(app, identity.tenantId, { now: first }), /cycle_failed/);
    const state = (await listed())[0];
    assert.equal(state.last_target_date, "2026-08-05"); assert.equal(state.latest_discovery?.selection_state, "known_empty");
    assert.equal(state.safe_reason, "target_limit"); assert.equal((await rows()).length, 0);
    await disableMetricSchedule({ pool: app, identity, metricScheduleId: schedule.metric_schedule_id });
    assert.equal((await processMetricSchedules(app, identity.tenantId, { now: next })).schedules, 0);
  });

  it("refuses privacy changes between target selection and publication without reviving removed evidence", async () => {
    const schedule = await register(); await claimNextScheduledDate(app, schedule, first);
    await withTenant(app, identity.tenantId, client => client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at,privacy_request_id)
      VALUES ($1,$2,'click-1','redacted','2026-08-12T10:00:00.000Z','privacy:synthetic-discovery')`, [identity.tenantId, identity.appId]));
    await assert.rejects(processMetricSchedules(app, identity.tenantId, { now: first }), /cycle_failed/);
    assert.equal((await listed())[0].safe_reason, "privacy_unavailable"); assert.equal((await rows()).length, 0);
  });
});
