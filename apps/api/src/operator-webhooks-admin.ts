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
import { webhookSigningRevision, listWebhookSigningRevisions } from "@openmasu/runtime/operator-webhook-signing";

type AppIdentity = AdminIdentity & { readonly appId: string };

export type OperatorWebhookDestination = Readonly<{
  destination_id: string;
  tenant_id: string;
  app_id: string;
  endpoint_url: string;
  events: readonly OperatorWebhookEventName[];
  status: "active" | "disabled";
  created_at: string;
  status_changed_at: string;
  signing_revision?: number;
  signing_revisions?: Awaited<ReturnType<typeof listWebhookSigningRevisions>>;
}>;

function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function audit(
  client: PoolClient,
  input: Readonly<{
    identity: AppIdentity;
    destinationId: string;
    action: string;
    occurredAt: string;
    digest: string;
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger.audit_logs (
       audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,action,
       target_scope,target_ref,policy_version,request_digest,outcome,reason_code
     ) VALUES ($1,$2,$3,$4,'admin_key',$5,$6,'webhook_destination',$7,
       'operator-webhook-v1',$8,'succeeded',NULL)`,
    [uuidV7(Date.parse(input.occurredAt) + 1), input.identity.tenantId, input.identity.appId,
      input.occurredAt, `admin_key:${input.identity.keyId}`, input.action,
      input.destinationId, input.digest],
  );
}

export async function registerOperatorWebhookDestination(options: Readonly<{
  pool: Pool;
  payloadStore: PayloadStore;
  identity: AppIdentity;
  body: Record<string, unknown>;
  destinationAllowlist: readonly string[];
  allowSyntheticLoopback?: boolean;
  lookup?: WebhookLookup;
  now?: Date;
}>): Promise<OperatorWebhookDestination & { readonly signing_secret: string }> {
  const endpoint = await resolveWebhookEndpoint(options.body.endpoint_url, options.destinationAllowlist, {
    allowSyntheticLoopback: options.allowSyntheticLoopback,
    lookup: options.lookup,
  });
  const comparisonOnly = options.body.purpose === "comparison_notifications";
  if (options.body.purpose !== undefined && !comparisonOnly) throw Error("operator_webhook_purpose_invalid");
  if (comparisonOnly && options.body.events !== undefined && (!Array.isArray(options.body.events) || options.body.events.length !== 0)) throw Error("operator_webhook_events_invalid");
  const events = comparisonOnly ? [] : normalizeOperatorWebhookEvents(options.body.events);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("operator_webhook_created_at_invalid");
  const createdAt = now.toISOString();
  const destinationId = `webhook:${uuidV7(now.valueOf())}`;
  const signingSecret = randomBytes(32).toString("base64url");
  const protectedRefs: string[] = [];
  try {
    const scope = { tenantId: options.identity.tenantId, appId: options.identity.appId };
    const secretRef = await options.payloadStore.write({ ...scope, objectId: `operator-webhook-reference-${destinationId}` },
      Buffer.from(randomBytes(32).toString("base64url"), "utf8"));
    protectedRefs.push(secretRef);
    const signingRef = await options.payloadStore.write({ ...scope, objectId: `operator-webhook-signing-${destinationId}-1` }, Buffer.from(signingSecret, "utf8"));
    protectedRefs.push(signingRef);
    const result = await withTenant(options.pool, options.identity.tenantId, async (client) => {
      const artifact = {
        destination_id: destinationId,
        tenant_id: options.identity.tenantId,
        app_id: options.identity.appId,
        endpoint_url: endpoint.url.href,
        events,
        created_at: createdAt,
      };
      await client.query(
        `INSERT INTO control.operator_webhook_destinations (
           destination_id,tenant_id,app_id,endpoint_url,allowed_events,secret_ref,created_at,artifact
         ) VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8::jsonb)`,
        [destinationId, options.identity.tenantId, options.identity.appId, endpoint.url.href,
          events, secretRef, createdAt, JSON.stringify(artifact)],
      );
      await client.query(
        `INSERT INTO control.operator_webhook_signing_revisions
         (tenant_id,app_id,destination_id,signing_revision,secret_ref,created_at,previous_valid_until)
         VALUES ($1,$2,$3,1,$4,$5,NULL)`,
        [options.identity.tenantId,options.identity.appId,destinationId,signingRef,createdAt],
      );
      await client.query(
        `INSERT INTO control.operator_webhook_destination_states (
           destination_id,tenant_id,app_id,status,changed_at,artifact
         ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
        [destinationId, options.identity.tenantId, options.identity.appId, createdAt,
          JSON.stringify({ destination_id: destinationId, status: "active", changed_at: createdAt })],
      );
      await audit(client, {
        identity: options.identity,
        destinationId,
        action: "operator_webhook_destination_registered",
        occurredAt: createdAt,
        digest: requestDigest({ endpoint_url: endpoint.url.href, events }),
      });
      return {
        destination_id: destinationId,
        tenant_id: options.identity.tenantId,
        app_id: options.identity.appId,
        endpoint_url: endpoint.url.href,
        events,
        status: "active" as const,
        created_at: createdAt,
        status_changed_at: createdAt,
        signing_secret: signingSecret,
        signing_revision: 1,
      };
    });
    return result;
  } catch {
    await purgeProtected(options.payloadStore, protectedRefs);
    throw Error("operator_webhook_registration_failed");
  }
}

