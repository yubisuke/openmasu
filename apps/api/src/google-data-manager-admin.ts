import type { Pool } from "pg";
import { uuidV7, withTenant } from "@openmasu/runtime";
import type { AdminIdentity } from "./admin-auth.js";
import { previewGoogleDestination } from "./google-destination-readiness.js";
import { configurationChange } from "./configuration-change.js";

type AppIdentity = AdminIdentity & { readonly appId: string };
export type GoogleDataManagerDestination = ReturnType<typeof previewGoogleDestination>["definition"] & {
  destination_id: string; tenant_id: string; app_id: string; revision: number; configured_at: string;
};
export async function googleDestinationHistory(pool: Pool, identity: AppIdentity) {
  return withTenant(pool, identity.tenantId, async client => (await client.query<{
    destination_id: string; revision: number; definition: Record<string, unknown>; definition_digest: string; ready: boolean; created_at: string;
  }>(`SELECT destination_id::text,revision,definition,definition_digest,ready,created_at
    FROM control.google_destination_revisions WHERE tenant_id=$1 AND app_id=$2 ORDER BY revision DESC LIMIT 50`,
  [identity.tenantId, identity.appId])).rows);
}
export async function configureGoogleDataManagerDestination(options: {
  pool: Pool; identity: AppIdentity; body: Record<string, unknown>; now?: Date;
}): Promise<GoogleDataManagerDestination> {
  const preview = previewGoogleDestination(options.body), definition = preview.definition;
  if (!Number.isInteger(options.body.expected_revision) || Number(options.body.expected_revision) < 0) throw Error("google_destination_revision_invalid");
  if (definition.enabled && (!preview.ready || options.body.preview_digest !== preview.preview_digest)) throw Error("google_destination_not_ready");
  return withTenant(options.pool, options.identity.tenantId, async client => {
    const { tenantId, appId, keyId } = options.identity;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('openmasu:google-destination:' || $1 || ':' || $2,0))", [tenantId, appId]);
    const current = (await client.query<{ destination_id: string; current_revision: number }>(
      "SELECT destination_id::text,current_revision FROM control.google_data_manager_destinations WHERE tenant_id=$1 AND app_id=$2 FOR UPDATE", [tenantId, appId])).rows[0];
    if ((current?.current_revision ?? 0) !== options.body.expected_revision) throw Error("google_destination_revision_stale");
    const prior = current ? (await client.query<{ definition: typeof definition; definition_digest: string; ready: boolean }>(
      `SELECT definition,definition_digest,ready FROM control.google_destination_revisions
       WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND revision=$4`,
      [tenantId, appId, current.destination_id, current.current_revision])).rows[0] : undefined;
    const now = options.now ?? new Date(), configuredAt = now.toISOString();
    const destinationId = current?.destination_id ?? uuidV7(now.valueOf()), revision = (current?.current_revision ?? 0) + 1;
    if (!current) await client.query(`INSERT INTO control.google_data_manager_destinations
      (destination_id,tenant_id,app_id,operating_account_id,conversion_action_id,app_audience,enabled,registered_at,artifact)
      VALUES ($1,$2,$3,$4,$5,$6,false,$7,'{}'::jsonb)`,
    [destinationId, tenantId, appId, definition.operating_account_id, definition.conversion_action_id, definition.app_audience, configuredAt]);
    await client.query(`INSERT INTO control.google_destination_revisions
      (tenant_id,app_id,destination_id,revision,definition,definition_digest,ready,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
    [tenantId, appId, destinationId, revision, JSON.stringify(definition), preview.preview_digest, preview.ready, configuredAt]);
    await client.query(`UPDATE control.google_data_manager_destinations SET operating_account_id=$4,conversion_action_id=$5,
      app_audience=$6,enabled=$7,registered_at=$8,artifact=$9::jsonb,current_revision=$10 WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`,
    [tenantId, appId, destinationId, definition.operating_account_id, definition.conversion_action_id, definition.app_audience,
      definition.enabled, configuredAt, JSON.stringify(definition), revision]);
    await client.query(`INSERT INTO ledger.audit_logs
      (audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,action,target_scope,target_ref,policy_version,request_digest,outcome,configuration_change)
      VALUES ($1,$2,$3::text,$4,'admin_key',$5,'google_destination_activated','app',$3::text,'google-destination-v2',$6,'succeeded',$7::jsonb)`,
    [uuidV7(now.valueOf()), tenantId, appId, configuredAt, `admin_key:${keyId}`, preview.preview_digest,
      JSON.stringify(configurationChange("google_destination", prior ? `${destinationId}:${current!.current_revision}` : null,
        prior ? { enabled: prior.definition.enabled, app_audience: prior.definition.app_audience, ready: prior.ready, definition_digest: prior.definition_digest } : null,
        `${destinationId}:${revision}`, { enabled: definition.enabled, app_audience: definition.app_audience, ready: preview.ready, definition_digest: preview.preview_digest }))]);
    return { ...definition, destination_id: destinationId, tenant_id: tenantId, app_id: appId, revision, configured_at: configuredAt };
  });
}
