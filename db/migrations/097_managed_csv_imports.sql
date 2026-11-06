-- Raw uploads remain encrypted and short-lived. Durable receipts contain no rows.
CREATE TABLE ephemeral.managed_import_uploads (
  upload_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  mapping_id control.identifier NOT NULL,
  revision integer NOT NULL,
  mapping_digest text NOT NULL CHECK (mapping_digest ~ '^[a-f0-9]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  confirmation_digest text NOT NULL CHECK (confirmation_digest ~ '^[a-f0-9]{64}$'),
  source_bytes integer NOT NULL CHECK (source_bytes BETWEEN 1 AND 4194304),
  protected_ref text,
  state text NOT NULL CHECK (state IN ('uploaded','previewed','blocked','queued','importing','completed','failed','expired')),
  preview jsonb,
  result jsonb,
  safe_reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  created_at control.canonical_timestamp NOT NULL,
  expires_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id,app_id,mapping_id,revision)
    REFERENCES control.import_mapping_revisions(tenant_id,app_id,mapping_id,revision)
);
CREATE INDEX managed_import_work ON ephemeral.managed_import_uploads (tenant_id,state,created_at);
CREATE TABLE control.managed_import_receipts (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_id control.identifier NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  mapping_digest text NOT NULL CHECK (mapping_digest ~ '^[a-f0-9]{64}$'),
  received_at control.canonical_timestamp NOT NULL,
  result jsonb,
  PRIMARY KEY (tenant_id,app_id,source_id,source_digest),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps(tenant_id,app_id)
);
CREATE FUNCTION control.keep_managed_import_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.app_id,NEW.source_id,NEW.source_digest,NEW.mapping_digest,NEW.received_at)
      IS DISTINCT FROM ROW(OLD.tenant_id,OLD.app_id,OLD.source_id,OLD.source_digest,OLD.mapping_digest,OLD.received_at)
      OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result) THEN
    RAISE EXCEPTION 'managed import binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER managed_import_binding_immutable BEFORE UPDATE ON control.managed_import_receipts
  FOR EACH ROW EXECUTE FUNCTION control.keep_managed_import_binding();
CREATE TRIGGER managed_import_binding_append_only BEFORE DELETE ON control.managed_import_receipts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
ALTER TABLE ephemeral.managed_import_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.managed_import_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE control.managed_import_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.managed_import_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_upload_tenant ON ephemeral.managed_import_uploads
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE POLICY managed_upload_discovery_owner ON ephemeral.managed_import_uploads
  FOR SELECT TO openmasu_owner USING (true);
CREATE POLICY managed_receipt_tenant ON control.managed_import_receipts
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
REVOKE ALL ON ephemeral.managed_import_uploads,control.managed_import_receipts FROM PUBLIC,openmasu_app,openmasu_reader,openmasu_seed;
GRANT SELECT,INSERT,UPDATE,DELETE ON ephemeral.managed_import_uploads TO openmasu_app;
GRANT SELECT (upload_id,tenant_id,app_id,mapping_id,revision,mapping_digest,source_digest,confirmation_digest,
  source_bytes,state,preview,result,safe_reason,attempts,created_at,expires_at) ON ephemeral.managed_import_uploads TO openmasu_reader;
GRANT SELECT,INSERT,UPDATE ON control.managed_import_receipts TO openmasu_app;
GRANT TRUNCATE ON ephemeral.managed_import_uploads,control.managed_import_receipts TO openmasu_seed;
ALTER TABLE control.worker_job_schedules DROP CONSTRAINT worker_job_schedules_job_name_check;
ALTER TABLE control.worker_job_schedules ADD CONSTRAINT worker_job_schedules_job_name_check CHECK (job_name IN (
  'max_inbox','sdk_inbox','adservices_lookup','integrity_verification','google_play_verification',
  'commerce_readback','google_conversion_delivery','operator_webhook_delivery','operator_bulk_export',
  'privacy_purge','metric_run','cost_refresh','fraud_maintenance','dashboard_session_sweep','managed_import'
));
ALTER FUNCTION control.list_m4_work_tenants() RENAME TO list_pre_managed_import_work_tenants;
REVOKE ALL ON FUNCTION control.list_pre_managed_import_work_tenants() FROM PUBLIC;
CREATE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT tenant_id FROM control.list_pre_managed_import_work_tenants() AS previous(tenant_id)
  UNION SELECT tenant_id FROM ephemeral.managed_import_uploads
  ORDER BY 1
$$;
REVOKE ALL ON FUNCTION control.list_m4_work_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.list_m4_work_tenants() TO openmasu_app;
