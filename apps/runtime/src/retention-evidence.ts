import type { PoolClient } from "pg";

/** Expiry is a current evidence fact, independent of the historical report cutoff. */
export function retentionMetricInvalidationSql(alias: "mr" | "run"): string {
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${alias}.artifact->'evidence_refs','[]'::jsonb)) AS retention_ref
    JOIN ledger.raw_payload_states AS retention_state ON retention_state.tenant_id=${alias}.tenant_id
      AND retention_state.app_id=${alias}.app_id AND retention_state.record_id=retention_ref->>'ref'
    WHERE retention_state.lifecycle_status='purged' AND retention_state.privacy_request_id IS NULL)`;
}

/** Do not manufacture a replay from surviving facts after its protected inputs expire. */
export async function assertMetricRetentionAvailable(client: PoolClient, scope: { tenant_id: string; app_id: string }, runId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM ledger.metric_runs AS run
    WHERE run.tenant_id=$1 AND run.app_id=$2 AND run.metric_run_id=$3 AND ${retentionMetricInvalidationSql("run")} LIMIT 1`,
  [scope.tenant_id, scope.app_id, runId]);
  if (result.rowCount) throw new Error("input_unavailable");
}
