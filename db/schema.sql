-- OpenMasu schema snapshot.
-- Generated deterministically from db/migrations; do not edit by hand.
-- 001_initial_ledger.sql
CREATE SCHEMA control AUTHORIZATION openmasu_owner;
CREATE SCHEMA ledger AUTHORIZATION openmasu_owner;

REVOKE ALL ON SCHEMA control, ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA control, ledger TO openmasu_app, openmasu_reader;
GRANT USAGE ON SCHEMA ledger TO openmasu_seed;

CREATE DOMAIN control.identifier AS text
  CHECK (VALUE ~ '^[A-Za-z0-9._:-]{1,128}$');

CREATE DOMAIN control.canonical_timestamp AS text
  CHECK (VALUE ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$');

CREATE FUNCTION control.canonical_timestamp_value(value control.canonical_timestamp)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$ SELECT value::text::timestamptz $$;

CREATE TABLE control.apps (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (tenant_id, app_id)
);

CREATE TABLE control.import_runs (
  import_run_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_id control.identifier NOT NULL,
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  started_at control.canonical_timestamp NOT NULL,
  completed_at control.canonical_timestamp,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.raw_records (
  ledger_seq bigint GENERATED ALWAYS AS IDENTITY,
  record_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  producer control.identifier NOT NULL,
  producer_version text NOT NULL,
  event_id control.identifier NOT NULL,
  delivery_id control.identifier NOT NULL,
  event_name control.identifier NOT NULL,
  schema_version text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_source text NOT NULL,
  received_at control.canonical_timestamp NOT NULL,
  received_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(received_at)) STORED,
  raw_payload_ref text NOT NULL,
  processing_purpose_id control.identifier,
  consent_evaluation_policy_version text NOT NULL,
  consent_decision_reason_code text NOT NULL,
  withdrawal_recognized_at control.canonical_timestamp,
  alternative_legal_basis_id control.identifier,
  alternative_legal_basis_policy_version text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, record_id)
);

CREATE INDEX raw_records_snapshot_idx
  ON ledger.raw_records (tenant_id, app_id, received_at, record_id);

CREATE TABLE ledger.raw_payload_states (
  state_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  record_id control.identifier NOT NULL,
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('available', 'redacted', 'purged')),
  changed_at control.canonical_timestamp NOT NULL,
  privacy_request_id control.identifier,
  privacy_tombstone_id control.identifier,
  UNIQUE (record_id, lifecycle_status),
  FOREIGN KEY (tenant_id, app_id, record_id)
    REFERENCES ledger.raw_records (tenant_id, app_id, record_id)
);

CREATE VIEW ledger.raw_records_current
WITH (security_invoker = true)
AS
SELECT
  r.*,
  s.lifecycle_status AS payload_lifecycle_status
FROM ledger.raw_records AS r
JOIN LATERAL (
  SELECT state.lifecycle_status
  FROM ledger.raw_payload_states AS state
  WHERE state.record_id = r.record_id
    AND state.tenant_id = r.tenant_id
    AND state.app_id = r.app_id
  ORDER BY state.state_seq DESC
  LIMIT 1
) AS s ON true;

CREATE TABLE ledger.event_deliveries (
  delivery_attempt_id uuid PRIMARY KEY,
  ledger_seq bigint GENERATED ALWAYS AS IDENTITY,
  delivery_id control.identifier NOT NULL,
  record_id control.identifier NOT NULL,
  canonical_record_id control.identifier,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  received_at control.canonical_timestamp NOT NULL,
  received_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(received_at)) STORED,
  ingestion_status text NOT NULL,
  duplicate_resolution text NOT NULL,
  timeliness text NOT NULL,
  clock_skew_suspected boolean NOT NULL,
  payload_disposition text NOT NULL,
  reason_code text,
  processing_purpose_id control.identifier,
  consent_evaluation_policy_version text NOT NULL,
  consent_decision_reason_code text NOT NULL,
  withdrawal_recognized_at control.canonical_timestamp,
  alternative_legal_basis_id control.identifier,
  alternative_legal_basis_policy_version text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX event_deliveries_evidence_idx
  ON ledger.event_deliveries (tenant_id, app_id, delivery_id);

CREATE TABLE ledger.logical_events (
  logical_event_id text PRIMARY KEY,
  record_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  producer control.identifier NOT NULL,
  event_id control.identifier NOT NULL,
  event_name control.identifier NOT NULL,
  record_lifecycle text NOT NULL DEFAULT 'active',
  timeliness text NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, record_id)
    REFERENCES ledger.raw_records (tenant_id, app_id, record_id),
  CONSTRAINT logical_events_idempotency UNIQUE (tenant_id, app_id, producer, event_id),
  UNIQUE (tenant_id, app_id, logical_event_id)
);

CREATE TABLE ledger.click_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  click_id text NOT NULL,
  redirector_click_at control.canonical_timestamp,
  artifact jsonb NOT NULL
);

CREATE INDEX click_facts_lookup_idx
  ON ledger.click_facts (tenant_id, app_id, click_id);

CREATE TABLE ledger.install_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text NOT NULL,
  prior_installation_id text,
  install_type text NOT NULL,
  click_id text,
  install_begin_at_server control.canonical_timestamp,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, installation_id)
);

CREATE TABLE ledger.session_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text NOT NULL,
  session_id text NOT NULL,
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  artifact jsonb NOT NULL
);

CREATE TABLE ledger.purchase_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text,
  transaction_id text NOT NULL,
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  artifact jsonb NOT NULL
);

CREATE TABLE ledger.ad_revenue_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text,
  anchor_source text,
  impression_id text,
  ad_unit_id text,
  ad_network text,
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  revenue_source text NOT NULL,
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  artifact jsonb NOT NULL
);

CREATE INDEX ad_revenue_facts_time_idx
  ON ledger.ad_revenue_facts (tenant_id, app_id, occurred_at_ts);

CREATE TABLE ledger.corrections (
  correction_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  corrects_record_id control.identifier NOT NULL,
  effective_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.rejections (
  rejection_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  delivery_id control.identifier NOT NULL,
  record_id control.identifier NOT NULL,
  reason_code text NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.privacy_requests (
  privacy_request_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  requested_at control.canonical_timestamp NOT NULL,
  completed_at control.canonical_timestamp,
  status text NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.privacy_tombstones (
  privacy_tombstone_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  privacy_request_id control.identifier,
  record_id control.identifier NOT NULL,
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('redacted', 'purged')),
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, privacy_request_id, record_id, lifecycle_status)
);

CREATE TABLE ledger.attribution_results (
  attribution_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_scope text NOT NULL,
  subject_ref text,
  effective_at control.canonical_timestamp NOT NULL,
  decided_at control.canonical_timestamp NOT NULL,
  status text NOT NULL,
  method text NOT NULL,
  model text NOT NULL,
  reason_code text NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.fraud_decisions (
  fraud_decision_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_ref text NOT NULL,
  decision text NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  evaluated_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.metric_runs (
  metric_run_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  metric_name text NOT NULL,
  metric_definition_version text NOT NULL,
  grouping jsonb NOT NULL DEFAULT '{}'::jsonb,
  grouping_digest text NOT NULL CHECK (grouping_digest ~ '^[0-9a-f]{64}$'),
  input_snapshot_id text NOT NULL CHECK (input_snapshot_id ~ '^[0-9a-f]{64}$'),
  input_received_at_watermark control.canonical_timestamp NOT NULL,
  input_ledger_position text NOT NULL,
  computed_at control.canonical_timestamp NOT NULL,
  data_freshness text NOT NULL,
  aggregation_time_zone text NOT NULL,
  rule_bundle_id text NOT NULL,
  rule_bundle_version text NOT NULL,
  rule_bundle_hash text NOT NULL CHECK (rule_bundle_hash ~ '^[0-9a-f]{64}$'),
  fx_rate_unscaled text,
  fx_rate_scale integer,
  fx_rate_source text,
  fx_rate_as_of control.canonical_timestamp,
  fx_rate_snapshot_id text,
  fx_policy_version text,
  rounding_mode text NOT NULL,
  reproducibility_status text NOT NULL,
  value_type text NOT NULL,
  value_unscaled text NOT NULL,
  amount_scale integer,
  currency text,
  supersedes_metric_run_id text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, metric_name, metric_definition_version, grouping_digest, input_snapshot_id)
);

CREATE TABLE ledger.cost_records (
  cost_record_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  network text NOT NULL,
  campaign_id text,
  ad_group_id text,
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  cost_date date NOT NULL,
  spend_unscaled text NOT NULL CHECK (spend_unscaled ~ '^[0-9]+$'),
  spend_scale integer NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source text NOT NULL,
  as_of control.canonical_timestamp NOT NULL,
  report_snapshot_digest text NOT NULL CHECK (report_snapshot_digest ~ '^[0-9a-f]{64}$'),
  cost_key_digest text NOT NULL CHECK (cost_key_digest ~ '^[0-9a-f]{64}$'),
  import_run_id uuid NOT NULL REFERENCES control.import_runs (import_run_id),
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, cost_key_digest, as_of)
);

CREATE VIEW ledger.cost_records_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (tenant_id, app_id, cost_key_digest) *
FROM ledger.cost_records
ORDER BY tenant_id, app_id, cost_key_digest, as_of DESC, cost_record_id;

CREATE TABLE ledger.audit_logs (
  audit_log_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier,
  occurred_at control.canonical_timestamp NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('admin_key', 'system_job')),
  actor_ref text NOT NULL,
  action text NOT NULL,
  target_scope text NOT NULL CHECK (target_scope IN ('tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source', 'admin_key')),
  target_ref text NOT NULL,
  policy_version text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  reason_code text
);

CREATE FUNCTION ledger.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %.% rejects %', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'raw_records', 'raw_payload_states', 'event_deliveries', 'logical_events',
    'click_facts', 'install_facts', 'session_facts', 'purchase_facts',
    'ad_revenue_facts', 'corrections', 'rejections', 'privacy_requests',
    'privacy_tombstones', 'attribution_results', 'fraud_decisions',
    'metric_runs', 'cost_records', 'audit_logs'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON ledger.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation()',
      table_name,
      table_name
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT columns.table_schema, columns.table_name
    FROM information_schema.columns AS columns
    JOIN information_schema.tables AS tables
      ON tables.table_schema = columns.table_schema
     AND tables.table_name = columns.table_name
     AND tables.table_type = 'BASE TABLE'
    WHERE columns.table_schema IN ('control', 'ledger')
      AND columns.column_name = 'tenant_id'
    GROUP BY columns.table_schema, columns.table_name
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''openmasu.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''openmasu.tenant_id'', true))',
      item.table_name,
      item.table_schema,
      item.table_name
    );
  END LOOP;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA control, ledger FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control, ledger FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control, ledger FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.canonical_timestamp_value(control.canonical_timestamp)
  TO openmasu_app, openmasu_reader;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA control, ledger TO openmasu_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control, ledger TO openmasu_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA control, ledger FROM openmasu_app;
GRANT TRUNCATE ON ALL TABLES IN SCHEMA ledger TO openmasu_seed;
GRANT SELECT ON ALL TABLES IN SCHEMA control, ledger TO openmasu_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA control, ledger TO openmasu_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE openmasu_owner IN SCHEMA control, ledger
  GRANT SELECT, INSERT ON TABLES TO openmasu_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openmasu_owner IN SCHEMA control, ledger
  GRANT USAGE, SELECT ON SEQUENCES TO openmasu_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openmasu_owner IN SCHEMA control, ledger
  GRANT SELECT ON TABLES TO openmasu_reader;

-- 002_fixture_parity.sql
CREATE SCHEMA testing AUTHORIZATION openmasu_owner;
REVOKE ALL ON SCHEMA testing FROM PUBLIC;

