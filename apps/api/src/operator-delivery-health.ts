import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

export const operatorDeliveryStates = ["queued", "retry", "succeeded", "failed", "suppressed"] as const;
export type OperatorDeliveryState = typeof operatorDeliveryStates[number];

type Timestamp = Date | string;
type SummaryRow = {
  readonly state: OperatorDeliveryState;
  readonly total: string;
  readonly due_now: string;
  readonly scheduled: string;
};

export type OperatorDeliverySummary = {
  readonly total: number;
  readonly due_now: number;
  readonly scheduled: number;
  readonly by_state: Readonly<Record<OperatorDeliveryState, number>>;
};

export type OperatorWebhookHealthRow = {
  readonly delivery_id: string;
  readonly destination_id: string;
  readonly event_name: string;
  readonly state: OperatorDeliveryState;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly last_http_status: number | null;
  readonly safe_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type OperatorBulkExportHealthRow = {
  readonly batch_id: string;
  readonly destination_id: string;
  readonly row_count: number;
  readonly state: OperatorDeliveryState;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly last_http_status: number | null;
  readonly safe_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type OperatorDeliveryHealth = {
  readonly webhooks: {
    readonly summary: OperatorDeliverySummary;
    readonly deliveries: readonly OperatorWebhookHealthRow[];
  };
  readonly bulk_exports: {
    readonly summary: OperatorDeliverySummary;
    readonly batches: readonly OperatorBulkExportHealthRow[];
  };
  readonly maximum_rows_per_channel: number;
};

function canonicalTimestamp(value: Timestamp): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error("operator_delivery_timestamp_invalid");
  return parsed.toISOString();
}

function summarize(rows: readonly SummaryRow[]): OperatorDeliverySummary {
  const byState = Object.fromEntries(operatorDeliveryStates.map((state) => [state, 0])) as Record<OperatorDeliveryState, number>;
  let total = 0;
  let dueNow = 0;
  let scheduled = 0;
  for (const row of rows) {
    const count = Number(row.total);
    byState[row.state] = count;
    total += count;
    dueNow += Number(row.due_now);
    scheduled += Number(row.scheduled);
  }
  return { total, due_now: dueNow, scheduled, by_state: byState };
}

export async function operatorDeliveryHealth(
  pool: Pool,
  identity: AppAdminIdentity,
  maximumRows = 50,
): Promise<OperatorDeliveryHealth> {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 100) {
    throw new Error("operator_delivery_health_limit_invalid");
  }
  return withTenant(pool, identity.tenantId, async (client) => {
    const webhookSummary = await client.query<SummaryRow>(
      `SELECT state,
              count(state)::text AS total,
              count(state) FILTER (
                WHERE state IN ('queued','retry') AND next_attempt_at <= now()
              )::text AS due_now,
              count(state) FILTER (
                WHERE state IN ('queued','retry') AND next_attempt_at > now()
              )::text AS scheduled
         FROM ephemeral.operator_webhook_deliveries
        WHERE tenant_id=$1 AND app_id=$2
        GROUP BY state`,
      [identity.tenantId, identity.appId],
    );
    const webhooks = await client.query<{
      delivery_id: string;
      destination_id: string;
      event_name: string;
      state: OperatorDeliveryState;
      attempts: number;
      next_attempt_at: Timestamp;
      last_http_status: number | null;
      safe_reason: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT delivery_id, destination_id, event_name, state, attempts, next_attempt_at,
              last_http_status, safe_reason, created_at, updated_at
         FROM ephemeral.operator_webhook_deliveries
        WHERE tenant_id=$1 AND app_id=$2
        ORDER BY updated_at DESC, delivery_id DESC
        LIMIT $3`,
      [identity.tenantId, identity.appId, maximumRows],
    );
    const bulkSummary = await client.query<SummaryRow>(
      `SELECT state,
              count(state)::text AS total,
              count(state) FILTER (
                WHERE state IN ('queued','retry') AND next_attempt_at <= now()
              )::text AS due_now,
              count(state) FILTER (
                WHERE state IN ('queued','retry') AND next_attempt_at > now()
              )::text AS scheduled
         FROM ephemeral.operator_bulk_export_batches
        WHERE tenant_id=$1 AND app_id=$2
        GROUP BY state`,
      [identity.tenantId, identity.appId],
    );
    const bulkExports = await client.query<{
      batch_id: string;
      destination_id: string;
      row_count: number;
      state: OperatorDeliveryState;
      attempts: number;
      next_attempt_at: Timestamp;
      last_http_status: number | null;
      safe_reason: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT batch_id, destination_id, row_count, state, attempts, next_attempt_at,
              last_http_status, safe_reason, created_at, updated_at
         FROM ephemeral.operator_bulk_export_batches
        WHERE tenant_id=$1 AND app_id=$2
        ORDER BY updated_at DESC, batch_id DESC
        LIMIT $3`,
      [identity.tenantId, identity.appId, maximumRows],
    );
    return {
      webhooks: {
        summary: summarize(webhookSummary.rows),
        deliveries: webhooks.rows.map((row) => ({ ...row, next_attempt_at: canonicalTimestamp(row.next_attempt_at) })),
      },
      bulk_exports: {
        summary: summarize(bulkSummary.rows),
        batches: bulkExports.rows.map((row) => ({ ...row, next_attempt_at: canonicalTimestamp(row.next_attempt_at) })),
      },
      maximum_rows_per_channel: maximumRows,
    };
  });
}
