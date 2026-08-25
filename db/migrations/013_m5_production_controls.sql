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
