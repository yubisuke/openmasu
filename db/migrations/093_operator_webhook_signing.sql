-- Keep the existing destination secret as the immutable reference-HMAC key.
-- Only signing use is revisioned; retries never silently adopt a later key.
CREATE TABLE control.operator_webhook_signing_revisions (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id control.identifier NOT NULL,
  signing_revision bigint NOT NULL CHECK (signing_revision BETWEEN 1 AND 9007199254740991),
  secret_ref text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  previous_valid_until control.canonical_timestamp,
  PRIMARY KEY (tenant_id,app_id,destination_id,signing_revision),
  FOREIGN KEY (tenant_id,app_id,destination_id)
    REFERENCES control.operator_webhook_destinations(tenant_id,app_id,destination_id),
  CHECK ((signing_revision=1 AND previous_valid_until IS NULL) OR
    (signing_revision>1 AND previous_valid_until IS NOT NULL
      AND control.canonical_timestamp_value(previous_valid_until)>=control.canonical_timestamp_value(created_at)
      AND control.canonical_timestamp_value(previous_valid_until)<=control.canonical_timestamp_value(created_at)+interval '1 day'))
);
-- The migration transaction runs as the table owner. Temporarily remove FORCE
-- only for this legacy backfill; the transactional DDL lock excludes concurrent
-- access, and ordinary roles retain their tenant policies throughout.
ALTER TABLE control.operator_webhook_destinations NO FORCE ROW LEVEL SECURITY;
INSERT INTO control.operator_webhook_signing_revisions
  (tenant_id,app_id,destination_id,signing_revision,secret_ref,created_at)
  SELECT tenant_id,app_id,destination_id,1,secret_ref,created_at FROM control.operator_webhook_destinations;
ALTER TABLE control.operator_webhook_destinations FORCE ROW LEVEL SECURITY;

CREATE TABLE control.operator_webhook_signing_retirements (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id control.identifier NOT NULL,
  signing_revision bigint NOT NULL,
  retired_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (tenant_id,app_id,destination_id,signing_revision),
  FOREIGN KEY (tenant_id,app_id,destination_id,signing_revision)
    REFERENCES control.operator_webhook_signing_revisions(tenant_id,app_id,destination_id,signing_revision)
);
ALTER TABLE ephemeral.operator_webhook_deliveries ADD COLUMN signing_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE ephemeral.operator_webhook_deliveries ADD CONSTRAINT operator_webhook_delivery_signer
  FOREIGN KEY (tenant_id,app_id,destination_id,signing_revision)
  REFERENCES control.operator_webhook_signing_revisions(tenant_id,app_id,destination_id,signing_revision);

ALTER TABLE control.operator_webhook_signing_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_webhook_signing_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_webhook_signing_revision_tenant ON control.operator_webhook_signing_revisions
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER operator_webhook_signing_revision_append_only BEFORE UPDATE OR DELETE
  ON control.operator_webhook_signing_revisions FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
ALTER TABLE control.operator_webhook_signing_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_webhook_signing_retirements FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_webhook_signing_retirement_tenant ON control.operator_webhook_signing_retirements
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER operator_webhook_signing_retirement_append_only BEFORE UPDATE OR DELETE
  ON control.operator_webhook_signing_retirements FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

-- Override the owner's default grants: readers must never select secret_ref.
REVOKE ALL ON control.operator_webhook_signing_revisions,control.operator_webhook_signing_retirements
  FROM PUBLIC,openmasu_reader,openmasu_app,openmasu_seed;
GRANT SELECT,INSERT ON control.operator_webhook_signing_revisions,control.operator_webhook_signing_retirements TO openmasu_app;
GRANT SELECT (tenant_id,app_id,destination_id,signing_revision,created_at,previous_valid_until)
  ON control.operator_webhook_signing_revisions TO openmasu_reader;
GRANT SELECT (tenant_id,app_id,destination_id,signing_revision,retired_at)
  ON control.operator_webhook_signing_retirements TO openmasu_reader;
GRANT SELECT (signing_revision) ON ephemeral.operator_webhook_deliveries TO openmasu_reader;
GRANT TRUNCATE ON control.operator_webhook_signing_revisions,control.operator_webhook_signing_retirements TO openmasu_seed;
