import type { Pool, PoolClient } from "pg";
import { previewAcceptedFraudEvidence } from "@openmasu/attribution-core/fraud-preview";
import { fraudBundleHash, sha256Jcs, type FraudBundle } from "@openmasu/fraud-rules";
import { acquirePrivacyTenantSessionReadFence } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

type Any = Record<string, any>;
export class FraudPreviewError extends Error {}
export const FRAUD_PREVIEW_LIMITS = { records:1_000,metricProfiles:20,sourceDays:100,costRows:1_000 } as const;
export type FraudPreviewRequest = { definition:FraudBundle;watermark_at_most:string;baseline_revision_id?:string };
const identifier=/^[A-Za-z0-9._:-]{1,128}$/;
export function parseFraudPreviewRequest(value: unknown,now=new Date()): FraudPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FraudPreviewError("fraud_preview_request_invalid");
  const body=value as Any;
  if (Object.keys(body).some(key=>!["definition","watermark_at_most","baseline_revision_id"].includes(key))) throw new FraudPreviewError("fraud_preview_field_forbidden");
  if (Buffer.byteLength(JSON.stringify(body),"utf8")>65_536) throw new FraudPreviewError("fraud_preview_request_too_large");
  const time=typeof body.watermark_at_most === "string" ? Date.parse(body.watermark_at_most) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== body.watermark_at_most || time>now.getTime()) throw new FraudPreviewError("fraud_preview_watermark_invalid");
  try {fraudBundleHash(body.definition);} catch {throw new FraudPreviewError("fraud_preview_definition_invalid");}
  if (!body.definition.id.startsWith("fraud-")) throw new FraudPreviewError("fraud_preview_definition_invalid");
  if (body.baseline_revision_id !== undefined && (typeof body.baseline_revision_id !== "string" || !identifier.test(body.baseline_revision_id))) throw new FraudPreviewError("fraud_preview_revision_invalid");
  return structuredClone(body) as FraudPreviewRequest;
}

