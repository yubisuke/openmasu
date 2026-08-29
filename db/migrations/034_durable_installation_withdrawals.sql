CREATE TABLE control.installation_withdrawals (
  installation_withdrawal_seq bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME control.installation_withdrawal_seq) PRIMARY KEY,
  installation_key_id control.identifier NOT NULL
    REFERENCES control.installation_credentials (installation_key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  processing_purpose_id control.identifier NOT NULL,
  withdrawal_recognized_at control.canonical_timestamp NOT NULL,
  withdrawal_recognized_sequence bigint NOT NULL CHECK (withdrawal_recognized_sequence >= 0),
  source_record_id control.identifier NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (installation_key_id, processing_purpose_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX installation_withdrawals_scope_idx
  ON control.installation_withdrawals (tenant_id, app_id, installation_key_id);

ALTER TABLE control.installation_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.installation_withdrawals FORCE ROW LEVEL SECURITY;
CREATE POLICY installation_withdrawals_tenant ON control.installation_withdrawals
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

REVOKE ALL ON control.installation_withdrawals FROM PUBLIC;
GRANT SELECT, INSERT ON control.installation_withdrawals TO openmasu_app;
GRANT SELECT ON control.installation_withdrawals TO openmasu_reader;
GRANT USAGE, SELECT ON SEQUENCE control.installation_withdrawal_seq TO openmasu_app;
GRANT SELECT ON SEQUENCE control.installation_withdrawal_seq TO openmasu_reader;