export async function listOperatorWebhookDestinations(
  pool: Pool,
  identity: AppIdentity,
): Promise<readonly OperatorWebhookDestination[]> {
  return withTenant(pool, identity.tenantId, async (client) => {
    const rows = (await client.query<OperatorWebhookDestination>(
    `SELECT destination_id,tenant_id,app_id,endpoint_url,events,
            status,created_at,status_changed_at
       FROM (
         SELECT DISTINCT ON (base.destination_id)
                base.destination_id,base.tenant_id,base.app_id,base.endpoint_url,
                base.allowed_events AS events,state.status,base.created_at,
                state.changed_at AS status_changed_at
           FROM control.operator_webhook_destinations AS base
           JOIN control.operator_webhook_destination_states AS state
             USING (destination_id,tenant_id,app_id)
          WHERE base.tenant_id=$1 AND base.app_id=$2
          ORDER BY base.destination_id,state.destination_state_seq DESC
       ) AS current
      ORDER BY created_at DESC,destination_id COLLATE "C"`,
    [identity.tenantId, identity.appId],
    )).rows;
    const now = new Date();
    const result: OperatorWebhookDestination[] = [];
    for (const row of rows) {
      const revisions = await listWebhookSigningRevisions(client, identity, row.destination_id, now);
      result.push({ ...row, signing_revision: revisions[0]?.signing_revision, signing_revisions: revisions });
    }
    return result;
  });
}

type SigningCommand = Readonly<{ pool: Pool; payloadStore: PayloadStore; identity: AppIdentity; destinationId: string;
  body: Record<string, unknown>; now?: Date }>;
function revisionNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw Error("operator_webhook_signing_revision_invalid");
  return value;
}
function commandTime(now = new Date()): string {
  if (!Number.isFinite(now.valueOf())) throw Error("operator_webhook_changed_at_invalid");
  return now.toISOString();
}
async function purgeProtected(store: PayloadStore, refs: readonly string[]): Promise<void> {
  let failed = false;
  for (const reference of new Set(refs)) {
    try { await store.purge(reference); } catch { failed = true; }
  }
  if (failed) throw Error("operator_webhook_protected_cleanup_failed");
}
function signingFailure(error: unknown): never {
  if (error instanceof Error && /^operator_webhook_(destination_not_(found|active)|signing_(revision_stale|overlap_active|revision_not_found|current_required))$/.test(error.message)) throw error;
  throw Error("operator_webhook_signing_operation_failed");
}
async function lockActiveDestination(client: PoolClient, identity: AppIdentity, destinationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook-destination:' || $1 || ':' || $2 || ':' || $3,0))",
    [identity.tenantId,identity.appId,destinationId]);
  const destination = (await client.query<{ status: string; secret_ref: string }>(
    `SELECT status,secret_ref FROM control.operator_webhook_destinations_current
      WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`, [identity.tenantId,identity.appId,destinationId])).rows[0];
  if (!destination) throw Error("operator_webhook_destination_not_found");
  if (destination.status !== "active") throw Error("operator_webhook_destination_not_active");
  return destination;
}

