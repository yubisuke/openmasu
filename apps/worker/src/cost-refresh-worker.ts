import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import {
  costRefreshRange, normalizeCostRefreshDefinition, uuidV7, withTenant,
  EnvironmentSecretStore, type CostRefreshDefinition, type SecretStore,
} from "@openmasu/runtime";
import { fetchGoogleAds, type FetchLike } from "./import/adapters.js";
import { fetchAppleAds } from "./import/apple-cost.js";
import { persistCostImportWithClient, type CostInput } from "./import/cost.js";
import { CostRefreshAuth, CostRefreshAuthError } from "./cost-refresh-auth.js";

const sharedAuthentication = new CostRefreshAuth();

type Claim = {
  cost_schedule_id: string; tenant_id: string; app_id: string;
  definition: CostRefreshDefinition; definition_digest: string;
  since: string; until: string; as_of: string; token: string; attempts: number;
  backfill_receipt?: string;
};

async function claimBackfill(pool: Pool, tenantId: string): Promise<Claim | null> {
  return withTenant(pool, tenantId, async client => {
    const row = (await client.query<{ cost_schedule_id: string; app_id: string; definition: CostRefreshDefinition;
      definition_digest: string; expected_digest: string; receipt: string; target_date: string; as_of: string; attempts: number;
      last_since: string | null; last_until: string | null; last_success_at: string | null; last_outcome: string | null }>(`
      SELECT checkpoint.cost_schedule_id,checkpoint.app_id,schedule.definition,schedule.definition_digest,
        job.definition_digest AS expected_digest,day.receipt,day.target_date::text,job.as_of,day.attempts,
        checkpoint.last_since::text,checkpoint.last_until::text,checkpoint.last_success_at,checkpoint.last_outcome
      FROM control.cost_schedule_checkpoints checkpoint
      JOIN control.cost_schedules schedule USING (tenant_id,app_id,cost_schedule_id)
      JOIN control.cost_schedules_current current USING (tenant_id,app_id,cost_schedule_id)
      JOIN control.cost_backfill_days day USING (tenant_id,app_id,cost_schedule_id)
      JOIN control.cost_backfills job USING (tenant_id,app_id,cost_schedule_id,receipt)
      WHERE checkpoint.tenant_id=$1 AND current.status='active' AND day.state IN ('queued','retry','processing')
        AND day.next_attempt_at<=clock_timestamp()
        AND (checkpoint.lease_expires_at IS NULL OR checkpoint.lease_expires_at<=clock_timestamp())
        AND (checkpoint.backfill_receipt IS NULL OR (checkpoint.backfill_receipt=day.receipt AND checkpoint.backfill_day=day.target_date))
        AND (checkpoint.state<>'processing' OR checkpoint.backfill_receipt IS NOT NULL)
      ORDER BY job.created_at,day.target_date,day.receipt COLLATE "C" LIMIT 1 FOR UPDATE OF checkpoint,day SKIP LOCKED`, [tenantId])).rows[0];
    if (!row) return null;
    const definition = normalizeCostRefreshDefinition(row.definition);
    const scope = [tenantId, row.app_id, row.cost_schedule_id];
    const finishedElsewhere = row.last_since && row.last_until && row.target_date >= row.last_since && row.target_date <= row.last_until
      && row.last_success_at && row.last_success_at >= row.as_of && row.last_outcome !== null;
    const reason = sha256(definition) !== row.expected_digest || row.definition_digest !== row.expected_digest ? "configuration_changed"
      : row.attempts >= 3 ? "retry_exhausted" : finishedElsewhere ? "covered_by_refresh" : null;
    if (reason) {
      await client.query(`UPDATE control.cost_backfill_days SET state=$6,safe_reason=$7,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3 AND receipt=$4 AND target_date=$5::date`,
      [...scope, row.receipt, row.target_date, reason === "covered_by_refresh" ? "skipped" : "failed", reason]);
      await client.query(`UPDATE control.cost_schedule_checkpoints SET backfill_receipt=NULL,backfill_day=NULL,
        lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3
        AND backfill_receipt=$4 AND backfill_day=$5::date`, [...scope, row.receipt, row.target_date]);
      return null;
    }
    const token = uuidV7(), attempts = row.attempts + 1;
    await client.query(`UPDATE control.cost_schedule_checkpoints SET backfill_receipt=$4,backfill_day=$5::date,
      lease_token=$6,lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3`, [...scope, row.receipt, row.target_date, token]);
    await client.query(`UPDATE control.cost_backfill_days SET state='processing',attempts=$6,safe_reason=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3 AND receipt=$4 AND target_date=$5::date`,
    [...scope, row.receipt, row.target_date, attempts]);
    return { cost_schedule_id: row.cost_schedule_id, tenant_id: tenantId, app_id: row.app_id, definition,
      definition_digest: row.definition_digest, since: row.target_date, until: row.target_date,
      as_of: row.as_of, token, attempts, backfill_receipt: row.receipt };
  });
}

