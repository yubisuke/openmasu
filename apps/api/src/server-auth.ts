import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const producerPattern = /^postback:[a-z0-9-]+$/;

export type ServerAuthConfig = {
  readonly tenantId: string;
  readonly timestampSkewMs: number;
  readonly nonceTtlMs: number;
};

export type VerifiedServerRequest = {
  readonly tenantId: string;
  readonly appId: string;
  readonly serverKeyId: string;
  readonly producer: string;
  readonly timestampMs: number;
  readonly nonce: string;
  readonly requestDigest: string;
};

export type ServerAuthFailure = {
  readonly status: 401;
  readonly reason: "headers_invalid" | "key_inactive" | "signature_invalid" | "timestamp_out_of_window" | "nonce_reused";
  readonly requestDigest: string;
  readonly actorRef: string;
};

export type ServerAuthResult =
  | { readonly ok: true; readonly identity: VerifiedServerRequest }
  | { readonly ok: false; readonly failure: ServerAuthFailure };

export type ServerKeyRecord = {
  readonly server_key_id: string;
  readonly producer: string;
  readonly status: "active" | "retired";
  readonly created_at: string;
  readonly status_changed_at: string;
};

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

export function serverBodyDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function serverCanonicalString(input: {
  readonly method: string;
  readonly path: string;
  readonly appId: string;
  readonly serverKeyId: string;
  readonly timestampMs: number;
  readonly nonce: string;
  readonly body: Buffer;
}): string {
  return [
    "openmasu-server-v1",
    input.method.toUpperCase(),
    input.path,
    input.appId,
    input.serverKeyId,
    String(input.timestampMs),
    input.nonce,
    serverBodyDigest(input.body),
  ].join("\n");
}

export function signServerRequest(
  secret: string,
  input: Parameters<typeof serverCanonicalString>[0],
): string {
  return createHmac("sha256", secret).update(serverCanonicalString(input), "utf8").digest("hex");
}

function safeSignature(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function verifyServerRequest(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly config: ServerAuthConfig;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly path: string;
  readonly body: Buffer;
  readonly nowMs?: number;
}): Promise<ServerAuthResult> {
  const requestDigest = serverBodyDigest(input.body);
  const appId = headerValue(input.headers, "x-openmasu-app-id");
  const serverKeyId = headerValue(input.headers, "x-openmasu-server-key-id");
  const timestampMs = Number(headerValue(input.headers, "x-openmasu-timestamp-ms"));
  const nonce = headerValue(input.headers, "x-openmasu-nonce");
  const signature = headerValue(input.headers, "x-openmasu-signature");
  const actorRef = `server_key:${serverKeyId || "unknown"}`;
  if (!identifierPattern.test(appId) || !identifierPattern.test(serverKeyId)
    || !Number.isSafeInteger(timestampMs) || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)) {
    return { ok: false, failure: { status: 401, reason: "headers_invalid", requestDigest, actorRef } };
  }
  const result = await withTenant(input.pool, input.config.tenantId, (client) => client.query<{
    tenant_id: string; app_id: string; server_key_id: string; producer: string; secret_ref: string;
  }>(
    `SELECT tenant_id, app_id, server_key_id, producer, secret_ref
       FROM control.server_keys_current
      WHERE tenant_id=$1 AND app_id=$2 AND server_key_id=$3 AND status='active'`,
    [input.config.tenantId, appId, serverKeyId],
  ));
  const row = result.rows[0];
  if (!row) return { ok: false, failure: { status: 401, reason: "key_inactive", requestDigest, actorRef } };
  let secret: string;
  try { secret = (await input.payloadStore.read(row.secret_ref)).toString("utf8"); }
  catch { return { ok: false, failure: { status: 401, reason: "key_inactive", requestDigest, actorRef } }; }
  const expected = signServerRequest(secret, {
    method: input.method,
    path: input.path,
    appId,
    serverKeyId,
    timestampMs,
    nonce,
    body: input.body,
  });
  if (!safeSignature(signature, expected)) {
    return { ok: false, failure: { status: 401, reason: "signature_invalid", requestDigest, actorRef } };
  }
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > input.config.timestampSkewMs) {
    return { ok: false, failure: { status: 401, reason: "timestamp_out_of_window", requestDigest, actorRef } };
  }
  const inserted = await withTenant(input.pool, input.config.tenantId, async (client) => {
    await client.query("DELETE FROM ephemeral.request_nonces WHERE expires_at <= clock_timestamp()");
    return client.query(
      `INSERT INTO ephemeral.request_nonces (
        tenant_id, app_id, principal_type, principal_key_id, nonce,
        timestamp_ms, created_at, expires_at
      ) VALUES ($1,$2,'server_key',$3,$4,$5,to_timestamp($6 / 1000.0),to_timestamp($7 / 1000.0))
      ON CONFLICT DO NOTHING RETURNING nonce`,
      [row.tenant_id, row.app_id, row.server_key_id, nonce, timestampMs, nowMs, nowMs + input.config.nonceTtlMs],
    );
  });
  if (inserted.rowCount !== 1) {
    return { ok: false, failure: { status: 401, reason: "nonce_reused", requestDigest, actorRef } };
  }
  return {
    ok: true,
    identity: {
      tenantId: row.tenant_id,
      appId: row.app_id,
      serverKeyId: row.server_key_id,
      producer: row.producer,
      timestampMs,
      nonce,
      requestDigest,
    },
  };
}

