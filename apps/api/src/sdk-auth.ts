import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@open-mmp/runtime";

type Principal = {
  tenantId: string;
  appId: string;
  sdkKeyId: string;
  installationKeyId?: string;
  installationIdDigest?: string;
  secretRef: string;
  actorType: "sdk_key" | "sdk_installation";
  platform: "android" | "ios";
};

export type SdkAuthConfig = {
  tenantId: string;
  appId: string;
  timestampSkewMs: number;
  nonceTtlMs: number;
  installationDigestKey: string;
};

export type VerifiedSdkRequest = Principal & {
  timestampMs: number;
  nonce: string;
  requestDigest: string;
};

export type SdkAuthFailure = {
  status: 401;
  reason: "headers_invalid" | "key_inactive" | "signature_invalid" | "timestamp_out_of_window" | "nonce_reused";
  requestDigest: string;
  actorRef: string;
};

export type SdkAuthResult = { ok: true; identity: VerifiedSdkRequest } | { ok: false; failure: SdkAuthFailure };

const headerValue = (headers: IncomingHttpHeaders, name: string): string => {
  const value = headers[name];
  return typeof value === "string" ? value : "";
};

export function sdkBodyDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function sdkCanonicalString(input: {
  method: string;
  path: string;
  sdkKeyId: string;
  installationKeyId?: string;
  timestampMs: number;
  nonce: string;
  body: Buffer;
}): string {
  return [
    "open-mmp-sdk-v1",
    input.method.toUpperCase(),
    input.path,
    input.sdkKeyId,
    input.installationKeyId ?? "-",
    String(input.timestampMs),
    input.nonce,
    sdkBodyDigest(input.body),
  ].join("\n");
}

export function signSdkRequest(secret: string, input: Parameters<typeof sdkCanonicalString>[0]): string {
  return createHmac("sha256", secret).update(sdkCanonicalString(input), "utf8").digest("hex");
}

