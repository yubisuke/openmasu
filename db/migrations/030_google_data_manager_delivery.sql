-- Tenant-scoped Google Data Manager destinations and durable outbound conversion delivery.
CREATE TABLE control.google_data_manager_destinations (
  destination_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  operating_account_id text NOT NULL CHECK (operating_account_id ~ '^[0-9]{1,32}$'),
  conversion_action_id text NOT NULL CHECK (conversion_action_id ~ '^[0-9]{1,32}$'),
  app_audience text NOT NULL CHECK (app_audience IN ('general','mixed','child_directed')),
  enabled boolean NOT NULL DEFAULT false,
  registered_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id)
);

CREATE TABLE ephemeral.google_conversion_deliveries (
  delivery_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id uuid NOT NULL REFERENCES control.google_data_manager_destinations (destination_id),
  verification_result_id uuid NOT NULL,
  verified_record_id control.identifier NOT NULL,
  request_ref text NOT NULL CHECK (request_ref LIKE 'encrypted:%'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  transaction_digest text NOT NULL CHECK (transaction_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'queued','http_accepted','diagnostics_processing',
    'succeeded','partial_success','failed','expired'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  provider_request_id text CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 256
  ),
  diagnostics_deadline_at timestamptz,
  safe_reason text CHECK (safe_reason IS NULL OR safe_reason ~ '^[a-z0-9_]{1,64}$'),
  created_at control.canonical_timestamp NOT NULL,
  updated_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (verification_result_id)
    REFERENCES ledger.google_play_purchase_verification_results (verification_result_id),
  UNIQUE (tenant_id, app_id, verification_result_id, destination_id),
  CHECK (
    (state IN ('http_accepted','diagnostics_processing','succeeded','partial_success')
      AND provider_request_id IS NOT NULL AND diagnostics_deadline_at IS NOT NULL)
    OR
    (state IN ('queued','failed','expired'))
  )
);

CREATE INDEX google_conversion_deliveries_due_idx
  ON ephemeral.google_conversion_deliveries (next_attempt_at, delivery_id)
  WHERE state IN ('queued','http_accepted','diagnostics_processing');

CREATE TABLE ledger.google_conversion_delivery_results (
  delivery_result_id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  state text NOT NULL CHECK (state IN (
    'queued','http_accepted','diagnostics_processing',
    'succeeded','partial_success','failed','expired'
  )),
  attempt integer NOT NULL CHECK (attempt >= 0),
  occurred_at control.canonical_timestamp NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  provider_request_id text CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 256
  ),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,64}$'),
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

ALTER TABLE control.google_data_manager_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_data_manager_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY google_data_manager_destinations_tenant
  ON control.google_data_manager_destinations
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ephemeral.google_conversion_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.google_conversion_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY google_conversion_deliveries_tenant
  ON ephemeral.google_conversion_deliveries
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
CREATE POLICY google_conversion_deliveries_discovery_owner
  ON ephemeral.google_conversion_deliveries FOR SELECT TO openmasu_owner
  USING (true);

ALTER TABLE ledger.google_conversion_delivery_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.google_conversion_delivery_results FORCE ROW LEVEL SECURITY;
CREATE POLICY google_conversion_delivery_results_tenant
  ON ledger.google_conversion_delivery_results
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER google_conversion_delivery_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.google_conversion_delivery_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON
  control.google_data_manager_destinations,
  ephemeral.google_conversion_deliveries,
  ledger.google_conversion_delivery_results
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON control.google_data_manager_destinations TO openmasu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.google_conversion_deliveries TO openmasu_app;
GRANT SELECT, INSERT ON ledger.google_conversion_delivery_results TO openmasu_app;
GRANT SELECT ON ledger.google_conversion_delivery_results TO openmasu_reader;
REVOKE SELECT ON control.google_data_manager_destinations FROM openmasu_reader;
REVOKE SELECT ON ephemeral.google_conversion_deliveries FROM openmasu_reader;
GRANT TRUNCATE ON
  control.google_data_manager_destinations,
  ephemeral.google_conversion_deliveries,
  ledger.google_conversion_delivery_results
TO openmasu_seed;

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
  ORDER BY 1
$$;

DROP INDEX ledger.audit_logs_job_health_idx;

CREATE INDEX audit_logs_job_health_idx
  ON ledger.audit_logs (tenant_id, actor_ref, outcome, occurred_at DESC)
  WHERE actor_type = 'system_job'
    AND action = 'job_completed'
    AND policy_version = 'job-health-v1'
    AND actor_ref IN (
      'job:mmp_import', 'job:cost_import', 'job:max_revenue_import',
      'job:google_conversion_delivery', 'job:metric_run'
    )
    AND outcome IN ('succeeded', 'failed')
    AND target_scope = 'app'
    AND app_id = target_ref
    AND (
      (outcome = 'succeeded' AND reason_code IS NULL)
      OR (outcome = 'failed' AND reason_code = 'job_failed')
    );
