-- Preserve existing values and allow an explicitly unsafe cost denominator.
ALTER TABLE ledger.metric_runs
  DROP CONSTRAINT IF EXISTS metric_runs_undefined_reason_check;
ALTER TABLE ledger.metric_runs
  ADD CONSTRAINT metric_runs_undefined_reason_check
  CHECK (undefined_reason IS NULL OR undefined_reason IN (
    'no_attributed_cost', 'no_activity_events', 'empty_cohort', 'overlapping_cost_grains'
  ));

-- Historical dimension digests do not include acquisition date. Two dated
-- observations at the same as-of are not revisions of the same cost cell.
ALTER TABLE ledger.cost_records
  DROP CONSTRAINT IF EXISTS cost_records_tenant_id_app_id_cost_key_digest_as_of_key;
ALTER TABLE ledger.cost_records
  DROP CONSTRAINT IF EXISTS cost_records_dated_revision_key;
ALTER TABLE ledger.cost_records
  ADD CONSTRAINT cost_records_dated_revision_key
  UNIQUE (tenant_id, app_id, cost_date, cost_key_digest, as_of);