function safeSignature(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function installationIdDigest(config: SdkAuthConfig, installationId: string): string {
  return createHmac("sha256", config.installationDigestKey)
    .update(`${config.tenantId}\u0000${config.appId}\u0000${installationId}`, "utf8")
    .digest("hex");
}

async function resolvePrincipal(
  pool: Pool,
  payloadStore: PayloadStore,
  config: SdkAuthConfig,
  sdkKeyId: string,
  installationKeyId: string | undefined,
): Promise<(Principal & { secret: string }) | undefined> {
  return withTenant(pool, config.tenantId, async (client) => {
    if (installationKeyId) {
      const result = await client.query<{
        installation_key_id: string; sdk_key_id: string; installation_id_digest: string; secret_ref: string;
        platform: "android" | "ios" | null;
      }>(
        `SELECT credential.installation_key_id, credential.sdk_key_id,
                credential.installation_id_digest, credential.secret_ref, sdk.platform
         FROM control.installation_credentials_current AS credential
         JOIN control.sdk_keys_current AS sdk
           ON sdk.sdk_key_id=credential.sdk_key_id
          AND sdk.tenant_id=credential.tenant_id AND sdk.app_id=credential.app_id
         WHERE credential.tenant_id=$1 AND credential.app_id=$2
           AND credential.installation_key_id=$3 AND credential.sdk_key_id=$4
           AND credential.status='active' AND sdk.status='active'`,
        [config.tenantId, config.appId, installationKeyId, sdkKeyId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        tenantId: config.tenantId, appId: config.appId, sdkKeyId: row.sdk_key_id,
        installationKeyId: row.installation_key_id,
        installationIdDigest: row.installation_id_digest,
        secretRef: row.secret_ref, actorType: "sdk_installation" as const,
        platform: row.platform ?? "android",
        secret: (await payloadStore.read(row.secret_ref)).toString("utf8"),
      };
    }
    const result = await client.query<{ sdk_key_id: string; secret_ref: string; platform: "android" | "ios" | null }>(
      `SELECT sdk_key_id, secret_ref, platform FROM control.sdk_keys_current
       WHERE tenant_id=$1 AND app_id=$2 AND sdk_key_id=$3 AND status='active'`,
      [config.tenantId, config.appId, sdkKeyId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tenantId: config.tenantId, appId: config.appId, sdkKeyId: row.sdk_key_id,
      secretRef: row.secret_ref, actorType: "sdk_key" as const,
      platform: row.platform ?? "android",
      secret: (await payloadStore.read(row.secret_ref)).toString("utf8"),
    };
  });
}

export async function verifySdkRequest(input: {
  pool: Pool;
  payloadStore: PayloadStore;
  config: SdkAuthConfig;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  body: Buffer;
  nowMs?: number;
  requireInstallation: boolean;
}): Promise<SdkAuthResult> {
  const requestDigest = sdkBodyDigest(input.body);
  const sdkKeyId = headerValue(input.headers, "x-openmmp-sdk-key-id");
  const installationHeader = headerValue(input.headers, "x-openmmp-installation-key-id");
  const installationKeyId = installationHeader && installationHeader !== "-" ? installationHeader : undefined;
  const timestampText = headerValue(input.headers, "x-openmmp-timestamp-ms");
  const nonce = headerValue(input.headers, "x-openmmp-nonce");
  const signature = headerValue(input.headers, "x-openmmp-signature");
  const actorRef = installationKeyId ? `sdk_installation:${installationKeyId}` : `sdk_key:${sdkKeyId || "unknown"}`;
  const timestampMs = Number(timestampText);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sdkKeyId)
    || (input.requireInstallation && !installationKeyId)
    || (installationKeyId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(installationKeyId))
    || !Number.isSafeInteger(timestampMs)
    || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)) {
    return { ok: false, failure: { status: 401, reason: "headers_invalid", requestDigest, actorRef } };
  }
  const principal = await resolvePrincipal(input.pool, input.payloadStore, input.config, sdkKeyId, installationKeyId);
  if (!principal) return { ok: false, failure: { status: 401, reason: "key_inactive", requestDigest, actorRef } };
  const expected = signSdkRequest(principal.secret, {
    method: input.method, path: input.path, sdkKeyId,
    installationKeyId, timestampMs, nonce, body: input.body,
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
      ) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7 / 1000.0),to_timestamp($8 / 1000.0))
      ON CONFLICT DO NOTHING RETURNING nonce`,
      [
        input.config.tenantId, input.config.appId, principal.actorType === "sdk_key" ? "sdk_key" : "installation",
        principal.installationKeyId ?? principal.sdkKeyId, nonce, timestampMs, nowMs, nowMs + input.config.nonceTtlMs,
      ],
    );
  });
  if (inserted.rowCount !== 1) {
    return { ok: false, failure: { status: 401, reason: "nonce_reused", requestDigest, actorRef } };
  }
  const { secret: _secret, ...identity } = principal;
  return { ok: true, identity: { ...identity, timestampMs, nonce, requestDigest } };
}

export async function recordSdkAudit(
  pool: Pool,
  scope: { tenantId: string; appId: string },
  input: {
    actorType: "sdk_key" | "sdk_installation";
    actorRef: string;
    action: string;
    targetScope: "sdk_key" | "installation" | "ingest_batch" | "privacy_request";
    targetRef: string;
    requestDigest: string;
    outcome: "succeeded" | "failed";
    reasonCode?: string;
    now?: string;
    auditLogId?: string;
  },
): Promise<string> {
  const auditLogId = input.auditLogId ?? uuidV7(input.now ? Date.parse(input.now) : Date.now());
  const occurredAt = input.now ?? new Date().toISOString();
  await withTenant(pool, scope.tenantId, (client) => client.query(
    `INSERT INTO ledger.audit_logs (
      audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
      action, target_scope, target_ref, policy_version, request_digest,
      outcome, reason_code
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sdk-auth-v1',$10,$11,$12)`,
    [auditLogId, scope.tenantId, scope.appId, occurredAt, input.actorType, input.actorRef,
      input.action, input.targetScope, input.targetRef, input.requestDigest, input.outcome, input.reasonCode ?? null],
  ).then(() => undefined));
  return auditLogId;
}

