import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { acquirePrivacyTenantSessionReadFence, replayPrivacyMetricItem, withTenant,
  type PrivacyCalculatedMetric } from "@openmasu/runtime";
import { computeSqlMetricRunsWithClient } from "./metrics/cohort.js";

type Claim = { recalculation_id: string; source_metric_run_id: string; tenant_id: string; app_id: string;
  replay_digest: string; watermark: string; created_at: string; lease_token: string;
  trigger_kind: "cost_revision" | "late_events" | "privacy_deletion" | "attribution_revision";
  automatic_correction: boolean; attribution_revision_id: string|null; source_snapshot_digest: string|null;
  privacy_request_id: string | null; completed_at: string | null;
  source_records: { record_id: string; payload_sha256: string }[] | null };

async function claimNext(pool: Pool, tenantId: string): Promise<Claim | undefined> {
  return withTenant(pool, tenantId, async client => {
    await client.query(`UPDATE control.metric_recalculation_items SET state='failed',safe_reason='retry_exhausted',
      lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND attempts>=3 AND state IN ('processing','retry')
        AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())`, [tenantId]);
    const next = await client.query<Omit<Claim, "lease_token">>(
      `SELECT item.recalculation_id,item.source_metric_run_id,item.tenant_id,item.app_id,item.replay_digest,
         job.watermark,job.created_at,job.trigger_kind,job.source_records,job.privacy_request_id,privacy.completed_at,
         job.automatic_correction,job.attribution_revision_id,job.source_snapshot_digest
       FROM control.metric_recalculation_items AS item
       JOIN control.metric_recalculation_jobs AS job USING (tenant_id,app_id,recalculation_id)
       LEFT JOIN ledger.privacy_requests AS privacy ON privacy.tenant_id=job.tenant_id
         AND privacy.privacy_request_id=job.privacy_request_id AND privacy.status='completed'
       WHERE item.tenant_id=$1 AND item.attempts<3 AND item.state IN ('queued','retry','processing')
         AND item.next_attempt_at<=clock_timestamp() AND (item.lease_expires_at IS NULL OR item.lease_expires_at<=clock_timestamp())
         AND (NOT job.automatic_correction OR EXISTS (SELECT 1 FROM control.metric_correction_policies AS policy
           WHERE policy.tenant_id=item.tenant_id AND policy.app_id=item.app_id AND policy.enabled))
         AND (job.trigger_kind<>'privacy_deletion' OR (privacy.completed_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM control.privacy_deletion_jobs AS purge
             WHERE purge.tenant_id=item.tenant_id AND purge.status='processing')))
       ORDER BY job.created_at,item.source_metric_run_id COLLATE "C" LIMIT 1 FOR UPDATE OF item SKIP LOCKED`, [tenantId]);
    if (!next.rows[0]) return undefined;
    const token = randomUUID(), row = next.rows[0];
    await client.query(`UPDATE control.metric_recalculation_items SET state='processing',attempts=attempts+1,
      lease_token=$4::uuid,lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND recalculation_id=$2 AND source_metric_run_id=$3`, [tenantId, row.recalculation_id, row.source_metric_run_id, token]);
    return { ...row, lease_token: token };
  });
}

