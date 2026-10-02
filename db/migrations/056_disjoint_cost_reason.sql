-- Preserve existing values and allow an explicitly unsafe cost denominator.
ALTER TABLE ledger.metric_runs
  DROP CONSTRAINT IF EXISTS metric_runs_undefined_reason_check;
ALTER TABLE ledger.metric_runs
  ADD CONSTRAINT metric_runs_undefined_reason_check
  CHECK (undefined_reason IS NULL OR undefined_reason IN (
    'no_attributed_cost', 'no_activity_events', 'empty_cohort', 'overlapping_cost_grains'
  ));
