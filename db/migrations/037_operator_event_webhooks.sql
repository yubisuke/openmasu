CREATE TABLE control.operator_webhook_destinations (
  destination_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 1 AND 2048),
  allowed_events text[] NOT NULL CHECK (
    cardinality(allowed_events) BETWEEN 1 AND 5
    AND allowed_events <@ ARRAY[
      'session_start', 'custom_event', 'purchase', 'refund', 'ad_revenue'
    ]::text[]
  ),
  secret_ref text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, destination_id)
);

CREATE TABLE control.operator_webhook_destination_states (
  destination_state_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME control.operator_webhook_destination_state_seq) PRIMARY KEY,
  destination_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  changed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_webhook_destinations (tenant_id, app_id, destination_id)
);

CREATE VIEW control.operator_webhook_destinations_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (destination.destination_id)
  destination.*, state.status, state.changed_at AS status_changed_at
FROM control.operator_webhook_destinations AS destination
JOIN control.operator_webhook_destination_states AS state
  USING (destination_id, tenant_id, app_id)
ORDER BY destination.destination_id, state.destination_state_seq DESC;

CREATE TABLE ephemeral.operator_webhook_deliveries (
  delivery_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id control.identifier NOT NULL,
  logical_event_id text NOT NULL,
  record_id control.identifier NOT NULL,
  event_name text NOT NULL CHECK (
    event_name IN ('session_start', 'custom_event', 'purchase', 'refund', 'ad_revenue')
  ),
  request_ref text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('queued', 'retry', 'succeeded', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 32),
  next_attempt_at timestamptz NOT NULL,
  last_http_status integer CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  safe_reason text,
  created_at control.canonical_timestamp NOT NULL,
  updated_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_webhook_destinations (tenant_id, app_id, destination_id),
  FOREIGN KEY (tenant_id, app_id, logical_event_id)
    REFERENCES ledger.logical_events (tenant_id, app_id, logical_event_id),
  FOREIGN KEY (tenant_id, app_id, record_id)
    REFERENCES ledger.raw_records (tenant_id, app_id, record_id),
  UNIQUE (tenant_id, app_id, destination_id, logical_event_id)
);

CREATE INDEX operator_webhook_deliveries_due_idx
  ON ephemeral.operator_webhook_deliveries (tenant_id, next_attempt_at, delivery_id)
  WHERE state IN ('queued', 'retry');

CREATE INDEX operator_webhook_deliveries_record_idx
  ON ephemeral.operator_webhook_deliveries (tenant_id, app_id, record_id, state, delivery_id);

CREATE TABLE ledger.operator_webhook_delivery_results (
  delivery_result_id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id control.identifier NOT NULL,
  state text NOT NULL CHECK (state IN ('retry', 'succeeded', 'failed', 'suppressed')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 32),
  occurred_at control.canonical_timestamp NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  reason_code text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, destination_id)
    REFERENCES control.operator_webhook_destinations (tenant_id, app_id, destination_id)
);

ALTER TABLE control.operator_webhook_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_webhook_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_webhook_destinations_tenant ON control.operator_webhook_destinations
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.operator_webhook_destination_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_webhook_destination_states FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_webhook_destination_states_tenant ON control.operator_webhook_destination_states
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ephemeral.operator_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.operator_webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_webhook_deliveries_tenant ON ephemeral.operator_webhook_deliveries
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.operator_webhook_delivery_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.operator_webhook_delivery_results FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_webhook_delivery_results_tenant ON ledger.operator_webhook_delivery_results
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER operator_webhook_destinations_append_only
  BEFORE UPDATE OR DELETE ON control.operator_webhook_destinations
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER operator_webhook_destination_states_append_only
  BEFORE UPDATE OR DELETE ON control.operator_webhook_destination_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER operator_webhook_delivery_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.operator_webhook_delivery_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON
  control.operator_webhook_destinations,
  control.operator_webhook_destination_states,
  ephemeral.operator_webhook_deliveries,
  ledger.operator_webhook_delivery_results
FROM PUBLIC;

GRANT SELECT, INSERT ON
  control.operator_webhook_destinations,
  control.operator_webhook_destination_states
TO openmasu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.operator_webhook_deliveries TO openmasu_app;
GRANT SELECT ON ephemeral.operator_webhook_deliveries TO openmasu_reader;
GRANT SELECT, INSERT ON ledger.operator_webhook_delivery_results TO openmasu_app;
GRANT SELECT ON
  control.operator_webhook_destinations,
  control.operator_webhook_destination_states,
  ledger.operator_webhook_delivery_results
TO openmasu_reader;
GRANT TRUNCATE ON
  control.operator_webhook_destinations,
  control.operator_webhook_destination_states,
  ephemeral.operator_webhook_deliveries,
  ledger.operator_webhook_delivery_results
TO openmasu_seed;
GRANT USAGE, SELECT ON SEQUENCE control.operator_webhook_destination_state_seq TO openmasu_app;
GRANT SELECT ON SEQUENCE control.operator_webhook_destination_state_seq TO openmasu_reader;

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session',
    'apple_app_registration', 'conversion_schema', 'postback', 'rule_bundle',
    'server_key', 'webhook_destination'
  ));

ALTER TABLE control.worker_job_schedules DROP CONSTRAINT worker_job_schedules_job_name_check;
ALTER TABLE control.worker_job_schedules ADD CONSTRAINT worker_job_schedules_job_name_check
  CHECK (job_name IN (
    'max_inbox', 'sdk_inbox', 'adservices_lookup', 'integrity_verification',
    'google_play_verification', 'commerce_readback', 'google_conversion_delivery',
    'operator_webhook_delivery', 'fraud_maintenance', 'dashboard_session_sweep'
  ));

DROP INDEX ledger.audit_logs_job_health_idx;
CREATE INDEX audit_logs_job_health_idx
  ON ledger.audit_logs (tenant_id, actor_ref, outcome, occurred_at DESC)
  WHERE actor_type = 'system_job'
    AND action = 'job_completed'
    AND policy_version = 'job-health-v1'
    AND actor_ref IN (
      'job:mmp_import', 'job:cost_import', 'job:max_revenue_import',
      'job:google_conversion_delivery', 'job:operator_webhook_delivery', 'job:metric_run'
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
  ORDER BY 1
$$;
