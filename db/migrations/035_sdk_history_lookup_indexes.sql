CREATE INDEX ingest_batch_records_record_lookup_idx
  ON ledger.ingest_batch_records (tenant_id, app_id, record_id, ingest_batch_id);

CREATE INDEX click_facts_remote_ref_lookup_idx
  ON ledger.click_facts (tenant_id, app_id, remote_click_ref)
  WHERE remote_click_ref IS NOT NULL;

CREATE INDEX install_facts_click_lookup_idx
  ON ledger.install_facts (tenant_id, app_id, click_id)
  WHERE click_id IS NOT NULL;

CREATE INDEX install_facts_prior_lookup_idx
  ON ledger.install_facts (tenant_id, app_id, prior_installation_id)
  WHERE prior_installation_id IS NOT NULL;

CREATE INDEX purchase_facts_transaction_lookup_idx
  ON ledger.purchase_facts (tenant_id, app_id, transaction_id);

CREATE INDEX purchase_facts_original_transaction_lookup_idx
  ON ledger.purchase_facts (tenant_id, app_id, original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE INDEX refund_facts_transaction_lookup_idx
  ON ledger.refund_facts (tenant_id, app_id, transaction_id);

CREATE INDEX refund_facts_original_transaction_lookup_idx
  ON ledger.refund_facts (tenant_id, app_id, original_transaction_id);

CREATE TABLE control.installation_withdrawal_backfill_states (
  installation_key_id control.identifier PRIMARY KEY
    REFERENCES control.installation_credentials (installation_key_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  completed_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

ALTER TABLE control.installation_withdrawal_backfill_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.installation_withdrawal_backfill_states FORCE ROW LEVEL SECURITY;
CREATE POLICY installation_withdrawal_backfill_states_tenant
  ON control.installation_withdrawal_backfill_states
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

REVOKE ALL ON control.installation_withdrawal_backfill_states FROM PUBLIC;
GRANT SELECT, INSERT ON control.installation_withdrawal_backfill_states TO openmasu_app;
GRANT SELECT ON control.installation_withdrawal_backfill_states TO openmasu_reader;
