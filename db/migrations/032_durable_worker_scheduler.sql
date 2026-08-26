CREATE TABLE control.worker_job_schedules (
  tenant_id control.identifier NOT NULL,
  job_name text NOT NULL CHECK (job_name IN (
    'max_inbox', 'sdk_inbox', 'adservices_lookup', 'integrity_verification',
    'google_play_verification', 'commerce_readback', 'google_conversion_delivery',
    'fraud_maintenance', 'dashboard_session_sweep'
  )),
  interval_ms integer NOT NULL CHECK (interval_ms BETWEEN 1000 AND 86400000),
  retry_ms integer NOT NULL CHECK (retry_ms BETWEEN 1000 AND 86400000),
  next_run_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome IN ('succeeded','failed')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  success_count bigint NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count bigint NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  PRIMARY KEY (tenant_id, job_name),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX worker_job_schedules_due_idx
  ON control.worker_job_schedules (next_run_at, lease_expires_at, tenant_id, job_name);

ALTER TABLE control.worker_job_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.worker_job_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_job_schedules_tenant ON control.worker_job_schedules
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

REVOKE ALL ON control.worker_job_schedules FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON control.worker_job_schedules TO openmasu_app;
GRANT SELECT ON control.worker_job_schedules TO openmasu_reader;
GRANT TRUNCATE ON control.worker_job_schedules TO openmasu_seed;
