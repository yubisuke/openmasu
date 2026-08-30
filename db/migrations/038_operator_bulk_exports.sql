CREATE TABLE control.operator_bulk_export_destinations (
  destination_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 1 AND 2048),
  bucket_name text NOT NULL CHECK (bucket_name ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  object_prefix text NOT NULL CHECK (length(object_prefix) BETWEEN 0 AND 512),
  region text NOT NULL CHECK (region ~ '^[a-z0-9-]{1,63}$'),
  allowed_events text[] NOT NULL CHECK (
    cardinality(allowed_events) BETWEEN 1 AND 5
    AND allowed_events <@ ARRAY[
      'session_start', 'custom_event', 'purchase', 'refund', 'ad_revenue'
    ]::text[]
  ),
  start_at control.canonical_timestamp NOT NULL,
  start_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(start_at)) STORED,
  credential_ref text NOT NULL,
  credential_digest text NOT NULL CHECK (credential_digest ~ '^[a-f0-9]{64}$'),
  reference_secret_ref text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, destination_id)
);

CREATE TABLE control.operator_bulk_export_destination_states (
  destination_state_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME control.operator_bulk_export_destination_state_seq) PRIMARY KEY,
  destination_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  changed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_bulk_export_destinations (tenant_id, app_id, destination_id)
);

CREATE VIEW control.operator_bulk_export_destinations_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (destination.destination_id)
  destination.*, state.status, state.changed_at AS status_changed_at
FROM control.operator_bulk_export_destinations AS destination
JOIN control.operator_bulk_export_destination_states AS state
  USING (destination_id, tenant_id, app_id)
ORDER BY destination.destination_id, state.destination_state_seq DESC;

CREATE TABLE control.operator_bulk_export_checkpoints (
  destination_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  event_received_at control.canonical_timestamp,
  event_received_at_ts timestamptz GENERATED ALWAYS AS (
    CASE WHEN event_received_at IS NULL THEN NULL
         ELSE control.canonical_timestamp_value(event_received_at) END
  ) STORED,
  event_record_id control.identifier,
  deletion_seq bigint NOT NULL DEFAULT 0 CHECK (deletion_seq >= 0),
  updated_at control.canonical_timestamp NOT NULL,
  CHECK ((event_received_at IS NULL) = (event_record_id IS NULL)),
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_bulk_export_destinations (tenant_id, app_id, destination_id)
);

CREATE TABLE ledger.operator_bulk_export_deletions (
  deletion_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME ledger.operator_bulk_export_deletion_seq) PRIMARY KEY,
  destination_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  privacy_request_id control.identifier NOT NULL,
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-f0-9]{64}$'),
  recognized_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_bulk_export_destinations (tenant_id, app_id, destination_id),
  UNIQUE (tenant_id, app_id, destination_id, privacy_request_id)
);

