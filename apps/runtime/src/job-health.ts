import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { uuidV7, withTenant } from "./index.js";

export const JOB_HEALTH_JOBS = [
  "mmp_import", "cost_import", "max_revenue_import", "google_conversion_delivery",
  "operator_webhook_delivery", "operator_bulk_export", "metric_run",
] as const;
export const JOB_HEALTH_OUTCOMES = ["succeeded", "failed"] as const;

export type JobHealthJob = typeof JOB_HEALTH_JOBS[number];
export type JobHealthOutcome = typeof JOB_HEALTH_OUTCOMES[number];

export const JOB_HEALTH_ACTOR_REFS: Readonly<Record<JobHealthJob, string>> = {
  mmp_import: "job:mmp_import",
  cost_import: "job:cost_import",
  max_revenue_import: "job:max_revenue_import",
  google_conversion_delivery: "job:google_conversion_delivery",
  operator_webhook_delivery: "job:operator_webhook_delivery",
  operator_bulk_export: "job:operator_bulk_export",
  metric_run: "job:metric_run",
};

const policyVersion = "job-health-v1";

function requestDigest(
  tenantId: string,
  appId: string,
  occurredAt: string,
  job: JobHealthJob,
  outcome: JobHealthOutcome,
): string {
  return createHash("sha256")
    .update(`${job}\u0000${outcome}\u0000${tenantId}\u0000${appId}\u0000${occurredAt}`, "utf8")
    .digest("hex");
}

export async function recordJobOutcome(options: {
  pool: Pool;
  tenantId: string;
  appId: string;
  job: JobHealthJob;
  outcome: JobHealthOutcome;
  now?: Date;
}): Promise<void> {
  if (!JOB_HEALTH_JOBS.includes(options.job)) throw new Error("job health job is invalid");
  if (!JOB_HEALTH_OUTCOMES.includes(options.outcome)) throw new Error("job health outcome is invalid");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("job completion time is invalid");
  const occurredAt = now.toISOString();
  await withTenant(options.pool, options.tenantId, (client) => client.query(
    `INSERT INTO ledger.audit_logs (
       audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
       action, target_scope, target_ref, policy_version, request_digest,
       outcome, reason_code
     ) VALUES (
       $1,$2,$3::text::control.identifier,$4,'system_job',$5,
       'job_completed','app',$3::text,$6,$7,$8,$9
     )`,
    [
      uuidV7(now.valueOf()),
      options.tenantId,
      options.appId,
      occurredAt,
      JOB_HEALTH_ACTOR_REFS[options.job],
      policyVersion,
      requestDigest(options.tenantId, options.appId, occurredAt, options.job, options.outcome),
      options.outcome,
      options.outcome === "failed" ? "job_failed" : null,
    ],
  ).then(() => undefined));
}

export async function runWithTerminalJobOutcome<T>(
  task: () => Promise<T>,
  recordOutcome: (outcome: JobHealthOutcome) => Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await task();
  } catch (taskError) {
    try {
      await recordOutcome("failed");
    } catch {
      // The task error is the command's cause; an unavailable audit sink must not replace it.
    }
    throw taskError;
  }
  await recordOutcome("succeeded");
  return result;
}
