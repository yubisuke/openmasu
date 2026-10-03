import type { Pool, PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { acquirePrivacyTenantXactFence, correctionCutoff, metricCostScopePredicate, normalizeMetricCorrectionPolicy,
  metricAcquisitionSql, metricAcquisitionJoinSql, metricAcquisitionDimensionSql, selectLateMetricInputs, supportsLateMetric, supportsAttributionMetric, withTenant,
  type MetricCorrectionPolicy } from "@openmasu/runtime";

type Any = Record<string, any>;
type Scope = { tenantId: string; appId: string };
type Target = { root_id: string; meaning: string };
type Receipt = { tenant_id: string; app_id: string; source_kind: "cost_revision"|"late_events"|"attribution_revision";
  source_ref: string; definition: MetricCorrectionPolicy; definition_digest: string; observed_at: Date;
  source_cutoff: string|null; targets: Target[]|null; continuation: number; attempts: number };
type Selected = { metric_run_id: string; replay: Any|null; safe_reason: string|null };
const meaning = (row: Any) => sha256({definition:row.comparison_context?.definition_digest??null,
  fx:row.comparison_context?.fx_digest??null,grouping:row.artifact.grouping?.dimensions??{}});
const ref = (r: Receipt) => [r.tenant_id,r.app_id,r.source_kind,r.source_ref];

async function source(client: PoolClient, r: Receipt) {
  const scope=[r.tenant_id,r.app_id,r.source_ref];
  if (r.source_kind === "cost_revision") {
    const row=(await client.query(`SELECT run.source_snapshot_digest,max(cost.as_of) AS cutoff FROM control.import_runs AS run
      JOIN ledger.cost_records AS cost USING (tenant_id,app_id,import_run_id)
      WHERE run.tenant_id=$1 AND run.app_id=$2 AND run.import_run_id=$3::uuid AND run.status='completed'
      GROUP BY run.source_snapshot_digest`,scope)).rows[0];
    if (!row) throw Error("input_unavailable");
    return {cutoff:row.cutoff,digest:row.source_snapshot_digest,artifact:null};
  }
  if (r.source_kind === "late_events") {
    const row=(await client.query(`SELECT raw.received_at AS cutoff,raw.payload_sha256 AS digest FROM ledger.raw_records_current AS raw
      JOIN ledger.logical_events AS event USING (tenant_id,app_id,record_id)
      WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=$3 AND raw.payload_lifecycle_status='available'`,scope)).rows[0];
    if (!row) throw Error("input_unavailable");
    return {...row,artifact:null};
  }
  const row=(await client.query(`SELECT artifact,decided_at FROM ledger.attribution_results
    WHERE tenant_id=$1 AND app_id=$2 AND attribution_id=$3`,scope)).rows[0];
  if (!row?.artifact?.supersedes_attribution_id || row.artifact.subject_scope!=="installation_level") throw Error("input_unavailable");
  return {cutoff:[row.decided_at,row.artifact.input_cutoff_at].sort().at(-1),digest:sha256(row.artifact),artifact:row.artifact};
}

async function attributionMatches(client: PoolClient, scope: Scope, row: Any, artifact: Any, watermark: string) {
  const replay=row.replay, metric=replay.metric_definition, grouping=replay.evaluation.grouping;
  // Test both the saved and revised membership: a move OUT of a cohort needs correction too.
  for (const [cutoff,previous] of [[row.input_received_at_watermark,artifact.supersedes_attribution_id],[watermark,null]]) {
    const platform=metric.acquisition_basis === "selected_verified_platform";
    const acquisition=previous && !platform ? `SELECT * FROM ledger.attribution_results WHERE tenant_id=$1 AND app_id=$2 AND attribution_id=$9::text`
      : `SELECT * FROM (${metricAcquisitionSql(platform)}) AS selected WHERE ($9::text IS NULL OR selected.attribution_id=$9::text)`;
    const match=await client.query(`WITH acquisition AS (${acquisition})
      SELECT 1 FROM ledger.install_facts AS install JOIN ledger.logical_events AS logical USING (logical_event_id)
      JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
      ${metricAcquisitionJoinSql("$7","$8",platform)}
      WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.installation_id=$4
        AND raw.received_at<=$3 AND raw.payload_lifecycle_status='available'
        ${platform ? "AND acquisition_source.network IS NOT NULL" : ""}
        AND timezone($6,install.occurred_at_ts)::date::text=$5::jsonb->>'cohort_date'
        AND ($5::jsonb->>'campaign_id' IS NULL OR ${metricAcquisitionDimensionSql("campaign_id",platform)}=$5::jsonb->>'campaign_id')
        AND ($5::jsonb->>'network' IS NULL OR ${metricAcquisitionDimensionSql("network",platform)}=$5::jsonb->>'network')
        AND ($5::jsonb->>'ad_group_id' IS NULL OR acquisition_source.ad_group_id=$5::jsonb->>'ad_group_id')
        AND ($5::jsonb->>'creative_id' IS NULL OR acquisition_source.creative_id=$5::jsonb->>'creative_id')
        AND ($5::jsonb->>'country' IS NULL OR install.country=$5::jsonb->>'country')
        AND ($5::jsonb->>'attribution_status' IS NULL OR coalesce(acquisition.status,'unattributed')=$5::jsonb->>'attribution_status') LIMIT 1`,
    [scope.tenantId,scope.appId,cutoff,artifact.subject_ref,JSON.stringify(grouping),metric.aggregation_time_zone,true,"after",previous]);
    if (match.rowCount) return true;
  }
  return false;
}

async function enqueuePage(client: PoolClient, r: Receipt, policy: MetricCorrectionPolicy, targets: Target[], revision: Awaited<ReturnType<typeof source>>) {
  const scope={tenantId:r.tenant_id,appId:r.app_id}, watermark=r.source_cutoff!;
  const current: Any[]=[];
  for (const target of targets) {
    // Follow only explicit lineage, not a similarly named schedule/definition.
    const rows=await client.query(`WITH RECURSIVE lineage AS (
      SELECT mr.*,0 AS depth FROM ledger.metric_runs AS mr WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id=$3
      UNION ALL SELECT next.*,lineage.depth+1 FROM ledger.metric_runs AS next JOIN lineage
        ON next.tenant_id=lineage.tenant_id AND next.app_id=lineage.app_id AND next.supersedes_metric_run_id=lineage.metric_run_id
        WHERE lineage.depth<100)
      SELECT lineage.*,manifest.artifact AS replay,
        EXISTS (SELECT 1 FROM control.metric_recalculation_items AS item WHERE item.tenant_id=$1 AND item.app_id=$2
          AND item.source_metric_run_id=lineage.metric_run_id AND item.state IN ('queued','processing','retry')) AS pending
      FROM lineage LEFT JOIN control.metric_replay_manifests AS manifest ON manifest.tenant_id=$1 AND manifest.app_id=$2
        AND manifest.source_metric_run_id=lineage.metric_run_id
      WHERE NOT EXISTS (SELECT 1 FROM ledger.metric_runs AS next WHERE next.tenant_id=$1 AND next.app_id=$2
        AND next.supersedes_metric_run_id=lineage.metric_run_id)`,[scope.tenantId,scope.appId,target.root_id]);
    if (rows.rows.length!==1 || meaning(rows.rows[0])!==target.meaning) throw Error("unsupported_definition");
    const row=rows.rows[0];
    if (row.pending) throw Error("waiting_for_predecessor");
    if (r.source_kind==="late_events" && row.artifact.evidence_refs?.some((e:Any)=>e.ref===r.source_ref
        && e.tenant_id===r.tenant_id && e.app_id===r.app_id && e.lifecycle_status==="available")) continue;
    // A later successor already includes this committed receipt's fixed cutoff.
    if (row.input_received_at_watermark >= watermark) continue;
    current.push(row);
  }
  let selected: Selected[]=[];
  let late: Awaited<ReturnType<typeof selectLateMetricInputs>>|undefined;
  if (r.source_kind === "late_events" && current.length) {
    late=await selectLateMetricInputs(client,scope,{trigger_kind:"late_events",source_record_ids:[r.source_ref],
      date_from:policy.date_from,date_to:policy.date_to,watermark},current.map(row=>row.metric_run_id),true);
    selected=late.rows;
  } else if (r.source_kind === "cost_revision" && current.length) {
    const matches=await client.query(`SELECT mr.metric_run_id FROM ledger.metric_runs AS mr WHERE mr.tenant_id=$1
      AND mr.app_id=$2 AND mr.metric_run_id=ANY($4::text[])
      AND EXISTS (SELECT 1 FROM ledger.cost_records AS cost WHERE ${metricCostScopePredicate} AND cost.import_run_id=$3::uuid)`,
    [scope.tenantId,scope.appId,r.source_ref,current.map(row=>row.metric_run_id)]);
    const ids=new Set(matches.rows.map(row=>row.metric_run_id));
    selected=current.filter(row=>ids.has(row.metric_run_id)).map(row=>({metric_run_id:row.metric_run_id,replay:row.replay,
      safe_reason:row.replay?.version===1 && supportsLateMetric(row.replay) ? null : "unsupported_definition"}));
  } else if (r.source_kind === "attribution_revision") {
    for (const row of current) {
      if (row.replay?.version!==1 || !supportsAttributionMetric(row.replay) || !["selected_first_party_click","selected_verified_platform"].includes(row.replay.metric_definition.acquisition_basis)) {
        selected.push({metric_run_id:row.metric_run_id,replay:row.replay,safe_reason:"unsupported_definition"});
      } else if (await attributionMatches(client,scope,row,revision.artifact,watermark)) {
        selected.push({metric_run_id:row.metric_run_id,replay:row.replay,safe_reason:null});
      }
    }
  }
  if (!selected.length) return null;
  const digest=sha256({receipt:ref(r),policy:r.definition_digest,cutoff:watermark,page:r.continuation,
    sources:revision.digest,targets:selected.map(row=>[row.metric_run_id,row.replay?sha256(row.replay):null,row.safe_reason])});
  const id=`auto-recalc:${digest.slice(0,48)}`;
  await client.query(`INSERT INTO control.metric_recalculation_jobs
    (recalculation_id,tenant_id,app_id,request_digest,date_from,date_to,watermark,created_at,trigger_kind,automatic_correction,
      cost_import_run_id,cost_snapshot_digest,source_snapshot_digest,source_records,input_status_counts,selection_status,attribution_revision_id)
    VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,true,$10::uuid,$11,$12,$13::jsonb,$14::jsonb,$15,$16)
    ON CONFLICT (tenant_id,app_id,request_digest) DO NOTHING`,[id,r.tenant_id,r.app_id,digest,policy.date_from,policy.date_to,
      watermark,new Date(r.observed_at).toISOString(),r.source_kind,
      r.source_kind==="cost_revision"?r.source_ref:null,r.source_kind==="cost_revision"?revision.digest:null,
      r.source_kind==="cost_revision"?null:late?.snapshot??revision.digest,late?JSON.stringify(late.records):null,
      late?JSON.stringify(late.counts):null,late?.status??null,r.source_kind==="attribution_revision"?r.source_ref:null]);
  for (const row of selected) await client.query(`INSERT INTO control.metric_recalculation_items
    (recalculation_id,tenant_id,app_id,source_metric_run_id,replay_digest,state,safe_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[id,r.tenant_id,r.app_id,row.metric_run_id,
      row.replay?sha256(row.replay):null,row.safe_reason?"unavailable":"queued",row.safe_reason]);
  return id;
}

/** Uses the existing tenant loop and durable jobs. Each short transaction holds a
 * policy row lock + receipt row lock; no extra scheduler, lease daemon or scan cursor. */
export async function planAutomaticMetricCorrections(pool: Pool, tenantId: string, maximumReceipts = 5) {
  if (!Number.isSafeInteger(maximumReceipts) || maximumReceipts<1 || maximumReceipts>20) throw Error("metric_correction_limit_invalid");
  const counts={pages:0,completed:0,deferred:0,unavailable:0};
  for (let index=0;index<maximumReceipts;index++) {
    const outcome=await withTenant(pool,tenantId,async client => {
      await client.query("SET LOCAL statement_timeout='15000'");
      await acquirePrivacyTenantXactFence(client,tenantId,"shared");
      const pending=(await client.query<{pending_count:string}>("SELECT pending_count FROM control.privacy_deletion_backlog()")).rows[0];
      if (pending?.pending_count!=="0") return "deferred";
      const next=(await client.query<Receipt>(`SELECT receipt.* FROM control.metric_correction_receipts AS receipt
        JOIN control.metric_correction_policies AS policy USING (tenant_id,app_id)
        WHERE receipt.tenant_id=$1 AND policy.enabled AND receipt.state IN ('queued','retry') AND receipt.next_attempt_at<=clock_timestamp()
        ORDER BY receipt.observed_at,receipt.source_kind,receipt.source_ref COLLATE "C"
        LIMIT 1 FOR UPDATE OF policy,receipt SKIP LOCKED`,[tenantId])).rows[0];
      if (!next) return null;
      const policy=normalizeMetricCorrectionPolicy(next.definition);
      if (index>=policy.receipts_per_cycle) return null;
      if (sha256(policy)!==next.definition_digest) throw Error("metric_correction_policy_invalid");
      await client.query("SAVEPOINT correction_page");
      try {
        const revision=await source(client,next);
        if (!next.source_cutoff) {
          const planning=(await client.query("SELECT clock_timestamp() AS planned_at")).rows[0].planned_at;
          next.source_cutoff=correctionCutoff([revision.cutoff,new Date(planning).toISOString()].sort().at(-1)!);
        }
        if (!next.targets) {
          const rows=await client.query(`SELECT metric_run_id,artifact,comparison_context FROM ledger.metric_runs AS mr
            WHERE tenant_id=$1 AND app_id=$2 AND grouping->>'cohort_date' BETWEEN $3 AND $4
              AND ($5::text[] IS NULL OR metric_name=ANY($5::text[]))
              AND NOT EXISTS (SELECT 1 FROM ledger.metric_runs AS newer WHERE newer.tenant_id=$1 AND newer.app_id=$2
                AND newer.supersedes_metric_run_id=mr.metric_run_id)
            ORDER BY metric_run_id COLLATE "C" LIMIT $6`,[tenantId,next.app_id,policy.date_from,policy.date_to,
              policy.metric_names??null,policy.maximum_runs_per_receipt+1]);
          if (rows.rows.length>policy.maximum_runs_per_receipt) throw Error("selection_limit");
          next.targets=rows.rows.map(row=>({root_id:row.metric_run_id,meaning:meaning(row)}));
        }
        const page=next.targets.slice(next.continuation,next.continuation+policy.runs_per_page);
        const job=await enqueuePage(client,next,policy,page,revision);
        const cursor=next.continuation+page.length,done=cursor===next.targets.length;
        await client.query(`UPDATE control.metric_correction_receipts SET targets=$5::jsonb,source_cutoff=$6,continuation=$7,
          state=$8,safe_reason=$9,attempts=0,next_attempt_at=clock_timestamp(),
          recalculation_ids=recalculation_ids || $10::jsonb
          WHERE tenant_id=$1 AND app_id=$2 AND source_kind=$3 AND source_ref=$4`,[...ref(next),JSON.stringify(next.targets),
            next.source_cutoff,cursor,done?"completed":"queued",!next.targets.length?"no_matching_runs":null,JSON.stringify(job?[job]:[])]);
        return done?"completed":"pages";
      } catch(error) {
        await client.query("ROLLBACK TO SAVEPOINT correction_page");
        const reason=error instanceof Error && ["input_unavailable","selection_limit","unsupported_definition","waiting_for_predecessor"].includes(error.message)
          ? error.message : "calculation_unavailable";
        const waiting=reason==="waiting_for_predecessor",terminal=["input_unavailable","selection_limit","unsupported_definition"].includes(reason);
        await client.query(`UPDATE control.metric_correction_receipts SET state=$5,safe_reason=$6,
          attempts=CASE WHEN $7 THEN attempts ELSE least(attempts+1,3) END,next_attempt_at=clock_timestamp()+interval '30 seconds'
          WHERE tenant_id=$1 AND app_id=$2 AND source_kind=$3 AND source_ref=$4`,[...ref(next),
            terminal?"unavailable":!waiting && next.attempts>=2?"failed":"retry",reason,waiting]);
        return terminal?"unavailable":"deferred";
      }
    });
    if (!outcome) break;
    counts[outcome]++;
    if (outcome==="deferred") break;
  }
  return counts;
}
