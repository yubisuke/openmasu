import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { normalizeMetricCorrectionPolicy, withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

export async function saveMetricCorrectionPolicy(pool: Pool, scope: AppAdminIdentity, body: unknown, now = new Date()) {
  const definition = normalizeMetricCorrectionPolicy(body), digest = sha256(definition);
  return withTenant(pool,scope.tenantId,async client => {
    // Serializes disable/configure with the planner and active auto calculations.
    await client.query(`INSERT INTO control.metric_correction_policies
      (tenant_id,app_id,definition,definition_digest,enabled,registered_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
      ON CONFLICT (tenant_id,app_id) DO UPDATE SET definition=EXCLUDED.definition,
        definition_digest=EXCLUDED.definition_digest,enabled=EXCLUDED.enabled,registered_at=EXCLUDED.registered_at`,
    [scope.tenantId,scope.appId,JSON.stringify(definition),digest,definition.enabled,now.toISOString()]);
    await recordDashboardAuditWithClient(client,{tenantId:scope.tenantId,appId:scope.appId,actorRef:`admin_key:${scope.keyId}`,
      action:"metric_correction_policy_configured",targetScope:"app",targetRef:scope.appId,outcome:"succeeded",now});
    return {definition,definition_digest:digest};
  });
}

/** Closed operator projection; source/device references and private frozen targets are omitted. */
export async function metricCorrectionStatus(pool: Pool, scope: AppAdminIdentity) {
  return withTenant(pool,scope.tenantId,async client => {
    const policy=(await client.query(`SELECT definition,definition_digest,enabled,registered_at
      FROM control.metric_correction_policies WHERE tenant_id=$1 AND app_id=$2`,[scope.tenantId,scope.appId])).rows[0]??null;
    const states=(await client.query(`SELECT source_kind,state,safe_reason,count(*)::text AS receipts,
      max(source_cutoff) AS source_cutoff,max(observed_at) AS latest_observed_at,
      sum(continuation)::text AS processed_targets
      FROM control.metric_correction_receipts WHERE tenant_id=$1 AND app_id=$2
      GROUP BY source_kind,state,safe_reason ORDER BY source_kind,state,safe_reason`,[scope.tenantId,scope.appId])).rows;
    const refresh=(await client.query(`SELECT state,last_outcome,safe_reason,count(*)::text AS checkpoints
      FROM control.cost_schedule_checkpoints WHERE tenant_id=$1 AND app_id=$2
      GROUP BY state,last_outcome,safe_reason ORDER BY state,last_outcome,safe_reason`,[scope.tenantId,scope.appId])).rows;
    return {policy,states,cost_refresh:refresh,scope:"retained_app_receipts",upstream_completeness:"unknown"};
  });
}
