import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";

export type PrivacyJobProgressRow = {
  privacy_request_id: string; requested_at: string; completed_at: string | null; payload_state: "processing" | "completed";
  payload_total: string; payload_purged: string; payload_failed: string;
  metric_total: string; metric_completed: string; metric_pending: string; metric_failed: string; metric_unavailable: string;
};
export class PrivacyJobQueryError extends Error {
  constructor() { super("privacy_job_query_invalid"); }
}

export function parsePrivacyJobRequest(target: URL): string | undefined {
  if (target.searchParams.size) throw new PrivacyJobQueryError();
  const match = /\/privacy-jobs(?:\/([^/]+))?$/.exec(target.pathname);
  if (!match) throw new PrivacyJobQueryError();
  if (match[1] === undefined) return undefined;
  try {
    const requestId = decodeURIComponent(match[1]);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new PrivacyJobQueryError();
    return requestId;
  } catch { throw new PrivacyJobQueryError(); }
}
/** Closed projection only: never spread a stored privacy artifact into an operator receipt. */
export function projectPrivacyProgress(row: PrivacyJobProgressRow) {
  const metricState = row.metric_total === "0" ? "not_recorded"
    : row.metric_failed !== "0" ? "failed" : row.metric_unavailable !== "0" ? "unavailable"
      : row.metric_pending !== "0" ? "processing" : row.metric_completed === row.metric_total ? "completed" : "unavailable";
  const payloadState = row.payload_state === "completed" ? "completed"
    : row.payload_failed !== "0" ? "retry_pending" : "processing";
  return {
    format: "privacy-job-progress-v1", request_id: row.privacy_request_id, requested_at: row.requested_at,
    payload: { state: payloadState, total: row.payload_total, purged: row.payload_purged,
      failed: row.payload_failed, completed_at: row.completed_at },
    recalculation: { state: metricState, total: row.metric_total, completed: row.metric_completed,
      pending: row.metric_pending, failed: row.metric_failed, unavailable: row.metric_unavailable },
    all_recorded_steps_completed: payloadState === "completed" && metricState === "completed",
  };
}
export async function privacyJobProgress(pool: Pool, scope: { tenantId: string; appId: string }, requestId?: string) {
  if (requestId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new PrivacyJobQueryError();
  return withTenant(pool, scope.tenantId, async client => {
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout='5s'");
    const rows = (await client.query<PrivacyJobProgressRow>(
      "SELECT * FROM control.privacy_job_progress($1,$2)", [scope.appId, requestId ?? null])).rows;
    return { data: rows.slice(0, 50).map(projectPrivacyProgress), has_more: rows.length > 50 };
  });
}
