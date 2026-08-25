import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import type { AdminIdentity, AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAudit } from "./session.js";
import { ensureSdkKeys } from "./sdk-auth.js";

const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export class AppNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() { super("app_not_found"); }
}

export async function requireRegisteredApp(
  pool: Pool,
  identity: AdminIdentity,
  appId: string,
): Promise<AppAdminIdentity> {
  if (!identifierPattern.test(appId)) throw new AppNotFoundError();
  const result = await withTenant(pool, identity.tenantId, (client) => client.query(
    "SELECT 1 FROM control.apps WHERE tenant_id=$1 AND app_id=$2",
    [identity.tenantId, appId],
  ));
  if (result.rowCount !== 1) throw new AppNotFoundError();
  return { ...identity, appId };
}

export async function listApps(pool: Pool, identity: AdminIdentity): Promise<readonly { app_id: string; created_at: string }[]> {
  const result = await withTenant(pool, identity.tenantId, (client) => client.query<{
    app_id: string;
    created_at: string;
  }>(
    "SELECT app_id, created_at FROM control.apps WHERE tenant_id=$1 ORDER BY app_id",
    [identity.tenantId],
  ));
  return result.rows;
}

export async function registerApp(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly identity: AdminIdentity;
  readonly appId: string;
  readonly sdkPlatform?: "android" | "ios";
  readonly publicBaseUrl: string;
  readonly redirectorBaseUrl: string;
  readonly now?: Date;
}): Promise<{
  readonly app_id: string;
  readonly sdk_key_id: string;
  readonly sdk_key: string;
  readonly sdk_platform: "android" | "ios";
  readonly redirector_base_url: string;
  readonly max_postback_base_url: string;
}> {
  if (!identifierPattern.test(input.appId)) throw new Error("app_id_invalid");
  const now = input.now ?? new Date();
  const sdkPlatform = input.sdkPlatform ?? "android";
  const inserted = await withTenant(input.pool, input.identity.tenantId, (client) => client.query(
    `INSERT INTO control.apps (tenant_id, app_id, created_at)
     VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
    [input.identity.tenantId, input.appId, now.toISOString()],
  ));
  if (inserted.rowCount !== 1) throw new Error("app_already_registered");

  const sdkKeyId = `sdk-key:${uuidV7(now.getTime())}`;
  const sdkKey = randomBytes(32).toString("base64url");
  await ensureSdkKeys(
    input.pool,
    input.payloadStore,
    { tenantId: input.identity.tenantId, appId: input.appId },
    [{ keyId: sdkKeyId, secret: sdkKey, platform: sdkPlatform }],
    now.toISOString(),
  );
  await recordDashboardAudit(input.pool, {
    tenantId: input.identity.tenantId,
    appId: input.appId,
    actorRef: `admin_key:${input.identity.keyId}`,
    action: "app_registered",
    targetScope: "app",
    targetRef: input.appId,
    outcome: "succeeded",
    now,
  });
  await recordDashboardAudit(input.pool, {
    tenantId: input.identity.tenantId,
    appId: input.appId,
    actorRef: `admin_key:${input.identity.keyId}`,
    action: "sdk_key_issued",
    targetScope: "sdk_key",
    targetRef: sdkKeyId,
    outcome: "succeeded",
    now,
  });
  return {
    app_id: input.appId,
    sdk_key_id: sdkKeyId,
    sdk_key: sdkKey,
    sdk_platform: sdkPlatform,
    redirector_base_url: input.redirectorBaseUrl,
    max_postback_base_url: `${input.publicBaseUrl}/v1/ingest/max`,
  };
}
