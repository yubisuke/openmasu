CREATE TABLE ledger.metric_calculation_evidence (
  metric_run_id text PRIMARY KEY REFERENCES ledger.metric_runs (metric_run_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  input_snapshot_id text NOT NULL CHECK (input_snapshot_id ~ '^[0-9a-f]{64}$'),
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CHECK (artifact->>'version' = '1' AND artifact->>'calculation' = 'revenue_over_cost'),
  CHECK (artifact->>'metric_run_id' = metric_run_id),
  CHECK (artifact->>'input_snapshot_id' = input_snapshot_id)
);

ALTER TABLE ledger.metric_calculation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.metric_calculation_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_calculation_evidence_tenant ON ledger.metric_calculation_evidence
  USING (tenant_id = current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('openmasu.tenant_id', true));

CREATE TRIGGER metric_calculation_evidence_append_only
  BEFORE UPDATE OR DELETE ON ledger.metric_calculation_evidence
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.metric_calculation_evidence FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.metric_calculation_evidence TO openmasu_app;
GRANT SELECT ON ledger.metric_calculation_evidence TO openmasu_reader;
GRANT TRUNCATE ON ledger.metric_calculation_evidence TO openmasu_seed;

COMMENT ON TABLE ledger.metric_calculation_evidence IS
  'Immutable reader-safe ROAS operands captured by the same SQL query and transaction as the metric run. No event IDs, installation IDs, raw payloads or provider references.';
