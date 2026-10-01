-- Private immutable configuration, append-only stop history and fenced progress.
CREATE TABLE control.cost_schedules (
  cost_schedule_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  created_at control.canonical_timestamp NOT NULL,
  UNIQUE (tenant_id,app_id,cost_schedule_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
CREATE TABLE control.cost_schedule_states (
  state_seq bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME control.cost_schedule_state_seq) PRIMARY KEY,
  cost_schedule_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active','disabled')),
  changed_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id,app_id,cost_schedule_id)
    REFERENCES control.cost_schedules (tenant_id,app_id,cost_schedule_id)
);
CREATE VIEW control.cost_schedules_current WITH (security_invoker=true) AS
SELECT DISTINCT ON (schedule.cost_schedule_id)
  schedule.cost_schedule_id,schedule.tenant_id,schedule.app_id,
  schedule.definition_digest,schedule.created_at,state.status,state.changed_at
FROM control.cost_schedules AS schedule JOIN control.cost_schedule_states AS state
  USING (tenant_id,app_id,cost_schedule_id)
ORDER BY schedule.cost_schedule_id,state.state_seq DESC;
CREATE TABLE control.cost_schedule_checkpoints (
  cost_schedule_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','processing','retry','failed','stopped')),
  last_target_date date,
  pending_since date,
  pending_until date,
  pending_as_of control.canonical_timestamp,
  pending_definition_digest text CHECK (pending_definition_digest ~ '^[a-f0-9]{64}$'),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_run_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  last_success_at control.canonical_timestamp,
  last_since date,
  last_until date,
  last_outcome text CHECK (last_outcome IN ('complete','empty')),
  last_row_count integer CHECK (last_row_count BETWEEN 0 AND 100000),
  last_snapshot_digest text CHECK (last_snapshot_digest ~ '^[a-f0-9]{64}$'),
  last_import_run_id uuid,
  safe_reason text CHECK (safe_reason IN ('source_unavailable','source_rejected','source_invalid','acquisition_timeout','retry_exhausted')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((pending_since IS NULL)=(pending_until IS NULL)
    AND (pending_since IS NULL)=(pending_as_of IS NULL)
    AND (pending_since IS NULL)=(pending_definition_digest IS NULL)),
  CHECK (pending_since IS NULL OR pending_since<=pending_until),
  FOREIGN KEY (tenant_id,app_id,cost_schedule_id)
    REFERENCES control.cost_schedules (tenant_id,app_id,cost_schedule_id)
);
CREATE INDEX cost_schedule_states_current_idx ON control.cost_schedule_states
  (tenant_id,app_id,cost_schedule_id,state_seq DESC);
CREATE INDEX cost_schedule_due_idx ON control.cost_schedule_checkpoints
  (tenant_id,state,next_attempt_at,next_run_at);
ALTER TABLE control.cost_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.cost_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY cost_schedules_tenant ON control.cost_schedules
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
ALTER TABLE control.cost_schedule_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.cost_schedule_states FORCE ROW LEVEL SECURITY;
CREATE POLICY cost_schedule_states_tenant ON control.cost_schedule_states
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
ALTER TABLE control.cost_schedule_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.cost_schedule_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY cost_schedule_checkpoints_tenant ON control.cost_schedule_checkpoints
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE POLICY cost_schedules_discovery_owner ON control.cost_schedules FOR SELECT TO openmasu_owner USING (true);
CREATE POLICY cost_schedule_states_discovery_owner ON control.cost_schedule_states FOR SELECT TO openmasu_owner USING (true);
CREATE TRIGGER cost_schedules_append_only BEFORE UPDATE OR DELETE ON control.cost_schedules
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER cost_schedule_states_append_only BEFORE UPDATE OR DELETE ON control.cost_schedule_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.cost_schedules,control.cost_schedule_states,control.cost_schedule_checkpoints FROM PUBLIC;
GRANT SELECT,INSERT ON control.cost_schedules,control.cost_schedule_states TO openmasu_app;
GRANT SELECT,INSERT,UPDATE ON control.cost_schedule_checkpoints TO openmasu_app;
GRANT SELECT (cost_schedule_id,tenant_id,app_id,definition_digest,created_at) ON control.cost_schedules TO openmasu_reader;
GRANT SELECT ON control.cost_schedule_states,control.cost_schedule_checkpoints,
  control.cost_schedules_current TO openmasu_reader;
GRANT SELECT ON control.cost_schedules_current TO openmasu_app;
GRANT USAGE,SELECT ON SEQUENCE control.cost_schedule_state_seq TO openmasu_app;
GRANT TRUNCATE ON control.cost_schedules,control.cost_schedule_states,control.cost_schedule_checkpoints TO openmasu_seed;
ALTER TABLE control.worker_job_schedules DROP CONSTRAINT worker_job_schedules_job_name_check;
ALTER TABLE control.worker_job_schedules ADD CONSTRAINT worker_job_schedules_job_name_check CHECK (job_name IN (
  'max_inbox','sdk_inbox','adservices_lookup','integrity_verification','google_play_verification',
  'commerce_readback','google_conversion_delivery','operator_webhook_delivery','operator_bulk_export',
  'privacy_purge','metric_run','cost_refresh','fraud_maintenance','dashboard_session_sweep'
));
CREATE OR REPLACE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT registration.tenant_id FROM control.apple_app_registrations AS registration
  UNION SELECT batch.tenant_id FROM ledger.ingest_batches_current AS batch
    WHERE batch.status='pending' OR (batch.status='processed' AND batch.reason_code='post_processing_pending')
  UNION SELECT lookup.tenant_id FROM ephemeral.adservices_lookups AS lookup
  UNION SELECT verification.tenant_id FROM ephemeral.integrity_verifications AS verification
  UNION SELECT verification.tenant_id FROM ephemeral.google_play_product_verifications AS verification
  UNION SELECT delivery.tenant_id FROM ephemeral.google_conversion_deliveries AS delivery
    WHERE delivery.state IN ('queued','http_accepted','diagnostics_processing')
  UNION SELECT readback.tenant_id FROM ephemeral.commerce_provider_readbacks AS readback
  UNION SELECT destination.tenant_id FROM control.operator_webhook_destinations_current AS destination WHERE destination.status='active'
  UNION SELECT delivery.tenant_id FROM ephemeral.operator_webhook_deliveries AS delivery WHERE delivery.state IN ('queued','retry')
  UNION SELECT destination.tenant_id FROM control.operator_bulk_export_destinations_current AS destination WHERE destination.status='active'
  UNION SELECT batch.tenant_id FROM ephemeral.operator_bulk_export_batches AS batch WHERE batch.state IN ('queued','retry')
  UNION SELECT job.tenant_id FROM control.privacy_deletion_jobs AS job WHERE job.status='processing'
  UNION SELECT schedule.tenant_id FROM control.metric_schedules_current AS schedule WHERE schedule.status='active'
  UNION SELECT schedule.tenant_id FROM control.cost_schedules_current AS schedule WHERE schedule.status='active'
  ORDER BY 1
$$;
