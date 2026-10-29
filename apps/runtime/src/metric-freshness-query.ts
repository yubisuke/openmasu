/** One app-scoped scalar projection shared by every row of the report query.
 * This is local retained receipt history, not the metric's population or upstream completeness.
 * Scope parameters are the same bound $1/$2 as the metric query. */
export const importReceiptObservationSql = `(
  WITH latest_imports AS MATERIALIZED (
    SELECT DISTINCT ON (source_id) import_run_id,source_id,source_snapshot_digest,status,started_at,completed_at
      FROM control.import_runs WHERE tenant_id=$1 AND app_id=$2
      ORDER BY source_id,started_at DESC,import_run_id DESC
  ), receipts AS (
    SELECT run.status, file.row_count,
      EXISTS (SELECT 1 FROM control.import_row_rejections AS rejected
        WHERE rejected.tenant_id=$1 AND rejected.app_id=$2 AND rejected.import_run_id=file.import_run_id) AS with_rejections,
      coalesce(run.completed_at,run.started_at) AS receipt_at
      FROM latest_imports AS run
      LEFT JOIN control.import_files AS file ON file.tenant_id=$1 AND file.app_id=$2
        AND file.source_id=run.source_id AND file.file_digest=run.source_snapshot_digest
    UNION ALL
    SELECT CASE WHEN checkpoint.state IN ('processing','retry') THEN 'running'
        WHEN checkpoint.state='failed' THEN 'failed'
        WHEN checkpoint.last_outcome IS NOT NULL THEN 'completed' ELSE 'unknown' END,
      checkpoint.last_row_count::bigint,false,
      coalesce(checkpoint.pending_as_of,checkpoint.last_success_at)
      FROM control.cost_schedule_checkpoints AS checkpoint WHERE checkpoint.tenant_id=$1 AND checkpoint.app_id=$2
        AND (checkpoint.pending_as_of IS NOT NULL OR checkpoint.last_success_at IS NOT NULL OR checkpoint.state='failed')
  )
  SELECT jsonb_build_object(
    'receipts',count(*)::text,
    'completed',count(*) FILTER (WHERE status IN ('completed','skipped'))::text,
    'running',count(*) FILTER (WHERE status='running')::text,
    'failed',count(*) FILTER (WHERE status='failed')::text,
    'with_row_rejections',count(*) FILTER (WHERE with_rejections)::text,
    'empty_receipts',count(*) FILTER (WHERE status IN ('completed','skipped') AND row_count=0)::text,
    'nonempty_receipts',count(*) FILTER (WHERE status IN ('completed','skipped') AND row_count>0)::text,
    'latest_receipt_at',max(receipt_at)
  ) FROM receipts
)`;
