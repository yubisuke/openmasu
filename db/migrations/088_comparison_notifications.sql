-- Empty event selection is reserved by registration for aggregate comparison notifications.
ALTER TABLE control.operator_webhook_destinations DROP CONSTRAINT operator_webhook_destinations_allowed_events_check;
ALTER TABLE control.operator_webhook_destinations ADD CONSTRAINT operator_webhook_destinations_allowed_events_check CHECK (
  cardinality(allowed_events) BETWEEN 0 AND 5
  AND allowed_events <@ ARRAY['session_start','custom_event','purchase','refund','ad_revenue']::text[]
);

CREATE TABLE control.comparison_notifications (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  comparison_id control.identifier PRIMARY KEY,
  destination_id control.identifier NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  muted boolean NOT NULL DEFAULT false,
  cooldown_seconds integer NOT NULL CHECK (cooldown_seconds BETWEEN 60 AND 86400),
  observed_state text CHECK (observed_state IN ('within_threshold','threshold_exceeded','missing_input','incomparable','unknown')),
  last_enqueued_state text CHECK (last_enqueued_state IN ('within_threshold','threshold_exceeded','missing_input','incomparable','unknown')),
  last_enqueued_at timestamptz,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence>=0),
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,app_id,comparison_id) REFERENCES control.comparison_definitions(tenant_id,app_id,comparison_id),
  FOREIGN KEY (tenant_id,app_id,destination_id) REFERENCES control.operator_webhook_destinations(tenant_id,app_id,destination_id)
);
ALTER TABLE control.comparison_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.comparison_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY comparison_notifications_tenant ON control.comparison_notifications
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
REVOKE ALL ON control.comparison_notifications FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON control.comparison_notifications TO openmasu_app;
GRANT SELECT ON control.comparison_notifications TO openmasu_reader;
GRANT TRUNCATE ON control.comparison_notifications TO openmasu_seed;

ALTER TABLE ephemeral.operator_webhook_deliveries
  ALTER COLUMN logical_event_id DROP NOT NULL,
  ALTER COLUMN record_id DROP NOT NULL,
  ADD COLUMN comparison_id control.identifier,
  ADD COLUMN comparison_run_id text,
  ADD COLUMN comparison_epoch text,
  ADD COLUMN comparison_state text,
  ADD COLUMN comparison_sequence bigint,
  ADD CONSTRAINT operator_webhook_comparison_scope_fk FOREIGN KEY (tenant_id,app_id,comparison_id)
    REFERENCES control.comparison_definitions(tenant_id,app_id,comparison_id),
  ADD CONSTRAINT operator_webhook_comparison_sequence_unique UNIQUE(comparison_id,comparison_sequence);
ALTER TABLE ephemeral.operator_webhook_deliveries DROP CONSTRAINT operator_webhook_deliveries_event_name_check;
ALTER TABLE ephemeral.operator_webhook_deliveries ADD CONSTRAINT operator_webhook_delivery_subject_check CHECK (
  (event_name IN ('session_start','custom_event','purchase','refund','ad_revenue')
    AND logical_event_id IS NOT NULL AND record_id IS NOT NULL
    AND comparison_id IS NULL AND comparison_run_id IS NULL AND comparison_epoch IS NULL AND comparison_state IS NULL AND comparison_sequence IS NULL)
  OR (event_name='comparison_state_changed' AND logical_event_id IS NULL AND record_id IS NULL
    AND comparison_id IS NOT NULL AND comparison_run_id IS NOT NULL AND comparison_epoch IS NOT NULL
    AND comparison_state IS NOT NULL AND comparison_sequence IS NOT NULL
    AND comparison_run_id ~ '^[a-f0-9]{64}$' AND comparison_epoch ~ '^[a-f0-9]{32}$'
    AND comparison_state IN ('within_threshold','threshold_exceeded','missing_input','incomparable','unknown') AND comparison_sequence>0)
);
GRANT SELECT(comparison_id,comparison_state) ON ephemeral.operator_webhook_deliveries TO openmasu_reader;
CREATE INDEX operator_webhook_comparison_receipts_idx ON ephemeral.operator_webhook_deliveries
  (tenant_id,app_id,updated_at DESC,delivery_id DESC) WHERE comparison_id IS NOT NULL;
