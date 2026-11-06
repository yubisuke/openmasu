-- Content selection is immutable and independent of signing-key rotation.
CREATE TABLE control.operator_webhook_content_revisions (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  destination_id control.identifier NOT NULL,
  policy_revision bigint NOT NULL CHECK (policy_revision BETWEEN 1 AND 2147483647),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object' AND definition->>'mode' IN ('legacy_v1','explicit_v1')),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  created_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (tenant_id,app_id,destination_id,policy_revision),
  FOREIGN KEY (tenant_id,app_id,destination_id) REFERENCES control.operator_webhook_destinations(tenant_id,app_id,destination_id)
);
ALTER TABLE control.operator_webhook_destinations NO FORCE ROW LEVEL SECURITY;
INSERT INTO control.operator_webhook_content_revisions
  SELECT tenant_id,app_id,destination_id,1,'{"mode":"legacy_v1"}'::jsonb,
    encode(sha256(convert_to('{"mode":"legacy_v1"}','UTF8')),'hex'),created_at
  FROM control.operator_webhook_destinations;
ALTER TABLE control.operator_webhook_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE control.operator_webhook_content_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operator_webhook_content_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_webhook_content_tenant ON control.operator_webhook_content_revisions
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER operator_webhook_content_append_only BEFORE UPDATE OR DELETE ON control.operator_webhook_content_revisions
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.operator_webhook_content_revisions FROM PUBLIC,openmasu_app,openmasu_reader,openmasu_seed;
GRANT SELECT,INSERT ON control.operator_webhook_content_revisions TO openmasu_app;
GRANT SELECT ON control.operator_webhook_content_revisions TO openmasu_reader;
GRANT TRUNCATE ON control.operator_webhook_content_revisions TO openmasu_seed;
-- NULL denotes pre-policy queued bytes, which are never rewritten.
ALTER TABLE ephemeral.operator_webhook_deliveries ADD COLUMN policy_revision bigint;
ALTER TABLE ephemeral.operator_webhook_deliveries ADD CONSTRAINT operator_webhook_content_binding
  FOREIGN KEY (tenant_id,app_id,destination_id,policy_revision)
  REFERENCES control.operator_webhook_content_revisions(tenant_id,app_id,destination_id,policy_revision);