CREATE TABLE testing.fixture_inputs (
  fixture_name text PRIMARY KEY,
  input_digest character(64) NOT NULL,
  input jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE testing.fixture_runs (
  fixture_name text PRIMARY KEY REFERENCES testing.fixture_inputs (fixture_name),
  input_digest character(64) NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE testing.fixture_attempts (
  fixture_name text NOT NULL REFERENCES testing.fixture_inputs (fixture_name) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  batch_id text NOT NULL,
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  record_id text NOT NULL,
  producer text NOT NULL,
  event_id text NOT NULL,
  click_id text,
  server_context jsonb NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (fixture_name, ordinal)
);

CREATE INDEX fixture_attempts_record_idx
  ON testing.fixture_attempts (fixture_name, record_id);
CREATE INDEX fixture_attempts_logical_scope_idx
  ON testing.fixture_attempts (fixture_name, tenant_id, app_id, producer, event_id);
CREATE INDEX fixture_attempts_click_idx
  ON testing.fixture_attempts (fixture_name, tenant_id, app_id, click_id)
  WHERE click_id IS NOT NULL;

CREATE TABLE testing.fixture_artifacts (
  fixture_name text NOT NULL REFERENCES testing.fixture_runs (fixture_name) ON DELETE CASCADE,
  artifact_kind text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_table text NOT NULL,
  artifact_digest character(64) NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (fixture_name, artifact_kind, ordinal)
);

REVOKE ALL ON ALL TABLES IN SCHEMA testing FROM PUBLIC;
GRANT USAGE ON SCHEMA testing TO openmasu_seed;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA testing TO openmasu_seed;

-- 003_import_foundation.sql
CREATE TABLE control.import_files (
  import_file_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_id control.identifier NOT NULL,
  file_digest text NOT NULL CHECK (file_digest ~ '^[0-9a-f]{64}$'),
  file_bytes bigint NOT NULL CHECK (file_bytes >= 0),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  first_seen_at control.canonical_timestamp NOT NULL,
  import_run_id uuid NOT NULL REFERENCES control.import_runs (import_run_id),
  UNIQUE (tenant_id, app_id, source_id, file_digest),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.import_attempts (
  import_attempt_id uuid PRIMARY KEY,
  import_run_id uuid NOT NULL REFERENCES control.import_runs (import_run_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_id control.identifier NOT NULL,
  row_ordinal bigint NOT NULL CHECK (row_ordinal >= 0),
  server_context jsonb NOT NULL,
  record jsonb NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX import_attempts_scope_idx
  ON control.import_attempts (tenant_id, app_id, source_id, row_ordinal);

CREATE TABLE control.import_row_rejections (
  import_rejection_id uuid PRIMARY KEY,
  import_run_id uuid NOT NULL REFERENCES control.import_runs (import_run_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_id control.identifier NOT NULL,
  row_ordinal bigint NOT NULL CHECK (row_ordinal >= 0),
  reason_code text NOT NULL CHECK (reason_code IN (
    'mapping_validation_failed', 'row_schema_invalid', 'timestamp_invalid',
    'row_too_large', 'unsupported_event_type'
  )),
  field_names jsonb NOT NULL,
  occurred_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.ingest_inbox (
  inbox_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  producer control.identifier NOT NULL,
  event_id control.identifier NOT NULL,
  token_mode text NOT NULL CHECK (token_mode IN ('all', 'event', 'reporting_api')),
  received_at control.canonical_timestamp NOT NULL,
  raw_query_ref text NOT NULL,
  raw_query_digest text NOT NULL CHECK (raw_query_digest ~ '^[0-9a-f]{64}$'),
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.ingest_inbox_states (
  inbox_state_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbox_id uuid NOT NULL REFERENCES ledger.ingest_inbox (inbox_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processed', 'rejected')),
  changed_at control.canonical_timestamp NOT NULL,
  reason_code text,
  artifact jsonb NOT NULL,
  UNIQUE (inbox_id, status),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE VIEW ledger.ingest_inbox_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (inbox.tenant_id, inbox.app_id, inbox.inbox_id)
  inbox.*,
  state.status,
  state.changed_at AS status_changed_at,
  state.reason_code
FROM ledger.ingest_inbox AS inbox
JOIN ledger.ingest_inbox_states AS state
  ON state.inbox_id = inbox.inbox_id
 AND state.tenant_id = inbox.tenant_id
 AND state.app_id = inbox.app_id
ORDER BY inbox.tenant_id, inbox.app_id, inbox.inbox_id, state.inbox_state_seq DESC;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('control', 'import_files'),
      ('control', 'import_attempts'),
      ('control', 'import_row_rejections'),
      ('ledger', 'ingest_inbox'),
      ('ledger', 'ingest_inbox_states')
    ) AS values_to_secure(table_schema, table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''openmasu.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''openmasu.tenant_id'', true))',
      item.table_name,
      item.table_schema,
      item.table_name
    );
  END LOOP;
END
$$;

CREATE TRIGGER ingest_inbox_append_only
  BEFORE UPDATE OR DELETE ON ledger.ingest_inbox
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER ingest_inbox_states_append_only
  BEFORE UPDATE OR DELETE ON ledger.ingest_inbox_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.import_files, control.import_attempts, control.import_row_rejections,
  ledger.ingest_inbox, ledger.ingest_inbox_states FROM PUBLIC;
GRANT SELECT, INSERT ON control.import_files, control.import_attempts, control.import_row_rejections,
  ledger.ingest_inbox, ledger.ingest_inbox_states TO openmasu_app;
GRANT SELECT ON control.import_files, control.import_attempts, control.import_row_rejections,
  ledger.ingest_inbox, ledger.ingest_inbox_states TO openmasu_reader;
GRANT USAGE, SELECT ON SEQUENCE ledger.ingest_inbox_states_inbox_state_seq_seq TO openmasu_app;
GRANT SELECT ON SEQUENCE ledger.ingest_inbox_states_inbox_state_seq_seq TO openmasu_reader;
GRANT TRUNCATE ON ledger.ingest_inbox, ledger.ingest_inbox_states TO openmasu_seed;

-- 004_admin_privacy.sql
CREATE TABLE control.admin_keys (
  key_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  scrypt_salt text NOT NULL CHECK (scrypt_salt ~ '^[a-f0-9]{32}$'),
  scrypt_digest text NOT NULL CHECK (scrypt_digest ~ '^[a-f0-9]{64}$'),
  created_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.admin_key_states (
  admin_key_state_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id control.identifier NOT NULL REFERENCES control.admin_keys (key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  changed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (key_id, status),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE VIEW control.admin_keys_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (key.key_id)
  key.*, state.status, state.changed_at AS status_changed_at
FROM control.admin_keys AS key
JOIN control.admin_key_states AS state ON state.key_id = key.key_id
ORDER BY key.key_id, state.admin_key_state_seq DESC;

ALTER TABLE control.admin_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.admin_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_keys_tenant ON control.admin_keys
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));
ALTER TABLE control.admin_key_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.admin_key_states FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_key_states_tenant ON control.admin_key_states
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

CREATE TRIGGER admin_keys_append_only
  BEFORE UPDATE OR DELETE ON control.admin_keys
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER admin_key_states_append_only
  BEFORE UPDATE OR DELETE ON control.admin_key_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.admin_keys, control.admin_key_states FROM PUBLIC;
GRANT SELECT, INSERT ON control.admin_keys, control.admin_key_states TO openmasu_app;
GRANT USAGE, SELECT ON SEQUENCE control.admin_key_states_admin_key_state_seq_seq TO openmasu_app;

GRANT TRUNCATE ON control.admin_keys, control.admin_key_states TO openmasu_seed;

-- 005_metric_engine.sql
ALTER TABLE ledger.install_facts
  ADD COLUMN occurred_at control.canonical_timestamp,
  ADD COLUMN occurred_at_ts timestamptz
    GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  ADD COLUMN campaign_id text,
  ADD COLUMN network text,
  ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

CREATE INDEX install_facts_cohort_idx
  ON ledger.install_facts (tenant_id, app_id, campaign_id, country, occurred_at_ts);

CREATE INDEX session_facts_activity_idx
  ON ledger.session_facts (tenant_id, app_id, installation_id, occurred_at_ts);

CREATE INDEX cost_records_watermark_idx
  ON ledger.cost_records (tenant_id, app_id, cost_key_digest, as_of, cost_record_id);

CREATE FUNCTION ledger.half_even_div(numerator numeric, denominator numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  absolute_numerator numeric;
  quotient numeric;
  remainder numeric;
  rounded numeric;
BEGIN
  IF denominator <= 0 OR denominator <> trunc(denominator) THEN
    RAISE EXCEPTION 'half_even_div denominator must be a positive integer';
  END IF;
  IF numerator <> trunc(numerator) THEN
    RAISE EXCEPTION 'half_even_div numerator must be an integer';
  END IF;

  absolute_numerator := abs(numerator);
  quotient := trunc(absolute_numerator / denominator);
  remainder := mod(absolute_numerator, denominator);
  rounded := quotient;

  IF remainder * 2 > denominator
    OR (remainder * 2 = denominator AND mod(quotient, 2) = 1)
  THEN
    rounded := quotient + 1;
  END IF;

  IF numerator < 0 THEN
    RETURN -rounded;
  END IF;
  RETURN rounded;
END
$$;

REVOKE ALL ON FUNCTION ledger.half_even_div(numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.half_even_div(numeric, numeric)
  TO openmasu_app, openmasu_reader, openmasu_seed;

-- 006_metric_engine_indexes.sql
CREATE INDEX ad_revenue_facts_installation_time_idx
  ON ledger.ad_revenue_facts (tenant_id, app_id, installation_id, occurred_at_ts);

-- 007_metric_snapshots.sql
ALTER TABLE ledger.raw_records
  ADD COLUMN policy_digest text CHECK (policy_digest IS NULL OR length(policy_digest) > 0);

CREATE INDEX raw_records_metric_snapshot_idx
  ON ledger.raw_records (tenant_id, app_id, received_at, record_id)
  INCLUDE (policy_digest);

COMMENT ON COLUMN ledger.raw_records.policy_digest IS
  'Server policy digest used by M1b snapshot identity. NULL marks pre-M1b rows that cannot be recomputed.';

-- 008_reporting_audit.sql
ALTER TABLE ledger.metric_runs
  ALTER COLUMN value_unscaled DROP NOT NULL,
  ADD COLUMN value_state text NOT NULL DEFAULT 'present'
    CHECK (value_state IN ('present', 'undefined')),
  ADD COLUMN undefined_reason text
    CHECK (undefined_reason IS NULL OR undefined_reason IN (
      'no_attributed_cost', 'no_activity_events', 'empty_cohort'
    ));

ALTER TABLE ledger.metric_runs
  ALTER COLUMN value_state DROP DEFAULT,
  ADD CONSTRAINT metric_runs_value_presence_check CHECK (
    (value_state='present' AND value_unscaled IS NOT NULL AND undefined_reason IS NULL)
    OR (value_state='undefined' AND value_unscaled IS NULL AND undefined_reason IS NOT NULL)
  );

CREATE TABLE ledger.reconciliation_results (
  reconciliation_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  input_snapshot_id control.identifier NOT NULL,
  external_snapshot_id control.identifier NOT NULL,
  difference_reason_code text NOT NULL,
  difference_reason_version text NOT NULL,
  freshness text NOT NULL CHECK (freshness IN ('current', 'stale', 'recalculated')),
  supersedes_reconciliation_id control.identifier,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX reconciliation_results_scope_idx
  ON ledger.reconciliation_results (tenant_id, app_id, difference_reason_code, reconciliation_id);

ALTER TABLE ledger.reconciliation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.reconciliation_results FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_results_tenant ON ledger.reconciliation_results
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

CREATE TRIGGER reconciliation_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.reconciliation_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.reconciliation_results FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.reconciliation_results TO openmasu_app;
GRANT SELECT ON ledger.reconciliation_results TO openmasu_reader;
GRANT TRUNCATE ON ledger.reconciliation_results TO openmasu_seed;

-- 009_m2a_server_foundation.sql
CREATE SCHEMA ephemeral AUTHORIZATION openmasu_owner;

REVOKE ALL ON SCHEMA ephemeral FROM PUBLIC;
GRANT USAGE ON SCHEMA ephemeral TO openmasu_app;

CREATE TABLE control.tracking_links (
  tracking_link_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[A-Za-z0-9_-]{12,64}$'),
  destination_kind text NOT NULL CHECK (destination_kind IN ('play_store', 'custom_https')),
  destination_url text NOT NULL CHECK (length(destination_url) BETWEEN 1 AND 2048),
  play_package_name text CHECK (play_package_name IS NULL OR play_package_name ~ '^[A-Za-z][A-Za-z0-9_.]{2,254}$'),
  network control.identifier,
  site_id control.identifier,
  campaign_id control.identifier,
  ad_group_id control.identifier,
  creative_id control.identifier,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CHECK (
    (destination_kind='play_store' AND play_package_name IS NOT NULL)
    OR (destination_kind='custom_https' AND play_package_name IS NULL)
  )
);

CREATE TABLE control.tracking_link_states (
  tracking_link_state_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tracking_link_id control.identifier NOT NULL REFERENCES control.tracking_links (tracking_link_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  changed_at control.canonical_timestamp NOT NULL,
  reason_code text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE VIEW control.tracking_links_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (link.tracking_link_id)
  link.*, state.status, state.changed_at AS status_changed_at, state.reason_code
FROM control.tracking_links AS link
JOIN control.tracking_link_states AS state USING (tracking_link_id, tenant_id, app_id)
ORDER BY link.tracking_link_id, state.tracking_link_state_seq DESC;

CREATE TABLE control.sdk_keys (
  sdk_key_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  secret_ref text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.sdk_key_states (
  sdk_key_state_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sdk_key_id control.identifier NOT NULL REFERENCES control.sdk_keys (sdk_key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  changed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE VIEW control.sdk_keys_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (key.sdk_key_id)
  key.*, state.status, state.changed_at AS status_changed_at
FROM control.sdk_keys AS key
JOIN control.sdk_key_states AS state USING (sdk_key_id, tenant_id, app_id)
ORDER BY key.sdk_key_id, state.sdk_key_state_seq DESC;

CREATE TABLE control.installation_credentials (
  installation_key_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id_digest text NOT NULL CHECK (installation_id_digest ~ '^[a-f0-9]{64}$'),
  sdk_key_id control.identifier NOT NULL REFERENCES control.sdk_keys (sdk_key_id),
  secret_ref text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, installation_id_digest),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.installation_credential_states (
  installation_credential_state_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME control.installation_credential_state_seq) PRIMARY KEY,
  installation_key_id control.identifier NOT NULL REFERENCES control.installation_credentials (installation_key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'deleted')),
  changed_at control.canonical_timestamp NOT NULL,
  reason_code text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE VIEW control.installation_credentials_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (credential.installation_key_id)
  credential.*, state.status, state.changed_at AS status_changed_at, state.reason_code
FROM control.installation_credentials AS credential
JOIN control.installation_credential_states AS state USING (installation_key_id, tenant_id, app_id)
ORDER BY credential.installation_key_id, state.installation_credential_state_seq DESC;

CREATE TABLE ephemeral.request_nonces (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('sdk_key', 'installation')),
  principal_key_id control.identifier NOT NULL,
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{22,128}$'),
  timestamp_ms bigint NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, app_id, principal_type, principal_key_id, nonce),
  CHECK (expires_at > created_at),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX request_nonces_expiry_idx ON ephemeral.request_nonces (expires_at);

CREATE TABLE ledger.ingest_batches (
  inbox_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  ingest_batch_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  producer control.identifier NOT NULL,
  sdk_key_id control.identifier,
  installation_key_id control.identifier,
  received_at control.canonical_timestamp NOT NULL,
  body_ref text NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  event_count integer NOT NULL CHECK (event_count BETWEEN 1 AND 100),
  request_nonce text,
  request_timestamp_ms bigint,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX ingest_batches_drain_idx
  ON ledger.ingest_batches (tenant_id, app_id, received_at, inbox_seq);

CREATE TABLE ledger.ingest_batch_states (
  ingest_batch_state_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingest_batch_id uuid NOT NULL REFERENCES ledger.ingest_batches (ingest_batch_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
  changed_at control.canonical_timestamp NOT NULL,
  reason_code text,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.ingest_batch_records (
  ingest_batch_id uuid NOT NULL REFERENCES ledger.ingest_batches (ingest_batch_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  record_id control.identifier NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (ingest_batch_id, record_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ledger.custom_event_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text NOT NULL,
  event_key control.identifier NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE VIEW ledger.ingest_batches_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (batch.ingest_batch_id)
  batch.*, state.status, state.changed_at AS status_changed_at, state.reason_code
FROM ledger.ingest_batches AS batch
JOIN ledger.ingest_batch_states AS state USING (ingest_batch_id, tenant_id, app_id)
ORDER BY batch.ingest_batch_id, state.ingest_batch_state_seq DESC;

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_actor_type_check
  CHECK (actor_type IN ('admin_key', 'system_job', 'sdk_key', 'sdk_installation'));
ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch'
  ));

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('control', 'tracking_links'),
      ('control', 'tracking_link_states'),
      ('control', 'sdk_keys'),
      ('control', 'sdk_key_states'),
      ('control', 'installation_credentials'),
      ('control', 'installation_credential_states'),
      ('ephemeral', 'request_nonces'),
      ('ledger', 'ingest_batches'),
      ('ledger', 'ingest_batch_states'),
      ('ledger', 'ingest_batch_records'),
      ('ledger', 'custom_event_facts')
    ) AS values_to_secure(table_schema, table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''openmasu.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''openmasu.tenant_id'', true))',
      item.table_name,
      item.table_schema,
      item.table_name
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('control', 'tracking_links'),
      ('control', 'tracking_link_states'),
      ('control', 'sdk_keys'),
      ('control', 'sdk_key_states'),
      ('control', 'installation_credentials'),
      ('control', 'installation_credential_states'),
      ('ledger', 'ingest_batches'),
      ('ledger', 'ingest_batch_states'),
      ('ledger', 'ingest_batch_records'),
      ('ledger', 'custom_event_facts')
    ) AS append_only(table_schema, table_name)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation()',
      item.table_name,
      item.table_schema,
      item.table_name
    );
  END LOOP;
END
$$;

REVOKE ALL ON
  control.tracking_links, control.tracking_link_states,
  control.sdk_keys, control.sdk_key_states,
  control.installation_credentials, control.installation_credential_states,
  ephemeral.request_nonces,
  ledger.ingest_batches, ledger.ingest_batch_states, ledger.ingest_batch_records,
  ledger.custom_event_facts
FROM PUBLIC;

GRANT SELECT, INSERT ON
  control.tracking_links, control.tracking_link_states,
  control.sdk_keys, control.sdk_key_states,
  control.installation_credentials, control.installation_credential_states,
  ledger.ingest_batches, ledger.ingest_batch_states, ledger.ingest_batch_records,
  ledger.custom_event_facts
TO openmasu_app;

GRANT SELECT, INSERT, DELETE ON ephemeral.request_nonces TO openmasu_app;

GRANT SELECT ON
  control.tracking_links, control.tracking_link_states,
  control.sdk_keys, control.sdk_key_states,
  control.installation_credentials, control.installation_credential_states,
  ledger.ingest_batches, ledger.ingest_batch_states, ledger.ingest_batch_records,
  ledger.custom_event_facts
TO openmasu_reader;

GRANT USAGE, SELECT ON SEQUENCE
  control.tracking_link_states_tracking_link_state_seq_seq,
  control.sdk_key_states_sdk_key_state_seq_seq,
  control.installation_credential_state_seq,
  ledger.ingest_batches_inbox_seq_seq,
  ledger.ingest_batch_states_ingest_batch_state_seq_seq
TO openmasu_app;

GRANT SELECT ON SEQUENCE
  control.tracking_link_states_tracking_link_state_seq_seq,
  control.sdk_key_states_sdk_key_state_seq_seq,
  control.installation_credential_state_seq,
  ledger.ingest_batches_inbox_seq_seq,
  ledger.ingest_batch_states_ingest_batch_state_seq_seq
TO openmasu_reader;

GRANT TRUNCATE ON
  ledger.ingest_batches, ledger.ingest_batch_states, ledger.ingest_batch_records,
  ledger.custom_event_facts,
  ephemeral.request_nonces
TO openmasu_seed;

-- 010_m3_dashboard.sql
ALTER TABLE control.admin_keys
  DROP CONSTRAINT admin_keys_tenant_id_app_id_fkey,
  ALTER COLUMN app_id DROP NOT NULL,
  ADD CONSTRAINT admin_keys_tenant_key_unique UNIQUE (tenant_id, key_id);

ALTER TABLE control.admin_key_states
  DROP CONSTRAINT admin_key_states_tenant_id_app_id_fkey,
  ALTER COLUMN app_id DROP NOT NULL;

CREATE TABLE ephemeral.dashboard_sessions (
  session_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  admin_key_id control.identifier NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  UNIQUE (token_digest),
  FOREIGN KEY (tenant_id, admin_key_id)
    REFERENCES control.admin_keys (tenant_id, key_id)
);

CREATE INDEX dashboard_sessions_expiry_idx
  ON ephemeral.dashboard_sessions (expires_at);

CREATE INDEX metric_runs_superseded_idx
  ON ledger.metric_runs (tenant_id, app_id, supersedes_metric_run_id)
  WHERE supersedes_metric_run_id IS NOT NULL;

CREATE INDEX metric_runs_dashboard_keyset_idx
  ON ledger.metric_runs (tenant_id, app_id, metric_name, grouping_digest, metric_run_id);

ALTER TABLE ledger.click_facts
  ADD COLUMN campaign_id text,
  ADD COLUMN network text,
  ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

CREATE INDEX click_facts_dashboard_dimensions_idx
  ON ledger.click_facts (tenant_id, app_id, campaign_id, network, country);

ALTER TABLE ephemeral.dashboard_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.dashboard_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_sessions_tenant ON ephemeral.dashboard_sessions
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session'
  ));

REVOKE ALL ON ephemeral.dashboard_sessions FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON ephemeral.dashboard_sessions TO openmasu_app;
GRANT USAGE ON SCHEMA ephemeral TO openmasu_reader;
GRANT SELECT ON ephemeral.dashboard_sessions TO openmasu_reader;
GRANT TRUNCATE ON ephemeral.dashboard_sessions TO openmasu_seed;

-- 011_m4_sdk_platform.sql
ALTER TABLE control.sdk_keys
  ADD COLUMN platform text
  CHECK (platform IS NULL OR platform IN ('android', 'ios'));

-- The pre-M4 view expanded key.* when it was created, so adding the table
-- column does not automatically expose it. Append the new column to preserve
-- every existing view-column position for current consumers.
CREATE OR REPLACE VIEW control.sdk_keys_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (key.sdk_key_id)
  key.sdk_key_id,
  key.tenant_id,
  key.app_id,
  key.secret_ref,
  key.created_at,
  key.artifact,
  state.status,
  state.changed_at AS status_changed_at,
  key.platform
FROM control.sdk_keys AS key
JOIN control.sdk_key_states AS state USING (sdk_key_id, tenant_id, app_id)
ORDER BY key.sdk_key_id, state.sdk_key_state_seq DESC;

COMMENT ON COLUMN control.sdk_keys.platform IS
  'Issuing SDK platform. NULL preserves pre-M4 key rows; new issuance must set android or ios.';

-- 012_m4_apple_attribution.sql
CREATE TABLE control.apple_app_registrations (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  apple_app_adam_id bigint NOT NULL CHECK (apple_app_adam_id > 0),
  apple_bundle_id text CHECK (
    apple_bundle_id IS NULL OR apple_bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$'
  ),
  registered_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id),
  UNIQUE (apple_app_adam_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.conversion_schemas (
  conversion_schema_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  schema_version text NOT NULL CHECK (schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, schema_version),
  UNIQUE (tenant_id, app_id, conversion_schema_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.conversion_schema_states (
  conversion_schema_state_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversion_schema_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  changed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, conversion_schema_id)
    REFERENCES control.conversion_schemas (tenant_id, app_id, conversion_schema_id)
);

CREATE VIEW control.conversion_schemas_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (schema.conversion_schema_id)
  schema.*, state.status, state.changed_at AS status_changed_at
FROM control.conversion_schemas AS schema
JOIN control.conversion_schema_states AS state
  USING (conversion_schema_id, tenant_id, app_id)
ORDER BY schema.conversion_schema_id, state.conversion_schema_state_seq DESC;

CREATE TABLE ephemeral.adservices_lookups (
  lookup_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  install_record_id control.identifier NOT NULL,
  token_ref text NOT NULL,
  token_created_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, install_record_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, install_record_id)
    REFERENCES ledger.raw_records (tenant_id, app_id, record_id)
);

-- Apple lookup responses are protected evidence. Parsed campaign values never
-- become columns; the encrypted response reference remains privacy-purgeable.
CREATE TABLE ledger.adservices_lookup_results (
  lookup_result_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  install_record_id control.identifier NOT NULL,
  attribution_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'attributed', 'not_attributed', 'token_expired', 'lookup_unavailable'
  )),
  response_ref text NOT NULL,
  response_digest text NOT NULL CHECK (response_digest ~ '^[a-f0-9]{64}$'),
  decided_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, install_record_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, install_record_id)
    REFERENCES ledger.raw_records (tenant_id, app_id, record_id),
  FOREIGN KEY (attribution_id) REFERENCES ledger.attribution_results (attribution_id)
);

-- Apple aggregate metric evaluation reads this non-identifying projection
-- instead of reopening protected postback payloads. The receipt timestamp is
-- authoritative for the public aggregate calendar series.
CREATE TABLE ledger.apple_postback_facts (
  logical_event_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  event_name text NOT NULL CHECK (event_name IN ('skan_postback', 'adattributionkit_postback')),
  signature_verified boolean NOT NULL,
  did_win boolean NOT NULL,
  source_identifier_present boolean NOT NULL,
  conversion_bucket text CHECK (
    conversion_bucket IS NULL
    OR conversion_bucket ~ '^(fine:([0-9]|[1-5][0-9]|6[0-3])|coarse:(low|medium|high))$'
  ),
  received_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, logical_event_id)
    REFERENCES ledger.logical_events (tenant_id, app_id, logical_event_id)
);

CREATE INDEX apple_postback_facts_metric_idx
  ON ledger.apple_postback_facts (
    tenant_id, app_id, event_name, received_at, conversion_bucket
  );

-- Unregistered Apple application identifiers do not have a tenant scope. Keep a
-- deployment-scoped, digest-only audit trail instead of inventing a tenant or
-- retaining the raw ADAM ID. The application role can insert but cannot read it.
CREATE TABLE control.public_postback_audits (
  public_postback_audit_id uuid PRIMARY KEY,
  occurred_at control.canonical_timestamp NOT NULL,
  postback_kind text NOT NULL CHECK (postback_kind IN ('skadnetwork', 'adattributionkit')),
  action text NOT NULL CHECK (action = 'postback_receive'),
  outcome text NOT NULL CHECK (outcome = 'ignored'),
  reason_code text NOT NULL CHECK (reason_code = 'apple_app_not_registered'),
  adam_id_digest text NOT NULL CHECK (adam_id_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  artifact jsonb NOT NULL
);

ALTER TABLE control.apple_app_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.apple_app_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY apple_app_registrations_tenant ON control.apple_app_registrations
  USING (
    tenant_id = current_setting('openmasu.tenant_id', true)
    OR current_user = 'openmasu_owner'
  )
  WITH CHECK (
    tenant_id = current_setting('openmasu.tenant_id', true)
    OR current_user = 'openmasu_owner'
  );

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('control', 'conversion_schemas'),
      ('control', 'conversion_schema_states'),
      ('ephemeral', 'adservices_lookups'),
      ('ledger', 'adservices_lookup_results'),
      ('ledger', 'apple_postback_facts')
    ) AS values_to_secure(table_schema, table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.table_schema, item.table_name);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''openmasu.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''openmasu.tenant_id'', true))',
      item.table_name,
      item.table_schema,
      item.table_name
    );
  END LOOP;
END
$$;

-- list_m4_work_tenants() runs before a tenant GUC exists. FORCE RLS therefore
-- needs SELECT-only owner policies on its three inputs. openmasu_owner is
-- NOLOGIN and the SECURITY DEFINER function returns tenant identifiers only.
CREATE POLICY ingest_batches_m4_discovery_owner
  ON ledger.ingest_batches FOR SELECT TO openmasu_owner USING (true);
CREATE POLICY ingest_batch_states_m4_discovery_owner
  ON ledger.ingest_batch_states FOR SELECT TO openmasu_owner USING (true);
CREATE POLICY adservices_lookups_m4_discovery_owner
  ON ephemeral.adservices_lookups FOR SELECT TO openmasu_owner USING (true);

CREATE FUNCTION control.resolve_apple_app_adam_id(_apple_app_adam_id bigint)
RETURNS TABLE (tenant_id control.identifier, app_id control.identifier)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT registration.tenant_id, registration.app_id
  FROM control.apple_app_registrations AS registration
  WHERE registration.apple_app_adam_id = _apple_app_adam_id
$$;

CREATE FUNCTION control.list_apple_postback_tenants()
RETURNS SETOF control.identifier
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT DISTINCT registration.tenant_id
  FROM control.apple_app_registrations AS registration
  ORDER BY registration.tenant_id
$$;

-- The worker must discover SDK/AdServices work before it has a tenant RLS
-- context. Return tenant identifiers only; no event or credential data crosses
-- this narrowly scoped SECURITY DEFINER boundary.
CREATE FUNCTION control.list_m4_work_tenants()
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
  ORDER BY 1
$$;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('control', 'apple_app_registrations'),
      ('control', 'conversion_schemas'),
      ('control', 'conversion_schema_states'),
      ('control', 'public_postback_audits'),
      ('ledger', 'adservices_lookup_results'),
      ('ledger', 'apple_postback_facts')
    ) AS append_only(table_schema, table_name)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation()',
      item.table_name,
      item.table_schema,
      item.table_name
    );
  END LOOP;
END
$$;

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_actor_type_check
  CHECK (actor_type IN (
    'admin_key', 'system_job', 'sdk_key', 'sdk_installation', 'apple_postback'
  ));
ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session',
    'apple_app_registration', 'conversion_schema', 'postback'
  ));

REVOKE ALL ON
  control.apple_app_registrations,
  control.conversion_schemas,
  control.conversion_schema_states,
  control.public_postback_audits,
  ephemeral.adservices_lookups,
  ledger.adservices_lookup_results,
  ledger.apple_postback_facts
FROM PUBLIC;

-- Default privileges grant later control tables to the application and reader
-- roles. This tenant-less audit sink is intentionally write-only to the app.
REVOKE ALL ON
  control.public_postback_audits,
  ledger.adservices_lookup_results
FROM openmasu_app, openmasu_reader;

GRANT SELECT, INSERT ON
  control.apple_app_registrations,
  control.conversion_schemas,
  control.conversion_schema_states
TO openmasu_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.adservices_lookups TO openmasu_app;
GRANT INSERT ON control.public_postback_audits TO openmasu_app;
GRANT SELECT, INSERT ON ledger.adservices_lookup_results TO openmasu_app;
GRANT SELECT, INSERT ON ledger.apple_postback_facts TO openmasu_app;

GRANT SELECT ON
  control.apple_app_registrations,
  control.conversion_schemas,
  control.conversion_schema_states,
  ephemeral.adservices_lookups,
  ledger.apple_postback_facts
TO openmasu_reader;

GRANT USAGE, SELECT ON SEQUENCE control.conversion_schema_states_conversion_schema_state_seq_seq
TO openmasu_app;
GRANT SELECT ON SEQUENCE control.conversion_schema_states_conversion_schema_state_seq_seq
TO openmasu_reader;

REVOKE ALL ON FUNCTION control.resolve_apple_app_adam_id(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.resolve_apple_app_adam_id(bigint) TO openmasu_app;
REVOKE ALL ON FUNCTION control.list_apple_postback_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_apple_postback_tenants() TO openmasu_app;
REVOKE ALL ON FUNCTION control.list_m4_work_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_m4_work_tenants() TO openmasu_app;

GRANT TRUNCATE ON
  control.public_postback_audits,
  ephemeral.adservices_lookups,
  ledger.adservices_lookup_results,
  ledger.apple_postback_facts
TO openmasu_seed;
GRANT USAGE ON SCHEMA control, ephemeral TO openmasu_seed;

-- 013_m5_production_controls.sql
ALTER TABLE control.admin_keys
  ADD COLUMN role text NOT NULL DEFAULT 'admin'
    CHECK (role IN ('admin', 'operator', 'read_only'));

DROP VIEW control.admin_keys_current;
CREATE VIEW control.admin_keys_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (key.key_id)
  key.*, state.status, state.changed_at AS status_changed_at
FROM control.admin_keys AS key
JOIN control.admin_key_states AS state ON state.key_id = key.key_id
ORDER BY key.key_id, state.admin_key_state_seq DESC;

CREATE VIEW control.admin_key_roles_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (key.key_id)
  key.key_id, key.tenant_id, key.role, state.status
FROM control.admin_keys AS key
JOIN control.admin_key_states AS state ON state.key_id = key.key_id
ORDER BY key.key_id, state.admin_key_state_seq DESC;

REVOKE ALL ON control.admin_key_roles_current FROM PUBLIC;
REVOKE SELECT ON control.admin_keys_current FROM openmasu_reader;
REVOKE SELECT ON control.admin_keys, control.admin_key_states FROM openmasu_reader;
GRANT SELECT ON control.admin_key_roles_current TO openmasu_reader;
GRANT SELECT (key_id, tenant_id, role) ON control.admin_keys TO openmasu_reader;
GRANT SELECT (key_id, tenant_id, status, admin_key_state_seq) ON control.admin_key_states TO openmasu_reader;

CREATE TABLE control.rule_bundle_revisions (
  rule_bundle_revision_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  rule_bundle_id control.identifier NOT NULL,
  rule_bundle_version text NOT NULL CHECK (length(rule_bundle_version) BETWEEN 1 AND 128),
  rule_bundle_hash text NOT NULL CHECK (rule_bundle_hash ~ '^[a-f0-9]{64}$'),
  supersedes_rule_bundle_revision_id control.identifier,
  activated_at control.canonical_timestamp NOT NULL,
  actor_ref text NOT NULL CHECK (length(actor_ref) BETWEEN 1 AND 256),
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, rule_bundle_id, rule_bundle_version),
  UNIQUE (tenant_id, app_id, rule_bundle_revision_id),
  UNIQUE (tenant_id, app_id, rule_bundle_id, rule_bundle_revision_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id, rule_bundle_id, supersedes_rule_bundle_revision_id)
    REFERENCES control.rule_bundle_revisions (tenant_id, app_id, rule_bundle_id, rule_bundle_revision_id),
  CHECK (supersedes_rule_bundle_revision_id IS NULL OR supersedes_rule_bundle_revision_id <> rule_bundle_revision_id),
  CHECK (artifact->>'rule_bundle_id'=rule_bundle_id),
  CHECK (artifact->>'rule_bundle_version'=rule_bundle_version),
  CHECK (artifact->>'rule_bundle_hash'=rule_bundle_hash),
  CHECK (COALESCE(artifact->>'supersedes_rule_bundle_revision_id', '')=
    COALESCE(supersedes_rule_bundle_revision_id, ''))
);

CREATE VIEW control.rule_bundles_current
WITH (security_invoker = true)
AS
SELECT revision.*
FROM control.rule_bundle_revisions AS revision
WHERE NOT EXISTS (
  SELECT 1
  FROM control.rule_bundle_revisions AS successor
  WHERE successor.tenant_id=revision.tenant_id
    AND successor.app_id=revision.app_id
    AND successor.supersedes_rule_bundle_revision_id=revision.rule_bundle_revision_id
);

CREATE INDEX rule_bundle_revisions_current_idx
  ON control.rule_bundle_revisions (
    tenant_id, app_id, rule_bundle_id, activated_at DESC, rule_bundle_revision_id DESC
  );

CREATE UNIQUE INDEX rule_bundle_revisions_single_successor_idx
  ON control.rule_bundle_revisions (tenant_id, app_id, supersedes_rule_bundle_revision_id)
  WHERE supersedes_rule_bundle_revision_id IS NOT NULL;

CREATE UNIQUE INDEX rule_bundle_revisions_single_root_idx
  ON control.rule_bundle_revisions (tenant_id, app_id, rule_bundle_id)
  WHERE supersedes_rule_bundle_revision_id IS NULL;

ALTER TABLE control.rule_bundle_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.rule_bundle_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_bundle_revisions_tenant ON control.rule_bundle_revisions
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

CREATE TRIGGER rule_bundle_revisions_append_only
  BEFORE UPDATE OR DELETE ON control.rule_bundle_revisions
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session',
    'apple_app_registration', 'conversion_schema', 'postback', 'rule_bundle'
  ));

