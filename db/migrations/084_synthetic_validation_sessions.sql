-- Disposable-only operational associations. No validation metadata enters the ledger.
CREATE TABLE ephemeral.synthetic_validation_sessions (
  session_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  expected_events text[] NOT NULL CHECK (cardinality(expected_events) BETWEEN 1 AND 7 AND
    expected_events <@ ARRAY['install','session_start','custom_event','ad_revenue','purchase','refund','deep_link_open']::text[]),
  expected_custom_keys text[] NOT NULL DEFAULT '{}' CHECK (cardinality(expected_custom_keys)<=16),
  batch_count integer NOT NULL DEFAULT 0 CHECK (batch_count BETWEEN 0 AND 50),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 200),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
  UNIQUE (tenant_id,app_id,session_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
CREATE INDEX synthetic_validation_expiry_idx ON ephemeral.synthetic_validation_sessions (tenant_id,expires_at,session_id);
CREATE TABLE ephemeral.synthetic_validation_receipts (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  session_id uuid NOT NULL,
  receipt text PRIMARY KEY CHECK (receipt ~ '^[A-Za-z0-9_-]{43}$'),
  ingest_batch_id uuid NOT NULL UNIQUE REFERENCES ledger.ingest_batches (ingest_batch_id),
  event_marks jsonb NOT NULL CHECK (jsonb_typeof(event_marks)='array' AND jsonb_array_length(event_marks) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,app_id,session_id) REFERENCES ephemeral.synthetic_validation_sessions (tenant_id,app_id,session_id) ON DELETE CASCADE
);
CREATE INDEX synthetic_validation_receipt_session_idx ON ephemeral.synthetic_validation_receipts (tenant_id,app_id,session_id);
ALTER TABLE ephemeral.synthetic_validation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.synthetic_validation_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY synthetic_validation_sessions_tenant ON ephemeral.synthetic_validation_sessions
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
ALTER TABLE ephemeral.synthetic_validation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.synthetic_validation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY synthetic_validation_receipts_tenant ON ephemeral.synthetic_validation_receipts
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
REVOKE ALL ON ephemeral.synthetic_validation_sessions,ephemeral.synthetic_validation_receipts FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON ephemeral.synthetic_validation_sessions TO openmasu_app;
GRANT SELECT,INSERT,DELETE ON ephemeral.synthetic_validation_receipts TO openmasu_app;
GRANT SELECT ON ephemeral.synthetic_validation_sessions,ephemeral.synthetic_validation_receipts TO openmasu_reader;
GRANT TRUNCATE ON ephemeral.synthetic_validation_sessions,ephemeral.synthetic_validation_receipts TO openmasu_seed;

-- Discover expired associations even when their tenant has no remaining SDK work.
CREATE OR REPLACE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT registration.tenant_id FROM control.apple_app_registrations AS registration
  UNION SELECT batch.tenant_id FROM ledger.ingest_batches_current AS batch
    WHERE batch.status='pending' OR (batch.status='processed' AND batch.reason_code='post_processing_pending')
  UNION SELECT lookup.tenant_id FROM ephemeral.adservices_lookups AS lookup
  UNION SELECT verification.tenant_id FROM ephemeral.integrity_verifications AS verification
  UNION SELECT verification.tenant_id FROM ephemeral.google_play_product_verifications AS verification
  UNION SELECT delivery.tenant_id FROM ephemeral.google_conversion_deliveries AS delivery
    WHERE delivery.state IN ('queued','http_accepted','diagnostics_processing')
  UNION SELECT readback.tenant_id FROM ephemeral.commerce_provider_readbacks AS readback
  UNION SELECT destination.tenant_id FROM control.operator_webhook_destinations_current AS destination WHERE destination.status='active'
  UNION SELECT delivery.tenant_id FROM ephemeral.operator_webhook_deliveries AS delivery WHERE delivery.state IN ('queued','retry')
  UNION SELECT destination.tenant_id FROM control.operator_bulk_export_destinations_current AS destination WHERE destination.status='active'
  UNION SELECT batch.tenant_id FROM ephemeral.operator_bulk_export_batches AS batch WHERE batch.state IN ('queued','retry')
  UNION SELECT job.tenant_id FROM control.privacy_deletion_jobs AS job WHERE job.status='processing'
  UNION SELECT schedule.tenant_id FROM control.metric_schedules_current AS schedule WHERE schedule.status='active'
  UNION SELECT schedule.tenant_id FROM control.cost_schedules_current AS schedule WHERE schedule.status='active'
  UNION SELECT item.tenant_id FROM control.metric_recalculation_items AS item WHERE item.state IN ('queued','processing','retry')
  UNION SELECT receipt.tenant_id FROM control.metric_correction_receipts AS receipt WHERE receipt.state IN ('queued','retry')
  UNION SELECT session.tenant_id FROM ephemeral.synthetic_validation_sessions AS session WHERE session.expires_at<=statement_timestamp()
  ORDER BY 1
$$;
