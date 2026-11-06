-- Immutable definitions; the existing row remains a current-state/pacing cache.
ALTER TABLE control.google_data_manager_destinations ADD COLUMN current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision>=0);
ALTER TABLE control.google_data_manager_destinations ADD UNIQUE (tenant_id,app_id,destination_id);
CREATE TABLE control.google_destination_revisions (
  tenant_id control.identifier NOT NULL, app_id control.identifier NOT NULL, destination_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0), definition jsonb NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  ready boolean NOT NULL, created_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (tenant_id,app_id,destination_id,revision),
  FOREIGN KEY (tenant_id,app_id,destination_id) REFERENCES control.google_data_manager_destinations(tenant_id,app_id,destination_id)
);
-- Historical numeric settings are not evidence of eligibility. Preserve, then disable.
ALTER TABLE control.google_data_manager_destinations NO FORCE ROW LEVEL SECURITY;
INSERT INTO control.google_destination_revisions
  SELECT tenant_id,app_id,destination_id,1,artifact,encode(sha256(convert_to(artifact::text,'UTF8')),'hex'),false,registered_at
  FROM control.google_data_manager_destinations;
UPDATE control.google_data_manager_destinations SET current_revision=1,enabled=false;
ALTER TABLE control.google_data_manager_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE control.google_destination_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_destination_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY google_destination_revision_tenant ON control.google_destination_revisions
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER google_destination_revision_append_only BEFORE UPDATE OR DELETE ON control.google_destination_revisions
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.google_destination_revisions FROM PUBLIC,openmasu_app,openmasu_reader,openmasu_seed;
GRANT SELECT,INSERT ON control.google_destination_revisions TO openmasu_app;
GRANT SELECT ON control.google_destination_revisions TO openmasu_reader;
GRANT TRUNCATE ON control.google_destination_revisions TO openmasu_seed;
ALTER TABLE ephemeral.google_conversion_deliveries ADD COLUMN destination_revision integer;
ALTER TABLE ephemeral.google_conversion_deliveries ADD FOREIGN KEY (tenant_id,app_id,destination_id,destination_revision)
  REFERENCES control.google_destination_revisions(tenant_id,app_id,destination_id,revision);