REVOKE ALL ON control.rule_bundle_revisions FROM PUBLIC;
GRANT SELECT, INSERT ON control.rule_bundle_revisions TO openmasu_app;
GRANT SELECT ON control.rule_bundle_revisions TO openmasu_reader;
GRANT TRUNCATE ON control.rule_bundle_revisions TO openmasu_seed;

-- 014_m5_privacy_reapply.sql
CREATE TABLE control.metric_replay_manifests (
  metric_replay_manifest_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_metric_run_id text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, source_metric_run_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (source_metric_run_id) REFERENCES ledger.metric_runs (metric_run_id),
  CHECK (artifact ? 'metric_definition' AND artifact ? 'evaluation' AND artifact ? 'fx_policy')
);

ALTER TABLE control.metric_replay_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_replay_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_replay_manifests_tenant ON control.metric_replay_manifests
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

CREATE TRIGGER metric_replay_manifests_append_only
  BEFORE UPDATE OR DELETE ON control.metric_replay_manifests
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.metric_replay_manifests FROM PUBLIC;
REVOKE SELECT ON control.metric_replay_manifests FROM openmasu_reader;
GRANT SELECT, INSERT ON control.metric_replay_manifests TO openmasu_app;
GRANT TRUNCATE ON control.metric_replay_manifests TO openmasu_seed;

