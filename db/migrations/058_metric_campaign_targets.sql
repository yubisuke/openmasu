CREATE TABLE control.metric_schedule_targets (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  metric_schedule_id control.identifier NOT NULL,
  target_date date NOT NULL,
  watermark control.canonical_timestamp NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  target_digest text NOT NULL CHECK (target_digest ~ '^[a-f0-9]{64}$'),
  selection_state text NOT NULL CHECK (selection_state IN ('ready','known_empty','partial_unknown')),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact->'targets')='array'
    AND jsonb_array_length(artifact->'targets')<=1000),
  PRIMARY KEY (tenant_id,app_id,metric_schedule_id,target_date),
  FOREIGN KEY (tenant_id,app_id,metric_schedule_id)
    REFERENCES control.metric_schedules (tenant_id,app_id,metric_schedule_id)
);
ALTER TABLE control.metric_schedule_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_schedule_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_schedule_targets_tenant ON control.metric_schedule_targets
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER metric_schedule_targets_append_only BEFORE UPDATE OR DELETE ON control.metric_schedule_targets
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.metric_schedule_targets FROM PUBLIC;
GRANT SELECT,INSERT ON control.metric_schedule_targets TO openmasu_app;
GRANT SELECT ON control.metric_schedule_targets TO openmasu_reader;
GRANT TRUNCATE ON control.metric_schedule_targets TO openmasu_seed;

ALTER TABLE control.metric_schedule_checkpoints ADD COLUMN safe_reason text
  CHECK (safe_reason IN ('target_limit','privacy_unavailable','privacy_pending','target_mismatch','calculation_unavailable'));
