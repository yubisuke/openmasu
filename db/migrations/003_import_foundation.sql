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
