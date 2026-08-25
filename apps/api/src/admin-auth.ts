import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@open-mmp/runtime";

export type AdminRole = "admin" | "operator" | "read_only";
export type AdminIdentity = { keyId: string; tenantId: string; role: AdminRole };
export type AppAdminIdentity = AdminIdentity & { appId: string };

export type ConfiguredAdminKey = { key: string; role: AdminRole };

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

export async function ensureAdminKeys(
  pool: Pool,
  scope: { tenantId: string; appId: string },
  configuredKeys: readonly (string | ConfiguredAdminKey)[],
  now = new Date().toISOString(),
): Promise<string[]> {
  const normalized = configuredKeys.filter(Boolean).map((entry) => typeof entry === "string"
    ? { key: entry, role: "admin" as const }
    : entry);
  const unique = [...new Map(normalized.map((entry) => [entry.key, entry])).values()];
  if (unique.length < 1 || unique.length > 6) throw new Error("one to six admin keys must be configured");
  return withTenant(pool, scope.tenantId, async (client) => {
    await client.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [scope.tenantId, scope.appId, now],
    );
    const identifiers: string[] = [];
    for (const configured of unique) {
      const { key, role } = configured;
      if (Buffer.byteLength(key, "utf8") < 32) throw new Error("admin keys must contain at least 32 bytes");
      const id = keyId(key);
      identifiers.push(id);
      const salt = randomBytes(16);
      await client.query(
        `INSERT INTO control.admin_keys (
          key_id, tenant_id, app_id, scrypt_salt, scrypt_digest, created_at, role
        ) VALUES ($1,$2,NULL,$3,$4,$5,$6) ON CONFLICT (key_id) DO NOTHING`,
        [id, scope.tenantId, salt.toString("hex"), verifier(key, salt), now, role],
      );
      const stored = await client.query<{ role: AdminRole }>(
        "SELECT role FROM control.admin_keys WHERE tenant_id=$1 AND key_id=$2",
        [scope.tenantId, id],
      );
      if (stored.rows[0]?.role !== role) throw new Error("admin key role is immutable");
      await client.query(
        `INSERT INTO control.admin_key_states (
          key_id, tenant_id, app_id, status, changed_at, artifact
        ) VALUES ($1,$2,NULL,'active',$3,$4::jsonb)
        ON CONFLICT (key_id, status) DO NOTHING`,
        [id, scope.tenantId, now, JSON.stringify({ key_id: id, status: "active", changed_at: now })],
      );
    }
    const active = await client.query<{ role: AdminRole; count: number }>(
      `SELECT role, count(*)::int AS count
         FROM control.admin_keys_current
        WHERE tenant_id=$1 AND status='active'
        GROUP BY role`,
      [scope.tenantId],
    );
    if (active.rows.some((row) => row.count > 2)) throw new Error("admin key overlap exceeds two active keys per role");
    return identifiers;
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
    const result = await client.query<{ key_id: string; scrypt_salt: string; scrypt_digest: string; role: AdminRole }>(
      `SELECT key_id, scrypt_salt, scrypt_digest, role FROM control.admin_keys_current
       WHERE tenant_id=$1 AND key_id=$2 AND status='active'`,
      [tenantId, id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const actual = Buffer.from(verifier(candidate, Buffer.from(row.scrypt_salt, "hex")), "hex");
    const expected = Buffer.from(row.scrypt_digest, "hex");
    return timingSafeEqual(actual, expected) ? { keyId: row.key_id, tenantId, role: row.role } : undefined;
  });
}