export async function issueServerKey(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly scope: AppAdminIdentity;
  readonly producer?: string;
  readonly actorRef: string;
  readonly now?: Date;
}): Promise<{ readonly server_key_id: string; readonly server_key: string; readonly producer: string }> {
  const producer = input.producer ?? "postback:first-party";
  if (!producerPattern.test(producer)) throw new Error("server_producer_invalid");
  const now = input.now ?? new Date();
  const serverKeyId = `server-key:${uuidV7(now.getTime())}`;
  const serverKey = randomBytes(32).toString("base64url");
  const secretRef = await input.payloadStore.write(
    { tenantId: input.scope.tenantId, appId: input.scope.appId, objectId: `server-key-${serverKeyId}` },
    Buffer.from(serverKey, "utf8"),
  );
  try {
    await withTenant(input.pool, input.scope.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify([input.scope.tenantId, input.scope.appId, producer, "server-key-lifecycle"])],
      );
      const active = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM control.server_keys_current
          WHERE tenant_id=$1 AND app_id=$2 AND producer=$3 AND status='active'`,
        [input.scope.tenantId, input.scope.appId, producer],
      );
      if ((active.rows[0]?.count ?? 0) >= 2) throw new Error("server_key_overlap_limit_reached");
      const createdAt = now.toISOString();
      await client.query(
        `INSERT INTO control.server_keys (
          server_key_id, tenant_id, app_id, producer, secret_ref, created_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [serverKeyId, input.scope.tenantId, input.scope.appId, producer, secretRef, createdAt,
          JSON.stringify({ server_key_id: serverKeyId, tenant_id: input.scope.tenantId,
            app_id: input.scope.appId, producer, created_at: createdAt })],
      );
      await client.query(
        `INSERT INTO control.server_key_states (
          server_key_id, tenant_id, app_id, status, changed_at, artifact
        ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
        [serverKeyId, input.scope.tenantId, input.scope.appId, createdAt,
          JSON.stringify({ server_key_id: serverKeyId, status: "active", changed_at: createdAt })],
      );
      await recordDashboardAuditWithClient(client, {
        tenantId: input.scope.tenantId,
        appId: input.scope.appId,
        actorRef: input.actorRef,
        action: "server_key_issued",
        targetScope: "server_key",
        targetRef: serverKeyId,
        outcome: "succeeded",
        now,
      });
    });
  } catch (error) {
    await input.payloadStore.purge(secretRef);
    throw error;
  }
  return { server_key_id: serverKeyId, server_key: serverKey, producer };
}

export async function listServerKeys(
  pool: Pool,
  scope: { readonly tenantId: string; readonly appId: string },
): Promise<readonly ServerKeyRecord[]> {
  const result = await withTenant(pool, scope.tenantId, (client) => client.query<ServerKeyRecord>(
    `SELECT server_key_id, producer, status, created_at, status_changed_at
       FROM control.server_keys_current
      WHERE tenant_id=$1 AND app_id=$2
      ORDER BY created_at DESC, server_key_id COLLATE "C"`,
    [scope.tenantId, scope.appId],
  ));
  return result.rows;
}

export async function retireServerKey(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly scope: AppAdminIdentity;
  readonly serverKeyId: string;
  readonly actorRef: string;
  readonly now?: Date;
}): Promise<{ readonly server_key_id: string; readonly status: "retired"; readonly changed_at: string }> {
  const now = input.now ?? new Date();
  const changedAt = now.toISOString();
  let secretRef = "";
  await withTenant(input.pool, input.scope.tenantId, async (client) => {
    const target = await client.query<{ producer: string; status: "active" | "retired"; secret_ref: string }>(
      `SELECT producer, status, secret_ref FROM control.server_keys_current
        WHERE tenant_id=$1 AND app_id=$2 AND server_key_id=$3`,
      [input.scope.tenantId, input.scope.appId, input.serverKeyId],
    );
    if (!target.rows[0]) throw new Error("server_key_not_found");
    if (target.rows[0].status !== "active") throw new Error("server_key_not_active");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify([input.scope.tenantId, input.scope.appId, target.rows[0].producer, "server-key-lifecycle"])],
    );
    const active = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM control.server_keys_current
        WHERE tenant_id=$1 AND app_id=$2 AND producer=$3 AND status='active'`,
      [input.scope.tenantId, input.scope.appId, target.rows[0].producer],
    );
    if ((active.rows[0]?.count ?? 0) <= 1) throw new Error("last_active_server_key");
    await client.query(
      `INSERT INTO control.server_key_states (
        server_key_id, tenant_id, app_id, status, changed_at, artifact
      ) VALUES ($1,$2,$3,'retired',$4,$5::jsonb)`,
      [input.serverKeyId, input.scope.tenantId, input.scope.appId, changedAt,
        JSON.stringify({ server_key_id: input.serverKeyId, status: "retired", changed_at: changedAt })],
    );
    await recordDashboardAuditWithClient(client, {
      tenantId: input.scope.tenantId,
      appId: input.scope.appId,
      actorRef: input.actorRef,
      action: "server_key_retired",
      targetScope: "server_key",
      targetRef: input.serverKeyId,
      outcome: "succeeded",
      now,
    });
    secretRef = target.rows[0].secret_ref;
  });
  await input.payloadStore.purge(secretRef);
  return { server_key_id: input.serverKeyId, status: "retired", changed_at: changedAt };
}
