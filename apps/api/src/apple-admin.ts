import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { uuidV7, withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/;
const schemaVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const maximumAdamId = 9_223_372_036_854_775_807n;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("conversion_schema_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  throw new Error("conversion_schema_json_invalid");
}

export function canonicalConversionSchema(definition: unknown): string {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("conversion_schema_definition_invalid");
  }
  return canonicalJsonValue(definition);
}

function adamId(value: unknown): string {
  const rendered = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value : "";
  if (!/^[1-9][0-9]{0,18}$/.test(rendered) || BigInt(rendered) > maximumAdamId) {
    throw new Error("apple_app_adam_id_invalid");
  }
  return rendered;
}

async function insertAdminAudit(
  client: PoolClient,
  input: {
    readonly identity: AppAdminIdentity;
    readonly action: string;
    readonly targetScope: "apple_app_registration" | "conversion_schema";
    readonly targetRef: string;
    readonly now: Date;
  },
): Promise<void> {
  const requestDigest = sha256([
    input.action,
    input.targetScope,
    input.targetRef,
    input.identity.tenantId,
    input.identity.appId,
  ].join("\u0000"));
  await client.query(
    `INSERT INTO ledger.audit_logs (
      audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
      action, target_scope, target_ref, policy_version, request_digest,
      outcome, reason_code
    ) VALUES ($1,$2,$3,$4,'admin_key',$5,$6,$7,$8,'m4-apple-admin-v1',$9,'succeeded',NULL)`,
    [
      uuidV7(input.now.getTime()), input.identity.tenantId, input.identity.appId,
      input.now.toISOString(), `admin_key:${input.identity.keyId}`, input.action,
      input.targetScope, input.targetRef, requestDigest,
    ],
  );
}

function namedConflict(error: unknown, conflicts: Readonly<Record<string, string>>): never {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code === "23505" && candidate.constraint && conflicts[candidate.constraint]) {
    throw new Error(conflicts[candidate.constraint]);
  }
  throw error;
}

export async function registerAppleApp(input: {
  readonly pool: Pool;
  readonly identity: AppAdminIdentity;
  readonly appleAppAdamId: unknown;
  readonly appleBundleId?: unknown;
  readonly now?: Date;
}): Promise<{
  readonly app_id: string;
  readonly apple_app_adam_id: string;
  readonly apple_bundle_id?: string;
  readonly registered_at: string;
}> {
  const resolvedAdamId = adamId(input.appleAppAdamId);
  const bundleId = input.appleBundleId === undefined ? undefined : String(input.appleBundleId);
  if (bundleId !== undefined && !bundleIdPattern.test(bundleId)) throw new Error("apple_bundle_id_invalid");
  const now = input.now ?? new Date();
  try {
    return await withTenant(input.pool, input.identity.tenantId, async (client) => {
      const artifact = {
        tenant_id: input.identity.tenantId,
        app_id: input.identity.appId,
        apple_app_adam_id: resolvedAdamId,
        ...(bundleId ? { apple_bundle_id: bundleId } : {}),
        registered_at: now.toISOString(),
      };
      await client.query(
        `INSERT INTO control.apple_app_registrations (
          tenant_id, app_id, apple_app_adam_id, apple_bundle_id, registered_at, artifact
        ) VALUES ($1,$2,$3::bigint,$4,$5,$6::jsonb)`,
        [
          input.identity.tenantId, input.identity.appId, resolvedAdamId,
          bundleId ?? null, now.toISOString(), JSON.stringify(artifact),
        ],
      );
      await insertAdminAudit(client, {
        identity: input.identity,
        action: "apple_app_registered",
        targetScope: "apple_app_registration",
        targetRef: input.identity.appId,
        now,
      });
      return {
        app_id: input.identity.appId,
        apple_app_adam_id: resolvedAdamId,
        ...(bundleId ? { apple_bundle_id: bundleId } : {}),
        registered_at: now.toISOString(),
      };
    });
  } catch (error) {
    return namedConflict(error, {
      apple_app_registrations_apple_app_adam_id_key: "apple_app_adam_id_already_registered",
      apple_app_registrations_pkey: "apple_app_already_registered",
    });
  }
}

export async function registerConversionSchema(input: {
  readonly pool: Pool;
  readonly identity: AppAdminIdentity;
  readonly schemaVersion: unknown;
  readonly definition: unknown;
  readonly now?: Date;
}): Promise<{
  readonly conversion_schema_id: string;
  readonly app_id: string;
  readonly schema_version: string;
  readonly schema_digest: string;
  readonly status: "active";
}> {
  const schemaVersion = typeof input.schemaVersion === "string" ? input.schemaVersion : "";
  if (!schemaVersionPattern.test(schemaVersion)) throw new Error("conversion_schema_version_invalid");
  const canonicalDefinition = canonicalConversionSchema(input.definition);
  const schemaDigest = sha256(canonicalDefinition);
  const now = input.now ?? new Date();
  const conversionSchemaId = `conversion-schema:${uuidV7(now.getTime())}`;
  try {
    return await withTenant(input.pool, input.identity.tenantId, async (client) => {
      const artifact = {
        conversion_schema_id: conversionSchemaId,
        tenant_id: input.identity.tenantId,
        app_id: input.identity.appId,
        schema_version: schemaVersion,
        schema_digest: schemaDigest,
        definition: input.definition,
        created_at: now.toISOString(),
      };
      await client.query(
        `INSERT INTO control.conversion_schemas (
          conversion_schema_id, tenant_id, app_id, schema_version,
          schema_digest, definition, created_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`,
        [
          conversionSchemaId, input.identity.tenantId, input.identity.appId,
          schemaVersion, schemaDigest, canonicalDefinition, now.toISOString(),
          JSON.stringify(artifact),
        ],
      );
      await client.query(
        `INSERT INTO control.conversion_schema_states (
          conversion_schema_id, tenant_id, app_id, status, changed_at, artifact
        ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
        [conversionSchemaId, input.identity.tenantId, input.identity.appId, now.toISOString(), JSON.stringify({
          conversion_schema_id: conversionSchemaId,
          status: "active",
          changed_at: now.toISOString(),
        })],
      );
      await insertAdminAudit(client, {
        identity: input.identity,
        action: "conversion_schema_registered",
        targetScope: "conversion_schema",
        targetRef: conversionSchemaId,
        now,
      });
      return {
        conversion_schema_id: conversionSchemaId,
        app_id: input.identity.appId,
        schema_version: schemaVersion,
        schema_digest: schemaDigest,
        status: "active",
      };
    });
  } catch (error) {
    return namedConflict(error, {
      conversion_schemas_tenant_id_app_id_schema_version_key: "conversion_schema_version_already_registered",
    });
  }
}
