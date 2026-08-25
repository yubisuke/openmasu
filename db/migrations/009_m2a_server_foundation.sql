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
