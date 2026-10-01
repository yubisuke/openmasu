-- Keep the contract artifact unchanged. Old runs have no captured definition.
ALTER TABLE ledger.metric_runs ADD COLUMN comparison_context jsonb;
ALTER TABLE ledger.metric_runs ADD CONSTRAINT metric_comparison_context_binding CHECK (
  comparison_context IS NULL OR ((
    comparison_context->>'version' = '1'
    AND comparison_context->>'metric_run_id' = metric_run_id
    AND comparison_context->>'input_snapshot_id' = input_snapshot_id
    AND comparison_context->'definition'->>'metric_name' = metric_name
    AND comparison_context->'definition'->>'metric_definition_version' = metric_definition_version
  ) IS TRUE)
);
COMMENT ON COLUMN ledger.metric_runs.comparison_context IS
  'Immutable aggregate-only definition/FX projection captured in the metric transaction; NULL is unknown, never reconstructed from current configuration.';
