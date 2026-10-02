import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core";
import { normalizeCostRefreshDefinition, uuidV7, withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

export async function registerCostSchedule(pool: Pool, identity: AppAdminIdentity, body: unknown, now = new Date()) {
  const definition = normalizeCostRefreshDefinition(body);
  const definitionDigest = sha256(definition);
  const scheduleId = `cost-schedule:${uuidV7(now.valueOf())}`;
  return withTenant(pool, identity.tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([identity.tenantId, identity.appId, "cost-schedules"]),
    ]);
    const active = await client.query(
      "SELECT 1 FROM control.cost_schedules_current WHERE tenant_id=$1 AND app_id=$2 AND status='active'",
      [identity.tenantId, identity.appId],
    );
    if (active.rowCount) throw new Error("cost_schedule_active_exists");
    await client.query(
      `INSERT INTO control.cost_schedules (cost_schedule_id,tenant_id,app_id,definition,definition_digest,created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      [scheduleId, identity.tenantId, identity.appId, JSON.stringify(definition), definitionDigest, now.toISOString()],
    );
    await client.query(
      `INSERT INTO control.cost_schedule_states (cost_schedule_id,tenant_id,app_id,status,changed_at)
       VALUES ($1,$2,$3,'active',$4)`, [scheduleId, identity.tenantId, identity.appId, now.toISOString()],
    );
    await client.query(
      `INSERT INTO control.cost_schedule_checkpoints (cost_schedule_id,tenant_id,app_id,next_run_at,next_attempt_at)
       VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp())`, [scheduleId, identity.tenantId, identity.appId],
    );
    await recordDashboardAuditWithClient(client, {
      tenantId: identity.tenantId, appId: identity.appId, actorRef: `admin_key:${identity.keyId}`,
      action: "cost_schedule_registered", targetScope: "app", targetRef: scheduleId, outcome: "succeeded", now,
    });
    return { cost_schedule_id: scheduleId, definition_digest: definitionDigest, status: "active" as const };
  });
}

// Closed aggregate projection: no account identifiers, source payload, secret
// names or definition body. Reader privileges independently enforce this split.
export async function listCostSchedules(pool: Pool, identity: AppAdminIdentity) {
  return withTenant(pool, identity.tenantId, async (client) => (await client.query(
    `SELECT schedule.cost_schedule_id,schedule.definition_digest,schedule.status,schedule.created_at,
            schedule.changed_at,checkpoint.state,checkpoint.last_target_date::text,
            checkpoint.pending_since::text,checkpoint.pending_until::text,
            checkpoint.next_run_at,checkpoint.next_attempt_at,checkpoint.attempts,
            checkpoint.last_success_at,checkpoint.last_since::text,checkpoint.last_until::text,
            checkpoint.last_outcome,checkpoint.last_row_count,checkpoint.last_import_run_id,checkpoint.last_snapshot_digest,checkpoint.safe_reason
       FROM control.cost_schedules_current AS schedule
       JOIN control.cost_schedule_checkpoints AS checkpoint USING (tenant_id,app_id,cost_schedule_id)
      WHERE schedule.tenant_id=$1 AND schedule.app_id=$2
      ORDER BY schedule.created_at DESC,schedule.cost_schedule_id COLLATE "C" LIMIT 100`,
    [identity.tenantId, identity.appId],
  )).rows);
}

export async function disableCostSchedule(pool: Pool, identity: AppAdminIdentity, scheduleId: string, now = new Date()) {
  return withTenant(pool, identity.tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([identity.tenantId, identity.appId, "cost-schedules"]),
    ]);
    // The checkpoint lock is also the publication fence. Stop wins before a
    // late source response can publish, or observes an already committed run.
    const checkpoint = await client.query(
      `SELECT 1 FROM control.cost_schedule_checkpoints
       WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3 FOR UPDATE`,
      [identity.tenantId, identity.appId, scheduleId],
    );
    if (!checkpoint.rowCount) throw new Error("cost_schedule_not_found");
    const active = await client.query(
      `SELECT 1 FROM control.cost_schedules_current WHERE tenant_id=$1 AND app_id=$2
       AND cost_schedule_id=$3 AND status='active'`, [identity.tenantId, identity.appId, scheduleId],
    );
    if (!active.rowCount) throw new Error("cost_schedule_not_active");
    await client.query(
      `INSERT INTO control.cost_schedule_states (cost_schedule_id,tenant_id,app_id,status,changed_at)
       VALUES ($1,$2,$3,'disabled',$4)`, [scheduleId, identity.tenantId, identity.appId, now.toISOString()],
    );
    await client.query(
      `UPDATE control.cost_schedule_checkpoints SET state='stopped',lease_token=NULL,lease_expires_at=NULL,
         updated_at=clock_timestamp() WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3`,
      [identity.tenantId, identity.appId, scheduleId],
    );
    await recordDashboardAuditWithClient(client, {
      tenantId: identity.tenantId, appId: identity.appId, actorRef: `admin_key:${identity.keyId}`,
      action: "cost_schedule_disabled", targetScope: "app", targetRef: scheduleId, outcome: "succeeded", now,
    });
    return { cost_schedule_id: scheduleId, status: "disabled" as const };
  });
}
