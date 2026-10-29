import type { PoolClient } from "pg";

type Scope = Readonly<{ tenantId: string; appId: string }>;
export type WebhookSigningStatus = Readonly<{
  signing_revision: number; created_at: string; valid_until: string | null; retired_at: string | null;
  state: "current" | "overlap" | "expired" | "retired";
}>;
export type WebhookSigningRevision = WebhookSigningStatus & Readonly<{ secret_ref: string }>;
type Row = { signing_revision: string; created_at: string; valid_until: string | null; retired_at: string | null };
const joins = `FROM control.operator_webhook_signing_revisions r
  LEFT JOIN control.operator_webhook_signing_revisions successor
    ON successor.tenant_id=r.tenant_id AND successor.app_id=r.app_id AND successor.destination_id=r.destination_id
      AND successor.signing_revision=r.signing_revision+1
  LEFT JOIN control.operator_webhook_signing_retirements retired
    ON retired.tenant_id=r.tenant_id AND retired.app_id=r.app_id AND retired.destination_id=r.destination_id
      AND retired.signing_revision=r.signing_revision
  WHERE r.tenant_id=$1 AND r.app_id=$2 AND r.destination_id=$3`;
const columns = "r.signing_revision::text,r.created_at,successor.previous_valid_until AS valid_until,retired.retired_at";

function status(row: Row, now: Date): WebhookSigningStatus {
  const revision = Number(row.signing_revision);
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(now.valueOf())) throw new Error("operator_webhook_signing_state_invalid");
  return { signing_revision: revision, created_at: row.created_at, valid_until: row.valid_until, retired_at: row.retired_at,
    state: row.retired_at ? "retired" : row.valid_until
      ? now.valueOf() >= Date.parse(row.valid_until) ? "expired" : "overlap" : "current" };
}

/** Writer-only protected reference lookup. Callers serialize activation/dispatch with the destination lock. */
export async function webhookSigningRevision(client: PoolClient, scope: Scope, destinationId: string,
  revision: number | undefined, now: Date): Promise<WebhookSigningRevision | undefined> {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) return undefined;
  const row = (await client.query<Row & { secret_ref: string }>(
    `SELECT ${columns},r.secret_ref ${joins} AND ($4::bigint IS NULL OR r.signing_revision=$4)
      ORDER BY r.signing_revision DESC LIMIT 1`, [scope.tenantId, scope.appId, destinationId, revision ?? null])).rows[0];
  return row ? { ...status(row, now), secret_ref: row.secret_ref } : undefined;
}

/** Reader-safe bounded history: the SQL does not select any protected reference. */
export async function listWebhookSigningRevisions(client: PoolClient, scope: Scope, destinationId: string,
  now: Date): Promise<readonly WebhookSigningStatus[]> {
  const rows = (await client.query<Row>(`SELECT ${columns} ${joins} ORDER BY r.signing_revision DESC LIMIT 50`,
    [scope.tenantId, scope.appId, destinationId])).rows;
  return rows.map(row => status(row, now));
}
