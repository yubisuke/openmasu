-- Additive opt-in reason. Missing recorded history is not zero or inactivity.
ALTER TABLE ledger.metric_runs DROP CONSTRAINT metric_runs_undefined_reason_check;
ALTER TABLE ledger.metric_runs ADD CONSTRAINT metric_runs_undefined_reason_check
  CHECK (undefined_reason IS NULL OR undefined_reason IN (
    'no_attributed_cost', 'no_activity_events', 'empty_cohort', 'overlapping_cost_grains',
    'missing_fx_rate', 'observation_window_not_elapsed', 'no_paying_installations', 'insufficient_activity_history'
  ));
