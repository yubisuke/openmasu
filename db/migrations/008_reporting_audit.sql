ALTER TABLE ledger.metric_runs
  ALTER COLUMN value_unscaled DROP NOT NULL,
  ADD COLUMN value_state text NOT NULL DEFAULT 'present'
    CHECK (value_state IN ('present', 'undefined')),
  ADD COLUMN undefined_reason text
    CHECK (undefined_reason IS NULL OR undefined_reason IN (
      'no_attributed_cost', 'no_activity_events', 'empty_cohort'
    ));

ALTER TABLE ledger.metric_runs
  ALTER COLUMN value_state DROP DEFAULT,
  ADD CONSTRAINT metric_runs_value_presence_check CHECK (
    (value_state='present' AND value_unscaled IS NOT NULL AND undefined_reason IS NULL)
    OR (value_state='undefined' AND value_unscaled IS NULL AND undefined_reason IS NOT NULL)
  );

CREATE TABLE ledger.reconciliation_results (
  reconciliation_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  input_snapshot_id control.identifier NOT NULL,
  external_snapshot_id control.identifier NOT NULL,
  difference_reason_code text NOT NULL,
  difference_reason_version text NOT NULL,
  freshness text NOT NULL CHECK (freshness IN ('current', 'stale', 'recalculated')),
  supersedes_reconciliation_id control.identifier,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX reconciliation_results_scope_idx
  ON ledger.reconciliation_results (tenant_id, app_id, difference_reason_code, reconciliation_id);

ALTER TABLE ledger.reconciliation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.reconciliation_results FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_results_tenant ON ledger.reconciliation_results
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));

CREATE TRIGGER reconciliation_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.reconciliation_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.reconciliation_results FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.reconciliation_results TO openmmp_app;
GRANT SELECT ON ledger.reconciliation_results TO openmmp_reader;
GRANT TRUNCATE ON ledger.reconciliation_results TO openmmp_seed;
