-- Extend the existing bounded queue. Cost receipts and historical jobs keep their meaning.
ALTER TABLE control.metric_recalculation_jobs
  ALTER COLUMN cost_import_run_id DROP NOT NULL,
  ALTER COLUMN cost_snapshot_digest DROP NOT NULL,
  ADD COLUMN trigger_kind text NOT NULL DEFAULT 'cost_revision' CHECK (trigger_kind IN ('cost_revision','late_events')),
  ADD COLUMN source_snapshot_digest text CHECK (source_snapshot_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN source_records jsonb,
  ADD COLUMN input_status_counts jsonb,
  ADD COLUMN selection_status text CHECK (selection_status IN ('selected','no_eligible_inputs','no_matching_runs')),
  ADD CONSTRAINT metric_recalculation_source_check CHECK (
    (trigger_kind='cost_revision' AND cost_import_run_id IS NOT NULL AND cost_snapshot_digest IS NOT NULL
      AND source_snapshot_digest IS NULL AND source_records IS NULL AND input_status_counts IS NULL AND selection_status IS NULL)
    OR (trigger_kind='late_events' AND cost_import_run_id IS NULL AND cost_snapshot_digest IS NULL
      AND source_snapshot_digest IS NOT NULL AND source_records IS NOT NULL AND jsonb_typeof(source_records)='array'
      AND jsonb_array_length(source_records)<=100 AND input_status_counts IS NOT NULL
      AND jsonb_typeof(input_status_counts)='object' AND selection_status IS NOT NULL)
  );
ALTER TABLE control.metric_recalculation_items DROP CONSTRAINT metric_recalculation_items_safe_reason_check;
ALTER TABLE control.metric_recalculation_items ADD CHECK (safe_reason IN (
  'replay_unavailable','definition_changed','already_superseded','privacy_pending','calculation_unavailable','retry_exhausted',
  'unsupported_definition','input_unavailable','already_pending'
));
CREATE INDEX metric_recalculation_cohort_idx ON ledger.metric_runs
  (tenant_id,app_id,((grouping->>'cohort_date')),metric_run_id);
