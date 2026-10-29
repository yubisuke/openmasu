import type { Pool, PoolClient } from "pg";
import { withTenant, normalizeCostBackfillRequest, costBackfillAsOf, costBackfillReceipt,
  type CostBackfillRequest, type CostBackfillPlan, type CostBackfillDay, type CostBackfillConfiguration } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

type Scope = AppAdminIdentity;
type Configuration = { cost_schedule_id: string; definition_digest: string; status: string;
  backfill_configuration: CostBackfillConfiguration; adapter_capability: unknown };
type Checkpoint = { state: string; pending_since: string | null; pending_until: string | null; safe_reason: string | null;
  last_since: string | null; last_until: string | null; last_outcome: string | null; last_import_run_id: string | null;
  last_success_at: string | null };
export type CostBackfillHistory = { receipt: string; cost_schedule_id: string; definition_digest: string; as_of: string;
  parent_receipt: string | null; created_at: string; days: { date: string; state: string; attempts: number; safe_reason: string | null;
    row_count: number | null; import_run_id: string | null }[] };
export type CostBackfillOverview = { schedules: Configuration[]; jobs: CostBackfillHistory[] };

async function configuration(client: PoolClient, scope: Scope, id: string): Promise<Configuration> {
  const row = (await client.query<Configuration>(`SELECT current.cost_schedule_id,current.definition_digest,current.status,
    current.adapter_capability,schedule.backfill_configuration FROM control.cost_schedules_current current
    JOIN control.cost_schedules schedule USING (tenant_id,app_id,cost_schedule_id)
    WHERE current.tenant_id=$1 AND current.app_id=$2 AND current.cost_schedule_id=$3`, [scope.tenantId, scope.appId, id])).rows[0];
  if (!row) throw new Error("cost_schedule_not_found");
  if (row.status !== "active") throw new Error("cost_schedule_not_active");
  if (!row.backfill_configuration || !["google_ads", "apple_ads"].includes(row.backfill_configuration.provider)
      || !Number.isSafeInteger(row.backfill_configuration.lag_days) || !row.backfill_configuration.limits) throw new Error("cost_backfill_configuration_unavailable");
  return row;
}

async function planWithClient(client: PoolClient, scope: Scope, request: CostBackfillRequest, asOf: string, now: Date): Promise<CostBackfillPlan> {
  const config = await configuration(client, scope, request.cost_schedule_id);
  const latest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    - config.backfill_configuration.lag_days * 86400000).toISOString().slice(0, 10);
  if (request.dates.at(-1)! > latest) throw new Error("cost_backfill_dates_not_eligible");
  if (request.retry_of) {
    const parent = (await client.query<{ as_of: string; definition_digest: string }>(`SELECT as_of,definition_digest FROM control.cost_backfills
      WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3 AND receipt=$4`,
    [scope.tenantId, scope.appId, request.cost_schedule_id, request.retry_of])).rows[0];
    if (!parent) throw new Error("cost_backfill_not_found");
    if (parent.definition_digest !== config.definition_digest) throw new Error("cost_backfill_configuration_changed");
    asOf = parent.as_of;
    const failed = await client.query<{ target_date: string }>(`SELECT target_date::text FROM control.cost_backfill_days
      WHERE tenant_id=$1 AND app_id=$2 AND receipt=$3 AND state='failed' AND target_date=ANY($4::date[])`,
    [scope.tenantId, scope.appId, request.retry_of, request.dates]);
    if (failed.rows.length !== request.dates.length) throw new Error("cost_backfill_retry_selection_invalid");
  }
  const checkpoint = (await client.query<Checkpoint>(`SELECT state,pending_since::text,pending_until::text,safe_reason,
    last_since::text,last_until::text,last_outcome,last_import_run_id,last_success_at FROM control.cost_schedule_checkpoints
    WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3`, [scope.tenantId, scope.appId, request.cost_schedule_id])).rows[0];
  const history = await client.query<{ date: string; state: string; row_count: number | null; import_run_id: string | null;
    safe_reason: string | null; receipt: string }>(`SELECT DISTINCT ON (day.target_date) day.target_date::text AS date,
      day.state,day.row_count,day.import_run_id,day.safe_reason,day.receipt FROM control.cost_backfill_days day
    JOIN control.cost_backfills job USING (tenant_id,app_id,cost_schedule_id,receipt)
    WHERE day.tenant_id=$1 AND day.app_id=$2 AND day.cost_schedule_id=$3 AND day.target_date=ANY($4::date[])
    ORDER BY day.target_date,job.created_at DESC,job.receipt COLLATE "C" DESC`, [scope.tenantId, scope.appId, request.cost_schedule_id, request.dates]);
  const days: CostBackfillDay[] = request.dates.map(date => {
    const row = history.rows.find(item => item.date === date);
    if (row) return { date, state: row.state, eligible: row.state === "failed", row_count: row.row_count,
      import_run_id: row.import_run_id, safe_reason: row.safe_reason, history_ref: row.receipt };
    if (checkpoint?.pending_since && checkpoint.pending_until && date >= checkpoint.pending_since && date <= checkpoint.pending_until
        && ["processing", "retry", "failed"].includes(checkpoint.state)) {
      return { date, state: checkpoint.state === "failed" ? "range_failed" : "range_pending", eligible: checkpoint.state === "failed",
        row_count: null, import_run_id: null, safe_reason: checkpoint.safe_reason, history_ref: `daily:${checkpoint.pending_since}:${checkpoint.pending_until}` };
    }
    if (checkpoint?.last_since && checkpoint.last_until && date >= checkpoint.last_since && date <= checkpoint.last_until && checkpoint.last_outcome) {
      return { date, state: checkpoint.last_outcome === "empty" ? "empty" : "acquired_range", eligible: false,
        row_count: checkpoint.last_outcome === "empty" ? 0 : null, import_run_id: checkpoint.last_import_run_id,
        safe_reason: null, history_ref: checkpoint.last_success_at };
    }
    return { date, state: "not_recorded", eligible: true, row_count: null, import_run_id: null, safe_reason: null, history_ref: null };
  });
  const plan = { ...request, definition_digest: config.definition_digest, as_of: asOf, configuration: config.backfill_configuration, days };
  const receipt = costBackfillReceipt(scope, plan);
  return { ...plan, receipt, confirmation: { ...request, as_of: asOf, receipt } };
}

