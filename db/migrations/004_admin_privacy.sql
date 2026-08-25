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
