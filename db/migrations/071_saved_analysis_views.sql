-- Only authorized report filters and display settings; never saved metric values.
CREATE TABLE control.saved_analysis_views (
  view_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  selection text NOT NULL CHECK (octet_length(selection)<=8192),
  display text NOT NULL CHECK (display IN ('all','exceptions')),
  created_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
CREATE INDEX saved_analysis_app_idx ON control.saved_analysis_views (tenant_id,app_id,created_at,view_id);
ALTER TABLE control.saved_analysis_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.saved_analysis_views FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_analysis_tenant ON control.saved_analysis_views
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
REVOKE ALL ON control.saved_analysis_views FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON control.saved_analysis_views TO openmasu_app;
GRANT SELECT ON control.saved_analysis_views TO openmasu_reader;
GRANT TRUNCATE ON control.saved_analysis_views TO openmasu_seed;
