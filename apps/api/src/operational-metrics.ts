import type { Pool } from "pg";
import {
  JOB_HEALTH_ACTOR_REFS,
  JOB_HEALTH_JOBS,
  JOB_HEALTH_OUTCOMES,
  SDK_POST_PROCESSING_PENDING_REASON,
  SCHEDULED_WORKER_JOBS,
  withTenant,
  type JobHealthJob,
  type JobHealthOutcome,
} from "@openmasu/runtime";
import type { RouteHandler } from "./routes.js";

type RouteLabel = RouteHandler | "unmatched";
type MethodLabel = "GET" | "POST" | "OTHER";
type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

function methodLabel(method: string | undefined): MethodLabel {
  return method === "GET" || method === "POST" ? method : "OTHER";
}

function statusClass(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function labels(values: Readonly<Record<string, string>>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}

export class OperationalMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durationCounts = new Map<string, number[]>();
  private readonly durationSums = new Map<string, number>();

  observe(route: RouteLabel, method: string | undefined, status: number, durationMs: number): void {
    const boundedMethod = methodLabel(method);
    const key = `${route}\u0000${boundedMethod}\u0000${statusClass(status)}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const durationKey = `${route}\u0000${boundedMethod}`;
    const counts = this.durationCounts.get(durationKey) ?? durationBuckets.map(() => 0);
    const seconds = Math.max(0, durationMs) / 1000;
    durationBuckets.forEach((bucket, index) => {
      if (seconds <= bucket) counts[index] += 1;
    });
    this.durationCounts.set(durationKey, counts);
    this.durationSums.set(durationKey, (this.durationSums.get(durationKey) ?? 0) + seconds);
  }

  renderProcessMetrics(): string[] {
    const lines = [
      "# HELP openmasu_http_requests_total Bounded API requests by route, method, and status class.",
      "# TYPE openmasu_http_requests_total counter",
    ];
    for (const [key, count] of [...this.requests].sort(([left], [right]) => left.localeCompare(right))) {
      const [route, method, status] = key.split("\u0000");
      lines.push(`openmasu_http_requests_total${labels({ route, method, status_class: status })} ${count}`);
    }
    lines.push(
      "# HELP openmasu_http_request_duration_seconds API request processing duration.",
      "# TYPE openmasu_http_request_duration_seconds histogram",
    );
    for (const [key, counts] of [...this.durationCounts].sort(([left], [right]) => left.localeCompare(right))) {
      const [route, method] = key.split("\u0000");
      durationBuckets.forEach((bucket, index) => {
        lines.push(`openmasu_http_request_duration_seconds_bucket${labels({ route, method, le: String(bucket) })} ${counts[index]}`);
      });
      const count = this.requestsForRouteMethod(route as RouteLabel, method as MethodLabel);
      lines.push(`openmasu_http_request_duration_seconds_bucket${labels({ route, method, le: "+Inf" })} ${count}`);
      lines.push(`openmasu_http_request_duration_seconds_sum${labels({ route, method })} ${this.durationSums.get(key) ?? 0}`);
      lines.push(`openmasu_http_request_duration_seconds_count${labels({ route, method })} ${count}`);
    }
    return lines;
  }

  private requestsForRouteMethod(route: RouteLabel, method: MethodLabel): number {
    return (["2xx", "3xx", "4xx", "5xx"] as const)
      .reduce((sum, status) => sum + (this.requests.get(`${route}\u0000${method}\u0000${status}`) ?? 0), 0);
  }
}

export async function renderOperationalMetrics(
  pool: Pool,
  tenantId: string,
  metrics: OperationalMetrics,
): Promise<string> {
  const durable = await withTenant(pool, tenantId, async (client) => {
    const inbox = await client.query<{ count: string; oldest: string }>(
      `SELECT count(*)::text AS count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-min(received_at::timestamptz))),0)::text AS oldest
         FROM ledger.ingest_inbox_current
        WHERE tenant_id=$1 AND status='pending'`,
      [tenantId],
    );
    const batches = await client.query<{ count: string; oldest: string }>(
      `SELECT count(*)::text AS count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-min(received_at::timestamptz))),0)::text AS oldest
         FROM ledger.ingest_batches_current
        WHERE tenant_id=$1
          AND (status='pending' OR (status='processed' AND reason_code=$2))`,
      [tenantId, SDK_POST_PROCESSING_PENDING_REASON],
    );
    const adservices = await client.query<{ count: string; oldest: string }>(
      `SELECT count(*)::text AS count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at))),0)::text AS oldest
         FROM ephemeral.adservices_lookups
        WHERE tenant_id=$1`,
      [tenantId],
    );
    const operatorWebhooks = await client.query<{ count: string; oldest: string }>(
      `SELECT count(*)::text AS count,
              COALESCE(GREATEST(EXTRACT(EPOCH FROM (
                clock_timestamp()-min(control.canonical_timestamp_value(created_at))
              )),0),0)::text AS oldest
         FROM ephemeral.operator_webhook_deliveries
        WHERE tenant_id=$1 AND state IN ('queued','retry')`,
      [tenantId],
    );
    const completedJobs = await client.query<{
      actor_ref: string;
      outcome: JobHealthOutcome;
      runs: string;
      latest: string;
    }>(
      `SELECT actor_ref, outcome, count(*)::text AS runs,
              COALESCE(
                EXTRACT(EPOCH FROM max(control.canonical_timestamp_value(occurred_at))),
                0
              )::text AS latest
         FROM ledger.audit_logs
        WHERE tenant_id=$1
          AND actor_type='system_job'
          AND action='job_completed'
          AND policy_version='job-health-v1'
          AND actor_ref IN (
            'job:mmp_import', 'job:cost_import', 'job:max_revenue_import',
            'job:google_conversion_delivery', 'job:operator_webhook_delivery', 'job:metric_run'
          )
          AND outcome IN ('succeeded', 'failed')
          AND target_scope='app'
          AND app_id=target_ref
          AND (
            (outcome='succeeded' AND reason_code IS NULL)
            OR (outcome='failed' AND reason_code='job_failed')
          )
        GROUP BY actor_ref, outcome`,
      [tenantId],
    );
    const scheduledJobs = await client.query<{
      job_name: string;
      last_outcome: "succeeded" | "failed" | null;
      consecutive_failures: string;
      success_count: string;
      failure_count: string;
      overdue: string;
      lease_active: boolean;
    }>(
      `SELECT job_name, last_outcome,
              consecutive_failures::text,
              success_count::text,
              failure_count::text,
              GREATEST(EXTRACT(EPOCH FROM (clock_timestamp()-next_run_at)),0)::text AS overdue,
              COALESCE(lease_expires_at > clock_timestamp(),false) AS lease_active
         FROM control.worker_job_schedules
        WHERE tenant_id=$1
        ORDER BY job_name`,
      [tenantId],
    );
    const jobs = new Map<string, { runs: string; latest: string }>();
    for (const job of JOB_HEALTH_JOBS) {
      for (const outcome of JOB_HEALTH_OUTCOMES) jobs.set(`${job}\u0000${outcome}`, { runs: "0", latest: "0" });
    }
    for (const row of completedJobs.rows) {
      const job = JOB_HEALTH_JOBS.find((candidate) => JOB_HEALTH_ACTOR_REFS[candidate] === row.actor_ref);
      if (job && JOB_HEALTH_OUTCOMES.includes(row.outcome)) {
        jobs.set(`${job}\u0000${row.outcome}`, { runs: row.runs, latest: row.latest });
      }
    }
    return {
      inbox: inbox.rows[0],
      batches: batches.rows[0],
      adservices: adservices.rows[0],
      operatorWebhooks: operatorWebhooks.rows[0],
      jobs,
      scheduledJobs: new Map(scheduledJobs.rows.map((row) => [row.job_name, row])),
    };
  });
  const lines = metrics.renderProcessMetrics();
  lines.push(
    "# HELP openmasu_ingest_backlog Pending durable ingest work by bounded queue.",
    "# TYPE openmasu_ingest_backlog gauge",
    `openmasu_ingest_backlog${labels({ queue: "max_inbox" })} ${durable.inbox.count}`,
    `openmasu_ingest_backlog${labels({ queue: "sdk_batches" })} ${durable.batches.count}`,
    `openmasu_ingest_backlog${labels({ queue: "adservices" })} ${durable.adservices.count}`,
    `openmasu_ingest_backlog${labels({ queue: "operator_webhooks" })} ${durable.operatorWebhooks.count}`,
    "# HELP openmasu_ingest_oldest_pending_seconds Age of the oldest pending item in a bounded queue.",
    "# TYPE openmasu_ingest_oldest_pending_seconds gauge",
    `openmasu_ingest_oldest_pending_seconds${labels({ queue: "max_inbox" })} ${durable.inbox.oldest}`,
    `openmasu_ingest_oldest_pending_seconds${labels({ queue: "sdk_batches" })} ${durable.batches.oldest}`,
    `openmasu_ingest_oldest_pending_seconds${labels({ queue: "adservices" })} ${durable.adservices.oldest}`,
    `openmasu_ingest_oldest_pending_seconds${labels({ queue: "operator_webhooks" })} ${durable.operatorWebhooks.oldest}`,
    "# HELP openmasu_job_runs_total Durable terminal operator job runs by fixed job and outcome.",
    "# TYPE openmasu_job_runs_total counter",
  );
  const jobValue = (job: JobHealthJob, outcome: JobHealthOutcome): { runs: string; latest: string } =>
    durable.jobs.get(`${job}\u0000${outcome}`) ?? { runs: "0", latest: "0" };
  for (const job of JOB_HEALTH_JOBS) {
    for (const outcome of JOB_HEALTH_OUTCOMES) {
      lines.push(`openmasu_job_runs_total${labels({ job, outcome })} ${jobValue(job, outcome).runs}`);
    }
  }
  lines.push(
    "# HELP openmasu_job_last_completion_timestamp_seconds Unix timestamp of the latest durable terminal operator job run.",
    "# TYPE openmasu_job_last_completion_timestamp_seconds gauge",
  );
  for (const job of JOB_HEALTH_JOBS) {
    for (const outcome of JOB_HEALTH_OUTCOMES) {
      lines.push(`openmasu_job_last_completion_timestamp_seconds${labels({ job, outcome })} ${jobValue(job, outcome).latest}`);
    }
  }
  lines.push(
    "# HELP openmasu_scheduled_job_runs_total Durable worker scheduler completions by fixed job and outcome.",
    "# TYPE openmasu_scheduled_job_runs_total counter",
  );
  for (const job of SCHEDULED_WORKER_JOBS) {
    const state = durable.scheduledJobs.get(job);
    lines.push(
      `openmasu_scheduled_job_runs_total${labels({ job, outcome: "succeeded" })} ${state?.success_count ?? "0"}`,
      `openmasu_scheduled_job_runs_total${labels({ job, outcome: "failed" })} ${state?.failure_count ?? "0"}`,
    );
  }
  lines.push(
    "# HELP openmasu_scheduled_job_consecutive_failures Current consecutive failures for a fixed worker job.",
    "# TYPE openmasu_scheduled_job_consecutive_failures gauge",
    "# HELP openmasu_scheduled_job_overdue_seconds Seconds since a fixed worker job became due.",
    "# TYPE openmasu_scheduled_job_overdue_seconds gauge",
    "# HELP openmasu_scheduled_job_lease_active Whether a fixed worker job currently has an unexpired lease.",
    "# TYPE openmasu_scheduled_job_lease_active gauge",
    "# HELP openmasu_scheduled_job_configured Whether a fixed worker job has durable schedule state.",
    "# TYPE openmasu_scheduled_job_configured gauge",
  );
  for (const job of SCHEDULED_WORKER_JOBS) {
    const state = durable.scheduledJobs.get(job);
    lines.push(
      `openmasu_scheduled_job_consecutive_failures${labels({ job })} ${state?.consecutive_failures ?? "0"}`,
      `openmasu_scheduled_job_overdue_seconds${labels({ job })} ${state?.overdue ?? "0"}`,
      `openmasu_scheduled_job_lease_active${labels({ job })} ${state?.lease_active ? "1" : "0"}`,
      `openmasu_scheduled_job_configured${labels({ job })} ${state ? "1" : "0"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
