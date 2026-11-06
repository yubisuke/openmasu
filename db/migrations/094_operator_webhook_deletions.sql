-- Deletion notifications are explicit destination policy, never implied by event consent.
ALTER TABLE control.operator_webhook_destination_states
  ADD COLUMN deletion_notifications boolean NOT NULL DEFAULT false;
CREATE OR REPLACE VIEW control.operator_webhook_destinations_current
WITH (security_invoker = true) AS
SELECT DISTINCT ON (destination.destination_id)
  destination.*, state.status, state.changed_at AS status_changed_at,
  state.deletion_notifications
FROM control.operator_webhook_destinations AS destination
JOIN control.operator_webhook_destination_states AS state
  USING (destination_id,tenant_id,app_id)
ORDER BY destination.destination_id,state.destination_state_seq DESC;
GRANT SELECT (deletion_notifications) ON control.operator_webhook_destination_states TO openmasu_reader;

-- Keep only the exact pseudonymous reference already emitted to this destination.
-- Readers cannot select it or the internal deletion-request identifier.
ALTER TABLE ephemeral.operator_webhook_deliveries
  ADD COLUMN subject_ref text CHECK (subject_ref ~ '^[a-f0-9]{64}$'),
  ADD COLUMN privacy_request_id control.identifier REFERENCES control.privacy_deletion_jobs(privacy_request_id),
  ADD CONSTRAINT operator_webhook_deletion_subject_unique
    UNIQUE (tenant_id,app_id,destination_id,privacy_request_id,subject_ref);
ALTER TABLE ephemeral.operator_webhook_deliveries DROP CONSTRAINT operator_webhook_delivery_subject_check;
ALTER TABLE ephemeral.operator_webhook_deliveries ADD CONSTRAINT operator_webhook_delivery_subject_check CHECK (
  (event_name IN ('session_start','custom_event','purchase','refund','ad_revenue')
    AND logical_event_id IS NOT NULL AND record_id IS NOT NULL AND privacy_request_id IS NULL
    AND comparison_id IS NULL AND comparison_run_id IS NULL AND comparison_epoch IS NULL
    AND comparison_state IS NULL AND comparison_sequence IS NULL)
  OR (event_name='comparison_state_changed' AND logical_event_id IS NULL AND record_id IS NULL
    AND privacy_request_id IS NULL AND subject_ref IS NULL
    AND comparison_id IS NOT NULL AND comparison_run_id IS NOT NULL AND comparison_epoch IS NOT NULL
    AND comparison_state IS NOT NULL AND comparison_sequence IS NOT NULL
    AND comparison_run_id ~ '^[a-f0-9]{64}$' AND comparison_epoch ~ '^[a-f0-9]{32}$'
    AND comparison_state IN ('within_threshold','threshold_exceeded','missing_input','incomparable','unknown')
    AND comparison_sequence>0)
  OR (event_name='subject_deletion' AND logical_event_id IS NULL AND record_id IS NULL
    AND privacy_request_id IS NOT NULL AND subject_ref IS NOT NULL
    AND comparison_id IS NULL AND comparison_run_id IS NULL AND comparison_epoch IS NULL
    AND comparison_state IS NULL AND comparison_sequence IS NULL)
);
CREATE INDEX operator_webhook_delivered_subject_idx ON ephemeral.operator_webhook_deliveries
  (tenant_id,app_id,destination_id,subject_ref,record_id)
  WHERE state='succeeded' AND logical_event_id IS NOT NULL;
