-- Additive operational metadata only; canonical artifacts and legacy evidence stay unchanged.
ALTER TABLE ledger.event_deliveries
  ADD COLUMN diagnostic_event_name text,
  ADD COLUMN diagnostic_producer text,
  ADD COLUMN diagnostic_producer_version text;
ALTER TABLE ledger.ingest_batches ADD COLUMN diagnostic_groups jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(diagnostic_groups)='array' AND jsonb_array_length(diagnostic_groups)<=100);
CREATE INDEX event_deliveries_health_idx ON ledger.event_deliveries (tenant_id,app_id,received_at_ts);
CREATE INDEX ingest_batches_health_idx ON ledger.ingest_batches
  (tenant_id,app_id,control.canonical_timestamp_value(received_at));