export async function ensureSdkKeys(
  pool: Pool,
  payloadStore: PayloadStore,
  scope: { tenantId: string; appId: string },
  keys: readonly { keyId: string; secret: string; platform?: "android" | "ios" }[],
  now = new Date().toISOString(),
): Promise<void> {
  const unique = [...new Map(keys.map((key) => [key.keyId, key])).values()];
  if (unique.length < 1 || unique.length > 2) throw new Error("one or two SDK keys must be configured");
  for (const key of unique) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key.keyId) || Buffer.byteLength(key.secret, "utf8") < 32) {
      throw new Error("SDK key configuration is invalid");
    }
    const exists = await withTenant(pool, scope.tenantId, (client) => client.query(
      "SELECT secret_ref FROM control.sdk_keys WHERE tenant_id=$1 AND app_id=$2 AND sdk_key_id=$3",
      [scope.tenantId, scope.appId, key.keyId],
    ));
    if (exists.rowCount === 0) {
      const secretRef = await payloadStore.write(
        { tenantId: scope.tenantId, appId: scope.appId, objectId: `sdk-key-${key.keyId}` },
        Buffer.from(key.secret, "utf8"),
      );
      try {
        await withTenant(pool, scope.tenantId, async (client) => {
          await client.query(
            `INSERT INTO control.apps (tenant_id, app_id, created_at)
             VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
            [scope.tenantId, scope.appId, now],
          );
          await client.query(
            `INSERT INTO control.sdk_keys (
              sdk_key_id, tenant_id, app_id, secret_ref, created_at, platform, artifact
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [key.keyId, scope.tenantId, scope.appId, secretRef, now, key.platform ?? "android", JSON.stringify({
              sdk_key_id: key.keyId, tenant_id: scope.tenantId, app_id: scope.appId,
              platform: key.platform ?? "android", created_at: now,
            })],
          );
          await client.query(
            `INSERT INTO control.sdk_key_states (
              sdk_key_id, tenant_id, app_id, status, changed_at, artifact
            ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
            [key.keyId, scope.tenantId, scope.appId, now, JSON.stringify({ sdk_key_id: key.keyId, status: "active", changed_at: now })],
          );
        });
      } catch (error) {
        await payloadStore.purge(secretRef);
        throw error;
      }
    }
  }
  const active = await withTenant(pool, scope.tenantId, (client) => client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM control.sdk_keys_current WHERE tenant_id=$1 AND app_id=$2 AND status='active'",
    [scope.tenantId, scope.appId],
  ));
  if (active.rows[0].count > 2) throw new Error("SDK key overlap exceeds two active keys");
}

export async function issueInstallationCredential(input: {
  pool: Pool;
  payloadStore: PayloadStore;
  config: SdkAuthConfig;
  sdkKeyId: string;
  installationId: string;
  now?: string;
}): Promise<{ installation_key_id: string; installation_secret: string }> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.installationId)) throw new Error("installation_id_invalid");
  const now = input.now ?? new Date().toISOString();
  const installationKeyId = `installation-key:${randomBytes(18).toString("base64url")}`;
  const secret = randomBytes(32).toString("base64url");
  const secretRef = await input.payloadStore.write(
    { tenantId: input.config.tenantId, appId: input.config.appId, objectId: installationKeyId },
    Buffer.from(secret, "utf8"),
  );
  try {
    await withTenant(input.pool, input.config.tenantId, async (client) => {
      await client.query(
        `INSERT INTO control.installation_credentials (
          installation_key_id, tenant_id, app_id, installation_id_digest,
          sdk_key_id, secret_ref, created_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [installationKeyId, input.config.tenantId, input.config.appId,
          installationIdDigest(input.config, input.installationId), input.sdkKeyId, secretRef, now,
          JSON.stringify({ installation_key_id: installationKeyId, sdk_key_id: input.sdkKeyId, created_at: now })],
      );
      await client.query(
        `INSERT INTO control.installation_credential_states (
          installation_key_id, tenant_id, app_id, status, changed_at, artifact
        ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
        [installationKeyId, input.config.tenantId, input.config.appId, now,
          JSON.stringify({ installation_key_id: installationKeyId, status: "active", changed_at: now })],
      );
    });
  } catch (error) {
    await input.payloadStore.purge(secretRef);
    throw error;
  }
  return { installation_key_id: installationKeyId, installation_secret: secret };
}

export async function revokeInstallationCredential(input: {
  pool: Pool;
  payloadStore: PayloadStore;
  identity: VerifiedSdkRequest;
  now?: string;
}): Promise<void> {
  if (!input.identity.installationKeyId) throw new Error("installation_credential_required");
  const now = input.now ?? new Date().toISOString();
  await withTenant(input.pool, input.identity.tenantId, async (client) => {
    await client.query(
      `INSERT INTO control.installation_credential_states (
        installation_key_id, tenant_id, app_id, status, changed_at, reason_code, artifact
      ) VALUES ($1,$2,$3,'deleted',$4,'privacy_deletion',$5::jsonb)`,
      [input.identity.installationKeyId, input.identity.tenantId, input.identity.appId, now,
        JSON.stringify({ installation_key_id: input.identity.installationKeyId, status: "deleted", changed_at: now, reason_code: "privacy_deletion" })],
    );
  });
  await input.payloadStore.purge(input.identity.secretRef);
}
