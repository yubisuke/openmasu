CREATE TABLE control.operator_bulk_export_credential_revisions (
  credential_revision_seq bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME control.operator_bulk_credential_revision_seq) PRIMARY KEY,
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  destination_id text NOT NULL,
  credential_ref text NOT NULL,
  credential_digest text NOT NULL CHECK (credential_digest ~ '^[a-f0-9]{64}$'),
  changed_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id,app_id,destination_id)
    REFERENCES control.operator_bulk_export_destinations(tenant_id,app_id,destination_id)
);
CREATE INDEX operator_bulk_credentials_current ON control.operator_bulk_export_credential_revisions
  (tenant_id,app_id,destination_id,credential_revision_seq DESC);
ALTER TABLE control.operator_bulk_export_credential_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_bulk_export_credential_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_bulk_credentials_tenant ON control.operator_bulk_export_credential_revisions
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER operator_bulk_credentials_append_only BEFORE UPDATE OR DELETE
  ON control.operator_bulk_export_credential_revisions
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.operator_bulk_export_credential_revisions FROM PUBLIC;
GRANT SELECT,INSERT ON control.operator_bulk_export_credential_revisions TO openmasu_app;
GRANT SELECT (credential_revision_seq,tenant_id,app_id,destination_id,changed_at)
  ON control.operator_bulk_export_credential_revisions TO openmasu_reader;
GRANT TRUNCATE ON control.operator_bulk_export_credential_revisions TO openmasu_seed;
GRANT USAGE,SELECT ON SEQUENCE control.operator_bulk_credential_revision_seq TO openmasu_app;
