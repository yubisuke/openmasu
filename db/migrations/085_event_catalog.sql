-- Event planning metadata is separate from immutable event and metric evidence.
CREATE TABLE control.event_catalog_revisions (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  event_key text NOT NULL CHECK (event_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  revision integer NOT NULL CHECK (revision > 0),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  meaning text NOT NULL CHECK (length(meaning) BETWEEN 1 AND 1000),
  firing_condition text NOT NULL CHECK (length(firing_condition) BETWEEN 1 AND 1000),
  lifecycle text NOT NULL CHECK (lifecycle IN ('planned','active','deprecated')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,app_id,event_key,revision),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
CREATE VIEW control.event_catalog_current WITH (security_invoker=true) AS
  SELECT DISTINCT ON (tenant_id,app_id,event_key) * FROM control.event_catalog_revisions
  ORDER BY tenant_id,app_id,event_key,revision DESC;
ALTER TABLE control.event_catalog_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.event_catalog_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY event_catalog_tenant ON control.event_catalog_revisions
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER event_catalog_append_only BEFORE UPDATE OR DELETE ON control.event_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.event_catalog_revisions,control.event_catalog_current FROM PUBLIC;
GRANT SELECT,INSERT ON control.event_catalog_revisions TO openmasu_app;
GRANT SELECT ON control.event_catalog_current TO openmasu_app;
GRANT SELECT ON control.event_catalog_revisions,control.event_catalog_current TO openmasu_reader;
GRANT TRUNCATE ON control.event_catalog_revisions TO openmasu_seed;
