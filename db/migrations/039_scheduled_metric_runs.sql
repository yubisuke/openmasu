CREATE TABLE control.metric_schedules (
  metric_schedule_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  lag_days integer NOT NULL CHECK (lag_days BETWEEN 1 AND 365),
  start_date date NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, metric_schedule_id)
);

CREATE TABLE control.metric_schedule_states (
  metric_schedule_state_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME control.metric_schedule_state_seq) PRIMARY KEY,
  metric_schedule_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  changed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id, metric_schedule_id)
    REFERENCES control.metric_schedules (tenant_id, app_id, metric_schedule_id)
);

CREATE VIEW control.metric_schedules_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (schedule.metric_schedule_id)
  schedule.*, state.status, state.changed_at AS status_changed_at
FROM control.metric_schedules AS schedule
JOIN control.metric_schedule_states AS state
  USING (metric_schedule_id, tenant_id, app_id)
ORDER BY schedule.metric_schedule_id, state.metric_schedule_state_seq DESC;

CREATE TABLE control.metric_schedule_checkpoints (
  metric_schedule_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  last_target_date date,
  pending_target_date date,
  pending_watermark control.canonical_timestamp,
  pending_definition_digest text CHECK (
    pending_definition_digest IS NULL OR pending_definition_digest ~ '^[a-f0-9]{64}$'
  ),
  updated_at control.canonical_timestamp NOT NULL,
  CHECK (
    (pending_target_date IS NULL)
    = (pending_watermark IS NULL)
    AND (pending_target_date IS NULL)
    = (pending_definition_digest IS NULL)
  ),
  FOREIGN KEY (tenant_id, app_id, metric_schedule_id)
    REFERENCES control.metric_schedules (tenant_id, app_id, metric_schedule_id)
);

CREATE INDEX metric_schedules_active_idx
  ON control.metric_schedule_states (tenant_id, app_id, metric_schedule_id, metric_schedule_state_seq DESC);

ALTER TABLE control.metric_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_schedules_tenant ON control.metric_schedules
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.metric_schedule_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_schedule_states FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_schedule_states_tenant ON control.metric_schedule_states
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.metric_schedule_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_schedule_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_schedule_checkpoints_tenant ON control.metric_schedule_checkpoints
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER metric_schedules_append_only
  BEFORE UPDATE OR DELETE ON control.metric_schedules
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER metric_schedule_states_append_only
  BEFORE UPDATE OR DELETE ON control.metric_schedule_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON
  control.metric_schedules,
  control.metric_schedule_states,
  control.metric_schedule_checkpoints
FROM PUBLIC;

GRANT SELECT, INSERT ON
  control.metric_schedules,
  control.metric_schedule_states
TO openmasu_app;
GRANT SELECT, INSERT, UPDATE ON control.metric_schedule_checkpoints TO openmasu_app;
GRANT SELECT ON
  control.metric_schedules,
  control.metric_schedule_states,
  control.metric_schedule_checkpoints
TO openmasu_reader;
GRANT SELECT ON control.metric_schedules_current TO openmasu_app, openmasu_reader;
GRANT TRUNCATE ON
  control.metric_schedules,
  control.metric_schedule_states,
  control.metric_schedule_checkpoints
TO openmasu_seed;
GRANT USAGE, SELECT ON SEQUENCE control.metric_schedule_state_seq TO openmasu_app;
GRANT SELECT ON SEQUENCE control.metric_schedule_state_seq TO openmasu_reader;

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session',
    'apple_app_registration', 'conversion_schema', 'postback', 'rule_bundle',
    'server_key', 'webhook_destination', 'bulk_export_destination', 'metric_schedule'
  ));

ALTER TABLE control.worker_job_schedules DROP CONSTRAINT worker_job_schedules_job_name_check;
ALTER TABLE control.worker_job_schedules ADD CONSTRAINT worker_job_schedules_job_name_check
  CHECK (job_name IN (
    'max_inbox', 'sdk_inbox', 'adservices_lookup', 'integrity_verification',
    'google_play_verification', 'commerce_readback', 'google_conversion_delivery',
    'operator_webhook_delivery', 'operator_bulk_export', 'metric_run',
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
  SELECT schedule.tenant_id
  FROM control.metric_schedules_current AS schedule
  WHERE schedule.status='active'
  ORDER BY 1
$$;
