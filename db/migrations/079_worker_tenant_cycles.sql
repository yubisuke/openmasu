-- A live session owns a tenant cycle. Expiring job leases never steal that session.
CREATE TABLE control.worker_tenant_cycles (
  tenant_id control.identifier PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation > 0),
  owner_token uuid NOT NULL,
  owner_pid integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  interrupted_cycles bigint NOT NULL DEFAULT 0 CHECK (interrupted_cycles >= 0)
);
ALTER TABLE control.worker_tenant_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.worker_tenant_cycles FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_tenant_cycles_tenant ON control.worker_tenant_cycles
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
REVOKE ALL ON control.worker_tenant_cycles FROM PUBLIC,openmasu_reader;
GRANT SELECT,INSERT,UPDATE ON control.worker_tenant_cycles TO openmasu_app;
GRANT TRUNCATE ON control.worker_tenant_cycles TO openmasu_seed;
