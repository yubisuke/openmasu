import type { Pool } from "pg";
import { SDK_POST_PROCESSING_PENDING_REASON } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recentMeasurementGroups, type MeasurementWindowHours } from "./recent-measurement-health.js";

import type { MeasurementHealth } from "./measurement-notices.js";
export { measurementNotices, type MeasurementHealth, type MeasurementNotice } from "./measurement-notices.js";
export { parseMeasurementWindow, MeasurementHealthQueryError } from "./recent-measurement-health.js";

/** A read-only, app-scoped snapshot. Counts use their own grains, never a conversion funnel. */
export async function measurementHealth(pool: Pool, identity: AppAdminIdentity, hours: MeasurementWindowHours = 24): Promise<MeasurementHealth> {
  if (![1,24,168].includes(hours)) throw new Error("health_window_invalid");
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
    const recent = await recentMeasurementGroups(client, identity, hours);
    const observed = await client.query<{ observed_at: string; received_from: string; previous_from: string }>(
      `SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
        to_char((transaction_timestamp()-$1::int*interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_from,
        to_char((transaction_timestamp()-($1::int*2)*interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS previous_from`, [hours]);
    await client.query("COMMIT");
    return { observed_at: observed.rows[0].observed_at, scope: "retained_history", sdk: sdk.rows[0], imports: imports.rows[0], events: events.rows[0], rejections: rejections.rows, metrics: metrics.rows[0],
      recent: { scope: "server_receipt_windows", window_hours: hours, unit: "delivery_attempts", ...recent,
        received_from: observed.rows[0].received_from, received_to: observed.rows[0].observed_at, previous_from: observed.rows[0].previous_from,
        pending_unit: "submitted_events", client_diagnostics: "on_device_only_not_received" } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