export function previewCostBackfill(pool: Pool, scope: Scope, body: unknown, now = new Date()): Promise<CostBackfillPlan> {
  const request = normalizeCostBackfillRequest(body);
  return withTenant(pool, scope.tenantId, client => planWithClient(client, scope, request, now.toISOString(), now));
}

export async function confirmCostBackfill(pool: Pool, scope: Scope, body: Record<string, unknown>, now = new Date()) {
  const request = normalizeCostBackfillRequest(body, true), asOf = costBackfillAsOf(body.as_of, now);
  if (typeof body.receipt !== "string" || !/^[a-f0-9]{64}$/.test(body.receipt)) throw new Error("cost_backfill_receipt_invalid");
  return withTenant(pool, scope.tenantId, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([scope.tenantId, scope.appId, "cost-schedules"])]);
    const existing = (await client.query<{ plan: CostBackfillPlan }>(`SELECT plan FROM control.cost_backfills
      WHERE tenant_id=$1 AND app_id=$2 AND receipt=$3`, [scope.tenantId, scope.appId, body.receipt])).rows[0];
    if (existing) {
      const old = existing.plan.confirmation;
      if (old.cost_schedule_id !== request.cost_schedule_id || old.as_of !== asOf || old.retry_of !== request.retry_of
          || JSON.stringify(old.dates) !== JSON.stringify(request.dates)) throw new Error("cost_backfill_receipt_invalid");
      return { receipt: body.receipt, replayed: true };
    }
    // Also serialize against daily/backfill claim and completion, not only other HTTP confirmations.
    await client.query(`SELECT 1 FROM control.cost_schedule_checkpoints WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3 FOR UPDATE`,
      [scope.tenantId, scope.appId, request.cost_schedule_id]);
    const plan = await planWithClient(client, scope, request, asOf, now);
    if (plan.receipt !== body.receipt || plan.as_of !== asOf) throw new Error("cost_backfill_preview_stale");
    const selected = plan.days.filter(day => day.eligible);
    if (!selected.length) throw new Error("cost_backfill_no_eligible_days");
    await client.query(`INSERT INTO control.cost_backfills (receipt,tenant_id,app_id,cost_schedule_id,definition_digest,as_of,parent_receipt,plan)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [plan.receipt, scope.tenantId, scope.appId, request.cost_schedule_id,
      plan.definition_digest, plan.as_of, request.retry_of ?? null, JSON.stringify(plan)]);
    await client.query(`INSERT INTO control.cost_backfill_days (tenant_id,app_id,cost_schedule_id,receipt,target_date)
      SELECT $1,$2,$3,$4,day FROM unnest($5::date[]) day`, [scope.tenantId, scope.appId, request.cost_schedule_id, plan.receipt, selected.map(day => day.date)]);
    await recordDashboardAuditWithClient(client, { tenantId: scope.tenantId, appId: scope.appId, actorRef: `admin_key:${scope.keyId}`,
      action: "cost_backfill_confirmed", targetScope: "app", targetRef: plan.receipt, outcome: "succeeded", now });
    return { receipt: plan.receipt, replayed: false };
  });
}

export function listCostBackfills(pool: Pool, scope: Scope): Promise<CostBackfillOverview> {
  return withTenant(pool, scope.tenantId, async client => {
    const schedules = (await client.query<Configuration>(`SELECT current.cost_schedule_id,current.definition_digest,current.status,
      current.adapter_capability,schedule.backfill_configuration FROM control.cost_schedules_current current
      JOIN control.cost_schedules schedule USING (tenant_id,app_id,cost_schedule_id)
      WHERE current.tenant_id=$1 AND current.app_id=$2 ORDER BY current.created_at DESC,current.cost_schedule_id COLLATE "C" LIMIT 100`,
    [scope.tenantId, scope.appId])).rows;
    const jobs = (await client.query<CostBackfillHistory>(`SELECT job.receipt,job.cost_schedule_id,job.definition_digest,job.as_of,
      job.parent_receipt,job.created_at::text,COALESCE((SELECT jsonb_agg(jsonb_build_object('date',day.target_date::text,
        'state',day.state,'attempts',day.attempts,'safe_reason',day.safe_reason,'row_count',day.row_count,'import_run_id',day.import_run_id)
        ORDER BY day.target_date) FROM control.cost_backfill_days day WHERE day.tenant_id=job.tenant_id AND day.app_id=job.app_id
        AND day.receipt=job.receipt),'[]'::jsonb) AS days
      FROM control.cost_backfills job WHERE job.tenant_id=$1 AND job.app_id=$2
      ORDER BY job.created_at DESC,job.receipt COLLATE "C" LIMIT 20`, [scope.tenantId, scope.appId])).rows;
    return { schedules, jobs };
  });
}
