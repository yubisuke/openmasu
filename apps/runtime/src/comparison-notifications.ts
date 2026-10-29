import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { jcs } from "@openmasu/attribution-core/canonical";
import { uuidV7, withTenant } from "./index.js";
import { acquirePrivacyTenantXactFence } from "./privacy-fence.js";
import { comparisonPrivacyEpoch } from "./fixed-comparison.js";
import { operatorWebhookReference } from "./webhook-security.js";
import type { PayloadStore } from "./payload-store.js";

export const comparisonNotificationStates = ["within_threshold", "threshold_exceeded", "missing_input", "incomparable", "unknown"] as const;
export type ComparisonNotificationState = typeof comparisonNotificationStates[number];
type Scope = { tenantId: string; appId: string };
type Setting = { comparison_id: string; destination_id: string; enabled: boolean; muted: boolean; cooldown_seconds: number;
  observed_state: ComparisonNotificationState | null; last_enqueued_state: ComparisonNotificationState | null;
  last_enqueued_at: Date | null; sequence: string };
export function notificationTransition(state: ComparisonNotificationState, previous: ComparisonNotificationState | null,
    lastAt: Date | null, now: Date, cooldownSeconds: number): "attention" | "recovered" | undefined {
  if (state === previous || (state === "within_threshold" && previous === null)) return undefined;
  if (lastAt && now.valueOf() - lastAt.valueOf() < cooldownSeconds * 1000) return undefined;
  return state === "within_threshold" ? "recovered" : "attention";
}
export function comparisonNotificationBody(input: { deliveryId: string; appId: string; comparisonId: string; runId: string;
    date: string; state: ComparisonNotificationState; previous: ComparisonNotificationState | null;
    transition: "attention" | "recovered"; now: Date }, secret: Buffer): Buffer {
  return Buffer.from(jcs({ schema: "openmasu.comparison_notification.v1", delivery_id: input.deliveryId,
    emitted_at: input.now.toISOString(), app_id: input.appId,
    comparison_ref: operatorWebhookReference(secret, "comparison_ref", input.comparisonId),
    result_ref: operatorWebhookReference(secret, "comparison_result", input.runId),
    target_date: input.date, state: input.state, transition: input.transition,
    ...(input.previous ? { previous_state: input.previous } : {}) }), "utf8");
}
export async function lockComparisonNotifications(client: PoolClient, tenantId: string) {
  await acquirePrivacyTenantXactFence(client, tenantId, "shared");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`comparison:${tenantId}`]);
}
async function lockDestination(client: PoolClient, scope: Scope, destinationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-webhook-destination:' || $1 || ':' || $2 || ':' || $3,0))",
    [scope.tenantId, scope.appId, destinationId]);
}
async function privacyCurrent(client: PoolClient, tenantId: string, epoch: string) {
  const backlog = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
  return backlog.rows[0]?.pending_count === "0" && await comparisonPrivacyEpoch(client, tenantId) === epoch;
}
/** Configuration never accepts a URL or secret: use an explicitly registered comparison-only destination. */
export async function configureComparisonNotifications(pool: Pool, scope: Scope, input: Record<string, unknown>, now = new Date()) {
  if (Object.keys(input).sort().join(",") !== "comparison_id,cooldown_seconds,destination_id,enabled,muted"
      || typeof input.comparison_id !== "string" || typeof input.destination_id !== "string"
      || input.comparison_id.length > 256 || input.destination_id.length > 256
      || typeof input.enabled !== "boolean" || typeof input.muted !== "boolean"
      || !Number.isInteger(input.cooldown_seconds) || Number(input.cooldown_seconds) < 60 || Number(input.cooldown_seconds) > 86400)
    throw Error("comparison_notification_settings_invalid");
  return withTenant(pool, scope.tenantId, async client => {
    await lockComparisonNotifications(client, scope.tenantId);
    await lockDestination(client, scope, input.destination_id as string);
    const revision = (await client.query<{ privacy_epoch: string }>(`SELECT privacy_epoch FROM control.comparison_definitions
      WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3 AND active AND deleted_at IS NULL`,
      [scope.tenantId,scope.appId,input.comparison_id])).rows[0];
    if (!revision || !await privacyCurrent(client, scope.tenantId, revision.privacy_epoch)) throw Error("comparison_not_available");
    const destination = await client.query(`SELECT destination_id FROM control.operator_webhook_destinations_current
      WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND status='active' AND cardinality(allowed_events)=0`,
      [scope.tenantId,scope.appId,input.destination_id]);
    if (!destination.rowCount) throw Error("comparison_notification_destination_unavailable");
    await client.query(`INSERT INTO control.comparison_notifications(tenant_id,app_id,comparison_id,destination_id,enabled,muted,cooldown_seconds,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(comparison_id) DO UPDATE SET
      destination_id=excluded.destination_id,enabled=excluded.enabled,muted=excluded.muted,cooldown_seconds=excluded.cooldown_seconds,
      last_enqueued_state=CASE WHEN comparison_notifications.destination_id<>excluded.destination_id THEN NULL ELSE comparison_notifications.last_enqueued_state END,
      updated_at=excluded.updated_at`, [scope.tenantId,scope.appId,input.comparison_id,input.destination_id,input.enabled,input.muted,input.cooldown_seconds,now.toISOString()]);
    return { comparison_id: input.comparison_id, configured: true };
  });
}
/** Called while holding the shared tenant privacy and comparison locks. No writes and no raw-record lookup. */
export async function comparisonNotificationEligible(client: PoolClient, scope: Scope, deliveryId: string, now: Date): Promise<boolean> {
  const row = (await client.query<{ comparison_epoch: string }>(`SELECT q.comparison_epoch FROM ephemeral.operator_webhook_deliveries q
    JOIN control.comparison_notifications n ON n.tenant_id=q.tenant_id AND n.app_id=q.app_id AND n.comparison_id=q.comparison_id
    JOIN control.comparison_definitions d ON d.tenant_id=q.tenant_id AND d.app_id=q.app_id AND d.comparison_id=q.comparison_id
    JOIN LATERAL (SELECT r.run_id,r.result->>'state' AS state FROM control.comparison_runs r
      WHERE r.tenant_id=q.tenant_id AND r.app_id=q.app_id AND r.comparison_id=q.comparison_id AND r.expires_at>$4
      ORDER BY r.target_date DESC,r.created_at DESC,r.run_id DESC LIMIT 1) latest ON true
    WHERE q.tenant_id=$1 AND q.app_id=$2 AND q.delivery_id=$3 AND n.enabled AND NOT n.muted
      AND n.destination_id=q.destination_id AND d.active AND d.deleted_at IS NULL
      AND q.comparison_sequence=n.sequence
      AND d.privacy_epoch=q.comparison_epoch AND latest.state=q.comparison_state
      AND EXISTS(SELECT 1 FROM control.comparison_runs source WHERE source.tenant_id=q.tenant_id AND source.app_id=q.app_id
        AND source.run_id=q.comparison_run_id AND source.expires_at>$4)`, [scope.tenantId,scope.appId,deliveryId,now.toISOString()])).rows[0];
  return Boolean(row && await privacyCurrent(client, scope.tenantId, row.comparison_epoch));
}
/** At most twenty active comparison revisions per tenant; retries are owned by the existing webhook outbox. */
export async function discoverComparisonNotifications(pool: Pool, payloadStore: PayloadStore, tenantId: string, now = new Date()): Promise<number> {
  const candidates = await withTenant(pool, tenantId, client => client.query<{ app_id: string; comparison_id: string }>(
    `SELECT n.app_id,n.comparison_id FROM control.comparison_notifications n JOIN control.comparison_definitions d USING(tenant_id,app_id,comparison_id)
      WHERE n.tenant_id=$1 AND n.enabled AND d.active AND d.deleted_at IS NULL ORDER BY n.comparison_id LIMIT 100`, [tenantId]));
  let queued = 0;
  for (const candidate of candidates.rows) {
    let written: string | undefined;
    try {
      const inserted = await withTenant(pool, tenantId, async client => {
        await lockComparisonNotifications(client, tenantId);
        const row = (await client.query<Setting & { privacy_epoch: string; secret_ref: string; run_id: string; target_date: string; state: ComparisonNotificationState }>(
          `SELECT n.*,d.privacy_epoch,w.secret_ref,r.run_id,r.target_date::text,r.result->>'state' AS state
          FROM control.comparison_notifications n JOIN control.comparison_definitions d USING(tenant_id,app_id,comparison_id)
          JOIN control.operator_webhook_destinations_current w ON w.tenant_id=n.tenant_id AND w.app_id=n.app_id AND w.destination_id=n.destination_id
          JOIN LATERAL (SELECT run_id,target_date,result FROM control.comparison_runs
            WHERE tenant_id=n.tenant_id AND app_id=n.app_id AND comparison_id=n.comparison_id AND expires_at>$4
            ORDER BY target_date DESC,created_at DESC,run_id DESC LIMIT 1) r ON true
          WHERE n.tenant_id=$1 AND n.app_id=$2 AND n.comparison_id=$3 AND n.enabled AND d.active AND d.deleted_at IS NULL
            AND w.status='active' AND cardinality(w.allowed_events)=0 FOR UPDATE OF n`,
          [tenantId,candidate.app_id,candidate.comparison_id,now.toISOString()])).rows[0];
        if (!row || !comparisonNotificationStates.includes(row.state) || !await privacyCurrent(client, tenantId, row.privacy_epoch)) return false;
        const scope = { tenantId, appId: candidate.app_id };
        await lockDestination(client, scope, row.destination_id);
        // Recheck after destination locking: disabling waits on this same lock.
        if (!(await client.query(`SELECT 1 FROM control.operator_webhook_destinations_current WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND status='active'`,
          [tenantId,scope.appId,row.destination_id])).rowCount) return false;
        await client.query("UPDATE control.comparison_notifications SET observed_state=$4,updated_at=$5 WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3",
          [tenantId,scope.appId,row.comparison_id,row.state,now.toISOString()]);
        const transition = row.muted ? undefined : notificationTransition(row.state,row.last_enqueued_state,row.last_enqueued_at,now,row.cooldown_seconds);
        if (!transition) return false;
        const deliveryId = uuidV7(now.valueOf()), sequence = (BigInt(row.sequence)+1n).toString();
        const secret = await payloadStore.read(row.secret_ref);
        const body = comparisonNotificationBody({ deliveryId,appId:scope.appId,comparisonId:row.comparison_id,runId:row.run_id,
          date:row.target_date,state:row.state,previous:row.last_enqueued_state,transition,now },secret);
        written = await payloadStore.write({ ...scope,objectId:`comparison-notification-${deliveryId}` },body);
        await client.query(`INSERT INTO ephemeral.operator_webhook_deliveries(delivery_id,tenant_id,app_id,destination_id,event_name,
          request_ref,request_digest,state,attempts,next_attempt_at,created_at,updated_at,
          comparison_id,comparison_run_id,comparison_epoch,comparison_state,comparison_sequence)
          VALUES ($1,$2,$3,$4,'comparison_state_changed',$5,$6,'queued',0,$7,$13,$14,$8,$9,$10,$11,$12)`,
          [deliveryId,tenantId,scope.appId,row.destination_id,written,createHash("sha256").update(body).digest("hex"),now.toISOString(),row.comparison_id,row.run_id,row.privacy_epoch,row.state,sequence,
            now.toISOString(),now.toISOString()]);
        await client.query(`UPDATE control.comparison_notifications SET last_enqueued_state=$4,last_enqueued_at=$5,sequence=$6
          WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3`,[tenantId,scope.appId,row.comparison_id,row.state,now.toISOString(),sequence]);
        return true;
      });
      if (inserted) queued++;
    } catch {
      if (written) {
        try { await payloadStore.purge(written); } catch { throw Error("comparison_notification_cleanup_failed"); }
      }
      throw Error("comparison_notification_enqueue_failed");
    }
  }
  return queued;
}
