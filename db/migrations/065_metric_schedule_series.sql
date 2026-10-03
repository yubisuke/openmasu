-- Runtime-only schedule provenance: historical metric artifacts remain immutable.
CREATE UNIQUE INDEX metric_runs_scope_id_idx ON ledger.metric_runs (tenant_id,app_id,metric_run_id);
CREATE TABLE control.metric_schedule_runs (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  metric_run_id text NOT NULL,
  metric_schedule_id control.identifier NOT NULL,
  target_date date NOT NULL,
  evaluation integer NOT NULL CHECK (evaluation BETWEEN 0 AND 99),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,app_id,metric_run_id),
  FOREIGN KEY (tenant_id,app_id,metric_run_id) REFERENCES ledger.metric_runs (tenant_id,app_id,metric_run_id),
  FOREIGN KEY (tenant_id,app_id,metric_schedule_id) REFERENCES control.metric_schedules (tenant_id,app_id,metric_schedule_id)
);
CREATE INDEX metric_schedule_runs_selection_idx ON control.metric_schedule_runs
  (tenant_id,app_id,metric_schedule_id,target_date,metric_run_id);
ALTER TABLE control.metric_schedule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_schedule_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_schedule_runs_tenant ON control.metric_schedule_runs
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER metric_schedule_runs_append_only BEFORE UPDATE OR DELETE ON control.metric_schedule_runs
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.metric_schedule_runs FROM PUBLIC;
GRANT SELECT,INSERT ON control.metric_schedule_runs TO openmasu_app;
GRANT SELECT ON control.metric_schedule_runs TO openmasu_reader;
GRANT TRUNCATE ON control.metric_schedule_runs TO openmasu_seed;

-- One acknowledged replacement request can create only one successor schedule.
CREATE UNIQUE INDEX metric_schedule_replacement_request_idx ON control.metric_schedules
  (tenant_id,app_id,(artifact->'replacement'->>'request_digest'))
  WHERE artifact->'replacement'->>'request_digest' IS NOT NULL;
