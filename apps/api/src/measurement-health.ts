import type { Pool } from "pg";
import { SDK_POST_PROCESSING_PENDING_REASON } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

export type MeasurementHealth = {
  observed_at: string;
  scope: "retained_history";
  sdk: { active_keys: string; batches: string; pending: string; failed: string; latest_received_at: string | null; oldest_pending_at: string | null };
  imports: { runs: string; running: string; failed: string; latest_started_at: string | null; latest_completed_at: string | null };
  events: { logical_events: string; latest_received_at: string | null };
  rejections: { source: "event" | "mapping"; reason: string; count: string }[];
  metrics: { runs: string; active_schedules: string; pending_schedules: string; latest_computed_at: string | null; latest_watermark: string | null; latest_cohort_date: string | null };
};

export type MeasurementNotice = { state: string; message: string; next: string };

export function measurementNotices(health: MeasurementHealth): MeasurementNotice[] {
  const notices: MeasurementNotice[] = [];
  if (health.sdk.active_keys === "0") notices.push({ state: "sdk_not_configured", message: "No active SDK key is configured.", next: "An administrator can issue an SDK key in app settings; file imports do not require an SDK key." });
  if (health.sdk.batches === "0" && health.imports.runs === "0" && health.events.logical_events === "0") notices.push({ state: "no_observations", message: "No SDK batches, import runs, or logical events are recorded.", next: "Check the chosen ingestion method and submit a synthetic sample. Absence does not prove a service failure." });
  if (health.sdk.pending !== "0" || health.imports.running !== "0") notices.push({ state: "processing_wait", message: "Ingestion work is pending or an import is recorded as running.", next: "Check worker/job status and the oldest pending time. This observation alone does not prove a stalled worker." });
  if (health.sdk.failed !== "0" || health.imports.failed !== "0" || health.rejections.length > 0) notices.push({ state: "rejections_observed", message: "Failures or rejections exist in retained history.", next: "Review the safe reason counts and import validation result before retrying. Historical failures may already be resolved." });
  if (health.events.logical_events !== "0" && health.metrics.runs === "0") notices.push({ state: "not_computed", message: "Logical events exist but no metric run is recorded.", next: "Check metric definitions, cohort date and watermark; run metrics:run or configure a metric schedule." });
  if (health.metrics.pending_schedules !== "0") notices.push({ state: "calculation_wait", message: "A metric schedule has a pending target.", next: "Check scheduled worker progress; a pending target is not proof of a failed calculation." });
  if (health.metrics.runs !== "0") notices.push({ state: "results_observed", message: "Metric results are recorded.", next: "Open the cohort report and check its filters, definition and watermark. Results do not prove complete ingestion or live delivery." });
  return notices;
}

/** A read-only, app-scoped snapshot. Counts use their own grains, never a conversion funnel. */
export async function measurementHealth(pool: Pool, identity: AppAdminIdentity): Promise<MeasurementHealth> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [identity.tenantId]);
    await client.query("SET LOCAL statement_timeout = '5s'");
    const args = [identity.tenantId, identity.appId];
    const sdk = await client.query<MeasurementHealth["sdk"]>(
      `SELECT (SELECT count(*)::text FROM control.sdk_keys_current WHERE tenant_id=$1 AND app_id=$2 AND status='active') AS active_keys,
        count(*)::text AS batches,
        count(*) FILTER (WHERE status='pending' OR (status='processed' AND reason_code=$3))::text AS pending,
        count(*) FILTER (WHERE status='failed')::text AS failed,
        max(received_at) AS latest_received_at,
        min(received_at) FILTER (WHERE status='pending' OR (status='processed' AND reason_code=$3)) AS oldest_pending_at
       FROM ledger.ingest_batches_current WHERE tenant_id=$1 AND app_id=$2`,
      [...args, SDK_POST_PROCESSING_PENDING_REASON],
    );
    const imports = await client.query<MeasurementHealth["imports"]>(
      `SELECT count(*)::text AS runs, count(*) FILTER (WHERE status='running')::text AS running,
        count(*) FILTER (WHERE status='failed')::text AS failed,
        max(started_at) AS latest_started_at, max(completed_at) AS latest_completed_at
       FROM control.import_runs WHERE tenant_id=$1 AND app_id=$2`, args,
    );
    const events = await client.query<MeasurementHealth["events"]>(
      `SELECT count(*)::text AS logical_events,
        (SELECT max(received_at) FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2) AS latest_received_at
       FROM ledger.logical_events WHERE tenant_id=$1 AND app_id=$2`, args,
    );
    // Collapse unknown/free-form reasons in SQL: neither their values nor payloads leave the DB.
    const rejections = await client.query<MeasurementHealth["rejections"][number]>(
      `SELECT source, CASE WHEN reason_code IN (
        'payload_schema_invalid','mapping_validation_failed','row_schema_invalid','timestamp_invalid',
        'row_too_large','unsupported_event_type','event_id_conflict','duplicate_delivery'
       ) THEN reason_code ELSE 'other' END AS reason, count(*)::text AS count
       FROM (
        SELECT 'event' AS source, reason_code FROM ledger.rejections WHERE tenant_id=$1 AND app_id=$2
        UNION ALL
        SELECT 'mapping' AS source, reason_code FROM control.import_row_rejections WHERE tenant_id=$1 AND app_id=$2
       ) AS rejected GROUP BY source, reason ORDER BY source, reason`, args,
    );
    const metrics = await client.query<MeasurementHealth["metrics"]>(
      `SELECT count(*)::text AS runs, max(computed_at) AS latest_computed_at,
        (SELECT input_received_at_watermark FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2
         ORDER BY computed_at DESC, metric_run_id DESC LIMIT 1) AS latest_watermark,
        (SELECT substring(grouping->'dimensions'->>'cohort_date' FROM '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
         FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2 ORDER BY computed_at DESC, metric_run_id DESC LIMIT 1) AS latest_cohort_date,
        (SELECT count(*)::text FROM control.metric_schedules_current WHERE tenant_id=$1 AND app_id=$2 AND status='active') AS active_schedules,
        (SELECT count(*)::text FROM control.metric_schedule_checkpoints WHERE tenant_id=$1 AND app_id=$2 AND pending_target_date IS NOT NULL) AS pending_schedules
       FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2`, args,
    );
    const observed = await client.query<{ observed_at: string }>("SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS observed_at");
    await client.query("COMMIT");
    return { observed_at: observed.rows[0].observed_at, scope: "retained_history", sdk: sdk.rows[0], imports: imports.rows[0], events: events.rows[0], rejections: rejections.rows, metrics: metrics.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