async function claimRefresh(pool: Pool, tenantId: string, now: Date): Promise<Claim | null> {
  return withTenant(pool, tenantId, async (client) => {
    // A process killed during its final attempt still reaches a bounded terminal
    // state after lease expiry; it cannot remain a permanently invisible claim.
    await client.query(
      `UPDATE control.cost_schedule_checkpoints SET state='failed',safe_reason='retry_exhausted',
         lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND backfill_receipt IS NULL AND state='processing' AND attempts=3 AND lease_expires_at<=clock_timestamp()`, [tenantId],
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
         AND checkpoint.backfill_receipt IS NULL
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
  if (error instanceof CostRefreshAuthError) return { reason: error.reason, retry: error.retry };
  const message = error instanceof Error ? error.message : "";
  if (message === "cost_acquisition_timeout") return { reason: "acquisition_timeout", retry: true };
  if (message === "cost_source_credentials_missing") return { reason: "source_rejected", retry: false };
  const status = /request failed with ([0-9]{3})$/.exec(message);
  if (status?.[1] === "401") return { reason: "reauth_required", retry: false };
  if (status && ![408, 429].includes(Number(status[1])) && Number(status[1]) < 500) {
    return { reason: "source_rejected", retry: false };
  }
  if (status || /request failed$/.test(message)) return { reason: "source_unavailable", retry: true };
  return { reason: "source_invalid", retry: false };
}

async function acquire(claim: Claim, secrets: SecretStore, fetcher: FetchLike, timeoutMs: number, authentication: CostRefreshAuth): Promise<CostInput[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("cost_acquisition_timeout")); }, timeoutMs);
    });
    const acquireRows = async (): Promise<CostInput[]> => {
      let sourceSecrets: SecretStore;
      const authScope = { tenantId: claim.tenant_id, appId: claim.app_id };
      if (claim.definition.provider === "google_ads") {
        const credentials = await authentication.google({ ...authScope, secrets, fetch: fetcher, signal: controller.signal });
        sourceSecrets = new EnvironmentSecretStore({
          OPENMASU_GOOGLE_ADS_ACCESS_TOKEN: { value: credentials.accessToken },
          OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN: { value: credentials.developerToken },
        });
      } else {
        const credentials = await authentication.apple({ ...authScope, secrets, fetch: fetcher, signal: controller.signal });
        sourceSecrets = new EnvironmentSecretStore({ OPENMASU_APPLE_ADS_ACCESS_TOKEN: { value: credentials.accessToken } });
      }
      if (controller.signal.aborted) throw new Error("cost_acquisition_timeout");
      const common = {
        fetch: (input, init) => fetcher(input, { ...init, signal: controller.signal }), secrets: sourceSecrets,
        since: claim.since, until: claim.until,
        scope: { tenant_id: claim.tenant_id, app_id: claim.app_id, currency: claim.definition.currency, as_of: claim.as_of },
      } satisfies Pick<Parameters<typeof fetchGoogleAds>[0], "fetch" | "secrets" | "since" | "until" | "scope">;
      try {
        return await (claim.definition.provider === "apple_ads"
          ? fetchAppleAds({ ...common, definition: claim.definition })
          : fetchGoogleAds({ ...common, customerId: claim.definition.customer_id, loginCustomerId: claim.definition.login_customer_id,
            apiVersion: claim.definition.api_version, limits: claim.definition.limits, detail: claim.definition.detail }));
      } catch (error) {
        if (error instanceof Error && /request failed with 401$/.test(error.message)) {
          authentication.invalidate(authScope, claim.definition.provider);
          throw new CostRefreshAuthError("reauth_required");
        }
        throw error;
      }
    };
    return await Promise.race([deadline, acquireRows()]);
  } finally { clearTimeout(timer!); }
}

