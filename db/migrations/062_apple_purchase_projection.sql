-- Protected admission scope and append-only monetary evidence; no contract change.
ALTER TABLE control.commerce_provider_notifications ADD COLUMN installation_id_digest text
  CHECK (installation_id_digest IS NULL OR installation_id_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE control.commerce_purchase_bindings ADD COLUMN apple_intent_id uuid;
-- Deliberately not a foreign key: privacy removes the protected intent while
-- keeping non-identifying historical binding/projection provenance readable.
CREATE TABLE control.apple_purchase_evidence (
  record_id control.identifier PRIMARY KEY REFERENCES ledger.raw_records (record_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id_digest text NOT NULL CHECK (installation_id_digest ~ '^[a-f0-9]{64}$'),
  intent_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'encrypted:%'),
  signed_digest text NOT NULL CHECK (signed_digest ~ '^[a-f0-9]{64}$'),
  recorded_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
ALTER TABLE control.apple_purchase_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.apple_purchase_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY apple_purchase_evidence_tenant ON control.apple_purchase_evidence
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER apple_purchase_evidence_append_only BEFORE UPDATE OR DELETE ON control.apple_purchase_evidence
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.apple_purchase_evidence FROM PUBLIC, openmasu_reader;
GRANT SELECT, INSERT ON control.apple_purchase_evidence TO openmasu_app;
GRANT TRUNCATE ON control.apple_purchase_evidence TO openmasu_seed;
CREATE INDEX apple_purchase_evidence_subject_idx
  ON control.apple_purchase_evidence (tenant_id,app_id,installation_id_digest);
CREATE INDEX commerce_notification_installation_idx
  ON control.commerce_provider_notifications (tenant_id,app_id,installation_id_digest)
  WHERE installation_id_digest IS NOT NULL;
CREATE INDEX apple_binding_intent_idx ON control.commerce_purchase_bindings (tenant_id,app_id,apple_intent_id)
  WHERE apple_intent_id IS NOT NULL;
