import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core";
import { normalizeMetricRecalculationRequest, revisedMetricCostPredicate, withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

export async function requestMetricRecalculation(pool: Pool, identity: AppAdminIdentity, body: unknown, now = new Date()) {
  const request = normalizeMetricRecalculationRequest(body);
  const digest = sha256(request), id = `recalculation:${sha256([identity.tenantId, identity.appId, digest]).slice(0, 48)}`;
  return withTenant(pool, identity.tenantId, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([identity.tenantId, identity.appId, "metric-recalculation"])]);
    const existing = await client.query("SELECT recalculation_id FROM control.metric_recalculation_jobs WHERE tenant_id=$1 AND app_id=$2 AND request_digest=$3", [identity.tenantId, identity.appId, digest]);
    if (existing.rowCount) return { recalculation_id: id, replayed: true };
    const imported = await client.query<{ source_snapshot_digest: string; watermark_before_revision: boolean }>(
      `SELECT run.source_snapshot_digest,bool_or(control.canonical_timestamp_value(cost.as_of)>$6::timestamptz) AS watermark_before_revision
       FROM control.import_runs AS run JOIN ledger.cost_records AS cost
         ON cost.tenant_id=run.tenant_id AND cost.app_id=run.app_id AND cost.import_run_id=run.import_run_id
       WHERE run.tenant_id=$1 AND run.app_id=$2 AND run.import_run_id=$3::uuid AND run.status='completed'
         AND cost.cost_date BETWEEN $4::date AND $5::date
       GROUP BY run.source_snapshot_digest`, [identity.tenantId, identity.appId, request.cost_import_run_id, request.date_from, request.date_to, request.watermark]);
    const source = imported.rows[0];
    if (!source) throw new Error("cost_revision_not_found");
    if (source.watermark_before_revision) throw new Error("metric_recalculation_watermark_before_revision");
    const selected = await client.query<{ metric_run_id: string; replay: Record<string, any> | null }>(
      `SELECT mr.metric_run_id,manifest.artifact AS replay FROM ledger.metric_runs AS mr
       LEFT JOIN control.metric_replay_manifests AS manifest ON manifest.tenant_id=mr.tenant_id
         AND manifest.app_id=mr.app_id AND manifest.source_metric_run_id=mr.metric_run_id
       WHERE mr.tenant_id=$1 AND mr.app_id=$2 AND ($6::text[] IS NULL OR mr.metric_name=ANY($6::text[]))
         AND NOT EXISTS (SELECT 1 FROM ledger.metric_runs AS replacement WHERE replacement.tenant_id=mr.tenant_id
           AND replacement.app_id=mr.app_id AND replacement.supersedes_metric_run_id=mr.metric_run_id)
         AND EXISTS (SELECT 1 FROM ledger.cost_records AS cost WHERE ${revisedMetricCostPredicate}
           AND cost.import_run_id=$3::uuid AND cost.cost_date BETWEEN $4::date AND $5::date)
       ORDER BY mr.metric_run_id COLLATE "C" LIMIT 101`,
      [identity.tenantId, identity.appId, request.cost_import_run_id, request.date_from, request.date_to, request.metric_names ?? null]);
    if (selected.rows.length > 100) throw new Error("metric_recalculation_selection_limit");
    await client.query(`INSERT INTO control.metric_recalculation_jobs
      (recalculation_id,tenant_id,app_id,request_digest,cost_import_run_id,cost_snapshot_digest,date_from,date_to,watermark,created_at)
      VALUES ($1,$2,$3,$4,$5::uuid,$6,$7::date,$8::date,$9,$10)`,
    [id, identity.tenantId, identity.appId, digest, request.cost_import_run_id, source.source_snapshot_digest, request.date_from, request.date_to, request.watermark, now.toISOString()]);
    for (const row of selected.rows) {
      const available = row.replay?.version === 1 && row.replay.metric_definition && row.replay.evaluation && row.replay.fx_policy;
      await client.query(`INSERT INTO control.metric_recalculation_items
        (recalculation_id,tenant_id,app_id,source_metric_run_id,replay_digest,state,safe_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, identity.tenantId, identity.appId, row.metric_run_id,
        available ? sha256(row.replay) : null, available ? "queued" : "unavailable", available ? null : "replay_unavailable"]);
    }
    await recordDashboardAuditWithClient(client, { tenantId: identity.tenantId, appId: identity.appId,
      actorRef: `admin_key:${identity.keyId}`, action: "metric_recalculation_requested", targetScope: "app", targetRef: id, outcome: "succeeded", now });
    return { recalculation_id: id, selected_runs: selected.rows.length, replayed: false };
  });
}

export async function listMetricRecalculations(pool: Pool, identity: AppAdminIdentity) {
  return withTenant(pool, identity.tenantId, async client => (await client.query(
    `SELECT job.recalculation_id,job.cost_import_run_id,job.cost_snapshot_digest,job.date_from::text,job.date_to::text,
       job.watermark,job.created_at,item.source_metric_run_id,item.replacement_metric_run_id,item.state,item.attempts,item.safe_reason
     FROM (SELECT * FROM control.metric_recalculation_jobs WHERE tenant_id=$1 AND app_id=$2
       ORDER BY created_at DESC,recalculation_id COLLATE "C" LIMIT 20) AS job
     LEFT JOIN control.metric_recalculation_items AS item USING (tenant_id,app_id,recalculation_id)
     ORDER BY job.created_at DESC,job.recalculation_id COLLATE "C",item.source_metric_run_id COLLATE "C"`,
    [identity.tenantId, identity.appId])).rows);
}