async function failClaim(pool: Pool, claim: Claim, error: unknown): Promise<boolean> {
  const failure = sourceFailure(error);
  const exhausted = failure.retry && claim.attempts >= 3;
  if (claim.backfill_receipt) return finishBackfill(pool, claim, undefined,
    { state: failure.retry && !exhausted ? "retry" : "failed", reason: exhausted ? "retry_exhausted" : failure.reason });
  return withTenant(pool, claim.tenant_id, async (client) => (await client.query(
    `UPDATE control.cost_schedule_checkpoints SET state=$4,safe_reason=$5,lease_token=NULL,lease_expires_at=NULL,
       next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND cost_schedule_id=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp() AND backfill_receipt IS NULL`,
    [claim.tenant_id, claim.cost_schedule_id, claim.token, failure.retry && !exhausted ? "retry" : "failed",
      exhausted ? "retry_exhausted" : failure.reason],
  )).rowCount === 1);
}

async function completeClaim(pool: Pool, claim: Claim, rows: readonly CostInput[]): Promise<boolean> {
  if (claim.backfill_receipt) return finishBackfill(pool, claim, rows);
  return withTenant(pool, claim.tenant_id, async (client) => {
    const current = await client.query(
      `SELECT 1 FROM control.cost_schedule_checkpoints AS checkpoint
       JOIN control.cost_schedules_current AS schedule USING (tenant_id,app_id,cost_schedule_id)
       WHERE checkpoint.tenant_id=$1 AND checkpoint.cost_schedule_id=$2 AND checkpoint.lease_token=$3
         AND checkpoint.lease_expires_at>clock_timestamp() AND schedule.status='active'
         AND checkpoint.backfill_receipt IS NULL
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

async function finishBackfill(pool: Pool, claim: Claim, rows?: readonly CostInput[], failure?: { state: string; reason: string }): Promise<boolean> {
  return withTenant(pool, claim.tenant_id, async client => {
    const scope = [claim.tenant_id, claim.app_id, claim.cost_schedule_id, claim.backfill_receipt!, claim.since];
    const current = await client.query(`SELECT 1 FROM control.cost_schedule_checkpoints checkpoint
      JOIN control.cost_schedules_current schedule USING (tenant_id,app_id,cost_schedule_id)
      JOIN control.cost_backfill_days day ON day.tenant_id=checkpoint.tenant_id AND day.app_id=checkpoint.app_id
        AND day.cost_schedule_id=checkpoint.cost_schedule_id AND day.receipt=checkpoint.backfill_receipt AND day.target_date=checkpoint.backfill_day
      WHERE checkpoint.tenant_id=$1 AND checkpoint.app_id=$2 AND checkpoint.cost_schedule_id=$3
        AND checkpoint.backfill_receipt=$4 AND checkpoint.backfill_day=$5::date AND checkpoint.lease_token=$6
        AND checkpoint.lease_expires_at>clock_timestamp() AND schedule.status='active' AND schedule.definition_digest=$7
        AND day.state='processing' FOR UPDATE OF checkpoint,day`, [...scope, claim.token, claim.definition_digest]);
    if (!current.rowCount) return false;
    const imported = rows?.length ? await persistCostImportWithClient(client, `cost-refresh:${claim.cost_schedule_id}`, rows) : null;
    await client.query(`UPDATE control.cost_backfill_days SET state=$6,safe_reason=$7,row_count=$8,import_run_id=$9,
      snapshot_digest=$10,next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3 AND receipt=$4 AND target_date=$5::date`,
    [...scope, failure?.state ?? (imported ? "complete" : "empty"), failure?.reason ?? null,
      rows?.length ?? null, imported?.import_run_id ?? null, imported ? sha256(rows) : null]);
    // Release only the acquisition fence. The daily cursor and pending range are unchanged.
    await client.query(`UPDATE control.cost_schedule_checkpoints SET backfill_receipt=NULL,backfill_day=NULL,
      lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND app_id=$2 AND cost_schedule_id=$3`, scope.slice(0, 3));
    return true;
  });
}

export async function processCostRefreshes(pool: Pool, tenantId: string, options: Readonly<{
  enabled: boolean; secrets: SecretStore; fetch?: FetchLike; now?: Date; timeoutMs?: number; maximumSchedules?: number;
  authentication?: CostRefreshAuth;
}>): Promise<Readonly<{ completed: number; empty: number; failed: number; fenced: number }>> {
  const result = { completed: 0, empty: 0, failed: 0, fenced: 0 };
  if (!options.enabled) return result;
  const maximum = options.maximumSchedules ?? 10;
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("cost_refresh_limit_invalid");
  for (let index = 0; index < maximum; index += 1) {
    const claim = await claimBackfill(pool, tenantId) ?? await claimRefresh(pool, tenantId, options.now ?? new Date());
    if (!claim) break;
    let rows: CostInput[];
    try { rows = await acquire(claim, options.secrets, options.fetch ?? fetch, timeout, options.authentication ?? sharedAuthentication); }
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
