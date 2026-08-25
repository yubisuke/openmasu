-- Open MMP schema snapshot.
-- Generated deterministically from db/migrations; do not edit by hand.
-- 001_initial_ledger.sql
CREATE SCHEMA control AUTHORIZATION openmmp_owner;
CREATE SCHEMA ledger AUTHORIZATION openmmp_owner;

REVOKE ALL ON SCHEMA control, ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA control, ledger TO openmmp_app, openmmp_reader;
GRANT USAGE ON SCHEMA ledger TO openmmp_seed;

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
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''open_mmp.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''open_mmp.tenant_id'', true))',
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
  TO openmmp_app, openmmp_reader;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA control, ledger TO openmmp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control, ledger TO openmmp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA control, ledger FROM openmmp_app;
GRANT TRUNCATE ON ALL TABLES IN SCHEMA ledger TO openmmp_seed;
GRANT SELECT ON ALL TABLES IN SCHEMA control, ledger TO openmmp_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA control, ledger TO openmmp_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE openmmp_owner IN SCHEMA control, ledger
  GRANT SELECT, INSERT ON TABLES TO openmmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openmmp_owner IN SCHEMA control, ledger
  GRANT USAGE, SELECT ON SEQUENCES TO openmmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE openmmp_owner IN SCHEMA control, ledger
  GRANT SELECT ON TABLES TO openmmp_reader;

-- 002_fixture_parity.sql
CREATE SCHEMA testing AUTHORIZATION openmmp_owner;
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
GRANT USAGE ON SCHEMA testing TO openmmp_seed;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA testing TO openmmp_seed;

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
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''open_mmp.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''open_mmp.tenant_id'', true))',
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
  ledger.ingest_inbox, ledger.ingest_inbox_states TO openmmp_app;
GRANT SELECT ON control.import_files, control.import_attempts, control.import_row_rejections,
  ledger.ingest_inbox, ledger.ingest_inbox_states TO openmmp_reader;
GRANT USAGE, SELECT ON SEQUENCE ledger.ingest_inbox_states_inbox_state_seq_seq TO openmmp_app;
GRANT SELECT ON SEQUENCE ledger.ingest_inbox_states_inbox_state_seq_seq TO openmmp_reader;
GRANT TRUNCATE ON ledger.ingest_inbox, ledger.ingest_inbox_states TO openmmp_seed;

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
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));
ALTER TABLE control.admin_key_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.admin_key_states FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_key_states_tenant ON control.admin_key_states
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));

CREATE TRIGGER admin_keys_append_only
  BEFORE UPDATE OR DELETE ON control.admin_keys
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER admin_key_states_append_only
  BEFORE UPDATE OR DELETE ON control.admin_key_states
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.admin_keys, control.admin_key_states FROM PUBLIC;
GRANT SELECT, INSERT ON control.admin_keys, control.admin_key_states TO openmmp_app;
GRANT USAGE, SELECT ON SEQUENCE control.admin_key_states_admin_key_state_seq_seq TO openmmp_app;

GRANT TRUNCATE ON control.admin_keys, control.admin_key_states TO openmmp_seed;

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
  TO openmmp_app, openmmp_reader, openmmp_seed;

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
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));

CREATE TRIGGER reconciliation_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.reconciliation_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.reconciliation_results FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.reconciliation_results TO openmmp_app;
GRANT SELECT ON ledger.reconciliation_results TO openmmp_reader;
GRANT TRUNCATE ON ledger.reconciliation_results TO openmmp_seed;
