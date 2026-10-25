-- Optional private aggregate storage. No raw files, identifiers or provider credentials.
CREATE TABLE control.comparison_definitions (
  comparison_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  definition jsonb NOT NULL CHECK (octet_length(definition::text)<=8192),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  privacy_epoch text NOT NULL,
  supersedes_id control.identifier,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id,app_id,comparison_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps(tenant_id,app_id),
  FOREIGN KEY (tenant_id,app_id,supersedes_id) REFERENCES control.comparison_definitions(tenant_id,app_id,comparison_id)
);
CREATE UNIQUE INDEX comparison_one_replacement_idx ON control.comparison_definitions(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TABLE control.comparison_snapshots (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  comparison_id control.identifier NOT NULL,
  target_date date NOT NULL,
  side text NOT NULL CHECK (side IN ('left','right')),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (octet_length(snapshot::text)<=5242880),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (comparison_id,target_date,side),
  FOREIGN KEY (tenant_id,app_id,comparison_id) REFERENCES control.comparison_definitions(tenant_id,app_id,comparison_id)
);
CREATE TABLE control.comparison_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  comparison_id control.identifier NOT NULL,
  target_date date NOT NULL,
  left_digest text,
  right_digest text,
  result jsonb NOT NULL CHECK (octet_length(result::text)<=5242880),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,app_id,comparison_id) REFERENCES control.comparison_definitions(tenant_id,app_id,comparison_id)
);
CREATE INDEX comparison_definitions_app_idx ON control.comparison_definitions(tenant_id,app_id,created_at);
CREATE INDEX comparison_runs_date_idx ON control.comparison_runs(tenant_id,app_id,comparison_id,target_date,created_at DESC);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['comparison_definitions','comparison_snapshots','comparison_runs'] LOOP
    EXECUTE format('ALTER TABLE control.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE control.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY comparison_tenant ON control.%I USING (tenant_id=current_setting(''openmasu.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''openmasu.tenant_id'',true))',name);
    EXECUTE format('REVOKE ALL ON control.%I FROM PUBLIC',name);
    EXECUTE format('GRANT SELECT,INSERT,DELETE ON control.%I TO openmasu_app',name);
    EXECUTE format('GRANT SELECT ON control.%I TO openmasu_reader',name);
    EXECUTE format('GRANT TRUNCATE ON control.%I TO openmasu_seed',name);
  END LOOP;
END $$;
GRANT UPDATE(active,deleted_at) ON control.comparison_definitions TO openmasu_app;

-- Retain every existing tenant-discovery branch without duplicating its definition.
ALTER FUNCTION control.list_m4_work_tenants() RENAME TO list_pre_comparison_work_tenants;
REVOKE ALL ON FUNCTION control.list_pre_comparison_work_tenants() FROM PUBLIC;
CREATE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT tenant_id FROM control.list_pre_comparison_work_tenants() AS previous(tenant_id)
  UNION SELECT tenant_id FROM control.comparison_definitions
  ORDER BY 1
$$;
REVOKE ALL ON FUNCTION control.list_m4_work_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_m4_work_tenants() TO openmasu_app;
