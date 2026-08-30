import type { Pool, PoolClient } from "pg";
import { uuidV7 } from "./index.js";

export const SCHEDULED_WORKER_JOBS = [
  "max_inbox",
  "sdk_inbox",
  "adservices_lookup",
  "integrity_verification",
  "google_play_verification",
  "commerce_readback",
  "google_conversion_delivery",
  "operator_webhook_delivery",
  "operator_bulk_export",
  "metric_run",
  "fraud_maintenance",
  "dashboard_session_sweep",
] as const;

export type ScheduledWorkerJob = typeof SCHEDULED_WORKER_JOBS[number];
export type ScheduledJobOutcome = "succeeded" | "failed";

export type ScheduledJobClaim = {
  tenantId: string;
  job: ScheduledWorkerJob;
  leaseToken: string;
  scheduledAt: Date;
};

export type SchedulePolicy = {
  intervalMs: number;
  retryMs: number;
  leaseMs: number;
};

export interface SchedulerStore {
  claim(tenantId: string, job: ScheduledWorkerJob, policy: SchedulePolicy, now: Date): Promise<ScheduledJobClaim | null>;
  renew(claim: ScheduledJobClaim, now: Date, leaseMs: number): Promise<boolean>;
  complete(claim: ScheduledJobClaim, now: Date): Promise<boolean>;
  fail(claim: ScheduledJobClaim, now: Date): Promise<boolean>;
}

export type ScheduledJobResult = "not_due" | ScheduledJobOutcome;

function positiveMilliseconds(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new Error(`${name} must be an integer from 1000 through 86400000`);
  }
}

function validDate(name: string, value: Date): void {
  if (!Number.isFinite(value.valueOf())) throw new Error(`${name} is invalid`);
}

export function validateSchedulePolicy(policy: SchedulePolicy): void {
  positiveMilliseconds("schedule interval", policy.intervalMs);
  positiveMilliseconds("schedule retry", policy.retryMs);
  positiveMilliseconds("schedule lease", policy.leaseMs);
}

export class PostgresSchedulerStore implements SchedulerStore {
  private readonly leaseClients = new Map<string, PoolClient>();

  constructor(private readonly pool: Pool) {}

  private lockKey(tenantId: string, job: ScheduledWorkerJob): string {
    return `openmasu:worker-job:${tenantId}:${job}`;
  }

