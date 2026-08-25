-- M6 deterministic fraud controls.
ALTER TABLE control.rule_bundle_revisions
  ADD COLUMN definition jsonb,
  ADD COLUMN definition_digest text CHECK (definition_digest IS NULL OR definition_digest ~ '^[a-f0-9]{64}$');

ALTER TABLE ledger.click_facts
  ALTER COLUMN click_id DROP NOT NULL,
  ADD COLUMN site_id text,
  ADD COLUMN remote_click_ref text;

ALTER TABLE ledger.fraud_decisions
  ADD COLUMN subject_scope text NOT NULL DEFAULT 'record'
    CHECK (subject_scope IN ('record','source')),
  ADD COLUMN rule_id text,
  ADD COLUMN resolution_deadline_at control.canonical_timestamp,
  ADD COLUMN supersedes_fraud_decision_id text,
  ADD CONSTRAINT fraud_decision_subject_namespace CHECK (
    (subject_scope='source' AND subject_ref LIKE 'source:%') OR
    (subject_scope='record' AND subject_ref NOT LIKE 'source:%')
  ),
  ADD CONSTRAINT fraud_decision_quarantine_deadline CHECK (
    action <> 'quarantine' OR resolution_deadline_at IS NOT NULL
  );

CREATE TABLE ledger.source_day_aggregates (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  metric_date date NOT NULL,
  campaign_id control.identifier NOT NULL,
  network text NOT NULL,
  site_id text NOT NULL,
  clicks bigint NOT NULL CHECK (clicks >= 0),
  installs bigint NOT NULL CHECK (installs >= 0),
  ctit_p05_ms bigint,
  ctit_p50_ms bigint,
  ctit_p95_ms bigint,
  ctit_negative_count bigint NOT NULL DEFAULT 0 CHECK (ctit_negative_count >= 0),
  organic_share_unscaled bigint,
  input_snapshot_id text NOT NULL CHECK (input_snapshot_id ~ '^[a-f0-9]{64}$'),
  computed_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id, metric_date, campaign_id, network, site_id, input_snapshot_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.fraud_quarantines (
  fraud_decision_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_ref text NOT NULL,
  resolve_after timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.integrity_verifications (
  verification_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  provider text NOT NULL CHECK (provider IN ('play_integrity','app_attest')),
  token_ref text NOT NULL CHECK (token_ref LIKE 'protected:%'),
  subject_record_id control.identifier NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX source_day_aggregates_lookup_idx
  ON ledger.source_day_aggregates (tenant_id, app_id, metric_date, campaign_id, network, site_id);
CREATE INDEX fraud_quarantines_due_idx ON ephemeral.fraud_quarantines (resolve_after);
CREATE INDEX integrity_verifications_due_idx ON ephemeral.integrity_verifications (next_attempt_at);

ALTER TABLE ledger.source_day_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.source_day_aggregates FORCE ROW LEVEL SECURITY;
CREATE POLICY source_day_aggregates_tenant ON ledger.source_day_aggregates
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ephemeral.fraud_quarantines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.fraud_quarantines FORCE ROW LEVEL SECURITY;
CREATE POLICY fraud_quarantines_tenant ON ephemeral.fraud_quarantines
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ephemeral.integrity_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.integrity_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY integrity_verifications_tenant ON ephemeral.integrity_verifications
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER source_day_aggregates_append_only
  BEFORE UPDATE OR DELETE ON ledger.source_day_aggregates
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.source_day_aggregates, ephemeral.fraud_quarantines, ephemeral.integrity_verifications FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.source_day_aggregates TO openmasu_app;
GRANT SELECT, INSERT, DELETE ON ephemeral.fraud_quarantines, ephemeral.integrity_verifications TO openmasu_app;
GRANT SELECT ON ledger.source_day_aggregates TO openmasu_reader;
GRANT TRUNCATE ON ledger.source_day_aggregates, ephemeral.fraud_quarantines, ephemeral.integrity_verifications TO openmasu_seed;
