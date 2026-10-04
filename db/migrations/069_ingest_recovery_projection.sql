-- Reader projection only: no token, subject, payload, reference or arbitrary worker error.
-- The owner already has SELECT-only discovery policies on these queues. The
-- explicit tenant/app predicates remain mandatory even at this definer boundary.
CREATE FUNCTION control.ingest_recovery_auxiliary_items(request_app text)
RETURNS TABLE (
  kind text, job_id text, revision text, attempts integer,
  next_attempt_at timestamptz, claimed boolean, source_available boolean,
  safe_reason text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH queue AS (
    SELECT 'adservices'::text AS kind, lookup_id::text AS job_id,
           tenant_id, app_id, install_record_id AS record_id, attempts,
           next_attempt_at, claimed_until,
           CASE WHEN artifact->>'last_outcome' IN ('rate_limited','request_timeout','network_failure','not_found')
             THEN artifact->>'last_outcome' ELSE 'provider_retry_or_pending' END AS safe_reason
      FROM ephemeral.adservices_lookups
     WHERE tenant_id=current_setting('openmasu.tenant_id',true) AND app_id=request_app
    UNION ALL
    SELECT 'integrity',verification_id::text,tenant_id,app_id,subject_record_id,
           attempts,next_attempt_at,claimed_until,'verification_pending'
      FROM ephemeral.integrity_verifications
     WHERE tenant_id=current_setting('openmasu.tenant_id',true) AND app_id=request_app
    UNION ALL
    SELECT 'google_play',verification_id::text,tenant_id,app_id,subject_record_id,
           attempts,next_attempt_at,claimed_until,'provider_retry_or_pending'
      FROM ephemeral.google_play_product_verifications
     WHERE tenant_id=current_setting('openmasu.tenant_id',true) AND app_id=request_app
  )
  SELECT queue.kind,queue.job_id,
         md5(concat(queue.attempts,':',queue.next_attempt_at::text,':',queue.claimed_until::text)),
         queue.attempts,queue.next_attempt_at,
         COALESCE(queue.claimed_until>statement_timestamp(),false),
         COALESCE(raw.payload_lifecycle_status='available',false),queue.safe_reason
    FROM queue LEFT JOIN ledger.raw_records_current AS raw
      ON raw.tenant_id=queue.tenant_id AND raw.app_id=queue.app_id AND raw.record_id=queue.record_id
   ORDER BY queue.next_attempt_at,queue.kind,queue.job_id LIMIT 50
$$;
REVOKE ALL ON FUNCTION control.ingest_recovery_auxiliary_items(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.ingest_recovery_auxiliary_items(text) TO openmasu_app,openmasu_reader;
