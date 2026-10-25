import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@openmasu/runtime";
import { recordDashboardAuditWithClient } from "./session.js";

export type AdminRole = "admin" | "operator" | "read_only";
export type AdminIdentity = { keyId: string; tenantId: string; role: AdminRole; appScope?: string };
export type AppAdminIdentity = AdminIdentity & { appId: string };

export type ConfiguredAdminKey = { key: string; role: AdminRole; appScope?: string };
const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseAdminRole(value: string | undefined): AdminRole {
  const role = value ?? "admin";
  if (role !== "admin" && role !== "operator" && role !== "read_only") {
    throw new Error("admin role must be admin, operator, or read_only");
  }
  return role;
}

function keyId(key: string): string {
  return `key:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function verifier(key: string, salt: Buffer): string {
  return scryptSync(key, salt, 32, { N: 16_384, r: 8, p: 1 }).toString("hex");
}

async function lockKeyLifecycle(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('openmasu:admin-keys'),hashtext($1))", [tenantId]);
}

async function ensureConfiguredKeys(client: PoolClient, tenantId: string, keys: readonly ConfiguredAdminKey[], now: string): Promise<string[]> {
  const identifiers: string[] = [];
  for (const { key, role, appScope } of keys) {
    parseAdminRole(role);
    if (Buffer.byteLength(key, "utf8") < 32) throw new Error("admin keys must contain at least 32 bytes");
    if (appScope !== undefined) {
      if (typeof appScope !== "string" || !identifierPattern.test(appScope)) throw new Error("admin_key_app_scope_invalid");
      if ((await client.query("SELECT 1 FROM control.apps WHERE tenant_id=$1 AND app_id=$2", [tenantId, appScope])).rowCount !== 1)
        throw new Error("app_not_found");
    }
    const id = keyId(key), salt = randomBytes(16);
    identifiers.push(id);
    await client.query(
      `INSERT INTO control.admin_keys (key_id,tenant_id,app_id,scrypt_salt,scrypt_digest,created_at,role,app_scope)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7) ON CONFLICT (key_id) DO NOTHING`,
      [id, tenantId, salt.toString("hex"), verifier(key, salt), now, role, appScope ?? null],
    );
    const stored = (await client.query<{ role: AdminRole; app_scope: string | null }>(
      "SELECT role,app_scope FROM control.admin_keys WHERE tenant_id=$1 AND key_id=$2", [tenantId, id],
    )).rows[0];
    if (stored?.role !== role) throw new Error("admin key role is immutable");
    if (stored.app_scope !== (appScope ?? null)) throw new Error("admin key app scope is immutable");
    await client.query(
      `INSERT INTO control.admin_key_states (key_id,tenant_id,app_id,status,changed_at,artifact)
       VALUES ($1,$2,NULL,'active',$3,$4::jsonb) ON CONFLICT (key_id,status) DO NOTHING`,
      [id, tenantId, now, JSON.stringify({ key_id: id, status: "active", changed_at: now })],
    );
  }
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM control.admin_keys_current WHERE tenant_id=$1 AND status='active'
     GROUP BY role,app_scope`, [tenantId],
  );
  if (active.rows.some(row => row.count > 2)) throw new Error("admin key overlap exceeds two active keys per role and app scope");
  return identifiers;
}

async function requireTenantAdmin(client: PoolClient, actor: AdminIdentity): Promise<void> {
  if (actor.role !== "admin" || actor.appScope !== undefined || (await client.query(
    "SELECT 1 FROM control.admin_keys_current WHERE tenant_id=$1 AND key_id=$2 AND role='admin' AND app_scope IS NULL AND status='active'",
    [actor.tenantId, actor.keyId],
  )).rowCount !== 1) throw new Error("forbidden");
}

