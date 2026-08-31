import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

export const googleDeliveryStates = [
  "queued",
  "http_accepted",
  "diagnostics_processing",
  "succeeded",
  "partial_success",
  "failed",
  "expired",
] as const;

export type GoogleDeliveryState = typeof googleDeliveryStates[number];

export type GoogleDeliveryHealthRow = {
  readonly delivery_id: string;
  readonly state: GoogleDeliveryState;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly diagnostics_deadline_at: string | null;
  readonly safe_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type GoogleDeliveryHealth = {
  readonly destination: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly next_request_at: string | null;
  };
  readonly summary: {
    readonly total: number;
    readonly due_now: number;
    readonly scheduled: number;
    readonly by_state: Readonly<Record<GoogleDeliveryState, number>>;
  };
  readonly deliveries: readonly GoogleDeliveryHealthRow[];
  readonly maximum_rows: number;
};

type Timestamp = Date | string;

function canonicalTimestamp(value: Timestamp | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error("google_delivery_timestamp_invalid");
  return parsed.toISOString();
}

export async function googleDeliveryHealth(
  pool: Pool,
  identity: AppAdminIdentity,
  maximumRows = 50,
): Promise<GoogleDeliveryHealth> {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 100) {
    throw new Error("google_delivery_health_limit_invalid");
  }
  return withTenant(pool, identity.tenantId, async (client) => {
    const destination = await client.query<{
      enabled: boolean;
      next_request_at: Timestamp | null;
    }>(
      `SELECT enabled,
              CASE WHEN next_request_at='-infinity'::timestamptz THEN NULL
                   ELSE next_request_at END AS next_request_at
         FROM control.google_data_manager_destinations
        WHERE tenant_id=$1 AND app_id=$2`,
      [identity.tenantId, identity.appId],
    );
    const summary = await client.query<{
      state: GoogleDeliveryState;
      total: string;
      due_now: string;
      scheduled: string;
    }>(
      `SELECT state,
              count(state)::text AS total,
              count(state) FILTER (
                WHERE state IN ('queued','http_accepted','diagnostics_processing')
                  AND next_attempt_at <= now()
              )::text AS due_now,
              count(state) FILTER (
                WHERE state IN ('queued','http_accepted','diagnostics_processing')
                  AND next_attempt_at > now()
              )::text AS scheduled
         FROM ephemeral.google_conversion_deliveries
        WHERE tenant_id=$1 AND app_id=$2
        GROUP BY state`,
      [identity.tenantId, identity.appId],
    );
    const rows = await client.query<{
      delivery_id: string;
      state: GoogleDeliveryState;
      attempts: number;
      next_attempt_at: Timestamp;
      diagnostics_deadline_at: Timestamp | null;
      safe_reason: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT delivery_id, state, attempts, next_attempt_at,
              diagnostics_deadline_at, safe_reason, created_at, updated_at
         FROM ephemeral.google_conversion_deliveries
        WHERE tenant_id=$1 AND app_id=$2
        ORDER BY updated_at DESC, delivery_id DESC
        LIMIT $3`,
      [identity.tenantId, identity.appId, maximumRows],
    );
    const byState = Object.fromEntries(googleDeliveryStates.map((state) => [state, 0])) as Record<GoogleDeliveryState, number>;
    let total = 0;
    let dueNow = 0;
    let scheduled = 0;
    for (const row of summary.rows) {
      const count = Number(row.total);
      byState[row.state] = count;
      total += count;
      dueNow += Number(row.due_now);
      scheduled += Number(row.scheduled);
    }
    const configured = destination.rows[0];
    return {
      destination: configured ? {
        configured: true,
        enabled: configured.enabled,
        next_request_at: canonicalTimestamp(configured.next_request_at),
      } : { configured: false, enabled: false, next_request_at: null },
      summary: { total, due_now: dueNow, scheduled, by_state: byState },
      deliveries: rows.rows.map((row) => ({
        delivery_id: row.delivery_id,
        state: row.state,
        attempts: row.attempts,
        next_attempt_at: canonicalTimestamp(row.next_attempt_at)!,
        diagnostics_deadline_at: canonicalTimestamp(row.diagnostics_deadline_at),
        safe_reason: row.safe_reason,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      maximum_rows: maximumRows,
    };
  });
}
