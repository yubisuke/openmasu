-- Mapping bodies and provider header names remain in the protected payload store.
CREATE TABLE control.import_mapping_revisions (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  mapping_id control.identifier NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  kind text NOT NULL CHECK (kind IN ('mmp_raw','manual_cost')),
  mapping_digest text NOT NULL CHECK (mapping_digest ~ '^[a-f0-9]{64}$'),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  protected_ref text NOT NULL,
  header_count integer NOT NULL CHECK (header_count BETWEEN 1 AND 256),
  created_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (tenant_id,app_id,mapping_id,revision),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps(tenant_id,app_id)
);
ALTER TABLE control.import_mapping_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.import_mapping_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY import_mapping_revision_tenant ON control.import_mapping_revisions
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER import_mapping_revision_append_only BEFORE UPDATE OR DELETE
  ON control.import_mapping_revisions FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.import_mapping_revisions FROM PUBLIC,openmasu_app,openmasu_reader,openmasu_seed;
GRANT SELECT,INSERT ON control.import_mapping_revisions TO openmasu_app;
GRANT SELECT (tenant_id,app_id,mapping_id,revision,kind,mapping_digest,definition_digest,header_count,created_at)
  ON control.import_mapping_revisions TO openmasu_reader;
GRANT TRUNCATE ON control.import_mapping_revisions TO openmasu_seed;