/** Same lock order for read preview and activation; no receipt/audit writes here. */
export async function withFraudSnapshot<T>(pool:Pool,identity:AppAdminIdentity,readOnly:boolean,
  task:(client:PoolClient)=>Promise<T>,bundleLock?:string):Promise<T> {
  if (!identifier.test(identity.tenantId)||!identifier.test(identity.appId)
    || identity.appScope !== undefined && identity.appScope !== identity.appId) throw new FraudPreviewError("forbidden");
  const client=await pool.connect();
  let releasePrivacy:(()=>Promise<void>)|undefined,locked=false,begun=false,broken=false;
  try {
    releasePrivacy=await acquirePrivacyTenantSessionReadFence(client,identity.tenantId);
    if (bundleLock) {await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[bundleLock]);locked=true;}
    await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ${readOnly ? " READ ONLY" : ""}`);begun=true;
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)",[identity.tenantId]);
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result=await task(client);
    await client.query("COMMIT");begun=false;
    return result;
  } finally {
    try {if (begun) await client.query("ROLLBACK");} catch {broken=true;}
    try {if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[bundleLock]);} catch {broken=true;}
    try {await releasePrivacy?.();} catch {broken=true;}
    client.release(broken ? new Error("fraud_snapshot_cleanup_failed") : undefined);
  }
}

function bounded(rows:Any[],maximum:number,reason:string):Any[] {
  if (rows.length>maximum) throw new FraudPreviewError(reason);
  return rows;
}
function side(run:Any) {
  return {value_state:run.value_state ?? "present",...(typeof run.value_unscaled === "string" ? {value_unscaled:run.value_unscaled}:{}),
    ...(run.undefined_reason ? {undefined_reason:run.undefined_reason}:{}),value_type:run.value_type,
    ...(run.currency ? {currency:run.currency}:{}),...(run.amount_scale !== undefined ? {amount_scale:run.amount_scale}:{}),
    ...(run.ratio_scale !== undefined ? {ratio_scale:run.ratio_scale}:{})};
}
function decisionCounts(decisions:readonly Any[]) {
  const byAction={allow:0,flag:0,exclude:0,quarantine:0},byDecision={clear:0,suspected:0,confirmed:0};
  for (const decision of decisions) {byAction[decision.action as keyof typeof byAction]++;byDecision[decision.decision as keyof typeof byDecision]++;}
  return {total:decisions.length,by_action:byAction,by_decision:byDecision};
}

export async function fraudPreviewWithClient(client:PoolClient,identity:AppAdminIdentity,request:FraudPreviewRequest) {
  const args=[identity.tenantId,identity.appId,request.watermark_at_most];
  const issues=new Set<string>();
  const current=(await client.query<Any>(`SELECT * FROM control.rule_bundles_current
    WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_id LIKE 'fraud-%'`,args.slice(0,2))).rows;
  if (current.length!==1) throw new FraudPreviewError("active_fraud_bundle_missing_or_ambiguous");
  const baseline=request.baseline_revision_id ? (await client.query<Any>(`SELECT * FROM control.rule_bundle_revisions
    WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_revision_id=$3`,[...args.slice(0,2),request.baseline_revision_id])).rows[0] : current[0];
  if (!baseline?.definition || baseline.rule_bundle_id !== request.definition.id) throw new FraudPreviewError("fraud_preview_baseline_mismatch");
  if (fraudBundleHash(baseline.definition)!==baseline.rule_bundle_hash || sha256Jcs(baseline.definition)!==baseline.definition_digest) throw new FraudPreviewError("fraud_preview_baseline_digest_invalid");
  const candidateHash=fraudBundleHash(request.definition);
  if (baseline.rule_bundle_revision_id!==current[0].rule_bundle_revision_id) issues.add("baseline_is_not_current");
  const privacy=(await client.query(`SELECT count(*)::int AS count FROM control.privacy_deletion_jobs
    WHERE tenant_id=$1 AND status='processing' AND (app_id=$2 OR artifact_template->>'deletion_scope'='tenant')`,args.slice(0,2))).rows[0];
  if (privacy.count>0) issues.add("privacy_in_progress");
  const rows=bounded((await client.query<Any>(`SELECT raw.artifact AS raw,stored.policy_digest,logical.artifact AS logical,
    COALESCE(click.artifact,install.artifact,session.artifact,purchase.artifact,refund.artifact,revenue.artifact,custom.artifact,deep.artifact) AS payload
    FROM ledger.raw_records_current raw JOIN ledger.raw_records stored USING(tenant_id,app_id,record_id)
    JOIN ledger.logical_events logical USING(tenant_id,app_id,record_id)
    LEFT JOIN ledger.click_facts click USING(tenant_id,app_id,logical_event_id)
    LEFT JOIN ledger.install_facts install USING(tenant_id,app_id,logical_event_id)
    LEFT JOIN ledger.session_facts session USING(tenant_id,app_id,logical_event_id)
    LEFT JOIN ledger.purchase_facts purchase USING(tenant_id,app_id,logical_event_id)
    LEFT JOIN ledger.refund_facts refund USING(tenant_id,app_id,logical_event_id)
    LEFT JOIN ledger.ad_revenue_facts revenue USING(tenant_id,app_id,logical_event_id)
    LEFT JOIN ledger.custom_event_facts custom USING(tenant_id,app_id,logical_event_id)
    LEFT JOIN ledger.deep_link_open_facts deep USING(tenant_id,app_id,logical_event_id)
    WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.received_at::timestamptz<=$3::timestamptz
      AND raw.payload_lifecycle_status='available' AND logical.record_lifecycle='active'
      AND logical.event_name IN ('click','install','session_start','purchase','refund','ad_revenue','custom_event','deep_link_open')
    ORDER BY raw.received_at::timestamptz,raw.record_id COLLATE "C" LIMIT 1001`,args)).rows,FRAUD_PREVIEW_LIMITS.records,"fraud_preview_evidence_limit_exceeded");
  for (const row of rows) {
    if (!row.payload) issues.add("projection_unavailable");
    if (typeof row.policy_digest!=="string"||!row.policy_digest) issues.add("historical_fraud_inputs_missing");
    if (["click","install"].includes(row.raw.event_name) && row.payload?.fraud_input_version!==1) issues.add("historical_fraud_inputs_missing");
  }
  if (rows.length===0) issues.add("no_available_evidence");
  const unavailable=(await client.query(`SELECT count(*)::int AS count FROM ledger.raw_records_current
    WHERE tenant_id=$1 AND app_id=$2 AND received_at::timestamptz<=$3::timestamptz AND payload_lifecycle_status<>'available'`,args)).rows[0].count;
  const attrs=(await client.query<Any>(`SELECT DISTINCT ON(subject_scope,subject_ref) artifact
    FROM ledger.attribution_results WHERE tenant_id=$1 AND app_id=$2 AND decided_at::timestamptz<=$3::timestamptz AND NOT(artifact ? 'fraud_decision_ref')
      AND attribution_id NOT LIKE '%:ctit-clock-provisional:%'
      AND attribution_id NOT LIKE 'attribution:ctit-provisional:%'
    ORDER BY subject_scope,subject_ref,decided_at::timestamptz DESC,attribution_id COLLATE "C" DESC LIMIT 1001`,args)).rows;
  bounded(attrs,FRAUD_PREVIEW_LIMITS.records,"fraud_preview_attribution_limit_exceeded");
  const costs=bounded((await client.query<Any>(`SELECT artifact FROM ledger.cost_records
    WHERE tenant_id=$1 AND app_id=$2 AND as_of::timestamptz<=$3::timestamptz ORDER BY as_of::timestamptz,cost_record_id COLLATE "C" LIMIT 1001`,args)).rows,
    FRAUD_PREVIEW_LIMITS.costRows,"fraud_preview_cost_limit_exceeded");
  const sources=bounded((await client.query<Any>(`SELECT DISTINCT ON(source.metric_date,source.campaign_id,source.network,source.site_id)
    source.tenant_id,source.app_id,source.metric_date::text,source.campaign_id,source.network,source.site_id,
    source.clicks::text,source.installs::text,source.artifact->>'median_cvr' AS median_cvr,
    source.artifact->>'fraud_input_version' AS fraud_input_version,source.ctit_negative_count::text,
    source.ctit_p50_ms::text,source.ctit_p95_ms::text,source.computed_at,source.input_snapshot_id FROM ledger.source_day_aggregates source
    WHERE source.tenant_id=$1 AND source.app_id=$2 AND source.computed_at::timestamptz<=$3::timestamptz
    ORDER BY source.metric_date,source.campaign_id,source.network,source.site_id,source.computed_at::timestamptz DESC,source.input_snapshot_id DESC LIMIT 101`,args)).rows,
    FRAUD_PREVIEW_LIMITS.sourceDays,"fraud_preview_source_limit_exceeded");
  if (sources.some(row=>row.fraud_input_version!=="1"||typeof row.median_cvr!=="string")) issues.add("historical_fraud_inputs_missing");
  const profiles=bounded((await client.query<Any>(`SELECT DISTINCT ON(run.metric_name,run.metric_definition_version,run.grouping_digest) manifest.artifact
    FROM ledger.metric_runs run JOIN control.metric_replay_manifests manifest
      ON manifest.tenant_id=run.tenant_id AND manifest.app_id=run.app_id AND manifest.source_metric_run_id=run.metric_run_id
    WHERE run.tenant_id=$1 AND run.app_id=$2 AND run.input_received_at_watermark::timestamptz<=$3::timestamptz
      AND manifest.artifact->'metric_definition'->>'fraud_policy' IN ('gross','net')
    ORDER BY run.metric_name,run.metric_definition_version,run.grouping_digest,run.computed_at::timestamptz DESC,run.metric_run_id DESC LIMIT 21`,args)).rows,
    FRAUD_PREVIEW_LIMITS.metricProfiles,"fraud_preview_metric_limit_exceeded");
  const policyPairs=new Map<string,Set<string>>();
  for (const {artifact:profile} of profiles) {
    const {metric_name:_name,fraud_policy:policy,...meaning}=profile.metric_definition;
    const key=sha256Jcs([meaning,profile.evaluation.grouping ?? {},profile.fx_policy]);
    policyPairs.set(key,new Set([...(policyPairs.get(key) ?? []),policy]));
  }
  if (![...policyPairs.values()].some(pair=>pair.has("gross")&&pair.has("net"))) issues.add("gross_net_metric_pair_missing");
  const records=rows.filter(row=>row.payload).map(({raw,logical,payload,policy_digest})=>({batch_id:`preview:${raw.record_id}`,
    server:{tenant_id:identity.tenantId,app_id:identity.appId,policy_digest,received_at:raw.received_at},
    record:{...raw,payload:Object.fromEntries(Object.entries(payload).filter(([key,value])=>value!==null&&key!=="fraud_input_version")),
      late:logical.timeliness==="late",processing_sequence:0},
    history_state:{payload_sha256:raw.payload_sha256,semantic_available:true,ledger_position:"preview"}}));
  const sourceInput=sources.map(row=>({...row,clicks:Number(row.clicks),installs:Number(row.installs),medianCvr:Number(row.median_cvr),
    ctitNegativeCount:Number(row.ctit_negative_count),...(row.ctit_p50_ms!==null ? {ctitP50Ms:Number(row.ctit_p50_ms)}:{}),
    ...(row.ctit_p95_ms!==null ? {ctitP95Ms:Number(row.ctit_p95_ms)}:{})}));
  if (sourceInput.some(row=>![row.clicks,row.installs,row.ctitNegativeCount].every(value=>Number.isSafeInteger(value)&&value>=0)
    || !Number.isFinite(row.medianCvr))) throw new FraudPreviewError("fraud_preview_aggregate_out_of_range");
  const emptyInput={source_day_aggregates:sourceInput,metric_evaluations:[]};
  const project=(definition:FraudBundle,metricInput:Any=emptyInput)=>previewAcceptedFraudEvidence({attempts:records,initialAttributions:attrs.map(row=>row.artifact),metricInput,definition});
  const calculationAvailable=!["privacy_in_progress","projection_unavailable","historical_fraud_inputs_missing","no_available_evidence"].some(issue=>issues.has(issue));
  const active=calculationAvailable ? project(baseline.definition):{fraud_decisions:[]};
  const candidate=calculationAvailable ? project(request.definition):{fraud_decisions:[]};
  const metricEffects:Any[]=[];
  for (const {artifact:profile} of profiles) {
    if (!calculationAvailable) break;
    const evaluation={...profile.evaluation,input_received_at_watermark:request.watermark_at_most,computed_at:request.watermark_at_most,
      metric_run_id_prefix:"counterfactual-preview",privacy_state:"after",metric_names:[profile.metric_definition.metric_name]};
    try {
      const metricInput={...emptyInput,metric_definitions:[profile.metric_definition],metric_evaluations:[evaluation],fx_policy:profile.fx_policy,
        cost_records:costs.map(row=>row.artifact)};
      const left=project(baseline.definition,metricInput).metric_runs[0],right=project(request.definition,metricInput).metric_runs[0];
      if (!left||!right) throw new Error("metric_missing");
      metricEffects.push({metric_name:left.metric_name,metric_definition_version:left.metric_definition_version,
        fraud_policy:profile.metric_definition.fraud_policy,grouping:left.grouping,active:side(left),candidate:side(right),
        ...(typeof left.value_unscaled === "string" && typeof right.value_unscaled === "string"
          ? {delta_unscaled:(BigInt(right.value_unscaled)-BigInt(left.value_unscaled)).toString()}:{})});
    } catch {issues.add("metric_evidence_unavailable");metricEffects.push({metric_name:profile.metric_definition.metric_name,
      fraud_policy:profile.metric_definition.fraud_policy,value_state:"unavailable",reason:"metric_evidence_unavailable"});}
  }
  const decisionMap=(values:readonly Any[])=>new Map(values.map(value=>[`${value.subject_ref}\0${value.rule_id}`,sha256Jcs([value.decision,value.action,value.reason_code])]));
  const left=decisionMap(active.fraud_decisions),right=decisionMap(candidate.fraud_decisions);
  const changed=[...new Set([...left.keys(),...right.keys()])].filter(key=>left.get(key)!==right.get(key)).length;
  const evidenceDigest=sha256Jcs({rows,attrs,costs,sources,profiles,unavailable});
  const binding={version:1,tenant_id:identity.tenantId,app_id:identity.appId,baseline_revision_id:baseline.rule_bundle_revision_id,
    candidate_definition_digest:sha256Jcs(request.definition),candidate_hash:candidateHash,watermark_at_most:request.watermark_at_most,evidence_digest:evidenceDigest};
  return {receipt:sha256Jcs(binding),watermark_at_most:request.watermark_at_most,baseline_revision_id:baseline.rule_bundle_revision_id,
    active:{id:baseline.rule_bundle_id,version:baseline.rule_bundle_version,hash:baseline.rule_bundle_hash,
      ...(calculationAvailable ? {...decisionCounts(active.fraud_decisions),decision_digest:sha256Jcs(active.fraud_decisions)}:{})},
    candidate:{id:request.definition.id,version:request.definition.version,hash:candidateHash,
      ...(calculationAvailable ? {...decisionCounts(candidate.fraud_decisions),decision_digest:sha256Jcs(candidate.fraud_decisions)}:{})},
    calculation_available:calculationAvailable,changed_decisions:calculationAvailable ? changed:null,metrics:metricEffects,
    evidence:{available_records:rows.length,excluded_unavailable_records:unavailable,source_days:sources.length,evidence_digest:evidenceDigest},
    issues:[...issues].sort(),can_activate:issues.size===0,writes:false as const,
    basis:"counterfactual_actions_enabled_on_same_available_evidence" as const};
}
export type FraudPreview=Awaited<ReturnType<typeof fraudPreviewWithClient>>;
export async function previewFraudBundle(pool:Pool,identity:AppAdminIdentity,value:unknown,now=new Date()):Promise<FraudPreview> {
  const request=parseFraudPreviewRequest(value,now);
  return withFraudSnapshot(pool,identity,true,client=>fraudPreviewWithClient(client,identity,request));
}
