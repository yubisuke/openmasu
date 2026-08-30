import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  normalizeOperatorWebhookEvents,
  resolveWebhookEndpoint,
  uuidV7,
  withTenant,
  type OperatorWebhookEventName,
  type PayloadStore,
  type WebhookLookup,
} from "@openmasu/runtime";
import type { AdminIdentity } from "./admin-auth.js";

type AppIdentity = AdminIdentity & { readonly appId: string };

export type OperatorBulkExportDestination = Readonly<{
  destination_id: string;
  tenant_id: string;
  app_id: string;
  endpoint_url: string;
  bucket_name: string;
  object_prefix: string;
  region: string;
  events: readonly OperatorWebhookEventName[];
  start_at: string;
  status: "active" | "disabled";
  created_at: string;
  status_changed_at: string;
}>;

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("operator_bulk_start_at_invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("operator_bulk_start_at_invalid");
  }
  return value;
}

function text(value: unknown, pattern: RegExp, maximum: number, error: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new Error(error);
  }
  return value;
}

function prefix(value: unknown): string {
  if (typeof value !== "string" || value.length > 512
    || value.startsWith("/") || value.endsWith("/")
    || (value && value.split("/").some((part) => !/^[A-Za-z0-9._=-]{1,128}$/.test(part)))) {
    throw new Error("operator_bulk_object_prefix_invalid");
  }
  return value;
}

function credentials(body: Record<string, unknown>): Buffer {
  const accessKeyId = text(body.access_key_id, /^[A-Za-z0-9]{8,128}$/, 128, "operator_bulk_access_key_invalid");
  const secretAccessKey = text(
    body.secret_access_key, /^[A-Za-z0-9/+=]{16,256}$/, 256, "operator_bulk_secret_key_invalid",
  );
  const sessionToken = body.session_token === undefined || body.session_token === "" ? undefined
    : text(body.session_token, /^[\x21-\x7E]{1,4096}$/, 4096, "operator_bulk_session_token_invalid");
  return Buffer.from(JSON.stringify({
    access_key_id: accessKeyId,
    secret_access_key: secretAccessKey,
    ...(sessionToken ? { session_token: sessionToken } : {}),
  }), "utf8");
}

function requestDigest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

async function audit(client: PoolClient, input: Readonly<{
  identity: AppIdentity;
  destinationId: string;
  action: string;
  occurredAt: string;
  digest: string;
}>): Promise<void> {
  await client.query(
    `INSERT INTO ledger.audit_logs (
       audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,action,
       target_scope,target_ref,policy_version,request_digest,outcome,reason_code
     ) VALUES ($1,$2,$3,$4,'admin_key',$5,$6,'bulk_export_destination',$7,
       'operator-bulk-export-v1',$8,'succeeded',NULL)`,
    [uuidV7(Date.parse(input.occurredAt) + 1), input.identity.tenantId, input.identity.appId,
      input.occurredAt, `admin_key:${input.identity.keyId}`, input.action,
      input.destinationId, input.digest],
  );
}