  private async releaseLease(claim: ScheduledJobClaim): Promise<void> {
    const client = this.leaseClients.get(claim.leaseToken);
    if (!client) return;
    this.leaseClients.delete(claim.leaseToken);
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1,0))",
        [this.lockKey(claim.tenantId, claim.job)],
      );
    } finally {
      client.release();
    }
  }

  async claim(
    tenantId: string,
    job: ScheduledWorkerJob,
    policy: SchedulePolicy,
    now: Date,
  ): Promise<ScheduledJobClaim | null> {
    if (!SCHEDULED_WORKER_JOBS.includes(job)) throw new Error("scheduled worker job is invalid");
    validateSchedulePolicy(policy);
    validDate("schedule claim time", now);
    const leaseToken = uuidV7(now.valueOf());
    const client = await this.pool.connect();
    let locked = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [this.lockKey(tenantId, job)],
      );
      if (!lock.rows[0]?.acquired) return null;
      locked = true;
      await client.query("BEGIN");
      await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO control.worker_job_schedules (
           tenant_id, job_name, interval_ms, retry_ms, next_run_at
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, job_name) DO NOTHING`,
        [tenantId, job, policy.intervalMs, policy.retryMs, now],
      );
      const claimed = await client.query<{ next_run_at: Date }>(
        `UPDATE control.worker_job_schedules
            SET interval_ms=$3,
                retry_ms=$4,
                lease_token=$5,
                lease_expires_at=$6::timestamptz,
                last_started_at=$2::timestamptz
          WHERE tenant_id=$1
            AND job_name=$7
            AND next_run_at <= $2::timestamptz
            AND (lease_expires_at IS NULL OR lease_expires_at <= $2::timestamptz)
        RETURNING next_run_at`,
        [tenantId, now, policy.intervalMs, policy.retryMs, leaseToken, new Date(now.valueOf() + policy.leaseMs), job],
      );
      await client.query("COMMIT");
      if (claimed.rowCount !== 1) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [this.lockKey(tenantId, job)],
        );
        locked = false;
        return null;
      }
      const claim = { tenantId, job, leaseToken, scheduledAt: new Date(claimed.rows[0].next_run_at) };
      this.leaseClients.set(leaseToken, client);
      return claim;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be unavailable */ }
      if (locked) {
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [this.lockKey(tenantId, job)],
          );
        } catch { /* connection close releases the advisory lock */ }
      }
      throw error;
    } finally {
      if (!this.leaseClients.has(leaseToken)) client.release();
    }
  }

  async complete(claim: ScheduledJobClaim, now: Date): Promise<boolean> {
    validDate("schedule completion time", now);
    const client = this.leaseClients.get(claim.leaseToken);
    if (!client) return false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [claim.tenantId]);
      const completed = await client.query(
        `UPDATE control.worker_job_schedules
            SET next_run_at=$4::timestamptz + interval_ms * interval '1 millisecond',
                lease_token=NULL,
                lease_expires_at=NULL,
                last_completed_at=$4::timestamptz,
                last_outcome='succeeded',
                consecutive_failures=0,
                success_count=success_count+1
          WHERE tenant_id=$1 AND job_name=$2 AND lease_token=$3`,
        [claim.tenantId, claim.job, claim.leaseToken, now],
      );
      await client.query("COMMIT");
      return completed.rowCount === 1;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be unavailable */ }
      throw error;
    } finally {
      await this.releaseLease(claim);
    }
  }

  async renew(claim: ScheduledJobClaim, now: Date, leaseMs: number): Promise<boolean> {
    validDate("schedule renewal time", now);
    positiveMilliseconds("schedule lease", leaseMs);
    const client = this.leaseClients.get(claim.leaseToken);
    if (!client) return false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [claim.tenantId]);
      const renewed = await client.query(
        `UPDATE control.worker_job_schedules
            SET lease_expires_at=$4::timestamptz
          WHERE tenant_id=$1 AND job_name=$2 AND lease_token=$3`,
        [claim.tenantId, claim.job, claim.leaseToken, new Date(now.valueOf() + leaseMs)],
      );
      await client.query("COMMIT");
      return renewed.rowCount === 1;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be unavailable */ }
      throw error;
    }
  }

  async fail(claim: ScheduledJobClaim, now: Date): Promise<boolean> {
    validDate("schedule failure time", now);
    const client = this.leaseClients.get(claim.leaseToken);
    if (!client) return false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [claim.tenantId]);
      const failed = await client.query(
        `UPDATE control.worker_job_schedules
            SET next_run_at=$4::timestamptz + retry_ms * interval '1 millisecond',
                lease_token=NULL,
                lease_expires_at=NULL,
                last_completed_at=$4::timestamptz,
                last_outcome='failed',
                consecutive_failures=consecutive_failures+1,
                failure_count=failure_count+1
          WHERE tenant_id=$1 AND job_name=$2 AND lease_token=$3`,
        [claim.tenantId, claim.job, claim.leaseToken, now],
      );
      await client.query("COMMIT");
      return failed.rowCount === 1;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be unavailable */ }
      throw error;
    } finally {
      await this.releaseLease(claim);
    }
  }
}

export async function runScheduledJob(options: {
  store: SchedulerStore;
  tenantId: string;
  job: ScheduledWorkerJob;
  policy: SchedulePolicy;
  task: () => Promise<void>;
  now?: () => Date;
}): Promise<ScheduledJobResult> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  validDate("schedule start time", startedAt);
  const claim = await options.store.claim(options.tenantId, options.job, options.policy, startedAt);
  if (!claim) return "not_due";
  let leaseLost = false;
  let renewal: Promise<void> | undefined;
  const heartbeatMs = Math.max(250, Math.floor(options.policy.leaseMs / 3));
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = options.store.renew(claim, clock(), options.policy.leaseMs)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; })
      .finally(() => { renewal = undefined; });
  }, heartbeatMs);
  heartbeat.unref();
  try {
    await options.task();
    clearInterval(heartbeat);
    await renewal;
    if (leaseLost) throw new Error("scheduled worker job lease was lost during execution");
    const completed = await options.store.complete(claim, clock());
    if (!completed) throw new Error("scheduled worker job lease was lost before completion");
    return "succeeded";
  } catch {
    clearInterval(heartbeat);
    await renewal;
    try {
      await options.store.fail(claim, clock());
    } catch {
      // The service log reports the bounded job failure when the durable store is unavailable.
    }
    return "failed";
  }
}
