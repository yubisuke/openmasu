-- Operational receipts, not contract/event artifacts. Dry-run preview writes nothing.
CREATE TABLE control.retention_receipts (
  receipt_digest text PRIMARY KEY CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  policy jsonb NOT NULL,
  candidate_count integer NOT NULL CHECK (candidate_count BETWEEN 0 AND 1000),
  dependent_run_count integer NOT NULL CHECK (dependent_run_count >= 0),
  created_at control.canonical_timestamp NOT NULL,
  UNIQUE (tenant_id,app_id,receipt_digest),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps(tenant_id,app_id)
);
CREATE TABLE control.retention_items (
  receipt_digest text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  layer text NOT NULL CHECK (layer IN ('protected_payload','expired_request_nonces')),
  target jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','invalidated','completed','skipped_changed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (last_error IS NULL OR last_error='payload_purge_failed'),
  updated_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (receipt_digest,ordinal),
  FOREIGN KEY (tenant_id,app_id,receipt_digest) REFERENCES control.retention_receipts(tenant_id,app_id,receipt_digest)
);
CREATE INDEX retention_items_pending ON control.retention_items(tenant_id,app_id,receipt_digest,ordinal)
  WHERE state IN ('pending','invalidated');
CREATE INDEX retention_items_payload ON control.retention_items(tenant_id,app_id,(target->>'payload_ref'))
  WHERE layer='protected_payload' AND state IN ('invalidated','completed');
ALTER TABLE control.retention_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.retention_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE control.retention_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.retention_items FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_receipts_tenant ON control.retention_receipts
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE POLICY retention_items_tenant ON control.retention_items
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER retention_receipts_append_only BEFORE UPDATE OR DELETE ON control.retention_receipts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE FUNCTION control.retention_item_progress_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.receipt_digest,NEW.ordinal,NEW.tenant_id,NEW.app_id,NEW.layer,NEW.target)
       IS DISTINCT FROM (OLD.receipt_digest,OLD.ordinal,OLD.tenant_id,OLD.app_id,OLD.layer,OLD.target)
     OR (OLD.state IN ('completed','skipped_changed') AND NEW IS DISTINCT FROM OLD)
     OR (OLD.state='invalidated' AND NEW.state NOT IN ('invalidated','completed')) THEN
    RAISE EXCEPTION 'retention target or completed progress is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retention_items_progress_only BEFORE UPDATE ON control.retention_items
  FOR EACH ROW EXECUTE FUNCTION control.retention_item_progress_only();
REVOKE ALL ON control.retention_receipts,control.retention_items FROM PUBLIC;
GRANT SELECT,INSERT ON control.retention_receipts TO openmasu_app;
GRANT SELECT,INSERT,UPDATE ON control.retention_items TO openmasu_app;
GRANT SELECT ON control.retention_receipts TO openmasu_reader;
GRANT TRUNCATE ON control.retention_receipts,control.retention_items TO openmasu_seed;
