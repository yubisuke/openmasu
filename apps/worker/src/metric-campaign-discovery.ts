import type { PoolClient } from "pg";
import { sha256Jcs } from "@openmasu/fraud-rules";
import { metricAcquisitionSql, metricAcquisitionJoinSql, metricAcquisitionDimensionSql } from "@openmasu/runtime";

type Any = Record<string, any>;
export type CampaignTarget = { evaluation: number; grouping: Record<string, string> };
export type CampaignTargetSet = {
  targets: CampaignTarget[]; target_digest: string; privacy_epoch: string;
  counts: Record<string, number>; selection_state: "ready" | "known_empty" | "partial_unknown";
};

export async function schedulePrivacyEpoch(client: PoolClient, tenantId: string, appId: string): Promise<string> {
  return (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ledger.raw_payload_states
    WHERE tenant_id=$1 AND app_id=$2 AND lifecycle_status<>'available'`, [tenantId, appId])).rows[0].count;
}

/** Discover dimensions, not values: all arithmetic stays in the cohort engine. */
export async function freezeCampaignTargets(
  client: PoolClient, schedule: Any, pending: { targetDate: string; watermark: string; definitionDigest: string },
): Promise<CampaignTargetSet> {
  const scope = [schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id, pending.targetDate];
  const existing = await client.query<{ artifact: CampaignTargetSet; watermark: string; definition_digest: string }>(
    `SELECT artifact,watermark,definition_digest FROM control.metric_schedule_targets
     WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3 AND target_date=$4::date`, scope);
  if (existing.rows[0]) {
    if (existing.rows[0].watermark !== pending.watermark || existing.rows[0].definition_digest !== pending.definitionDigest
        || sha256Jcs(existing.rows[0].artifact.targets) !== existing.rows[0].artifact.target_digest) {
      throw new Error("metric_schedule_target_mismatch");
    }
    return existing.rows[0].artifact;
  }
  const targets: CampaignTarget[] = [], counts = { unknown_nonorganic: 0, unknown_cost: 0, cost_only_targets: 0 };
  for (const [index, evaluation] of schedule.definition.evaluations.entries()) {
    if (!evaluation.campaign_discovery) {
      targets.push({ evaluation: index, grouping: evaluation.grouping });
      continue;
    }
    const metric = schedule.definition.metric_definitions.find((value: Any) => value.metric_name === evaluation.metric_names[0]);
    const platform = metric.acquisition_basis === "selected_verified_platform";
    const result = await client.query<{ grouping: Record<string, string> | null; reason: string; count: string; cost_only: boolean }>(
      `WITH acquisition AS (${metricAcquisitionSql(metric.acquisition_basis === "selected_verified_platform")}),
       cohort_sources AS (
         SELECT ${metricAcquisitionDimensionSql("campaign_id", metric.acquisition_basis === "selected_verified_platform")} AS campaign_id,
           ${metricAcquisitionDimensionSql("network", metric.acquisition_basis === "selected_verified_platform")} AS network,
           install.country,acquisition.reason_code,
           coalesce(acquisition.status,'unattributed') AS status,
           (raw.payload_lifecycle_status<>'available'
             ${platform ? "OR coalesce(acquisition.lifecycle_status<>'available',false)" : ""} OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(coalesce(acquisition.artifact->'evidence_refs','[]'::jsonb)) AS ref
             JOIN ledger.raw_records_current AS evidence ON evidence.tenant_id=$1 AND evidence.app_id=$2
               AND evidence.record_id=ref->>'ref' WHERE evidence.payload_lifecycle_status<>'available'
           )) AS unavailable
         FROM ledger.install_facts AS install
         JOIN ledger.logical_events AS logical ON logical.logical_event_id=install.logical_event_id
           AND logical.tenant_id=install.tenant_id AND logical.app_id=install.app_id
         JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id
           AND raw.record_id=logical.record_id
         ${metricAcquisitionJoinSql("$7", "$8", metric.acquisition_basis === "selected_verified_platform")}
         WHERE install.tenant_id=$1 AND install.app_id=$2 AND raw.received_at<=$3
           AND timezone($5::text,install.occurred_at_ts)::date=$4::date
           ${platform ? "AND acquisition.source IS NOT NULL" : ""}
       ), current_cost AS (
         SELECT DISTINCT ON (network,cost_date,campaign_id,ad_group_id,country) campaign_id,network
         FROM ledger.cost_records WHERE tenant_id=$1 AND app_id=$2 AND as_of<=$3 AND cost_date=$4::date
           ${platform ? "AND network IN ('apple_adservices','meta_install_referrer')" : ""}
           AND ($6::jsonb->>'network' IS NULL OR network=$6::jsonb->>'network')
           AND ($6::jsonb->>'country' IS NULL OR country=$6::jsonb->>'country')
           AND ($6::jsonb->>'attribution_status' IS NULL OR $6::jsonb->>'attribution_status'='non_organic')
         ORDER BY network,cost_date,campaign_id,ad_group_id,country,as_of DESC,cost_record_id COLLATE "C" DESC
       ), candidates AS (
         SELECT CASE WHEN unavailable THEN 'privacy_unavailable'
                  WHEN status='non_organic' AND (campaign_id IS NULL OR network IS NULL) THEN 'unknown_nonorganic'
                  ELSE 'target' END AS reason,
           ${platform ? "jsonb_strip_nulls(jsonb_build_object('campaign_id',campaign_id,'network',network,'attribution_status',status))"
             : "CASE WHEN status='non_organic' THEN jsonb_build_object('campaign_id',campaign_id,'network',network,'attribution_status',status) ELSE jsonb_build_object('attribution_status',status) END"} AS grouping, false AS from_cost
         FROM cohort_sources
         WHERE unavailable OR (
           ($6::jsonb->>'network' IS NULL OR network=$6::jsonb->>'network')
           AND ($6::jsonb->>'country' IS NULL OR country=$6::jsonb->>'country')
           AND ($6::jsonb->>'attribution_status' IS NULL OR status=$6::jsonb->>'attribution_status')
           AND ($9::text='gross' OR reason_code IS DISTINCT FROM 'fraud_excluded'))
         UNION ALL
         SELECT CASE WHEN campaign_id IS NULL OR network IS NULL THEN 'unknown_cost' ELSE 'target' END,
           jsonb_build_object('campaign_id',campaign_id,'network',network,'attribution_status','non_organic'),true
         FROM current_cost
       ) SELECT reason,CASE WHEN reason='target' THEN grouping ELSE NULL END AS grouping,
         count(*)::text AS count,bool_and(from_cost) AS cost_only FROM candidates
       GROUP BY reason,CASE WHEN reason='target' THEN grouping ELSE NULL END
       ORDER BY reason COLLATE "C",(CASE WHEN reason='target' THEN grouping ELSE NULL END)::text COLLATE "C"
       LIMIT $10`, [schedule.tenant_id, schedule.app_id, pending.watermark, pending.targetDate, metric.aggregation_time_zone,
        // Discover a superset for all metric names; each metric retains its own gross/net calculation policy.
        JSON.stringify(evaluation.grouping), true, "after", "gross", evaluation.campaign_discovery.max_targets + 4]);
    if (result.rows.some(row => row.reason === "privacy_unavailable")) throw new Error("metric_schedule_privacy_unavailable");
    const selected = result.rows.filter(row => row.reason === "target");
    if (selected.length > evaluation.campaign_discovery.max_targets) throw new Error("metric_schedule_target_limit");
    for (const row of result.rows) {
      if (row.reason === "unknown_nonorganic" || row.reason === "unknown_cost") counts[row.reason] += Number(row.count);
      if (row.reason === "target") {
        targets.push({ evaluation: index, grouping: { ...evaluation.grouping, ...row.grouping } });
        if (row.cost_only) counts.cost_only_targets += 1;
      }
    }
  }
  targets.sort((a, b) => a.evaluation - b.evaluation || (sha256Jcs(a.grouping) < sha256Jcs(b.grouping) ? -1 : 1));
  const artifact: CampaignTargetSet = { targets, target_digest: sha256Jcs(targets), counts,
    privacy_epoch: await schedulePrivacyEpoch(client, schedule.tenant_id, schedule.app_id),
    selection_state: counts.unknown_nonorganic || counts.unknown_cost ? "partial_unknown" : targets.length ? "ready" : "known_empty" };
  // An empty post-deletion ledger is not affirmative evidence of an empty original cohort.
  if (!targets.length && artifact.privacy_epoch !== "0") throw new Error("metric_schedule_privacy_unavailable");
  await client.query(`INSERT INTO control.metric_schedule_targets
    (tenant_id,app_id,metric_schedule_id,target_date,watermark,definition_digest,target_digest,selection_state,artifact)
    VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9::jsonb)`,
  [...scope, pending.watermark, pending.definitionDigest, artifact.target_digest, artifact.selection_state, JSON.stringify(artifact)]);
  return artifact;
}
