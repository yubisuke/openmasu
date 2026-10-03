import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import {
  costRefreshRange, costRefreshSecretName, normalizeCostRefreshDefinition, uuidV7, withTenant,
  type CostRefreshDefinition, type SecretStore,
} from "@openmasu/runtime";
import { fetchGoogleAds, type FetchLike } from "./import/adapters.js";
import { persistCostImportWithClient, type CostInput } from "./import/cost.js";

type Claim = {
  cost_schedule_id: string; tenant_id: string; app_id: string;
  definition: CostRefreshDefinition; definition_digest: string;
  since: string; until: string; as_of: string; token: string; attempts: number;
};

async function claimRefresh(pool: Pool, tenantId: string, now: Date): Promise<Claim | null> {
  return withTenant(pool, tenantId, async (client) => {
    // A process killed during its final attempt still reaches a bounded terminal
    // state after lease expiry; it cannot remain a permanently invisible claim.
    await client.query(
      `UPDATE control.cost_schedule_checkpoints SET state='failed',safe_reason='retry_exhausted',
         lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND state='processing' AND attempts=3 AND lease_expires_at<=clock_timestamp()`, [tenantId],
    );
    const selected = await client.query<{
      cost_schedule_id: string; app_id: string; definition: CostRefreshDefinition; definition_digest: string;
      last_target_date: string | null; pending_since: string | null; pending_until: string | null;
      pending_as_of: string | null; pending_definition_digest: string | null; attempts: number;
    }>(
      `SELECT checkpoint.cost_schedule_id,checkpoint.app_id,schedule.definition,schedule.definition_digest,
         checkpoint.last_target_date::text,checkpoint.pending_since::text,checkpoint.pending_until::text,
         checkpoint.pending_as_of,checkpoint.pending_definition_digest,checkpoint.attempts
       FROM control.cost_schedule_checkpoints AS checkpoint
       JOIN control.cost_schedules AS schedule USING (tenant_id,app_id,cost_schedule_id)
       JOIN control.cost_schedules_current AS current USING (tenant_id,app_id,cost_schedule_id)
       WHERE checkpoint.tenant_id=$1 AND current.status='active'
         AND checkpoint.state IN ('idle','retry','processing')
         AND checkpoint.next_attempt_at<=clock_timestamp() AND checkpoint.next_run_at<=clock_timestamp()
         AND (checkpoint.lease_expires_at IS NULL OR checkpoint.lease_expires_at<=clock_timestamp())
         AND (checkpoint.pending_since IS NULL OR checkpoint.attempts<3)
       ORDER BY checkpoint.next_run_at,checkpoint.cost_schedule_id COLLATE "C"
       LIMIT 1 FOR UPDATE OF checkpoint SKIP LOCKED`, [tenantId],
    );
    const row = selected.rows[0];
    if (!row) return null;
    const definition = normalizeCostRefreshDefinition(row.definition);
    if (sha256(definition) !== row.definition_digest
      || (row.pending_definition_digest && row.pending_definition_digest !== row.definition_digest)) {
      throw new Error("cost_schedule_definition_digest_mismatch");
    }
    const range = row.pending_since ? { since: row.pending_since, until: row.pending_until! } : costRefreshRange(now, definition);
    if (!row.pending_since && row.last_target_date && range.until <= row.last_target_date) {
      await client.query(
        `UPDATE control.cost_schedule_checkpoints SET next_run_at=clock_timestamp()+interval '1 hour'
         WHERE tenant_id=$1 AND cost_schedule_id=$2`, [tenantId, row.cost_schedule_id],
      );
      return null;
    }
    const asOf = row.pending_as_of ?? now.toISOString();
    const token = uuidV7();
    const attempts = row.pending_since ? row.attempts + 1 : 1;
    await client.query(
      `UPDATE control.cost_schedule_checkpoints SET state='processing',pending_since=$3::date,pending_until=$4::date,
         pending_as_of=$5,pending_definition_digest=$6,attempts=$7,lease_token=$8,
         lease_expires_at=clock_timestamp()+interval '120 seconds',safe_reason=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND cost_schedule_id=$2`,
      [tenantId, row.cost_schedule_id, range.since, range.until, asOf, row.definition_digest, attempts, token],
    );
    return { cost_schedule_id: row.cost_schedule_id, tenant_id: tenantId, app_id: row.app_id,
      definition, definition_digest: row.definition_digest, ...range, as_of: asOf, token, attempts };
  });
}

function sourceFailure(error: unknown): { reason: string; retry: boolean } {
  const message = error instanceof Error ? error.message : "";
  if (message === "cost_acquisition_timeout") return { reason: "acquisition_timeout", retry: true };
  if (message === "cost_source_credentials_missing") return { reason: "source_rejected", retry: false };
  const status = /request failed with ([0-9]{3})$/.exec(message);
  if (status && ![408, 429].includes(Number(status[1])) && Number(status[1]) < 500) {
    return { reason: "source_rejected", retry: false };
  }
  if (status || /request failed$/.test(message)) return { reason: "source_unavailable", retry: true };
  return { reason: "source_invalid", retry: false };
}

