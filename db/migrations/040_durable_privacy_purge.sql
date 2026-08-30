CREATE TABLE control.privacy_deletion_jobs (
  privacy_request_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  requested_at control.canonical_timestamp NOT NULL,
  completed_at control.canonical_timestamp,
  artifact_template jsonb NOT NULL CHECK (jsonb_typeof(artifact_template) = 'object'),
  actor_type text NOT NULL CHECK (actor_type IN ('admin_key', 'sdk_installation')),
  actor_ref text NOT NULL CHECK (length(actor_ref) BETWEEN 1 AND 256),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  updated_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, privacy_request_id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE control.privacy_payload_purges (
  privacy_request_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  reference_digest text NOT NULL CHECK (reference_digest ~ '^[a-f0-9]{64}$'),
  payload_ref text NOT NULL CHECK (
    payload_ref ~ '^encrypted:[A-Za-z0-9._-]+$'
    AND length(payload_ref) BETWEEN 11 AND 522
    AND position('..' in payload_ref)=0
  ),
  status text NOT NULL CHECK (status IN ('queued', 'purged')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  updated_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (privacy_request_id, reference_digest),
  FOREIGN KEY (tenant_id, app_id, privacy_request_id)
    REFERENCES control.privacy_deletion_jobs (tenant_id, app_id, privacy_request_id)
);

CREATE INDEX privacy_deletion_jobs_pending_idx
  ON control.privacy_deletion_jobs (tenant_id, requested_at, privacy_request_id)
  WHERE status = 'processing';
CREATE INDEX privacy_payload_purges_pending_idx
  ON control.privacy_payload_purges (tenant_id, app_id, privacy_request_id, reference_digest)
  WHERE status = 'queued';

ALTER TABLE control.privacy_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.privacy_deletion_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_deletion_jobs_tenant ON control.privacy_deletion_jobs
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
CREATE POLICY privacy_deletion_jobs_discovery_owner
  ON control.privacy_deletion_jobs FOR SELECT TO openmasu_owner USING (true);

ALTER TABLE control.privacy_payload_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.privacy_payload_purges FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_payload_purges_tenant ON control.privacy_payload_purges
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE FUNCTION control.privacy_deletion_backlog()
RETURNS TABLE(pending_count bigint, oldest_seconds double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT count(*)::bigint,
         COALESCE(GREATEST(EXTRACT(EPOCH FROM (
           statement_timestamp()-min(control.canonical_timestamp_value(job.requested_at))
         )),0),0)::double precision
    FROM control.privacy_deletion_jobs AS job
   WHERE job.tenant_id=current_setting('openmasu.tenant_id', true)
     AND job.status='processing'
$$;

REVOKE ALL ON control.privacy_deletion_jobs, control.privacy_payload_purges FROM PUBLIC;
REVOKE SELECT ON control.privacy_deletion_jobs, control.privacy_payload_purges FROM openmasu_reader;
REVOKE ALL ON FUNCTION control.privacy_deletion_backlog() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON
  control.privacy_deletion_jobs,
  control.privacy_payload_purges
TO openmasu_app;
GRANT TRUNCATE ON
  control.privacy_deletion_jobs,
  control.privacy_payload_purges
TO openmasu_seed;
GRANT EXECUTE ON FUNCTION control.privacy_deletion_backlog() TO openmasu_app, openmasu_reader;

ALTER TABLE control.worker_job_schedules DROP CONSTRAINT worker_job_schedules_job_name_check;
ALTER TABLE control.worker_job_schedules ADD CONSTRAINT worker_job_schedules_job_name_check
  CHECK (job_name IN (
    'max_inbox', 'sdk_inbox', 'adservices_lookup', 'integrity_verification',
    'google_play_verification', 'commerce_readback', 'google_conversion_delivery',
    'operator_webhook_delivery', 'operator_bulk_export', 'privacy_purge', 'metric_run',
    'fraud_maintenance', 'dashboard_session_sweep'
  ));

CREATE OR REPLACE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT registration.tenant_id
  FROM control.apple_app_registrations AS registration
  UNION
  SELECT batch.tenant_id
  FROM ledger.ingest_batches_current AS batch
  WHERE batch.status IN ('pending', 'processed')
  UNION
  SELECT lookup.tenant_id
  FROM ephemeral.adservices_lookups AS lookup
  UNION
  SELECT verification.tenant_id
  FROM ephemeral.google_play_product_verifications AS verification
  UNION
  SELECT delivery.tenant_id
  FROM ephemeral.google_conversion_deliveries AS delivery
  WHERE delivery.state IN ('queued','http_accepted','diagnostics_processing')
  UNION
  SELECT destination.tenant_id
  FROM control.operator_webhook_destinations_current AS destination
  WHERE destination.status='active'
  UNION
  SELECT delivery.tenant_id
  FROM ephemeral.operator_webhook_deliveries AS delivery
  WHERE delivery.state IN ('queued','retry')
  UNION
  SELECT destination.tenant_id
  FROM control.operator_bulk_export_destinations_current AS destination
  WHERE destination.status='active'
  UNION
  SELECT batch.tenant_id
  FROM ephemeral.operator_bulk_export_batches AS batch
  WHERE batch.state IN ('queued','retry')
  UNION
  SELECT job.tenant_id
  FROM control.privacy_deletion_jobs AS job
  WHERE job.status='processing'
  UNION
  SELECT schedule.tenant_id
  FROM control.metric_schedules_current AS schedule
  WHERE schedule.status='active'
  ORDER BY 1
$$;
