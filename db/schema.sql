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

-- 009_m2a_server_foundation.sql
CREATE SCHEMA ephemeral AUTHORIZATION openmmp_owner;

REVOKE ALL ON SCHEMA ephemeral FROM PUBLIC;
GRANT USAGE ON SCHEMA ephemeral TO openmmp_app;

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
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''open_mmp.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''open_mmp.tenant_id'', true))',
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
TO openmmp_app;

GRANT SELECT, INSERT, DELETE ON ephemeral.request_nonces TO openmmp_app;

GRANT SELECT ON
  control.tracking_links, control.tracking_link_states,
  control.sdk_keys, control.sdk_key_states,
  control.installation_credentials, control.installation_credential_states,
  ledger.ingest_batches, ledger.ingest_batch_states, ledger.ingest_batch_records,
  ledger.custom_event_facts
TO openmmp_reader;

GRANT USAGE, SELECT ON SEQUENCE
  control.tracking_link_states_tracking_link_state_seq_seq,
  control.sdk_key_states_sdk_key_state_seq_seq,
  control.installation_credential_state_seq,
  ledger.ingest_batches_inbox_seq_seq,
  ledger.ingest_batch_states_ingest_batch_state_seq_seq
TO openmmp_app;

GRANT SELECT ON SEQUENCE
  control.tracking_link_states_tracking_link_state_seq_seq,
  control.sdk_key_states_sdk_key_state_seq_seq,
  control.installation_credential_state_seq,
  ledger.ingest_batches_inbox_seq_seq,
  ledger.ingest_batch_states_ingest_batch_state_seq_seq
TO openmmp_reader;

GRANT TRUNCATE ON
  ledger.ingest_batches, ledger.ingest_batch_states, ledger.ingest_batch_records,
  ledger.custom_event_facts,
  ephemeral.request_nonces
TO openmmp_seed;

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
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));

ALTER TABLE ledger.audit_logs DROP CONSTRAINT audit_logs_target_scope_check;
ALTER TABLE ledger.audit_logs ADD CONSTRAINT audit_logs_target_scope_check
  CHECK (target_scope IN (
    'tenant', 'app', 'record', 'privacy_request', 'metric_run', 'import_source',
    'admin_key', 'sdk_key', 'installation', 'tracking_link', 'ingest_batch', 'session'
  ));

REVOKE ALL ON ephemeral.dashboard_sessions FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON ephemeral.dashboard_sessions TO openmmp_app;
GRANT USAGE ON SCHEMA ephemeral TO openmmp_reader;
GRANT SELECT ON ephemeral.dashboard_sessions TO openmmp_reader;
GRANT TRUNCATE ON ephemeral.dashboard_sessions TO openmmp_seed;

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
    tenant_id = current_setting('open_mmp.tenant_id', true)
    OR current_user = 'openmmp_owner'
  )
  WITH CHECK (
    tenant_id = current_setting('open_mmp.tenant_id', true)
    OR current_user = 'openmmp_owner'
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
      'CREATE POLICY %I_tenant ON %I.%I USING (tenant_id = current_setting(''open_mmp.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''open_mmp.tenant_id'', true))',
      item.table_name,
      item.table_schema,
      item.table_name
    );
  END LOOP;
END
$$;

-- list_m4_work_tenants() runs before a tenant GUC exists. FORCE RLS therefore
-- needs SELECT-only owner policies on its three inputs. openmmp_owner is
-- NOLOGIN and the SECURITY DEFINER function returns tenant identifiers only.
CREATE POLICY ingest_batches_m4_discovery_owner
  ON ledger.ingest_batches FOR SELECT TO openmmp_owner USING (true);
CREATE POLICY ingest_batch_states_m4_discovery_owner
  ON ledger.ingest_batch_states FOR SELECT TO openmmp_owner USING (true);
CREATE POLICY adservices_lookups_m4_discovery_owner
  ON ephemeral.adservices_lookups FOR SELECT TO openmmp_owner USING (true);

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
FROM openmmp_app, openmmp_reader;

GRANT SELECT, INSERT ON
  control.apple_app_registrations,
  control.conversion_schemas,
  control.conversion_schema_states
TO openmmp_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.adservices_lookups TO openmmp_app;
GRANT INSERT ON control.public_postback_audits TO openmmp_app;
GRANT SELECT, INSERT ON ledger.adservices_lookup_results TO openmmp_app;
GRANT SELECT, INSERT ON ledger.apple_postback_facts TO openmmp_app;

GRANT SELECT ON
  control.apple_app_registrations,
  control.conversion_schemas,
  control.conversion_schema_states,
  ephemeral.adservices_lookups,
  ledger.apple_postback_facts
TO openmmp_reader;

GRANT USAGE, SELECT ON SEQUENCE control.conversion_schema_states_conversion_schema_state_seq_seq
TO openmmp_app;
GRANT SELECT ON SEQUENCE control.conversion_schema_states_conversion_schema_state_seq_seq
TO openmmp_reader;

REVOKE ALL ON FUNCTION control.resolve_apple_app_adam_id(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.resolve_apple_app_adam_id(bigint) TO openmmp_app;
REVOKE ALL ON FUNCTION control.list_apple_postback_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_apple_postback_tenants() TO openmmp_app;
REVOKE ALL ON FUNCTION control.list_m4_work_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_m4_work_tenants() TO openmmp_app;

GRANT TRUNCATE ON
  control.public_postback_audits,
  ephemeral.adservices_lookups,
  ledger.adservices_lookup_results,
  ledger.apple_postback_facts
TO openmmp_seed;
GRANT USAGE ON SCHEMA control, ephemeral TO openmmp_seed;

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
REVOKE SELECT ON control.admin_keys_current FROM openmmp_reader;
REVOKE SELECT ON control.admin_keys, control.admin_key_states FROM openmmp_reader;
GRANT SELECT ON control.admin_key_roles_current TO openmmp_reader;
GRANT SELECT (key_id, tenant_id, role) ON control.admin_keys TO openmmp_reader;
GRANT SELECT (key_id, tenant_id, status, admin_key_state_seq) ON control.admin_key_states TO openmmp_reader;

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
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));

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
GRANT SELECT, INSERT ON control.rule_bundle_revisions TO openmmp_app;
GRANT SELECT ON control.rule_bundle_revisions TO openmmp_reader;
GRANT TRUNCATE ON control.rule_bundle_revisions TO openmmp_seed;

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
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));

CREATE TRIGGER metric_replay_manifests_append_only
  BEFORE UPDATE OR DELETE ON control.metric_replay_manifests
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.metric_replay_manifests FROM PUBLIC;
REVOKE SELECT ON control.metric_replay_manifests FROM openmmp_reader;
GRANT SELECT, INSERT ON control.metric_replay_manifests TO openmmp_app;
GRANT TRUNCATE ON control.metric_replay_manifests TO openmmp_seed;