export async function registerOperatorBulkExportDestination(options: Readonly<{
  pool: Pool;
  payloadStore: PayloadStore;
  identity: AppIdentity;
  body: Record<string, unknown>;
  destinationAllowlist: readonly string[];
  allowSyntheticLoopback?: boolean;
  lookup?: WebhookLookup;
  now?: Date;
}>): Promise<OperatorBulkExportDestination> {
  const endpoint = await resolveWebhookEndpoint(options.body.endpoint_url, options.destinationAllowlist, {
    allowSyntheticLoopback: options.allowSyntheticLoopback,
    lookup: options.lookup,
  });
  if (endpoint.url.pathname !== "/" || endpoint.url.search || endpoint.url.hash) {
    throw new Error("operator_bulk_endpoint_origin_required");
  }
  const bucketName = text(
    options.body.bucket_name, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 63, "operator_bulk_bucket_invalid",
  );
  const objectPrefix = prefix(options.body.object_prefix ?? "");
  const region = text(options.body.region, /^[a-z0-9-]{1,63}$/, 63, "operator_bulk_region_invalid");
  const events = normalizeOperatorWebhookEvents(options.body.events);
  const startAt = exactTimestamp(options.body.start_at);
  const protectedCredentials = credentials(options.body);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("operator_bulk_created_at_invalid");
  const createdAt = now.toISOString();
  const destinationId = `bulk:${uuidV7(now.valueOf())}`;
  const credentialRef = await options.payloadStore.write({
    tenantId: options.identity.tenantId,
    appId: options.identity.appId,
    objectId: `operator-bulk-credentials-${destinationId}`,
  }, protectedCredentials);
  let referenceSecretRef: string | undefined;
  try {
    referenceSecretRef = await options.payloadStore.write({
      tenantId: options.identity.tenantId,
      appId: options.identity.appId,
      objectId: `operator-bulk-reference-secret-${destinationId}`,
    }, randomBytes(32));
    return await withTenant(options.pool, options.identity.tenantId, async (client) => {
      const artifact = {
        destination_id: destinationId,
        tenant_id: options.identity.tenantId,
        app_id: options.identity.appId,
        endpoint_url: endpoint.url.origin,
        bucket_name: bucketName,
        object_prefix: objectPrefix,
        region,
        events,
        start_at: startAt,
        credential_digest: sha256(protectedCredentials),
        created_at: createdAt,
      };
      await client.query(
        `INSERT INTO control.operator_bulk_export_destinations (
           destination_id,tenant_id,app_id,endpoint_url,bucket_name,object_prefix,region,
           allowed_events,start_at,credential_ref,credential_digest,reference_secret_ref,created_at,artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14::jsonb)`,
        [destinationId, options.identity.tenantId, options.identity.appId, endpoint.url.origin,
          bucketName, objectPrefix, region, events, startAt, credentialRef, sha256(protectedCredentials),
          referenceSecretRef, createdAt, JSON.stringify(artifact)],
      );
      await client.query(
        `INSERT INTO control.operator_bulk_export_destination_states (
           destination_id,tenant_id,app_id,status,changed_at,artifact
         ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
        [destinationId, options.identity.tenantId, options.identity.appId, createdAt,
          JSON.stringify({ destination_id: destinationId, status: "active", changed_at: createdAt })],
      );
      await client.query(
        `INSERT INTO control.operator_bulk_export_checkpoints (
           destination_id,tenant_id,app_id,event_received_at,event_record_id,deletion_seq,updated_at
         ) VALUES ($1,$2,$3,NULL,NULL,0,$4)`,
        [destinationId, options.identity.tenantId, options.identity.appId, createdAt],
      );
      await audit(client, {
        identity: options.identity,
        destinationId,
        action: "operator_bulk_export_destination_registered",
        occurredAt: createdAt,
        digest: requestDigest(artifact),
      });
      return {
        destination_id: destinationId,
        tenant_id: options.identity.tenantId,
        app_id: options.identity.appId,
        endpoint_url: endpoint.url.origin,
        bucket_name: bucketName,
        object_prefix: objectPrefix,
        region,
        events,
        start_at: startAt,
        status: "active",
        created_at: createdAt,
        status_changed_at: createdAt,
      };
    });
  } catch (error) {
    await Promise.all([
      options.payloadStore.purge(credentialRef),
      ...(referenceSecretRef ? [options.payloadStore.purge(referenceSecretRef)] : []),
    ]);
    throw error;
  }
}

export async function listOperatorBulkExportDestinations(
  pool: Pool,
  identity: AppIdentity,
): Promise<readonly OperatorBulkExportDestination[]> {
  return withTenant(pool, identity.tenantId, async (client) => (await client.query<OperatorBulkExportDestination>(
    `SELECT destination_id,tenant_id,app_id,endpoint_url,bucket_name,object_prefix,region,
            allowed_events AS events,start_at,status,created_at,status_changed_at
       FROM control.operator_bulk_export_destinations_current
      WHERE tenant_id=$1 AND app_id=$2
      ORDER BY created_at DESC,destination_id COLLATE "C"`,
    [identity.tenantId, identity.appId],
  )).rows);
}

export async function disableOperatorBulkExportDestination(options: Readonly<{
  pool: Pool;
  payloadStore: PayloadStore;
  identity: AppIdentity;
  destinationId: string;
  now?: Date;
}>): Promise<Readonly<{ destination_id: string; status: "disabled"; changed_at: string }>> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("operator_bulk_changed_at_invalid");
  const changedAt = now.toISOString();
  const protectedRefs = await withTenant(options.pool, options.identity.tenantId, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-bulk-destination:' || $1 || ':' || $2 || ':' || $3,0))",
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    const selected = await client.query<{ status: string; credential_ref: string; reference_secret_ref: string }>(
      `SELECT current.status,base.credential_ref,base.reference_secret_ref
         FROM control.operator_bulk_export_destinations AS base
         JOIN control.operator_bulk_export_destinations_current AS current
           USING (destination_id,tenant_id,app_id)
        WHERE base.tenant_id=$1 AND base.app_id=$2 AND base.destination_id=$3`,
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    const destination = selected.rows[0];
    if (!destination) throw new Error("operator_bulk_destination_not_found");
    if (destination.status !== "active") throw new Error("operator_bulk_destination_not_active");
    await client.query(
      `INSERT INTO control.operator_bulk_export_destination_states (
         destination_id,tenant_id,app_id,status,changed_at,artifact
       ) VALUES ($1,$2,$3,'disabled',$4,$5::jsonb)`,
      [options.destinationId, options.identity.tenantId, options.identity.appId, changedAt,
        JSON.stringify({ destination_id: options.destinationId, status: "disabled", changed_at: changedAt })],
    );
    const pending = await client.query<{
      batch_id: string; object_ref: string; object_key: string; object_digest: string; attempts: number;
    }>(
      `SELECT batch_id::text,object_ref,object_key,object_digest,attempts
         FROM ephemeral.operator_bulk_export_batches
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state IN ('queued','retry')
        ORDER BY batch_id FOR UPDATE`,
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    for (const row of pending.rows) {
      await client.query(
        `UPDATE ephemeral.operator_bulk_export_batches
            SET state='suppressed',safe_reason='destination_disabled',updated_at=$4
          WHERE tenant_id=$1 AND app_id=$2 AND batch_id=$3`,
        [options.identity.tenantId, options.identity.appId, row.batch_id, changedAt],
      );
      const artifact = {
        batch_id: row.batch_id,
        destination_id: options.destinationId,
        tenant_id: options.identity.tenantId,
        app_id: options.identity.appId,
        object_key: row.object_key,
        object_digest: row.object_digest,
        state: "suppressed",
        attempt: row.attempts,
        occurred_at: changedAt,
        reason_code: "destination_disabled",
      };
      await client.query(
        `INSERT INTO ledger.operator_bulk_export_results (
           export_result_id,batch_id,tenant_id,app_id,destination_id,object_key,object_digest,
           state,attempt,occurred_at,reason_code,artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'suppressed',$8,$9,'destination_disabled',$10::jsonb)`,
        [uuidV7(now.valueOf() + row.attempts), row.batch_id, options.identity.tenantId,
          options.identity.appId, options.destinationId, row.object_key, row.object_digest,
          row.attempts, changedAt, JSON.stringify(artifact)],
      );
    }
    await audit(client, {
      identity: options.identity,
      destinationId: options.destinationId,
      action: "operator_bulk_export_destination_disabled",
      occurredAt: changedAt,
      digest: requestDigest({ destination_id: options.destinationId, status: "disabled" }),
    });
    return [destination.credential_ref, destination.reference_secret_ref, ...pending.rows.map((row) => row.object_ref)];
  });
  for (const reference of protectedRefs) await options.payloadStore.purge(reference);
  return { destination_id: options.destinationId, status: "disabled", changed_at: changedAt };
}
