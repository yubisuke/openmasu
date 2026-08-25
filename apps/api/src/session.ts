import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { uuidV7, withTenant } from "@openmasu/runtime";
import type { AdminRole } from "./admin-auth.js";

const csrfPurpose = "openmasu-dashboard-csrf-v1";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type DashboardSession = {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly adminKeyId: string;
  readonly role: AdminRole;
  readonly token: string;
  readonly expiresAt: string;
};

export function assertDashboardBaseUrl(enabled: boolean, publicBaseUrl: string): URL {
  const parsed = new URL(publicBaseUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (enabled && parsed.protocol === "http:" && !localHosts.has(parsed.hostname)) {
    throw new Error(
      "OPENMASU_DASHBOARD_INSECURE_ORIGIN: use the proxy Compose profile for non-localhost dashboard access",
    );
  }
  return parsed;
}

export function dashboardCookieName(publicBaseUrl: string): string {
  return new URL(publicBaseUrl).protocol === "https:"
    ? "__Host-openmasu_dashboard"
    : "openmasu_dashboard";
}

export function dashboardSessionCookie(
  token: string,
  publicBaseUrl: string,
  maxAgeSeconds: number,
): string {
  return `${dashboardCookieName(publicBaseUrl)}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearDashboardSessionCookie(publicBaseUrl: string): string {
  return `${dashboardCookieName(publicBaseUrl)}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readDashboardToken(cookieHeader: string | undefined, publicBaseUrl: string): string | undefined {
  const name = dashboardCookieName(publicBaseUrl);
  const candidate = (cookieHeader ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  const token = candidate?.slice(name.length + 1);
  return token && tokenPattern.test(token) ? token : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function csrfToken(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update(csrfPurpose, "utf8").digest("base64url");
}

export function verifyCsrfToken(sessionToken: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const actual = Buffer.from(candidate, "utf8");
  const expected = Buffer.from(csrfToken(sessionToken), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function issueDashboardSession(
  pool: Pool,
  tenantId: string,
  adminKeyId: string,
  ttlSeconds: number,
  now = new Date(),
  token = randomBytes(32).toString("base64url"),
): Promise<Omit<DashboardSession, "role">> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) throw new Error("dashboard session TTL is invalid");
  if (!tokenPattern.test(token)) throw new Error("dashboard session token is invalid");
  const sessionId = `session:${uuidV7(now.getTime())}`;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await withTenant(pool, tenantId, (client) => client.query(
    `INSERT INTO ephemeral.dashboard_sessions (
      session_id, tenant_id, admin_key_id, token_digest, created_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sessionId, tenantId, adminKeyId, digest(token), now.toISOString(), expiresAt.toISOString()],
  ).then(() => undefined));
  return { sessionId, tenantId, adminKeyId, token, expiresAt: expiresAt.toISOString() };
}

export async function verifyDashboardSession(
  readerPool: Pool,
  tenantId: string,
  cookieHeader: string | undefined,
  publicBaseUrl: string,
  now = new Date(),
): Promise<DashboardSession | undefined> {
  const token = readDashboardToken(cookieHeader, publicBaseUrl);
  if (!token) return undefined;
  const result = await withTenant(readerPool, tenantId, (client) => client.query<{
    session_id: string;
    admin_key_id: string;
    expires_at: Date | string;
    role: AdminRole;
  }>(
    `SELECT session.session_id, session.admin_key_id, session.expires_at, key.role
       FROM ephemeral.dashboard_sessions AS session
       JOIN control.admin_key_roles_current AS key
         ON key.tenant_id=session.tenant_id AND key.key_id=session.admin_key_id
      WHERE session.tenant_id=$1 AND session.token_digest=$2
        AND session.expires_at > $3::timestamptz AND key.status='active'`,
    [tenantId, digest(token), now.toISOString()],
  ));
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    tenantId,
    adminKeyId: row.admin_key_id,
    role: row.role,
    token,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function revokeDashboardSession(
  pool: Pool,
  session: Pick<DashboardSession, "sessionId" | "tenantId">,
): Promise<boolean> {
  const result = await withTenant(pool, session.tenantId, (client) => client.query(
    "DELETE FROM ephemeral.dashboard_sessions WHERE tenant_id=$1 AND session_id=$2",
    [session.tenantId, session.sessionId],
  ));
  return (result.rowCount ?? 0) === 1;
}

export async function sweepExpiredDashboardSessions(
  pool: Pool,
  tenantId: string,
  now = new Date(),
): Promise<number> {
  const result = await withTenant(pool, tenantId, (client) => client.query(
    "DELETE FROM ephemeral.dashboard_sessions WHERE tenant_id=$1 AND expires_at <= $2::timestamptz",
    [tenantId, now.toISOString()],
  ));
  return result.rowCount ?? 0;
}

export type DashboardAuditInput = {
    readonly tenantId: string;
    readonly appId?: string;
    readonly actorRef: string;
    readonly action: string;
    readonly targetScope: "tenant" | "app" | "session" | "tracking_link" | "sdk_key" | "rule_bundle";
    readonly targetRef: string;
    readonly outcome: "succeeded" | "failed";
    readonly reasonCode?: string;
    readonly now?: Date;
};

export async function recordDashboardAuditWithClient(
  client: PoolClient,
  input: DashboardAuditInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const requestDigest = digest([
    input.action,
    input.targetScope,
    input.targetRef,
    input.outcome,
    input.reasonCode ?? "",
  ].join("\u0000"));
  await client.query(
    `INSERT INTO ledger.audit_logs (
      audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
      action, target_scope, target_ref, policy_version, request_digest,
      outcome, reason_code
    ) VALUES ($1,$2,$3,$4,'admin_key',$5,$6,$7,$8,'dashboard-v1',$9,$10,$11)`,
    [
      uuidV7(now.getTime()), input.tenantId, input.appId ?? null, now.toISOString(),
      input.actorRef, input.action, input.targetScope, input.targetRef,
      requestDigest, input.outcome, input.reasonCode ?? null,
    ],
  );
}

export async function recordDashboardAudit(
  pool: Pool,
  input: DashboardAuditInput,
): Promise<void> {
  await withTenant(pool, input.tenantId, (client) => recordDashboardAuditWithClient(client, input));
}
