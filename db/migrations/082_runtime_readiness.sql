-- Read-only version metadata, not owner credentials or migration authority.
CREATE VIEW control.runtime_schema_inventory AS
  SELECT version,name,checksum FROM public.schema_migrations;
REVOKE ALL ON control.runtime_schema_inventory FROM PUBLIC;
GRANT SELECT ON control.runtime_schema_inventory TO openmasu_app,openmasu_reader;

-- One expiring discovery heartbeat per tenant; job success has separate metrics.
CREATE TABLE control.worker_heartbeats (
  tenant_id control.identifier PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > observed_at)
);
ALTER TABLE control.worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_heartbeats_tenant ON control.worker_heartbeats
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
REVOKE ALL ON control.worker_heartbeats FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON control.worker_heartbeats TO openmasu_app;
GRANT SELECT ON control.worker_heartbeats TO openmasu_reader;
GRANT TRUNCATE ON control.worker_heartbeats TO openmasu_seed;
