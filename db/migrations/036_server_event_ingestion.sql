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
