-- Accepted declarations survive encrypted queue expiry, restart and replay.
CREATE TABLE control.installation_consent_controls (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_key_id control.identifier NOT NULL REFERENCES control.installation_credentials(installation_key_id),
  source_record_id control.identifier NOT NULL,
  processing_purpose_id text NOT NULL CHECK (processing_purpose_id IN ('attribution','analytics','revenue_measurement')),
  consent_state text NOT NULL CHECK (consent_state IN ('granted','denied','withdrawn','not_required','unknown')),
  consent_revision bigint CHECK (consent_revision BETWEEN 1 AND 9007199254740991),
  recognized_sequence bigint NOT NULL CHECK (recognized_sequence BETWEEN 0 AND 9007199254740991),
  recognized_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (tenant_id,app_id,source_record_id,processing_purpose_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps(tenant_id,app_id)
);
CREATE INDEX installation_consent_versioned_scope_idx
  ON control.installation_consent_controls
  (tenant_id,app_id,installation_key_id,processing_purpose_id,consent_revision DESC,recognized_sequence)
  WHERE consent_revision IS NOT NULL AND consent_state<>'unknown';
CREATE INDEX installation_consent_legacy_scope_idx
  ON control.installation_consent_controls
  (tenant_id,app_id,installation_key_id,processing_purpose_id,recognized_sequence DESC)
  WHERE consent_revision IS NULL AND consent_state IN ('denied','withdrawn');

-- The previous durable barrier is retained; no historical grant is invented.
ALTER TABLE control.installation_withdrawals NO FORCE ROW LEVEL SECURITY;
INSERT INTO control.installation_consent_controls
  (tenant_id,app_id,installation_key_id,source_record_id,processing_purpose_id,
   consent_state,recognized_sequence,recognized_at)
  SELECT tenant_id,app_id,installation_key_id,source_record_id,processing_purpose_id,
    'withdrawn',withdrawal_recognized_sequence,withdrawal_recognized_at
  FROM control.installation_withdrawals;
ALTER TABLE control.installation_withdrawals FORCE ROW LEVEL SECURITY;

ALTER TABLE control.installation_consent_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.installation_consent_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY installation_consent_controls_tenant ON control.installation_consent_controls
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER installation_consent_controls_append_only
  BEFORE UPDATE OR DELETE ON control.installation_consent_controls
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.installation_consent_controls FROM PUBLIC,openmasu_app,openmasu_reader,openmasu_seed;
GRANT SELECT,INSERT ON control.installation_consent_controls TO openmasu_app;
GRANT SELECT ON control.installation_consent_controls TO openmasu_reader;
GRANT TRUNCATE ON control.installation_consent_controls TO openmasu_seed;