-- 015_m6_fraud.sql
-- M6 deterministic fraud controls.
ALTER TABLE control.rule_bundle_revisions
  ADD COLUMN definition jsonb,
  ADD COLUMN definition_digest text CHECK (definition_digest IS NULL OR definition_digest ~ '^[a-f0-9]{64}$');

ALTER TABLE ledger.click_facts
  ALTER COLUMN click_id DROP NOT NULL,
  ADD COLUMN site_id text,
  ADD COLUMN remote_click_ref text;

ALTER TABLE ledger.fraud_decisions
  ADD COLUMN subject_scope text NOT NULL DEFAULT 'record'
    CHECK (subject_scope IN ('record','source')),
  ADD COLUMN rule_id text,
  ADD COLUMN resolution_deadline_at control.canonical_timestamp,
  ADD COLUMN supersedes_fraud_decision_id text,
  ADD CONSTRAINT fraud_decision_subject_namespace CHECK (
    (subject_scope='source' AND subject_ref LIKE 'source:%') OR
    (subject_scope='record' AND subject_ref NOT LIKE 'source:%')
  ),
  ADD CONSTRAINT fraud_decision_quarantine_deadline CHECK (
    action <> 'quarantine' OR resolution_deadline_at IS NOT NULL
  );

CREATE TABLE ledger.source_day_aggregates (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  metric_date date NOT NULL,
  campaign_id control.identifier NOT NULL,
  network text NOT NULL,
  site_id text NOT NULL,
  clicks bigint NOT NULL CHECK (clicks >= 0),
  installs bigint NOT NULL CHECK (installs >= 0),
  ctit_p05_ms bigint,
  ctit_p50_ms bigint,
  ctit_p95_ms bigint,
  ctit_negative_count bigint NOT NULL DEFAULT 0 CHECK (ctit_negative_count >= 0),
  organic_share_unscaled bigint,
  input_snapshot_id text NOT NULL CHECK (input_snapshot_id ~ '^[a-f0-9]{64}$'),
  computed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id, metric_date, campaign_id, network, site_id, input_snapshot_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.fraud_quarantines (
  fraud_decision_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_ref text NOT NULL,
  resolve_after timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.integrity_verifications (
  verification_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  provider text NOT NULL CHECK (provider IN ('play_integrity','app_attest')),
  token_ref text NOT NULL CHECK (token_ref LIKE 'protected:%'),
  subject_record_id control.identifier NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX source_day_aggregates_lookup_idx
  ON ledger.source_day_aggregates (tenant_id, app_id, metric_date, campaign_id, network, site_id);
CREATE INDEX fraud_quarantines_due_idx ON ephemeral.fraud_quarantines (resolve_after);
CREATE INDEX integrity_verifications_due_idx ON ephemeral.integrity_verifications (next_attempt_at);

ALTER TABLE ledger.source_day_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.source_day_aggregates FORCE ROW LEVEL SECURITY;
CREATE POLICY source_day_aggregates_tenant ON ledger.source_day_aggregates
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ephemeral.fraud_quarantines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.fraud_quarantines FORCE ROW LEVEL SECURITY;
CREATE POLICY fraud_quarantines_tenant ON ephemeral.fraud_quarantines
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ephemeral.integrity_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.integrity_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY integrity_verifications_tenant ON ephemeral.integrity_verifications
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER source_day_aggregates_append_only
  BEFORE UPDATE OR DELETE ON ledger.source_day_aggregates
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.source_day_aggregates, ephemeral.fraud_quarantines, ephemeral.integrity_verifications FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.source_day_aggregates TO openmasu_app;
GRANT SELECT, INSERT, DELETE ON ephemeral.fraud_quarantines, ephemeral.integrity_verifications TO openmasu_app;
GRANT SELECT ON ledger.source_day_aggregates TO openmasu_reader;
GRANT TRUNCATE ON ledger.source_day_aggregates, ephemeral.fraud_quarantines, ephemeral.integrity_verifications TO openmasu_seed;

-- 016_m6_integrity.sql
-- M6b platform-integrity verification results and replay protection.
ALTER TABLE ephemeral.integrity_verifications
  DROP CONSTRAINT integrity_verifications_token_ref_check,
  ADD CONSTRAINT integrity_verifications_token_ref_check
    CHECK (token_ref LIKE 'encrypted:%'),
  ADD CONSTRAINT integrity_verifications_binding_once
    UNIQUE (tenant_id, app_id, provider, challenge_digest);

CREATE TABLE ledger.integrity_verification_results (
  verification_result_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_record_id control.identifier NOT NULL,
  provider text NOT NULL CHECK (provider IN ('play_integrity','app_attest')),
  verdict text NOT NULL CHECK (verdict IN ('verified','failed','unavailable')),
  evidence_ref text,
  response_digest text,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  decided_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CHECK (
    (verdict IN ('verified','failed') AND evidence_ref LIKE 'encrypted:%'
      AND response_digest ~ '^[a-f0-9]{64}$')
    OR
    (verdict='unavailable' AND evidence_ref IS NULL AND response_digest IS NULL)
  )
);

CREATE INDEX integrity_results_subject_idx
  ON ledger.integrity_verification_results (tenant_id, app_id, subject_record_id, decided_at);
CREATE UNIQUE INDEX integrity_results_binding_once_idx
  ON ledger.integrity_verification_results (tenant_id, app_id, provider, binding_digest);

ALTER TABLE ledger.integrity_verification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.integrity_verification_results FORCE ROW LEVEL SECURITY;
CREATE POLICY integrity_verification_results_tenant ON ledger.integrity_verification_results
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER integrity_verification_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.integrity_verification_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.integrity_verification_results FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.integrity_verification_results TO openmasu_app;
GRANT SELECT ON ledger.integrity_verification_results TO openmasu_reader;
GRANT UPDATE ON ephemeral.integrity_verifications TO openmasu_app;
GRANT TRUNCATE ON ledger.integrity_verification_results TO openmasu_seed;

-- 017_m6_fraud_bundle_view.sql
-- Expose additive fraud definition columns through the current-revision view.
-- PostgreSQL expands SELECT * when a view is created, so migration 015's new
-- columns are not visible until the view definition is replaced explicitly.
CREATE OR REPLACE VIEW control.rule_bundles_current
WITH (security_invoker = true)
AS
SELECT revision.*
FROM control.rule_bundle_revisions AS revision
WHERE NOT EXISTS (
  SELECT 1
  FROM control.rule_bundle_revisions AS successor
  WHERE successor.tenant_id=revision.tenant_id
    AND successor.app_id=revision.app_id
    AND successor.supersedes_rule_bundle_revision_id=revision.rule_bundle_revision_id
);

-- 018_m7_deeplink.sql
-- M7 link-domain registration, association identities, deferred-link definitions, and engagement projections.
CREATE TABLE control.link_domains (
  tenant_id control.identifier PRIMARY KEY,
  host text NOT NULL CHECK (host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  registered_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (host)
);

CREATE TABLE control.app_link_identities (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  android_package_name text CHECK (android_package_name IS NULL OR android_package_name ~ '^[A-Za-z][A-Za-z0-9_.]{2,254}$'),
  android_sha256_fingerprints text[] NOT NULL DEFAULT '{}',
  apple_team_id text CHECK (apple_team_id IS NULL OR apple_team_id ~ '^[A-Z0-9]{10}$'),
  apple_bundle_id text CHECK (apple_bundle_id IS NULL OR apple_bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$'),
  registered_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (android_package_name),
  UNIQUE (apple_team_id, apple_bundle_id),
  CHECK (cardinality(android_sha256_fingerprints) <= 8),
  CHECK ((apple_team_id IS NULL AND apple_bundle_id IS NULL) OR (apple_team_id IS NOT NULL AND apple_bundle_id IS NOT NULL))
);

-- Host-based routing needs a deployment-wide lookup before a tenant RLS context exists.
-- This boundary returns only the tenant identifier and never exposes registration rows.
CREATE FUNCTION control.resolve_link_host(request_host text)
RETURNS control.identifier
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT tenant_id
    FROM control.link_domains
   WHERE host = lower(trim(trailing '.' from request_host))
   LIMIT 1
$$;

ALTER TABLE control.tracking_links
  ADD COLUMN deep_link_value text
    CHECK (deep_link_value IS NULL OR (length(deep_link_value) <= 256 AND deep_link_value ~ '^(/[A-Za-z0-9._~-]{1,64}){1,8}$')),
  ADD COLUMN deep_link_param_names text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(deep_link_param_names) <= 10),
  ADD COLUMN deferred_deep_link_ttl_seconds integer NOT NULL DEFAULT 604800
    CHECK (deferred_deep_link_ttl_seconds BETWEEN 0 AND 7776000);

ALTER TABLE ledger.click_facts
  ADD COLUMN tracking_link_id control.identifier REFERENCES control.tracking_links (tracking_link_id);

CREATE TABLE ledger.deep_link_open_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text NOT NULL,
  tracking_link_id control.identifier,
  campaign_id text,
  open_source text NOT NULL CHECK (open_source IN ('android_app_link','ios_universal_link','custom_scheme','android_deferred_referrer')),
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  days_since_last_session integer CHECK (days_since_last_session IS NULL OR days_since_last_session >= 0),
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX deep_link_open_facts_dimensions_idx
  ON ledger.deep_link_open_facts (tenant_id, app_id, campaign_id, occurred_at_ts);

ALTER TABLE control.link_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.link_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY link_domains_tenant ON control.link_domains
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.app_link_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.app_link_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY app_link_identities_tenant ON control.app_link_identities
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.deep_link_open_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.deep_link_open_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY deep_link_open_facts_tenant ON ledger.deep_link_open_facts
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER link_domains_append_only BEFORE UPDATE OR DELETE ON control.link_domains
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER app_link_identities_append_only BEFORE UPDATE OR DELETE ON control.app_link_identities
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER deep_link_open_facts_append_only BEFORE UPDATE OR DELETE ON ledger.deep_link_open_facts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts FROM PUBLIC;
REVOKE ALL ON FUNCTION control.resolve_link_host(text) FROM PUBLIC;
GRANT SELECT, INSERT ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts TO openmasu_app;
GRANT EXECUTE ON FUNCTION control.resolve_link_host(text) TO openmasu_app;
GRANT SELECT ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts TO openmasu_reader;
GRANT TRUNCATE ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts TO openmasu_seed;

-- 019_m7_deeplink_view_refresh.sql
-- Refresh the tracking-link projection after M7 added deep-link columns.
-- PostgreSQL expands SELECT * when a view is created, so migration 018's
-- additive base-table columns are not visible until the view is recreated.
DROP VIEW control.tracking_links_current;

CREATE VIEW control.tracking_links_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (link.tracking_link_id)
  link.*, state.status, state.changed_at AS status_changed_at, state.reason_code
FROM control.tracking_links AS link
JOIN control.tracking_link_states AS state USING (tracking_link_id, tenant_id, app_id)
ORDER BY link.tracking_link_id, state.tracking_link_state_seq DESC;

-- 020_m7_link_host_resolver_policy.sql
-- The SECURITY DEFINER host resolver is owned by openmasu_owner, which remains
-- subject to FORCE RLS. Permit that non-login owner to read only link-domain
-- registrations while keeping direct application access tenant-scoped.
DROP POLICY link_domains_tenant ON control.link_domains;

CREATE POLICY link_domains_tenant ON control.link_domains
  USING (
    tenant_id=current_setting('openmasu.tenant_id', true)
    OR current_user='openmasu_owner'
  )
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

-- 021_wo16_role_grants.sql
-- WO-16 repairs grants for databases that applied M6/M7 before their role ACLs
-- were complete. The statements are idempotent and intentionally narrow.
GRANT USAGE ON SCHEMA control, ledger, ephemeral TO openmasu_app;
GRANT USAGE ON SCHEMA control, ledger TO openmasu_reader;
GRANT USAGE ON SCHEMA control, ledger, ephemeral TO openmasu_seed;

GRANT SELECT, INSERT ON
  control.rule_bundle_revisions,
  control.link_domains,
  control.app_link_identities,
  ledger.fraud_decisions,
  ledger.source_day_aggregates,
  ledger.integrity_verification_results,
  ledger.deep_link_open_facts
TO openmasu_app;

GRANT SELECT, INSERT, DELETE ON ephemeral.fraud_quarantines TO openmasu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.integrity_verifications TO openmasu_app;

GRANT SELECT ON
  control.rule_bundle_revisions,
  control.link_domains,
  control.app_link_identities,
  ledger.fraud_decisions,
  ledger.source_day_aggregates,
  ledger.integrity_verification_results,
  ledger.deep_link_open_facts
TO openmasu_reader;

GRANT TRUNCATE ON
  control.rule_bundle_revisions,
  control.link_domains,
  control.app_link_identities,
  ledger.fraud_decisions,
  ledger.source_day_aggregates,
  ledger.integrity_verification_results,
  ledger.deep_link_open_facts,
  ephemeral.fraud_quarantines,
  ephemeral.integrity_verifications
TO openmasu_seed;

-- 022_wo16_fraud_quarantine_lock_grant.sql
-- SELECT ... FOR UPDATE SKIP LOCKED requires UPDATE even though the worker
-- resolves a quarantine row with a separate DELETE statement.
GRANT UPDATE ON ephemeral.fraud_quarantines TO openmasu_app;

-- 023_job_health.sql
CREATE INDEX audit_logs_job_health_idx
  ON ledger.audit_logs (tenant_id, actor_ref, outcome, occurred_at DESC)
  WHERE actor_type = 'system_job'
    AND action = 'job_completed'
    AND policy_version = 'job-health-v1'
    AND actor_ref IN ('job:mmp_import', 'job:cost_import', 'job:metric_run')
    AND outcome IN ('succeeded', 'failed')
    AND target_scope = 'app'
    AND app_id = target_ref
    AND (
      (outcome = 'succeeded' AND reason_code IS NULL)
      OR (outcome = 'failed' AND reason_code = 'job_failed')
    );

-- 024_purchase_refund_net_revenue.sql
-- Provider-neutral purchase/refund projections used by the additive settled net-revenue metrics.
-- Existing purchase rows predate financial-status projection and intentionally remain NULL;
-- they are excluded from settled metrics until replayed from protected payload storage.
ALTER TABLE ledger.logical_events
  ADD CONSTRAINT logical_events_record_identity_unique
    UNIQUE (tenant_id, app_id, logical_event_id, record_id);

ALTER TABLE ledger.purchase_facts
  ADD COLUMN record_id control.identifier,
  ADD COLUMN original_transaction_id text
    CHECK (original_transaction_id IS NULL OR original_transaction_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD COLUMN financial_status text
    CHECK (financial_status IS NULL OR financial_status IN ('settled', 'pending', 'reversed'));

ALTER TABLE ledger.purchase_facts
  ADD CONSTRAINT purchase_facts_projected_record_required
    CHECK (financial_status IS NULL OR record_id IS NOT NULL),
  ADD CONSTRAINT purchase_facts_source_scope_fk
    FOREIGN KEY (tenant_id, app_id, logical_event_id, record_id)
    REFERENCES ledger.logical_events (tenant_id, app_id, logical_event_id, record_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT purchase_facts_record_scope_unique UNIQUE (tenant_id, app_id, record_id);

CREATE INDEX purchase_facts_net_revenue_idx
  ON ledger.purchase_facts (tenant_id, app_id, installation_id, occurred_at_ts)
  WHERE financial_status = 'settled';

CREATE INDEX purchase_facts_refund_target_idx
  ON ledger.purchase_facts (
    tenant_id, app_id, installation_id,
    (COALESCE(original_transaction_id, transaction_id)), currency, occurred_at_ts
  )
  WHERE financial_status = 'settled';

CREATE TABLE ledger.refund_facts (
  logical_event_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text NOT NULL,
  transaction_id text NOT NULL CHECK (transaction_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  original_transaction_id text NOT NULL CHECK (original_transaction_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  correction_target_record_id control.identifier NOT NULL,
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL CHECK (amount_scale BETWEEN 0 AND 18),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  financial_status text NOT NULL CHECK (financial_status IN ('settled', 'pending', 'reversed')),
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CONSTRAINT refund_facts_source_scope_fk
    FOREIGN KEY (tenant_id, app_id, logical_event_id)
    REFERENCES ledger.logical_events (tenant_id, app_id, logical_event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT refund_facts_target_scope_fk
    FOREIGN KEY (tenant_id, app_id, correction_target_record_id)
    REFERENCES ledger.purchase_facts (tenant_id, app_id, record_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION ledger.enforce_refund_target_invariant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_purchase record;
  refund_received_at_ts timestamptz;
  eligible_target_count bigint;
BEGIN
  SELECT raw.received_at_ts
    INTO refund_received_at_ts
    FROM ledger.logical_events AS logical_event
    JOIN ledger.raw_records AS raw
      ON raw.tenant_id = logical_event.tenant_id
     AND raw.app_id = logical_event.app_id
     AND raw.record_id = logical_event.record_id
   WHERE logical_event.tenant_id = NEW.tenant_id
     AND logical_event.app_id = NEW.app_id
     AND logical_event.logical_event_id = NEW.logical_event_id;

  -- A missing same-scope source is reported by refund_facts_source_scope_fk as 23503.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT purchase.financial_status,
         purchase.installation_id,
         COALESCE(purchase.original_transaction_id, purchase.transaction_id) AS original_transaction_id,
         purchase.currency,
         purchase.occurred_at_ts,
         raw.received_at_ts
    INTO target_purchase
    FROM ledger.purchase_facts AS purchase
    JOIN ledger.raw_records AS raw
      ON raw.tenant_id = purchase.tenant_id
     AND raw.app_id = purchase.app_id
     AND raw.record_id = purchase.record_id
   WHERE purchase.tenant_id = NEW.tenant_id
     AND purchase.app_id = NEW.app_id
     AND purchase.record_id = NEW.correction_target_record_id;

  -- A missing same-scope target is reported by refund_facts_target_scope_fk as 23503.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF target_purchase.financial_status IS DISTINCT FROM 'settled'
     OR target_purchase.installation_id IS DISTINCT FROM NEW.installation_id
     OR target_purchase.original_transaction_id IS DISTINCT FROM NEW.original_transaction_id
     OR target_purchase.currency IS DISTINCT FROM NEW.currency
     OR target_purchase.occurred_at_ts > NEW.occurred_at_ts
     OR target_purchase.received_at_ts > refund_received_at_ts THEN
    RAISE EXCEPTION 'refund target invariant violation'
      USING ERRCODE = '23514',
            CONSTRAINT = 'refund_facts_target_invariant';
  END IF;

  SELECT count(*)
    INTO eligible_target_count
    FROM ledger.purchase_facts AS purchase
    JOIN ledger.raw_records AS raw
      ON raw.tenant_id = purchase.tenant_id
     AND raw.app_id = purchase.app_id
     AND raw.record_id = purchase.record_id
   WHERE purchase.tenant_id = NEW.tenant_id
     AND purchase.app_id = NEW.app_id
     AND purchase.financial_status = 'settled'
     AND purchase.installation_id = NEW.installation_id
     AND COALESCE(purchase.original_transaction_id, purchase.transaction_id) = NEW.original_transaction_id
     AND purchase.currency = NEW.currency
     AND purchase.occurred_at_ts <= NEW.occurred_at_ts
     AND raw.received_at_ts <= refund_received_at_ts;

  IF eligible_target_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'refund target resolution is ambiguous'
      USING ERRCODE = '23514',
            CONSTRAINT = 'refund_facts_target_invariant';
  END IF;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION ledger.enforce_refund_target_invariant() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER refund_facts_target_invariant
  AFTER INSERT ON ledger.refund_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.enforce_refund_target_invariant();

CREATE INDEX refund_facts_net_revenue_idx
  ON ledger.refund_facts (
    tenant_id, app_id, installation_id, occurred_at_ts, correction_target_record_id
  )
  WHERE financial_status = 'settled';

ALTER TABLE ledger.refund_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.refund_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_facts_tenant ON ledger.refund_facts
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER refund_facts_append_only BEFORE UPDATE OR DELETE ON ledger.refund_facts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.refund_facts FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.refund_facts TO openmasu_app;
GRANT SELECT ON ledger.refund_facts TO openmasu_reader;
GRANT TRUNCATE ON ledger.refund_facts TO openmasu_seed;

-- 025_google_play_product_verification.sql
-- Protected Google Play one-time-product verification queue and append-only outcomes.
CREATE TABLE control.google_play_purchase_tokens (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  verification_id uuid NOT NULL UNIQUE,
  registered_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.google_play_product_verifications (
  verification_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_record_id control.identifier NOT NULL,
  token_ref text NOT NULL CHECK (token_ref LIKE 'encrypted:%'),
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 255),
  verified_record_id control.identifier NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  requested_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, subject_record_id),
  UNIQUE (token_digest)
);

CREATE INDEX google_play_product_verifications_due_idx
  ON ephemeral.google_play_product_verifications (next_attempt_at, verification_id);

CREATE TABLE ledger.google_play_purchase_verification_results (
  verification_result_id uuid PRIMARY KEY,
  verification_id uuid NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_record_id control.identifier NOT NULL,
  verified_record_id control.identifier,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  verdict text NOT NULL CHECK (verdict IN ('verified','failed','unavailable')),
  provider_purchase_state text,
  product_matched boolean NOT NULL,
  evidence_ref text,
  response_digest text,
  decided_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (verification_id),
  UNIQUE (token_digest),
  CHECK (
    (verdict IN ('verified','failed') AND evidence_ref LIKE 'encrypted:%'
      AND response_digest ~ '^[a-f0-9]{64}$')
    OR
    (verdict='unavailable' AND evidence_ref IS NULL AND response_digest IS NULL)
  ),
  CHECK ((verdict='verified') = (verified_record_id IS NOT NULL))
);

CREATE INDEX google_play_purchase_results_subject_idx
  ON ledger.google_play_purchase_verification_results (
    tenant_id, app_id, subject_record_id, decided_at
  );

ALTER TABLE ephemeral.google_play_product_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.google_play_product_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_product_verifications_tenant
  ON ephemeral.google_play_product_verifications
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

-- The worker discovers due work before it has a tenant RLS context. The
-- SECURITY DEFINER function below returns tenant identifiers only.
CREATE POLICY google_play_product_verifications_discovery_owner
  ON ephemeral.google_play_product_verifications FOR SELECT TO openmasu_owner
  USING (true);

ALTER TABLE control.google_play_purchase_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_play_purchase_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_purchase_tokens_tenant
  ON control.google_play_purchase_tokens
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.google_play_purchase_verification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.google_play_purchase_verification_results FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_purchase_verification_results_tenant
  ON ledger.google_play_purchase_verification_results
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER google_play_purchase_verification_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.google_play_purchase_verification_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

CREATE TRIGGER google_play_purchase_tokens_append_only
  BEFORE UPDATE OR DELETE ON control.google_play_purchase_tokens
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON
  ephemeral.google_play_product_verifications,
  control.google_play_purchase_tokens,
  ledger.google_play_purchase_verification_results
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ephemeral.google_play_product_verifications TO openmasu_app;
GRANT SELECT, INSERT ON control.google_play_purchase_tokens TO openmasu_app;
REVOKE SELECT ON control.google_play_purchase_tokens FROM openmasu_reader;
GRANT SELECT, INSERT
  ON ledger.google_play_purchase_verification_results TO openmasu_app;
GRANT SELECT
  ON ledger.google_play_purchase_verification_results TO openmasu_reader;
GRANT TRUNCATE
  ON ephemeral.google_play_product_verifications,
     control.google_play_purchase_tokens,
     ledger.google_play_purchase_verification_results TO openmasu_seed;

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
  ORDER BY 1
$$;

-- 026_google_play_subscription_verification.sql
-- Extend the protected Google Play verification queue for initial subscription orders.
ALTER TABLE ephemeral.google_play_product_verifications
  ADD COLUMN purchase_kind text NOT NULL DEFAULT 'one_time_product'
    CHECK (purchase_kind IN ('one_time_product', 'subscription_initial'));

ALTER TABLE ledger.google_play_purchase_verification_results
  ADD COLUMN purchase_kind text NOT NULL DEFAULT 'one_time_product'
    CHECK (purchase_kind IN ('one_time_product', 'subscription_initial'));

-- 027_google_play_rtdn_renewals.sql
-- Authenticated Google Play RTDN renewal queue and deployment-wide replay boundaries.
ALTER TABLE control.google_play_purchase_tokens
  ADD COLUMN product_id text CHECK (product_id IS NULL OR length(product_id) BETWEEN 1 AND 255),
  ADD COLUMN purchase_kind text CHECK (purchase_kind IS NULL OR purchase_kind IN ('one_time_product','subscription_initial'));

ALTER TABLE ephemeral.google_play_product_verifications
  DROP CONSTRAINT google_play_product_verifications_purchase_kind_check,
  DROP CONSTRAINT google_play_product_verifications_token_digest_key,
  ADD CONSTRAINT google_play_product_verifications_purchase_kind_check
    CHECK (purchase_kind IN ('one_time_product','subscription_initial','subscription_renewal'));

ALTER TABLE ledger.google_play_purchase_verification_results
  DROP CONSTRAINT google_play_purchase_verification_results_purchase_kind_check,
  DROP CONSTRAINT google_play_purchase_verification_results_token_digest_key,
  ADD CONSTRAINT google_play_purchase_verification_results_purchase_kind_check
    CHECK (purchase_kind IN ('one_time_product','subscription_initial','subscription_renewal'));

CREATE TABLE control.google_play_rtdn_messages (
  message_digest text PRIMARY KEY CHECK (message_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  verification_id uuid NOT NULL UNIQUE,
  subject_record_id control.identifier NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'encrypted:%'),
  notification_type integer NOT NULL CHECK (notification_type = 2),
  event_time control.canonical_timestamp NOT NULL,
  received_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.google_play_order_digests (
  order_digest text PRIMARY KEY CHECK (order_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  verification_id uuid NOT NULL UNIQUE,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 255),
  status text NOT NULL CHECK (status IN ('pending','verified')),
  claimed_at control.canonical_timestamp NOT NULL,
  verified_at control.canonical_timestamp,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CHECK ((status='verified') = (verified_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION control.resolve_android_package(request_package text)
RETURNS TABLE (tenant_id control.identifier, app_id control.identifier)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT identity.tenant_id, identity.app_id
    FROM control.app_link_identities AS identity
   WHERE identity.android_package_name=request_package
   LIMIT 1
$$;

DROP POLICY app_link_identities_tenant ON control.app_link_identities;
CREATE POLICY app_link_identities_tenant ON control.app_link_identities
  USING (
    tenant_id=current_setting('openmasu.tenant_id', true)
    OR current_user='openmasu_owner'
  )
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.google_play_rtdn_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_play_rtdn_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_rtdn_messages_tenant ON control.google_play_rtdn_messages
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.google_play_order_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_play_order_digests FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_order_digests_tenant ON control.google_play_order_digests
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER google_play_rtdn_messages_append_only
  BEFORE UPDATE OR DELETE ON control.google_play_rtdn_messages
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

CREATE TRIGGER google_play_order_digests_append_only_delete
  BEFORE DELETE ON control.google_play_order_digests
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.google_play_rtdn_messages, control.google_play_order_digests FROM PUBLIC;
REVOKE ALL ON FUNCTION control.resolve_android_package(text) FROM PUBLIC;
GRANT SELECT, INSERT ON control.google_play_rtdn_messages TO openmasu_app;
GRANT SELECT, INSERT, UPDATE ON control.google_play_order_digests TO openmasu_app;
GRANT EXECUTE ON FUNCTION control.resolve_android_package(text) TO openmasu_app;
REVOKE SELECT ON control.google_play_rtdn_messages, control.google_play_order_digests FROM openmasu_reader;
GRANT TRUNCATE ON control.google_play_rtdn_messages, control.google_play_order_digests TO openmasu_seed;

-- 028_max_aggregate_revenue.sql
-- Append-only MAX Reporting API aggregate-revenue snapshots.
-- This provider-reported aggregate series is intentionally separate from
-- installation-level and aggregate S2S ad-revenue evidence.
CREATE TABLE ledger.aggregate_revenue_snapshots (
  aggregate_revenue_snapshot_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  provider control.identifier NOT NULL CHECK (provider = 'applovin-max'),
  source_series text NOT NULL CHECK (source_series = 'provider_reported_aggregate'),
  revenue_date date NOT NULL,
  max_ad_unit_id text NOT NULL CHECK (length(max_ad_unit_id) BETWEEN 1 AND 256),
  network text NOT NULL CHECK (length(network) BETWEEN 1 AND 256),
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL CHECK (amount_scale = 6),
  currency text NOT NULL CHECK (currency = 'USD'),
  as_of control.canonical_timestamp NOT NULL,
  as_of_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(as_of)) STORED,
  report_snapshot_digest text NOT NULL CHECK (report_snapshot_digest ~ '^[0-9a-f]{64}$'),
  retained_dimension_digest text NOT NULL CHECK (retained_dimension_digest ~ '^[0-9a-f]{64}$'),
  import_run_id uuid NOT NULL REFERENCES control.import_runs (import_run_id),
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, report_snapshot_digest, retained_dimension_digest)
);

CREATE INDEX aggregate_revenue_snapshots_history_idx
  ON ledger.aggregate_revenue_snapshots (
    tenant_id, app_id, provider, source_series, retained_dimension_digest,
    as_of_ts DESC, report_snapshot_digest DESC, aggregate_revenue_snapshot_id DESC
  );

ALTER TABLE ledger.aggregate_revenue_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.aggregate_revenue_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY aggregate_revenue_snapshots_tenant ON ledger.aggregate_revenue_snapshots
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER aggregate_revenue_snapshots_append_only
  BEFORE UPDATE OR DELETE ON ledger.aggregate_revenue_snapshots
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

CREATE VIEW ledger.aggregate_revenue_snapshots_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (
  tenant_id, app_id, provider, source_series, retained_dimension_digest
)
  *
FROM ledger.aggregate_revenue_snapshots
ORDER BY
  tenant_id, app_id, provider, source_series, retained_dimension_digest,
  as_of_ts DESC, report_snapshot_digest DESC, aggregate_revenue_snapshot_id DESC;

REVOKE ALL ON ledger.aggregate_revenue_snapshots FROM PUBLIC;
REVOKE ALL ON ledger.aggregate_revenue_snapshots_current FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.aggregate_revenue_snapshots TO openmasu_app;
GRANT SELECT ON ledger.aggregate_revenue_snapshots_current TO openmasu_app;
GRANT SELECT ON ledger.aggregate_revenue_snapshots, ledger.aggregate_revenue_snapshots_current TO openmasu_reader;
GRANT TRUNCATE ON ledger.aggregate_revenue_snapshots TO openmasu_seed;

-- 029_max_revenue_job_health.sql
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

-- 030_google_data_manager_delivery.sql
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

-- 031_verified_commerce_lifecycle.sql
-- Provider-neutral verified commerce notifications, lifecycle facts, and resumable read-back state.
CREATE TABLE control.commerce_provider_notifications (
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  notification_digest text NOT NULL CHECK (notification_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_]{2,127}$'),
  subject_digest text CHECK (subject_digest IS NULL OR subject_digest ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'encrypted:%'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  occurred_at control.canonical_timestamp NOT NULL,
  received_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (provider, notification_digest),
  UNIQUE (provider, notification_digest, tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.commerce_provider_readbacks (
  readback_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  notification_digest text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('google_subscription','google_order_refund','apple_transaction_history','apple_refund_history')),
  cursor_ref text CHECK (cursor_ref IS NULL OR cursor_ref LIKE 'encrypted:%'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL,
  requested_at control.canonical_timestamp NOT NULL,
  last_status integer CHECK (last_status IS NULL OR last_status BETWEEN 100 AND 599),
  FOREIGN KEY (provider, notification_digest, tenant_id, app_id)
    REFERENCES control.commerce_provider_notifications (provider, notification_digest, tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (provider, tenant_id, app_id, notification_digest, operation)
);

CREATE TABLE ledger.commerce_lifecycle_facts (
  lifecycle_fact_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  notification_digest text NOT NULL,
  provider_event_digest text NOT NULL CHECK (provider_event_digest ~ '^[a-f0-9]{64}$'),
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_]{2,127}$'),
  subject_digest text CHECK (subject_digest IS NULL OR subject_digest ~ '^[a-f0-9]{64}$'),
  transaction_digest text CHECK (transaction_digest IS NULL OR transaction_digest ~ '^[a-f0-9]{64}$'),
  original_transaction_digest text CHECK (original_transaction_digest IS NULL OR original_transaction_digest ~ '^[a-f0-9]{64}$'),
  subscription_state text,
  financial_effect text NOT NULL CHECK (financial_effect IN ('none','purchase','refund','refund_reversal')),
  environment text CHECK (environment IS NULL OR environment IN ('Sandbox','Production')),
  effective_at control.canonical_timestamp NOT NULL,
  recorded_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (provider, notification_digest, tenant_id, app_id)
    REFERENCES control.commerce_provider_notifications (provider, notification_digest, tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (provider, notification_digest, event_kind, transaction_digest)
);

CREATE TABLE control.commerce_purchase_bindings (
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  transaction_digest text NOT NULL CHECK (transaction_digest ~ '^[a-f0-9]{64}$'),
  original_transaction_digest text CHECK (original_transaction_digest IS NULL OR original_transaction_digest ~ '^[a-f0-9]{64}$'),
  purchase_record_id control.identifier NOT NULL,
  installation_digest text NOT NULL CHECK (installation_digest ~ '^[a-f0-9]{64}$'),
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL CHECK (amount_scale BETWEEN 0 AND 18),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 10000),
  bound_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (provider, transaction_digest),
  FOREIGN KEY (tenant_id, app_id, purchase_record_id)
    REFERENCES ledger.purchase_facts (tenant_id, app_id, record_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.commerce_backfill_checkpoints (
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]{2,127}$'),
  cursor_ref text CHECK (cursor_ref IS NULL OR cursor_ref LIKE 'encrypted:%'),
  window_start control.canonical_timestamp NOT NULL,
  window_end control.canonical_timestamp NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  updated_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (provider, tenant_id, app_id, stream),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE FUNCTION control.resolve_apple_store_registration(_bundle_id text, _app_apple_id bigint)
RETURNS TABLE (tenant_id control.identifier, app_id control.identifier)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT registration.tenant_id, registration.app_id
    FROM control.apple_app_registrations AS registration
   WHERE registration.apple_bundle_id=_bundle_id
     AND (_app_apple_id IS NULL OR registration.apple_app_adam_id=_app_apple_id)
   ORDER BY registration.tenant_id, registration.app_id
   LIMIT 2
$$;

CREATE INDEX commerce_lifecycle_scope_time_idx
  ON ledger.commerce_lifecycle_facts (tenant_id, app_id, effective_at, lifecycle_fact_id);
CREATE INDEX commerce_lifecycle_subject_idx
  ON ledger.commerce_lifecycle_facts (tenant_id, app_id, subject_digest)
  WHERE subject_digest IS NOT NULL;
CREATE UNIQUE INDEX commerce_lifecycle_idempotency_idx
  ON ledger.commerce_lifecycle_facts (provider, event_kind, provider_event_digest);
CREATE INDEX commerce_readbacks_due_idx
  ON ephemeral.commerce_provider_readbacks (tenant_id, next_attempt_at, readback_id);

ALTER TABLE control.commerce_provider_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.commerce_provider_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_notifications_tenant ON control.commerce_provider_notifications
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE ephemeral.commerce_provider_readbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.commerce_provider_readbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_readbacks_tenant ON ephemeral.commerce_provider_readbacks
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE ledger.commerce_lifecycle_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.commerce_lifecycle_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_lifecycle_facts_tenant ON ledger.commerce_lifecycle_facts
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE control.commerce_purchase_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.commerce_purchase_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_purchase_bindings_tenant ON control.commerce_purchase_bindings
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE control.commerce_backfill_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.commerce_backfill_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_backfill_checkpoints_tenant ON control.commerce_backfill_checkpoints
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER commerce_provider_notifications_append_only
  BEFORE UPDATE OR DELETE ON control.commerce_provider_notifications
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER commerce_lifecycle_facts_append_only
  BEFORE UPDATE OR DELETE ON ledger.commerce_lifecycle_facts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER commerce_purchase_bindings_append_only
  BEFORE UPDATE OR DELETE ON control.commerce_purchase_bindings
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.commerce_provider_notifications, control.commerce_purchase_bindings,
  control.commerce_backfill_checkpoints, ledger.commerce_lifecycle_facts,
  ephemeral.commerce_provider_readbacks FROM PUBLIC;
REVOKE ALL ON FUNCTION control.resolve_apple_store_registration(text, bigint) FROM PUBLIC;
GRANT SELECT, INSERT ON control.commerce_provider_notifications, control.commerce_purchase_bindings TO openmasu_app;
GRANT SELECT, INSERT, UPDATE ON control.commerce_backfill_checkpoints TO openmasu_app;
GRANT SELECT, INSERT ON ledger.commerce_lifecycle_facts TO openmasu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.commerce_provider_readbacks TO openmasu_app;
GRANT EXECUTE ON FUNCTION control.resolve_apple_store_registration(text, bigint) TO openmasu_app;
GRANT SELECT ON ledger.commerce_lifecycle_facts TO openmasu_reader;
REVOKE SELECT ON control.commerce_provider_notifications, control.commerce_purchase_bindings,
  control.commerce_backfill_checkpoints, ephemeral.commerce_provider_readbacks FROM openmasu_reader;
GRANT TRUNCATE ON control.commerce_provider_notifications, control.commerce_purchase_bindings,
  control.commerce_backfill_checkpoints, ledger.commerce_lifecycle_facts,
  ephemeral.commerce_provider_readbacks TO openmasu_seed;

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
  SELECT readback.tenant_id
  FROM ephemeral.commerce_provider_readbacks AS readback
  ORDER BY 1
$$;

-- 032_durable_worker_scheduler.sql
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

-- 033_aak_reengagement.sql
-- Add the non-identifying AdAttributionKit conversion type to the protected
-- Apple fact projection. Existing rows predate re-engagement support and remain
-- readable with NULL, which the install-series query treats as a legacy install
-- postback.
ALTER TABLE ledger.apple_postback_facts
  ADD COLUMN IF NOT EXISTS conversion_type text
  CHECK (
    conversion_type IS NULL
    OR conversion_type IN ('download', 'redownload', 're-engagement')
  );

DROP INDEX IF EXISTS ledger.apple_postback_facts_metric_idx;

CREATE INDEX apple_postback_facts_metric_idx
  ON ledger.apple_postback_facts (
    tenant_id, app_id, event_name, conversion_type, received_at, conversion_bucket
  );

-- 034_durable_installation_withdrawals.sql
CREATE TABLE control.installation_withdrawals (
  installation_withdrawal_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME control.installation_withdrawal_seq) PRIMARY KEY,
  installation_key_id control.identifier NOT NULL
    REFERENCES control.installation_credentials (installation_key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  processing_purpose_id control.identifier NOT NULL,
  withdrawal_recognized_at control.canonical_timestamp NOT NULL,
  withdrawal_recognized_sequence bigint NOT NULL CHECK (withdrawal_recognized_sequence >= 0),
  source_record_id control.identifier NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (installation_key_id, processing_purpose_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX installation_withdrawals_scope_idx
  ON control.installation_withdrawals (tenant_id, app_id, installation_key_id);

ALTER TABLE control.installation_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.installation_withdrawals FORCE ROW LEVEL SECURITY;
CREATE POLICY installation_withdrawals_tenant ON control.installation_withdrawals
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

REVOKE ALL ON control.installation_withdrawals FROM PUBLIC;
GRANT SELECT, INSERT ON control.installation_withdrawals TO openmasu_app;
GRANT SELECT ON control.installation_withdrawals TO openmasu_reader;
GRANT USAGE, SELECT ON SEQUENCE control.installation_withdrawal_seq TO openmasu_app;
GRANT SELECT ON SEQUENCE control.installation_withdrawal_seq TO openmasu_reader;

-- 035_sdk_history_lookup_indexes.sql
CREATE INDEX ingest_batch_records_record_lookup_idx
  ON ledger.ingest_batch_records (tenant_id, app_id, record_id, ingest_batch_id);

CREATE INDEX click_facts_remote_ref_lookup_idx
  ON ledger.click_facts (tenant_id, app_id, remote_click_ref)
  WHERE remote_click_ref IS NOT NULL;

CREATE INDEX install_facts_click_lookup_idx
  ON ledger.install_facts (tenant_id, app_id, click_id)
  WHERE click_id IS NOT NULL;

CREATE INDEX install_facts_prior_lookup_idx
  ON ledger.install_facts (tenant_id, app_id, prior_installation_id)
  WHERE prior_installation_id IS NOT NULL;

CREATE INDEX purchase_facts_transaction_lookup_idx
  ON ledger.purchase_facts (tenant_id, app_id, transaction_id);

CREATE INDEX purchase_facts_original_transaction_lookup_idx
  ON ledger.purchase_facts (tenant_id, app_id, original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE INDEX refund_facts_transaction_lookup_idx
  ON ledger.refund_facts (tenant_id, app_id, transaction_id);

CREATE INDEX refund_facts_original_transaction_lookup_idx
  ON ledger.refund_facts (tenant_id, app_id, original_transaction_id);

CREATE TABLE control.installation_withdrawal_backfill_states (
  installation_key_id control.identifier PRIMARY KEY
    REFERENCES control.installation_credentials (installation_key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  completed_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

ALTER TABLE control.installation_withdrawal_backfill_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.installation_withdrawal_backfill_states FORCE ROW LEVEL SECURITY;
CREATE POLICY installation_withdrawal_backfill_states_tenant
  ON control.installation_withdrawal_backfill_states
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

REVOKE ALL ON control.installation_withdrawal_backfill_states FROM PUBLIC;
GRANT SELECT, INSERT ON control.installation_withdrawal_backfill_states TO openmasu_app;
GRANT SELECT ON control.installation_withdrawal_backfill_states TO openmasu_reader;

-- 036_server_event_ingestion.sql
CREATE TABLE control.server_keys (
  server_key_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  producer control.identifier NOT NULL CHECK (producer ~ '^postback:[a-z0-9-]+$'),
  secret_ref text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.server_key_states (
  server_key_state_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME control.server_key_state_seq) PRIMARY KEY,
  server_key_id control.identifier NOT NULL REFERENCES control.server_keys (server_key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  changed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE VIEW control.server_keys_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (key.server_key_id)
  key.*, state.status, state.changed_at AS status_changed_at
FROM control.server_keys AS key
JOIN control.server_key_states AS state USING (server_key_id, tenant_id, app_id)
ORDER BY key.server_key_id, state.server_key_state_seq DESC;

ALTER TABLE ephemeral.request_nonces
  DROP CONSTRAINT request_nonces_principal_type_check;
ALTER TABLE ephemeral.request_nonces
  ADD CONSTRAINT request_nonces_principal_type_check
  CHECK (principal_type IN ('sdk_key', 'installation', 'server_key'));

ALTER TABLE ledger.ingest_batches
  ADD COLUMN server_key_id control.identifier REFERENCES control.server_keys (server_key_id),
  ADD COLUMN subject_digest text CHECK (subject_digest ~ '^[a-f0-9]{64}$');

-- PostgreSQL expands batch.* when the view is created. Preserve every existing
-- view column in place and append the new server-ingest columns so migrations
-- from an existing database expose them without renaming status columns.
CREATE OR REPLACE VIEW ledger.ingest_batches_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (batch.ingest_batch_id)
  batch.inbox_seq,
  batch.ingest_batch_id,
  batch.tenant_id,
  batch.app_id,
  batch.producer,
  batch.sdk_key_id,
  batch.installation_key_id,
  batch.received_at,
  batch.body_ref,
  batch.body_digest,
  batch.event_count,
  batch.request_nonce,
  batch.request_timestamp_ms,
  batch.artifact,
  state.status,
  state.changed_at AS status_changed_at,
  state.reason_code,
  batch.server_key_id,
  batch.subject_digest
FROM ledger.ingest_batches AS batch
JOIN ledger.ingest_batch_states AS state USING (ingest_batch_id, tenant_id, app_id)
ORDER BY batch.ingest_batch_id, state.ingest_batch_state_seq DESC;

CREATE INDEX ingest_batches_server_key_idx
  ON ledger.ingest_batches (tenant_id, app_id, server_key_id, received_at, inbox_seq)
  WHERE server_key_id IS NOT NULL;

CREATE INDEX ingest_batches_subject_digest_idx
  ON ledger.ingest_batches (tenant_id, app_id, subject_digest, received_at, inbox_seq)
  WHERE subject_digest IS NOT NULL;

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_actor_type_check
  CHECK (actor_type IN (
    'admin_key', 'system_job', 'sdk_key', 'sdk_installation', 'apple_postback',
    'server_key'
  ));
ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session',
    'apple_app_registration', 'conversion_schema', 'postback', 'rule_bundle',
    'server_key'
  ));

ALTER TABLE control.server_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.server_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY server_keys_tenant ON control.server_keys
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

ALTER TABLE control.server_key_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.server_key_states FORCE ROW LEVEL SECURITY;
CREATE POLICY server_key_states_tenant ON control.server_key_states
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

CREATE TRIGGER server_keys_append_only
  BEFORE UPDATE OR DELETE ON control.server_keys
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER server_key_states_append_only
  BEFORE UPDATE OR DELETE ON control.server_key_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.server_keys, control.server_key_states FROM PUBLIC;
GRANT SELECT, INSERT ON control.server_keys, control.server_key_states TO openmasu_app;
GRANT SELECT ON control.server_keys, control.server_key_states TO openmasu_reader;
GRANT TRUNCATE ON control.server_keys, control.server_key_states TO openmasu_seed;
GRANT USAGE, SELECT ON SEQUENCE control.server_key_state_seq TO openmasu_app;
GRANT SELECT ON SEQUENCE control.server_key_state_seq TO openmasu_reader;

-- 037_operator_event_webhooks.sql
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