async function calculate(pool: Pool, claim: Claim): Promise<"completed" | "skipped" | "fenced"> {
  const client = await pool.connect();
  const runLock = JSON.stringify([claim.tenant_id, claim.app_id, "metric-recalculation", claim.source_metric_run_id]);
  let releaseFence: (() => Promise<void>) | undefined, runLocked = false, transaction = false, priorTimeout: string | undefined;
  try {
    priorTimeout = (await client.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
    await client.query("SELECT set_config('statement_timeout','60000',false)");
    // Lock BEFORE the RR snapshot, so a waited-for deletion or replacement is visible.
    releaseFence = await acquirePrivacyTenantSessionReadFence(client, claim.tenant_id);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [runLock]); runLocked = true;
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); transaction = true;
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [claim.tenant_id]);
    const owned = await client.query(`SELECT 1 FROM control.metric_recalculation_items
      WHERE tenant_id=$1 AND app_id=$2 AND recalculation_id=$3 AND source_metric_run_id=$4
        AND lease_token=$5::uuid AND state='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [claim.tenant_id, claim.app_id, claim.recalculation_id, claim.source_metric_run_id, claim.lease_token]);
    if (!owned.rowCount) { await client.query("COMMIT"); transaction = false; return "fenced"; }
    if (claim.automatic_correction) {
      const enabled=await client.query(`SELECT enabled FROM control.metric_correction_policies
        WHERE tenant_id=$1 AND app_id=$2 FOR SHARE`,[claim.tenant_id,claim.app_id]);
      if (!enabled.rows[0]?.enabled) {
        await client.query(`UPDATE control.metric_recalculation_items SET state='queued',attempts=greatest(attempts-1,0),
          lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND app_id=$2 AND recalculation_id=$3
          AND source_metric_run_id=$4 AND lease_token=$5::uuid`,
        [claim.tenant_id,claim.app_id,claim.recalculation_id,claim.source_metric_run_id,claim.lease_token]);
        await client.query("COMMIT"); transaction=false; return "fenced";
      }
    }
    const pending = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
    if (pending.rows[0]?.pending_count !== "0") throw new Error("privacy_pending");
    if (claim.trigger_kind === "attribution_revision") {
      const revision=(await client.query(`SELECT artifact FROM ledger.attribution_results
        WHERE tenant_id=$1 AND app_id=$2 AND attribution_id=$3`,
      [claim.tenant_id,claim.app_id,claim.attribution_revision_id])).rows[0]?.artifact;
      if (!revision || sha256(revision)!==claim.source_snapshot_digest) throw Error("input_unavailable");
      const unavailable=await client.query(`SELECT 1 FROM jsonb_array_elements($3::jsonb) AS ref
        LEFT JOIN ledger.raw_records_current AS raw ON raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=ref->>'ref'
        WHERE ref->>'tenant_id'<>$1 OR ref->>'app_id'<>$2 OR raw.record_id IS NULL
          OR raw.payload_lifecycle_status<>'available' LIMIT 1`,
      [claim.tenant_id,claim.app_id,JSON.stringify(revision.evidence_refs??[])]);
      if (unavailable.rowCount) throw Error("input_unavailable");
    }
    if (claim.trigger_kind === "late_events") {
      const missing = await client.query(`SELECT 1 FROM jsonb_to_recordset($3::jsonb)
        AS source(record_id text,payload_sha256 text)
        LEFT JOIN ledger.raw_records_current AS raw ON raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=source.record_id
        WHERE raw.record_id IS NULL OR raw.payload_lifecycle_status<>'available' OR raw.payload_sha256<>source.payload_sha256
        LIMIT 1`, [claim.tenant_id, claim.app_id, JSON.stringify(claim.source_records)]);
      if (missing.rowCount) throw new Error("input_unavailable");
      const lostEvidence = await client.query(`SELECT 1 FROM ledger.metric_runs AS mr,
        LATERAL jsonb_array_elements(coalesce(mr.artifact->'evidence_refs','[]'::jsonb)) AS ref
        LEFT JOIN ledger.raw_records_current AS raw ON raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=ref->>'ref'
        LEFT JOIN ledger.cost_records AS cost ON cost.tenant_id=$1 AND cost.app_id=$2 AND cost.cost_record_id=ref->>'ref'
        WHERE mr.tenant_id=$1 AND mr.app_id=$2 AND mr.metric_run_id=$3
          AND ((raw.record_id IS NOT NULL AND raw.payload_lifecycle_status<>'available')
            OR (raw.record_id IS NULL AND cost.cost_record_id IS NULL)) LIMIT 1`,
      [claim.tenant_id, claim.app_id, claim.source_metric_run_id]);
      if (lostEvidence.rowCount) throw new Error("input_unavailable");
    }
    const superseded = await client.query(`SELECT 1 FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2
      AND supersedes_metric_run_id=$3`, [claim.tenant_id, claim.app_id, claim.source_metric_run_id]);
    let replacementId: string | null = null;
    if (claim.trigger_kind === "privacy_deletion") {
      if (!claim.privacy_request_id || !claim.completed_at) throw new Error("privacy_pending");
      replacementId = await replayPrivacyMetricItem(client, {
        ...claim, privacy_request_id: claim.privacy_request_id, completed_at: claim.completed_at,
      }, async (metricClient, calculation) => await computeSqlMetricRunsWithClient(
        metricClient, calculation.input, true, calculation.scope,
      ) as PrivacyCalculatedMetric[]) ?? null;
    } else if (!superseded.rowCount) {
      const manifest = await client.query<{ artifact: Record<string, any> }>(`SELECT artifact FROM control.metric_replay_manifests
        WHERE tenant_id=$1 AND app_id=$2 AND source_metric_run_id=$3`, [claim.tenant_id, claim.app_id, claim.source_metric_run_id]);
      const replay = manifest.rows[0]?.artifact;
      if (!replay || sha256(replay) !== claim.replay_digest || replay.source_metric_run_id !== claim.source_metric_run_id) throw new Error("definition_changed");
      const name = replay.metric_definition.metric_name;
      if (typeof name !== "string" || name.length > 81) throw new Error("definition_changed");
      const prefix = `recalc:${sha256([claim.recalculation_id, claim.source_metric_run_id]).slice(0, 40)}`;
      const evaluation = { ...replay.evaluation, metric_names: [name], metric_run_id_prefix: prefix,
        supersedes_metric_run_id_prefix: undefined, supersedes_metric_run_id: claim.source_metric_run_id,
        input_received_at_watermark: claim.watermark, computed_at: claim.created_at,
        privacy_state: "after", data_freshness: "recalculated" };
      const runs = await computeSqlMetricRunsWithClient(client, { fx_policy: replay.fx_policy,
        metric_definitions: [replay.metric_definition], metric_evaluations: [evaluation] }, true,
      { tenant_id: claim.tenant_id, app_id: claim.app_id });
      if (runs.length !== 1 || runs[0].supersedes_metric_run_id !== claim.source_metric_run_id) throw new Error("definition_changed");
      replacementId = runs[0].metric_run_id;
    }
    await client.query(`UPDATE control.metric_recalculation_items SET state=$6,replacement_metric_run_id=$7,
      safe_reason=$8,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND app_id=$2 AND recalculation_id=$3 AND source_metric_run_id=$4 AND lease_token=$5::uuid`,
    [claim.tenant_id, claim.app_id, claim.recalculation_id, claim.source_metric_run_id, claim.lease_token,
      replacementId ? "completed" : "skipped", replacementId, replacementId ? null : "already_superseded"]);
    await client.query("COMMIT"); transaction = false;
    return replacementId ? "completed" : "skipped";
  } finally {
    let cleanupError: Error | undefined;
    try {
      if (transaction) await client.query("ROLLBACK");
      if (runLocked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [runLock]);
      if (releaseFence) await releaseFence();
      if (priorTimeout !== undefined) await client.query("SELECT set_config('statement_timeout',$1,false)", [priorTimeout]);
    } catch { cleanupError = new Error("metric_recalculation_cleanup_failed"); }
    client.release(cleanupError);
  }
}

export async function processMetricRecalculations(pool: Pool, tenantId: string, maximumItems = 5) {
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1 || maximumItems > 10) throw new Error("metric_recalculation_limit_invalid");
  const counts = { completed: 0, skipped: 0, fenced: 0, failed: 0 };
  for (let index = 0; index < maximumItems; index += 1) {
    const claim = await claimNext(pool, tenantId);
    if (!claim) break;
    try { counts[await calculate(pool, claim)] += 1; }
    catch (error) {
      const reason = error instanceof Error && ["privacy_pending", "definition_changed", "input_unavailable"].includes(error.message)
        ? error.message : "calculation_unavailable";
      await withTenant(pool, tenantId, client => client.query(`UPDATE control.metric_recalculation_items
        SET state=CASE WHEN $6='input_unavailable' THEN 'unavailable' WHEN attempts>=3 OR $6='definition_changed' THEN 'failed' ELSE 'retry' END,
          safe_reason=$6,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND app_id=$2 AND recalculation_id=$3 AND source_metric_run_id=$4 AND lease_token=$5::uuid`,
      [tenantId, claim.app_id, claim.recalculation_id, claim.source_metric_run_id, claim.lease_token, reason]));
      counts.failed += 1;
    }
  }
  return counts;
}
