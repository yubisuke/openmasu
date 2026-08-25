import type { Pool } from "pg";
import { validateAppLinkIdentity, type AppLinkIdentity } from "@openmasu/app-association";
import { withTenant } from "@openmasu/runtime";
import type { AdminIdentity, AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAudit } from "./session.js";

const hostPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export async function registerLinkDomain(input: {
  readonly pool: Pool;
  readonly identity: AdminIdentity;
  readonly host: string;
  readonly now?: string;
}): Promise<{ readonly host: string }> {
  const host = input.host.toLowerCase().replace(/\.$/, "");
  if (!hostPattern.test(host)) throw new Error("link_host_invalid");
  const now = input.now ?? new Date().toISOString();
  try {
    await withTenant(input.pool, input.identity.tenantId, (client) => client.query(
      `INSERT INTO control.link_domains (tenant_id, host, registered_at, artifact)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [input.identity.tenantId, host, now, JSON.stringify({ tenant_id: input.identity.tenantId, host, registered_at: now })],
    ).then(() => undefined));
  } catch (error: any) {
    if (error?.code === "23505") throw new Error("link_host_already_registered");
    throw error;
  }
  await recordDashboardAudit(input.pool, {
    tenantId: input.identity.tenantId, actorRef: `admin_key:${input.identity.keyId}`,
    action: "link_domain_registered", targetScope: "tenant", targetRef: host,
    outcome: "succeeded", now: new Date(now),
  });
  return { host };
}

export async function registerAppLinkIdentity(input: {
  readonly pool: Pool;
  readonly identity: AppAdminIdentity;
  readonly body: Record<string, unknown>;
  readonly now?: string;
}): Promise<AppLinkIdentity> {
  const identity: AppLinkIdentity = {
    app_id: input.identity.appId,
    ...(input.body.android_package_name ? { android_package_name: String(input.body.android_package_name) } : {}),
    ...(Array.isArray(input.body.android_sha256_fingerprints)
      ? { android_sha256_fingerprints: input.body.android_sha256_fingerprints.map(String) }
      : {}),
    ...(input.body.apple_team_id ? { apple_team_id: String(input.body.apple_team_id) } : {}),
    ...(input.body.apple_bundle_id ? { apple_bundle_id: String(input.body.apple_bundle_id) } : {}),
  };
  validateAppLinkIdentity(identity);
  const now = input.now ?? new Date().toISOString();
  try {
    await withTenant(input.pool, input.identity.tenantId, (client) => client.query(
      `INSERT INTO control.app_link_identities (
         tenant_id, app_id, android_package_name, android_sha256_fingerprints,
         apple_team_id, apple_bundle_id, registered_at, artifact
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [input.identity.tenantId, input.identity.appId, identity.android_package_name ?? null,
        identity.android_sha256_fingerprints ?? [], identity.apple_team_id ?? null,
        identity.apple_bundle_id ?? null, now, JSON.stringify({ ...identity, registered_at: now })],
    ).then(() => undefined));
  } catch (error: any) {
    if (error?.code === "23505") throw new Error("app_link_identity_already_registered");
    throw error;
  }
  return identity;
}