async function acquire(claim: Claim, secrets: SecretStore, fetcher: FetchLike, timeoutMs: number): Promise<CostInput[]> {
  const scoped: SecretStore = {
    read: (name) => secrets.read(costRefreshSecretName(claim.tenant_id, claim.app_id,
      name === "OPENMASU_GOOGLE_ADS_ACCESS_TOKEN" ? "access_token" : "developer_token")),
    require(name) {
      const value = this.read(name);
      if (!value) throw new Error("cost_source_credentials_missing");
      return value;
    },
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("cost_acquisition_timeout")); }, timeoutMs);
    });
    return await Promise.race([deadline, fetchGoogleAds({
      fetch: (input, init) => fetcher(input, { ...init, signal: controller.signal }), secrets: scoped,
      customerId: claim.definition.customer_id, loginCustomerId: claim.definition.login_customer_id,
      apiVersion: claim.definition.api_version, limits: claim.definition.limits,
      since: claim.since, until: claim.until,
      scope: { tenant_id: claim.tenant_id, app_id: claim.app_id, currency: claim.definition.currency, as_of: claim.as_of },
    })]);
  } finally { clearTimeout(timer!); }
}

async function failClaim(pool: Pool, claim: Claim, error: unknown): Promise<boolean> {
  const failure = sourceFailure(error);
  const exhausted = failure.retry && claim.attempts >= 3;
  return withTenant(pool, claim.tenant_id, async (client) => (await client.query(
    `UPDATE control.cost_schedule_checkpoints SET state=$4,safe_reason=$5,lease_token=NULL,lease_expires_at=NULL,
       next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND cost_schedule_id=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp()`,
    [claim.tenant_id, claim.cost_schedule_id, claim.token, failure.retry && !exhausted ? "retry" : "failed",
      exhausted ? "retry_exhausted" : failure.reason],
  )).rowCount === 1);
}

async function completeClaim(pool: Pool, claim: Claim, rows: readonly CostInput[]): Promise<boolean> {
  return withTenant(pool, claim.tenant_id, async (client) => {
    const current = await client.query(
      `SELECT 1 FROM control.cost_schedule_checkpoints AS checkpoint
       JOIN control.cost_schedules_current AS schedule USING (tenant_id,app_id,cost_schedule_id)
       WHERE checkpoint.tenant_id=$1 AND checkpoint.cost_schedule_id=$2 AND checkpoint.lease_token=$3
         AND checkpoint.lease_expires_at>clock_timestamp() AND schedule.status='active'
         AND schedule.definition_digest=$4 AND checkpoint.pending_definition_digest=$4
       FOR UPDATE OF checkpoint`, [claim.tenant_id, claim.cost_schedule_id, claim.token, claim.definition_digest],
    );
    if (!current.rowCount) return false;
    const imported = rows.length > 0
      ? await persistCostImportWithClient(client, `cost-refresh:${claim.cost_schedule_id}`, rows) : null;
    await client.query(
      `UPDATE control.cost_schedule_checkpoints SET state='idle',last_target_date=$3::date,
         last_success_at=$4,last_since=$5::date,last_until=$3::date,last_outcome=$6,last_row_count=$7,
         last_snapshot_digest=$8,last_import_run_id=$9,pending_since=NULL,pending_until=NULL,
         pending_as_of=NULL,pending_definition_digest=NULL,lease_token=NULL,lease_expires_at=NULL,
         attempts=0,safe_reason=NULL,next_run_at=clock_timestamp()+interval '1 day',
         next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND cost_schedule_id=$2`,
      [claim.tenant_id, claim.cost_schedule_id, claim.until, new Date().toISOString(), claim.since,
        imported ? "complete" : "empty", rows.length, imported ? sha256(rows) : null, imported?.import_run_id ?? null],
    );
    return true;
  });
}

export async function processCostRefreshes(pool: Pool, tenantId: string, options: Readonly<{
  enabled: boolean; secrets: SecretStore; fetch?: FetchLike; now?: Date; timeoutMs?: number; maximumSchedules?: number;
}>): Promise<Readonly<{ completed: number; empty: number; failed: number; fenced: number }>> {
  const result = { completed: 0, empty: 0, failed: 0, fenced: 0 };
  if (!options.enabled) return result;
  const maximum = options.maximumSchedules ?? 10;
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("cost_refresh_limit_invalid");
  for (let index = 0; index < maximum; index += 1) {
    const claim = await claimRefresh(pool, tenantId, options.now ?? new Date());
    if (!claim) break;
    let rows: CostInput[];
    try { rows = await acquire(claim, options.secrets, options.fetch ?? fetch, timeout); }
    catch (error) {
      if (await failClaim(pool, claim, error)) result.failed += 1;
      else result.fenced += 1;
      continue;
    }
    if (!await completeClaim(pool, claim, rows)) result.fenced += 1;
    else if (rows.length === 0) result.empty += 1;
    else result.completed += 1;
  }
  return result;
}
