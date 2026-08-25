import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { uuidV7, withTenant } from "@openmasu/runtime";
import type { AdminIdentity } from "./admin-auth.js";

type AppIdentity = AdminIdentity & { readonly appId: string };

export type GoogleDataManagerDestination = {
  readonly destination_id: string;
  readonly tenant_id: string;
  readonly app_id: string;
  readonly operating_account_id: string;
  readonly conversion_action_id: string;
  readonly enabled: boolean;
  readonly app_audience: "general" | "mixed" | "child_directed";
  readonly configured_at: string;
};

function numericId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9]{1,32}$/.test(value)) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

export function normalizeGoogleDataManagerDestination(body: Record<string, unknown>): {
  readonly operatingAccountId: string;
  readonly conversionActionId: string;
  readonly enabled: boolean;
  readonly appAudience: "general" | "mixed" | "child_directed";
} {
  if (typeof body.enabled !== "boolean") throw new Error("google_data_manager_enabled_invalid");
  if (!new Set(["general", "mixed", "child_directed"]).has(String(body.app_audience))) {
    throw new Error("google_data_manager_app_audience_invalid");
  }
  return {
    operatingAccountId: numericId(body.operating_account_id, "google_data_manager_operating_account_id"),
    conversionActionId: numericId(body.conversion_action_id, "google_data_manager_conversion_action_id"),
    enabled: body.enabled,
    appAudience: body.app_audience as "general" | "mixed" | "child_directed",
  };
}

export async function configureGoogleDataManagerDestination(options: {
  readonly pool: Pool;
  readonly identity: AppIdentity;
  readonly body: Record<string, unknown>;
  readonly now?: Date;
}): Promise<GoogleDataManagerDestination> {
  const normalized = normalizeGoogleDataManagerDestination(options.body);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("google_data_manager_configured_at_invalid");
  const configuredAt = now.toISOString();
  const destinationId = uuidV7(now.valueOf());
  return withTenant(options.pool, options.identity.tenantId, async (client) => {
    const result = await client.query<{ destination_id: string }>(
        `INSERT INTO control.google_data_manager_destinations (
           destination_id, tenant_id, app_id, operating_account_id,
           conversion_action_id, app_audience, enabled, registered_at, artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (tenant_id, app_id) DO UPDATE SET
           operating_account_id=EXCLUDED.operating_account_id,
           conversion_action_id=EXCLUDED.conversion_action_id,
           app_audience=EXCLUDED.app_audience,
           enabled=EXCLUDED.enabled,
           registered_at=EXCLUDED.registered_at,
           artifact=EXCLUDED.artifact
         RETURNING destination_id::text`,
        [
          destinationId,
          options.identity.tenantId,
          options.identity.appId,
          normalized.operatingAccountId,
          normalized.conversionActionId,
          normalized.appAudience,
          normalized.enabled,
          configuredAt,
          JSON.stringify({
            tenant_id: options.identity.tenantId,
            app_id: options.identity.appId,
            operating_account_id: normalized.operatingAccountId,
            conversion_action_id: normalized.conversionActionId,
            app_audience: normalized.appAudience,
            enabled: normalized.enabled,
            configured_at: configuredAt,
          }),
        ],
    );
    const actualDestinationId = result.rows[0]?.destination_id;
    if (!actualDestinationId) throw new Error("google_data_manager_destination_not_persisted");
    const artifact: GoogleDataManagerDestination = {
        destination_id: actualDestinationId,
        tenant_id: options.identity.tenantId,
        app_id: options.identity.appId,
        operating_account_id: normalized.operatingAccountId,
        conversion_action_id: normalized.conversionActionId,
        app_audience: normalized.appAudience,
        enabled: normalized.enabled,
        configured_at: configuredAt,
    };
    const requestDigest = createHash("sha256").update(JSON.stringify({
        app_id: artifact.app_id,
        operating_account_id: artifact.operating_account_id,
        conversion_action_id: artifact.conversion_action_id,
        enabled: artifact.enabled,
    })).digest("hex");
    await client.query(
        `INSERT INTO ledger.audit_logs (
           audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
           action, target_scope, target_ref, policy_version, request_digest,
           outcome, reason_code
         ) VALUES ($1,$2,$3,$4,'admin_key',$5,'google_data_manager_destination_configured',
           'app',$3,'google-data-manager-v1',$6,'succeeded',NULL)`,
        [uuidV7(now.valueOf() + 1), options.identity.tenantId, options.identity.appId,
          configuredAt, `admin_key:${options.identity.keyId}`, requestDigest],
    );
    return artifact;
  });
}