CREATE TABLE ephemeral.operator_bulk_export_batches (
  batch_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id control.identifier NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  object_ref text NOT NULL,
  object_digest text NOT NULL CHECK (object_digest ~ '^[a-f0-9]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 10000),
  event_received_at_before control.canonical_timestamp,
  event_record_id_before control.identifier,
  event_received_at_after control.canonical_timestamp,
  event_record_id_after control.identifier,
  deletion_seq_before bigint NOT NULL CHECK (deletion_seq_before >= 0),
  deletion_seq_after bigint NOT NULL CHECK (deletion_seq_after >= deletion_seq_before),
  state text NOT NULL CHECK (state IN ('queued','retry','succeeded','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 32),
  next_attempt_at timestamptz NOT NULL,
  last_http_status integer CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  safe_reason text,
  created_at control.canonical_timestamp NOT NULL,
  updated_at control.canonical_timestamp NOT NULL,
  CHECK ((event_received_at_before IS NULL) = (event_record_id_before IS NULL)),
  CHECK ((event_received_at_after IS NULL) = (event_record_id_after IS NULL)),
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_bulk_export_destinations (tenant_id, app_id, destination_id),
  UNIQUE (tenant_id, app_id, destination_id, object_key)
);

CREATE INDEX operator_bulk_export_batches_due_idx
  ON ephemeral.operator_bulk_export_batches (tenant_id, next_attempt_at, batch_id)
  WHERE state IN ('queued','retry');

CREATE TABLE ledger.operator_bulk_export_results (
  export_result_id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id control.identifier NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  object_digest text NOT NULL CHECK (object_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('retry','succeeded','failed','suppressed')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 32),
  occurred_at control.canonical_timestamp NOT NULL,
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  reason_code text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_bulk_export_destinations (tenant_id, app_id, destination_id)
);

ALTER TABLE control.operator_bulk_export_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_bulk_export_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_bulk_export_destinations_tenant ON control.operator_bulk_export_destinations
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.operator_bulk_export_destination_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_bulk_export_destination_states FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_bulk_export_destination_states_tenant ON control.operator_bulk_export_destination_states
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.operator_bulk_export_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_bulk_export_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_bulk_export_checkpoints_tenant ON control.operator_bulk_export_checkpoints
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.operator_bulk_export_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.operator_bulk_export_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_bulk_export_deletions_tenant ON ledger.operator_bulk_export_deletions
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ephemeral.operator_bulk_export_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.operator_bulk_export_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_bulk_export_batches_tenant ON ephemeral.operator_bulk_export_batches
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.operator_bulk_export_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.operator_bulk_export_results FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_bulk_export_results_tenant ON ledger.operator_bulk_export_results
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER operator_bulk_export_destinations_append_only
  BEFORE UPDATE OR DELETE ON control.operator_bulk_export_destinations
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER operator_bulk_export_destination_states_append_only
  BEFORE UPDATE OR DELETE ON control.operator_bulk_export_destination_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER operator_bulk_export_deletions_append_only
  BEFORE UPDATE OR DELETE ON ledger.operator_bulk_export_deletions
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER operator_bulk_export_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.operator_bulk_export_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON
  control.operator_bulk_export_destinations,
  control.operator_bulk_export_destination_states,
  control.operator_bulk_export_checkpoints,
  ledger.operator_bulk_export_deletions,
  ephemeral.operator_bulk_export_batches,
  ledger.operator_bulk_export_results
FROM PUBLIC;

GRANT SELECT, INSERT ON
  control.operator_bulk_export_destinations,
  control.operator_bulk_export_destination_states,
  ledger.operator_bulk_export_deletions,
  ledger.operator_bulk_export_results
TO openmasu_app;
GRANT SELECT, INSERT, UPDATE ON control.operator_bulk_export_checkpoints TO openmasu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.operator_bulk_export_batches TO openmasu_app;
GRANT SELECT ON
  control.operator_bulk_export_destinations,
  control.operator_bulk_export_destination_states,
  control.operator_bulk_export_checkpoints,
  ledger.operator_bulk_export_deletions,
  ephemeral.operator_bulk_export_batches,
  ledger.operator_bulk_export_results
TO openmasu_reader;
GRANT TRUNCATE ON
  control.operator_bulk_export_destinations,
  control.operator_bulk_export_destination_states,
  control.operator_bulk_export_checkpoints,
  ledger.operator_bulk_export_deletions,
  ephemeral.operator_bulk_export_batches,
  ledger.operator_bulk_export_results
TO openmasu_seed;
GRANT USAGE, SELECT ON SEQUENCE
  control.operator_bulk_export_destination_state_seq,
  ledger.operator_bulk_export_deletion_seq
TO openmasu_app;
GRANT SELECT ON SEQUENCE
  control.operator_bulk_export_destination_state_seq,
  ledger.operator_bulk_export_deletion_seq
TO openmasu_reader;

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session',
    'apple_app_registration', 'conversion_schema', 'postback', 'rule_bundle',
    'server_key', 'webhook_destination', 'bulk_export_destination'
  ));

ALTER TABLE control.worker_job_schedules DROP CONSTRAINT worker_job_schedules_job_name_check;
ALTER TABLE control.worker_job_schedules ADD CONSTRAINT worker_job_schedules_job_name_check
  CHECK (job_name IN (
    'max_inbox', 'sdk_inbox', 'adservices_lookup', 'integrity_verification',
    'google_play_verification', 'commerce_readback', 'google_conversion_delivery',
    'operator_webhook_delivery', 'operator_bulk_export', 'fraud_maintenance',
    'dashboard_session_sweep'
  ));

DROP INDEX ledger.audit_logs_job_health_idx;
CREATE INDEX audit_logs_job_health_idx
  ON ledger.audit_logs (tenant_id, actor_ref, outcome, occurred_at DESC)
  WHERE actor_type = 'system_job'
    AND action = 'job_completed'
    AND policy_version = 'job-health-v1'
    AND actor_ref IN (
      'job:mmp_import', 'job:cost_import', 'job:max_revenue_import',
      'job:google_conversion_delivery', 'job:operator_webhook_delivery',
      'job:operator_bulk_export', 'job:metric_run'
    )
    AND outcome IN ('succeeded', 'failed')
    AND target_scope = 'app'
    AND app_id = target_ref
    AND (
      (outcome = 'succeeded' AND reason_code IS NULL)
      OR (outcome = 'failed' AND reason_code = 'job_failed')
    );

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
  ORDER BY 1
$$;
