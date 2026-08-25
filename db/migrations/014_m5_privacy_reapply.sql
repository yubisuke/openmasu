CREATE TABLE control.metric_replay_manifests (
  metric_replay_manifest_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_metric_run_id text NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, source_metric_run_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  FOREIGN KEY (source_metric_run_id) REFERENCES ledger.metric_runs (metric_run_id),
  CHECK (artifact ? 'metric_definition' AND artifact ? 'evaluation' AND artifact ? 'fx_policy')
);

ALTER TABLE control.metric_replay_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_replay_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_replay_manifests_tenant ON control.metric_replay_manifests
  USING (tenant_id = current_setting('open_mmp.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('open_mmp.tenant_id', true));

CREATE TRIGGER metric_replay_manifests_append_only
  BEFORE UPDATE OR DELETE ON control.metric_replay_manifests
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.metric_replay_manifests FROM PUBLIC;
REVOKE SELECT ON control.metric_replay_manifests FROM openmmp_reader;
GRANT SELECT, INSERT ON control.metric_replay_manifests TO openmmp_app;
GRANT TRUNCATE ON control.metric_replay_manifests TO openmmp_seed;
