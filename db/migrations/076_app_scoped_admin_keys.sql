-- NULL preserves all existing tenant-wide keys; legacy app_id is not reinterpreted.
ALTER TABLE control.admin_keys ADD COLUMN app_scope control.identifier;
ALTER TABLE control.admin_keys ADD CONSTRAINT admin_keys_app_scope_fkey
  FOREIGN KEY (tenant_id,app_scope) REFERENCES control.apps(tenant_id,app_id);

CREATE OR REPLACE VIEW control.admin_keys_current WITH (security_invoker=true) AS
SELECT DISTINCT ON (key.key_id)
  key.key_id,key.tenant_id,key.app_id,key.scrypt_salt,key.scrypt_digest,key.created_at,key.role,
  state.status,state.changed_at AS status_changed_at,key.app_scope
FROM control.admin_keys AS key JOIN control.admin_key_states AS state ON state.key_id=key.key_id
ORDER BY key.key_id,state.admin_key_state_seq DESC;

CREATE OR REPLACE VIEW control.admin_key_roles_current WITH (security_invoker=true) AS
SELECT DISTINCT ON (key.key_id) key.key_id,key.tenant_id,key.role,state.status,key.app_scope
FROM control.admin_keys AS key JOIN control.admin_key_states AS state ON state.key_id=key.key_id
ORDER BY key.key_id,state.admin_key_state_seq DESC;
GRANT SELECT (app_scope) ON control.admin_keys TO openmasu_reader;
