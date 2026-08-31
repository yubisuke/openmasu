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

export type OperatorWebhookDestination = Readonly<{
  destination_id: string;
  tenant_id: string;
  app_id: string;
  endpoint_url: string;
  events: readonly OperatorWebhookEventName[];
  status: "active" | "disabled";
  created_at: string;
  status_changed_at: string;
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
  const events = normalizeOperatorWebhookEvents(options.body.events);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("operator_webhook_created_at_invalid");
  const createdAt = now.toISOString();
  const destinationId = `webhook:${uuidV7(now.valueOf())}`;
  const signingSecret = randomBytes(32).toString("base64url");
  const secretRef = await options.payloadStore.write({
    tenantId: options.identity.tenantId,
    appId: options.identity.appId,
    objectId: `operator-webhook-secret-${destinationId}`,
  }, Buffer.from(signingSecret, "utf8"));
  try {
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
      };
    });
    return result;
  } catch (error) {
    await options.payloadStore.purge(secretRef);
    throw error;
  }
}

export async function listOperatorWebhookDestinations(
  pool: Pool,
  identity: AppIdentity,
): Promise<readonly OperatorWebhookDestination[]> {
  return withTenant(pool, identity.tenantId, async (client) => (await client.query<{
    destination_id: string;
    tenant_id: string;
    app_id: string;
    endpoint_url: string;
    events: OperatorWebhookEventName[];
    status: "active" | "disabled";
    created_at: string;
    status_changed_at: string;
  }>(
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
  )).rows);
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
  const protectedRefs = await withTenant(options.pool, options.identity.tenantId, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook-destination:' || $1 || ':' || $2 || ':' || $3,0))",
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    const selected = await client.query<{ status: string; secret_ref: string }>(
      `SELECT current.status,base.secret_ref
         FROM control.operator_webhook_destinations AS base
         JOIN control.operator_webhook_destinations_current AS current
           USING (destination_id,tenant_id,app_id)
        WHERE base.tenant_id=$1 AND base.app_id=$2 AND base.destination_id=$3`,
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    const destination = selected.rows[0];
    if (!destination) throw new Error("operator_webhook_destination_not_found");
    if (destination.status !== "active") throw new Error("operator_webhook_destination_not_active");
    await client.query(
      `INSERT INTO control.operator_webhook_destination_states (
         destination_id,tenant_id,app_id,status,changed_at,artifact
       ) VALUES ($1,$2,$3,'disabled',$4,$5::jsonb)`,
      [options.destinationId, options.identity.tenantId, options.identity.appId, changedAt,
        JSON.stringify({ destination_id: options.destinationId, status: "disabled", changed_at: changedAt })],
    );
    const pending = await client.query<{
      delivery_id: string;
      request_ref: string;
      request_digest: string;
      attempts: number;
    }>(
      `SELECT delivery_id::text,request_ref,request_digest,attempts
         FROM ephemeral.operator_webhook_deliveries
        WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND state IN ('queued','retry')
        ORDER BY delivery_id FOR UPDATE`,
      [options.identity.tenantId, options.identity.appId, options.destinationId],
    );
    for (const row of pending.rows) {
      await client.query(
        `UPDATE ephemeral.operator_webhook_deliveries
            SET state='suppressed',safe_reason='destination_disabled',updated_at=$4
          WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3`,
        [options.identity.tenantId, options.identity.appId, row.delivery_id, changedAt],
      );
      const artifact = {
        delivery_id: row.delivery_id,
        destination_id: options.destinationId,
        tenant_id: options.identity.tenantId,
        app_id: options.identity.appId,
        state: "suppressed",
        attempt: row.attempts,
        occurred_at: changedAt,
        request_digest: row.request_digest,
        reason_code: "destination_disabled",
      };
      await client.query(
        `INSERT INTO ledger.operator_webhook_delivery_results (
           delivery_result_id,delivery_id,tenant_id,app_id,destination_id,state,attempt,
           occurred_at,request_digest,reason_code,artifact
         ) VALUES ($1,$2,$3,$4,$5,'suppressed',$6,$7,$8,'destination_disabled',$9::jsonb)`,
        [uuidV7(now.valueOf() + row.attempts), row.delivery_id, options.identity.tenantId,
          options.identity.appId, options.destinationId, row.attempts, changedAt,
          row.request_digest, JSON.stringify(artifact)],
      );
    }
    await audit(client, {
      identity: options.identity,
      destinationId: options.destinationId,
      action: "operator_webhook_destination_disabled",
      occurredAt: changedAt,
      digest: requestDigest({ destination_id: options.destinationId, status: "disabled" }),
    });
    return [destination.secret_ref, ...pending.rows.map((row) => row.request_ref)];
  });
  for (const reference of protectedRefs) await options.payloadStore.purge(reference);
  return { destination_id: options.destinationId, status: "disabled", changed_at: changedAt };
}
