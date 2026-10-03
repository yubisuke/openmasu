-- Additive: captured dated FX can be incomplete without publishing a partial sum.
ALTER TABLE ledger.metric_runs DROP CONSTRAINT metric_runs_undefined_reason_check;
ALTER TABLE ledger.metric_runs ADD CONSTRAINT metric_runs_undefined_reason_check
  CHECK (undefined_reason IS NULL OR undefined_reason IN (
    'no_attributed_cost', 'no_activity_events', 'empty_cohort', 'overlapping_cost_grains', 'missing_fx_rate'
  ));
