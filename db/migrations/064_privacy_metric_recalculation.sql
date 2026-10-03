-- Privacy corrections reuse the durable metric queue, not cost/late-input semantics.
ALTER TABLE control.metric_recalculation_jobs
  ADD COLUMN privacy_request_id control.identifier,
  DROP CONSTRAINT metric_recalculation_jobs_trigger_kind_check,
  DROP CONSTRAINT metric_recalculation_jobs_date_to_check,
  DROP CONSTRAINT metric_recalculation_source_check,
  ADD CONSTRAINT metric_recalculation_trigger_kind_check
    CHECK (trigger_kind IN ('cost_revision','late_events','privacy_deletion')),
  ADD CONSTRAINT metric_recalculation_date_range_check
    CHECK (date_to>=date_from AND (trigger_kind='privacy_deletion' OR date_to-date_from<31)),
  ADD CONSTRAINT metric_recalculation_source_check CHECK (
    (trigger_kind='cost_revision' AND cost_import_run_id IS NOT NULL AND cost_snapshot_digest IS NOT NULL
      AND source_snapshot_digest IS NULL AND source_records IS NULL AND input_status_counts IS NULL
      AND selection_status IS NULL AND privacy_request_id IS NULL)
    OR (trigger_kind='late_events' AND cost_import_run_id IS NULL AND cost_snapshot_digest IS NULL
      AND source_snapshot_digest IS NOT NULL AND source_records IS NOT NULL AND jsonb_typeof(source_records)='array'
      AND jsonb_array_length(source_records)<=100 AND input_status_counts IS NOT NULL
      AND jsonb_typeof(input_status_counts)='object' AND selection_status IS NOT NULL AND privacy_request_id IS NULL)
    OR (trigger_kind='privacy_deletion' AND cost_import_run_id IS NULL AND cost_snapshot_digest IS NULL
      AND source_snapshot_digest IS NOT NULL AND privacy_request_id IS NOT NULL
      AND source_records IS NULL AND input_status_counts IS NULL AND selection_status IS NULL)
  );
CREATE INDEX metric_recalculation_privacy_idx ON control.metric_recalculation_jobs
  (tenant_id,privacy_request_id,app_id) WHERE trigger_kind='privacy_deletion';