/** Generate once; the verifier and audit commit together. Scope/role changes require another key. */
export async function issueAdminKey(pool: Pool, actor: AdminIdentity, options: { role: AdminRole; appScope?: string }, now = new Date()): Promise<{
  key_id: string; admin_key: string; role: AdminRole; app_scope: string | null;
}> {
  return withTenant(pool, actor.tenantId, async client => {
    await lockKeyLifecycle(client, actor.tenantId);
    await requireTenantAdmin(client, actor);
    const key = randomBytes(32).toString("base64url");
    const [id] = await ensureConfiguredKeys(client, actor.tenantId, [{ key, ...options }], now.toISOString());
    await recordDashboardAuditWithClient(client, { tenantId: actor.tenantId, appId: options.appScope,
      actorRef: `admin_key:${actor.keyId}`, action: "admin_key_issued", targetScope: "admin_key", targetRef: id!, outcome: "succeeded", now });
    return { key_id: id!, admin_key: key, role: options.role, app_scope: options.appScope ?? null };
  });
}

export async function retireAdminKey(pool: Pool, actor: AdminIdentity, targetKeyId: string, now = new Date()): Promise<boolean> {
  if (!identifierPattern.test(targetKeyId)) throw new Error("admin_key_not_found");
  return withTenant(pool, actor.tenantId, async client => {
    await lockKeyLifecycle(client, actor.tenantId);
    await requireTenantAdmin(client, actor);
    const target = (await client.query<{ role: AdminRole; app_scope: string | null; status: string }>(
      "SELECT role,app_scope,status FROM control.admin_keys_current WHERE tenant_id=$1 AND key_id=$2", [actor.tenantId, targetKeyId],
    )).rows[0];
    if (!target) throw new Error("admin_key_not_found");
    if (target.status === "retired") return false;
    if (target.role === "admin" && target.app_scope === null && (await client.query(
      "SELECT 1 FROM control.admin_keys_current WHERE tenant_id=$1 AND key_id<>$2 AND role='admin' AND app_scope IS NULL AND status='active'",
      [actor.tenantId, targetKeyId],
    )).rowCount === 0) throw new Error("admin_key_last_tenant_admin");
    await client.query(
      `INSERT INTO control.admin_key_states (key_id,tenant_id,app_id,status,changed_at,artifact)
       VALUES ($1,$2,NULL,'retired',$3,$4::jsonb)`,
      [targetKeyId, actor.tenantId, now.toISOString(), JSON.stringify({ key_id: targetKeyId, status: "retired", changed_at: now.toISOString() })],
    );
    await recordDashboardAuditWithClient(client, { tenantId: actor.tenantId, appId: target.app_scope ?? undefined,
      actorRef: `admin_key:${actor.keyId}`, action: "admin_key_retired", targetScope: "admin_key", targetRef: targetKeyId, outcome: "succeeded", now });
    return true;
  });
}

export async function ensureAdminKeys(
  pool: Pool,
  scope: { tenantId: string; appId: string },
  configuredKeys: readonly (string | ConfiguredAdminKey)[],
  now = new Date().toISOString(),
): Promise<string[]> {
  const normalized: ConfiguredAdminKey[] = configuredKeys.filter(Boolean).map((entry) => typeof entry === "string"
    ? { key: entry, role: "admin" as const }
    : entry);
  const unique = [...new Map(normalized.map((entry) => [entry.key, entry])).values()];
  if (unique.length < 1 || unique.length > 6) throw new Error("one to six admin keys must be configured");
  return withTenant(pool, scope.tenantId, async (client) => {
    await lockKeyLifecycle(client, scope.tenantId);
    await client.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [scope.tenantId, scope.appId, now],
    );
    return ensureConfiguredKeys(client, scope.tenantId, unique, now);
  });
}

export async function verifyAdminKey(
  pool: Pool,
  tenantId: string,
  authorization: string | undefined,
): Promise<AdminIdentity | undefined> {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  if (!match) return undefined;
  const candidate = match[1];
  const id = keyId(candidate);
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ key_id: string; scrypt_salt: string; scrypt_digest: string; role: AdminRole; app_scope: string | null }>(
      `SELECT key_id, scrypt_salt, scrypt_digest, role, app_scope FROM control.admin_keys_current
       WHERE tenant_id=$1 AND key_id=$2 AND status='active'`,
      [tenantId, id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const actual = Buffer.from(verifier(candidate, Buffer.from(row.scrypt_salt, "hex")), "hex");
    const expected = Buffer.from(row.scrypt_digest, "hex");
    return timingSafeEqual(actual, expected) ? { keyId: row.key_id, tenantId, role: row.role,
      ...(typeof row.app_scope === "string" ? { appScope: row.app_scope } : {}) } : undefined;
  });
}
