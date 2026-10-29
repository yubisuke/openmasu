-- Reader-facing projection, not access to subjects, protected references or raw artifacts.
-- migrateDatabase creates this under SET LOCAL ROLE openmasu_owner, a NOLOGIN,
-- NOBYPASSRLS owner. Explicit tenant/app predicates remain mandatory because
-- existing owner-only discovery policies can see work queues across tenants.
-- No SELECT permission on either private privacy table is granted to readers.
CREATE INDEX privacy_deletion_jobs_progress_idx
  ON control.privacy_deletion_jobs (tenant_id,app_id,requested_at DESC,privacy_request_id COLLATE "C" DESC);

CREATE FUNCTION control.privacy_job_progress(_app_id text, _request_id text DEFAULT NULL)
RETURNS TABLE (
  privacy_request_id text, requested_at text, completed_at text, payload_state text,
  payload_total bigint, payload_purged bigint, payload_failed bigint,
  metric_total bigint, metric_completed bigint, metric_pending bigint, metric_failed bigint,
  metric_unavailable bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT j.privacy_request_id::text,j.requested_at::text,j.completed_at::text,j.status,
    p.total,p.purged,p.failed,m.total,m.completed,m.pending,m.failed,m.unavailable
  FROM (
    SELECT privacy_request_id,tenant_id,app_id,requested_at,completed_at,status
    FROM control.privacy_deletion_jobs
    WHERE tenant_id=current_setting('openmasu.tenant_id',true) AND app_id=_app_id
      AND (_request_id IS NULL OR privacy_request_id=_request_id)
    ORDER BY requested_at DESC,privacy_request_id COLLATE "C" DESC LIMIT 51
  ) j
  CROSS JOIN LATERAL (
    SELECT count(*) AS total,count(*) FILTER(WHERE status='purged') AS purged,
      count(*) FILTER(WHERE status='queued' AND last_error_code IS NOT NULL) AS failed
    FROM control.privacy_payload_purges
    WHERE tenant_id=j.tenant_id AND app_id=j.app_id AND privacy_request_id=j.privacy_request_id
  ) p
  CROSS JOIN LATERAL (
    SELECT count(*) AS total,count(*) FILTER(WHERE i.state='completed') AS completed,
      count(*) FILTER(WHERE i.state IN ('queued','processing','retry')) AS pending,
      count(*) FILTER(WHERE i.state='failed') AS failed,
      count(*) FILTER(WHERE i.state IN ('skipped','unavailable')) AS unavailable
    FROM control.metric_recalculation_jobs r
    JOIN control.metric_recalculation_items i USING(tenant_id,app_id,recalculation_id)
    WHERE r.tenant_id=j.tenant_id AND r.app_id=j.app_id AND r.privacy_request_id=j.privacy_request_id
      AND r.trigger_kind='privacy_deletion'
  ) m
  ORDER BY j.requested_at DESC,j.privacy_request_id COLLATE "C" DESC
$$;
REVOKE ALL ON FUNCTION control.privacy_job_progress(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.privacy_job_progress(text,text) TO openmasu_app,openmasu_reader;
