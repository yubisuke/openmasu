import type { Pool, PoolClient } from "pg";
import { withTenant, uuidV7 } from "@openmasu/runtime";
import { parseWebhookContentPolicy, webhookContentDigest, type StoredWebhookContentPolicy } from "@openmasu/runtime/webhook-content";
import type { AppAdminIdentity } from "./admin-auth.js";

export type ContentRevision = { policy_revision: number; definition: StoredWebhookContentPolicy; definition_digest: string; created_at: string };
export async function webhookContentHistory(client: PoolClient, identity: AppAdminIdentity, destinationId: string): Promise<ContentRevision[]> {
  return (await client.query<ContentRevision>(`SELECT policy_revision::integer,definition,definition_digest,created_at
    FROM control.operator_webhook_content_revisions WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3
    ORDER BY policy_revision DESC LIMIT 50`, [identity.tenantId, identity.appId, destinationId])).rows;
}
export async function readWebhookContent(pool: Pool, identity: AppAdminIdentity, destinationId: string) {
  return withTenant(pool, identity.tenantId, async client => {
    const destination = (await client.query<{ allowed_events: string[]; status: string }>(`SELECT allowed_events,status
      FROM control.operator_webhook_destinations_current WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
    [identity.tenantId, identity.appId, destinationId])).rows[0];
    if (!destination) throw Error("operator_webhook_destination_not_found");
    if (!destination.allowed_events.length) throw Error("operator_webhook_content_comparison_only");
    return { destination_id: destinationId, events: destination.allowed_events, status: destination.status,
      revisions: await webhookContentHistory(client, identity, destinationId) };
  });
}
export async function activateWebhookContent(pool: Pool, identity: AppAdminIdentity, destinationId: string, body: Record<string, unknown>, now = new Date()) {
  if (Object.keys(body).some(key => !["policy", "preview_digest", "expected_revision"].includes(key))) throw Error("operator_webhook_content_invalid");
  const policy = parseWebhookContentPolicy(body.policy), digest = webhookContentDigest(policy);
  if (body.preview_digest !== digest) throw Error("operator_webhook_content_preview_required");
  if (!Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 1) throw Error("operator_webhook_content_revision_invalid");
  return withTenant(pool, identity.tenantId, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook-destination:' || $1 || ':' || $2 || ':' || $3,0))",
      [identity.tenantId, identity.appId, destinationId]);
    const destination = (await client.query<{ status: string; allowed_events: string[] }>(`SELECT status,allowed_events FROM control.operator_webhook_destinations_current
      WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`, [identity.tenantId, identity.appId, destinationId])).rows[0];
    if (!destination) throw Error("operator_webhook_destination_not_found");
    if (destination.status !== "active") throw Error("operator_webhook_destination_not_active");
    if (!destination.allowed_events.length) throw Error("operator_webhook_content_comparison_only");
    const current = (await webhookContentHistory(client, identity, destinationId))[0];
    if (!current || current.policy_revision !== body.expected_revision) throw Error("operator_webhook_content_revision_stale");
    if (now.toISOString() < current.created_at) throw Error("operator_webhook_content_time_invalid");
    const revision = { policy_revision: current.policy_revision + 1, definition: policy, definition_digest: digest, created_at: now.toISOString() };
    await client.query(`INSERT INTO control.operator_webhook_content_revisions
      (tenant_id,app_id,destination_id,policy_revision,definition,definition_digest,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [identity.tenantId, identity.appId, destinationId, revision.policy_revision, JSON.stringify(policy), digest, revision.created_at]);
    await client.query(`INSERT INTO ledger.audit_logs
      (audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,action,target_scope,target_ref,policy_version,request_digest,outcome)
      VALUES ($1,$2,$3,$4,'admin_key',$5,'operator_webhook_content_activated','webhook_destination',$6,'operator-webhook-content-v1',$7,'succeeded')`,
    [uuidV7(now.valueOf()), identity.tenantId, identity.appId, revision.created_at, `admin_key:${identity.keyId}`, destinationId, digest]);
    return revision;
  });
}
