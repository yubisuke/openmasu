DROP INDEX ledger.audit_logs_job_health_idx;

CREATE INDEX audit_logs_job_health_idx
  ON ledger.audit_logs (tenant_id, actor_ref, outcome, occurred_at DESC)
  WHERE actor_type = 'system_job'
    AND action = 'job_completed'
    AND policy_version = 'job-health-v1'
    AND actor_ref IN ('job:mmp_import', 'job:cost_import', 'job:max_revenue_import', 'job:metric_run')
    AND outcome IN ('succeeded', 'failed')
    AND target_scope = 'app'
    AND app_id = target_ref
    AND (
      (outcome = 'succeeded' AND reason_code IS NULL)
      OR (outcome = 'failed' AND reason_code = 'job_failed')
    );
