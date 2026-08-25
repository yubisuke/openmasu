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
