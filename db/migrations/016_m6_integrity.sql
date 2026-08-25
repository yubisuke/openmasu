-- M6b platform-integrity verification results and replay protection.
ALTER TABLE ephemeral.integrity_verifications
  DROP CONSTRAINT integrity_verifications_token_ref_check,
  ADD CONSTRAINT integrity_verifications_token_ref_check
    CHECK (token_ref LIKE 'encrypted:%'),
  ADD CONSTRAINT integrity_verifications_binding_once
    UNIQUE (tenant_id, app_id, provider, challenge_digest);

CREATE TABLE ledger.integrity_verification_results (
  verification_result_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_record_id control.identifier NOT NULL,
  provider text NOT NULL CHECK (provider IN ('play_integrity','app_attest')),
  verdict text NOT NULL CHECK (verdict IN ('verified','failed','unavailable')),
  evidence_ref text,
  response_digest text,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  decided_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CHECK (
    (verdict IN ('verified','failed') AND evidence_ref LIKE 'encrypted:%'
      AND response_digest ~ '^[a-f0-9]{64}$')
    OR
    (verdict='unavailable' AND evidence_ref IS NULL AND response_digest IS NULL)
  )
);

CREATE INDEX integrity_results_subject_idx
  ON ledger.integrity_verification_results (tenant_id, app_id, subject_record_id, decided_at);
CREATE UNIQUE INDEX integrity_results_binding_once_idx
  ON ledger.integrity_verification_results (tenant_id, app_id, provider, binding_digest);

ALTER TABLE ledger.integrity_verification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.integrity_verification_results FORCE ROW LEVEL SECURITY;
CREATE POLICY integrity_verification_results_tenant ON ledger.integrity_verification_results
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER integrity_verification_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.integrity_verification_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.integrity_verification_results FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.integrity_verification_results TO openmasu_app;
GRANT SELECT ON ledger.integrity_verification_results TO openmasu_reader;
GRANT UPDATE ON ephemeral.integrity_verifications TO openmasu_app;
GRANT TRUNCATE ON ledger.integrity_verification_results TO openmasu_seed;