export async function rotateOperatorWebhookSigningKey(options: SigningCommand): Promise<{
  destination_id: string; signing_revision: number; created_at: string; previous_valid_until: string; signing_secret: string;
}> {
  if (Object.keys(options.body).some(key => !["expected_revision", "overlap_seconds"].includes(key))) throw Error("operator_webhook_signing_fields_invalid");
  const expected = revisionNumber(options.body.expected_revision), seconds = options.body.overlap_seconds ?? 3600;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > 86400) throw Error("operator_webhook_signing_overlap_invalid");
  const now = options.now ?? new Date(), createdAt = commandTime(now), validUntil = new Date(now.valueOf() + seconds * 1000).toISOString();
  let secretRef: string | undefined;
  try {
    return await withTenant(options.pool, options.identity.tenantId, async client => {
      await lockActiveDestination(client, options.identity, options.destinationId);
      const current = await webhookSigningRevision(client, options.identity, options.destinationId, undefined, now);
      if (!current || current.signing_revision !== expected || expected >= Number.MAX_SAFE_INTEGER) throw Error("operator_webhook_signing_revision_stale");
      const previous = expected > 1 ? await webhookSigningRevision(client, options.identity, options.destinationId, expected - 1, now) : undefined;
      if (previous?.state === "overlap") throw Error("operator_webhook_signing_overlap_active");
      const signingSecret = randomBytes(32).toString("base64url"), revision = expected + 1;
      secretRef = await options.payloadStore.write({ tenantId: options.identity.tenantId, appId: options.identity.appId,
        objectId: `operator-webhook-signing-${options.destinationId}-${revision}` }, Buffer.from(signingSecret, "utf8"));
      await client.query(`INSERT INTO control.operator_webhook_signing_revisions
        (tenant_id,app_id,destination_id,signing_revision,secret_ref,created_at,previous_valid_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [options.identity.tenantId,options.identity.appId,options.destinationId,revision,secretRef,createdAt,validUntil]);
      await audit(client, { identity: options.identity, destinationId: options.destinationId, action: "operator_webhook_signing_key_rotated",
        occurredAt: createdAt, digest: requestDigest({ signing_revision: revision, previous_valid_until: validUntil }) });
      return { destination_id: options.destinationId, signing_revision: revision, created_at: createdAt,
        previous_valid_until: validUntil, signing_secret: signingSecret };
    });
  } catch (error) {
    if (secretRef) await purgeProtected(options.payloadStore, [secretRef]);
    return signingFailure(error);
  }
}

export async function retireOperatorWebhookSigningKey(options: SigningCommand): Promise<{
  destination_id: string; signing_revision: number; retired_at: string;
}> {
  if (Object.keys(options.body).some(key => !["expected_revision", "signing_revision"].includes(key))) throw Error("operator_webhook_signing_fields_invalid");
  const expected = revisionNumber(options.body.expected_revision), revision = revisionNumber(options.body.signing_revision);
  const now = options.now ?? new Date(), retiredAt = commandTime(now);
  let protectedRefs: string[] = [];
  let result: { destination_id: string; signing_revision: number; retired_at: string };
  try {
    result = await withTenant(options.pool, options.identity.tenantId, async client => {
      const destination = await lockActiveDestination(client, options.identity, options.destinationId);
      const current = await webhookSigningRevision(client, options.identity, options.destinationId, undefined, now);
      const target = await webhookSigningRevision(client, options.identity, options.destinationId, revision, now);
      if (!target) throw Error("operator_webhook_signing_revision_not_found");
      if (!target.retired_at) {
        if (!current || current.signing_revision !== expected) throw Error("operator_webhook_signing_revision_stale");
        if (revision === current.signing_revision) throw Error("operator_webhook_signing_current_required");
        await client.query(`INSERT INTO control.operator_webhook_signing_retirements
          (tenant_id,app_id,destination_id,signing_revision,retired_at) VALUES ($1,$2,$3,$4,$5)`,
          [options.identity.tenantId,options.identity.appId,options.destinationId,revision,retiredAt]);
        await audit(client, { identity: options.identity, destinationId: options.destinationId, action: "operator_webhook_signing_key_retired",
          occurredAt: retiredAt, digest: requestDigest({ signing_revision: revision }) });
      }
      protectedRefs = await suppressPending(client, options.identity, options.destinationId, now, "signing_key_retired", revision);
      // Legacy revision 1 shared this reference-HMAC key. Retirement revokes
      // signing authority, but must not destroy future stable references.
      if (target.secret_ref !== destination.secret_ref) protectedRefs.push(target.secret_ref);
      return { destination_id: options.destinationId, signing_revision: revision, retired_at: target.retired_at ?? retiredAt };
    });
  } catch (error) { return signingFailure(error); }
  await purgeProtected(options.payloadStore, protectedRefs);
  return result;
}

async function suppressPending(client: PoolClient, identity: AppIdentity, destinationId: string, now: Date,
    reason: "destination_disabled" | "signing_key_retired", revision: number | null = null): Promise<string[]> {
  const changedAt = now.toISOString();
  const pending = await client.query<{ delivery_id: string; request_ref: string; request_digest: string; attempts: number }>(
    `SELECT delivery_id::text,request_ref,request_digest,attempts FROM ephemeral.operator_webhook_deliveries
      WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state IN ('queued','retry')
        AND ($4::bigint IS NULL OR signing_revision=$4) ORDER BY delivery_id FOR UPDATE`,
    [identity.tenantId,identity.appId,destinationId,revision]);
  for (const row of pending.rows) {
    await client.query(`UPDATE ephemeral.operator_webhook_deliveries SET state='suppressed',safe_reason=$4,updated_at=$5
      WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3`, [identity.tenantId,identity.appId,row.delivery_id,reason,changedAt]);
    const artifact = { delivery_id: row.delivery_id, destination_id: destinationId, tenant_id: identity.tenantId, app_id: identity.appId,
      state: "suppressed", attempt: row.attempts, occurred_at: changedAt, request_digest: row.request_digest, reason_code: reason };
    await client.query(`INSERT INTO ledger.operator_webhook_delivery_results
      (delivery_result_id,delivery_id,tenant_id,app_id,destination_id,state,attempt,occurred_at,request_digest,reason_code,artifact)
      VALUES ($1,$2,$3,$4,$5,'suppressed',$6,$7,$8,$9,$10::jsonb)`,
      [uuidV7(now.valueOf() + row.attempts),row.delivery_id,identity.tenantId,identity.appId,destinationId,row.attempts,changedAt,row.request_digest,reason,JSON.stringify(artifact)]);
  }
  // Include prior suppressions so an interrupted post-commit purge can be retried.
  return (await client.query<{ request_ref: string }>(`SELECT request_ref FROM ephemeral.operator_webhook_deliveries
    WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state='suppressed' AND safe_reason=$4
      AND ($5::bigint IS NULL OR signing_revision=$5)`, [identity.tenantId,identity.appId,destinationId,reason,revision])).rows.map(row => row.request_ref);
}

export async function disableOperatorWebhookDestination(options: Readonly<{
  pool: Pool;
  payloadStore: PayloadStore;
  identity: AppIdentity;
  destinationId: string;
  now?: Date;
}>): Promise<{ readonly destination_id: string; readonly status: "disabled"; readonly changed_at: string }> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("operator_webhook_changed_at_invalid");
  const changedAt = now.toISOString();
  let effectiveChangedAt = changedAt;
  const protectedRefs = await withTenant(options.pool, options.identity.tenantId, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook-destination:' || $1 || ':' || $2 || ':' || $3,0))",
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    const selected = await client.query<{ status: string; secret_ref: string; status_changed_at: string }>(
      `SELECT current.status,current.status_changed_at,base.secret_ref
         FROM control.operator_webhook_destinations AS base
         JOIN control.operator_webhook_destinations_current AS current
           USING (destination_id,tenant_id,app_id)
        WHERE base.tenant_id=$1 AND base.app_id=$2 AND base.destination_id=$3`,
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    const destination = selected.rows[0];
    if (!destination) throw new Error("operator_webhook_destination_not_found");
    if (destination.status === "disabled") effectiveChangedAt = destination.status_changed_at;
    if (destination.status === "active") {
      await client.query(
        `INSERT INTO control.operator_webhook_destination_states (
           destination_id,tenant_id,app_id,status,changed_at,artifact
         ) VALUES ($1,$2,$3,'disabled',$4,$5::jsonb)`,
        [options.destinationId, options.identity.tenantId, options.identity.appId, changedAt,
          JSON.stringify({ destination_id: options.destinationId, status: "disabled", changed_at: changedAt })],
      );
      await audit(client, {
        identity: options.identity,
        destinationId: options.destinationId,
        action: "operator_webhook_destination_disabled",
        occurredAt: changedAt,
        digest: requestDigest({ destination_id: options.destinationId, status: "disabled" }),
      });
    }
    await suppressPending(client, options.identity, options.destinationId, now, "destination_disabled");
    const revisions = await client.query<{ secret_ref: string }>(`SELECT secret_ref FROM control.operator_webhook_signing_revisions
      WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3
      UNION ALL SELECT request_ref AS secret_ref FROM ephemeral.operator_webhook_deliveries
      WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3`, [options.identity.tenantId,options.identity.appId,options.destinationId]);
    return [destination.secret_ref, ...revisions.rows.map(row => row.secret_ref)];
  });
  await purgeProtected(options.payloadStore, protectedRefs);
  return { destination_id: options.destinationId, status: "disabled", changed_at: effectiveChangedAt };
}
