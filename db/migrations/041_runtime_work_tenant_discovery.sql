-- Restore queue-only tenant discovery for platform-integrity and commerce read-back work.
-- The worker resolves tenants before a tenant RLS context exists, so the
-- SECURITY DEFINER function may read these queues through SELECT-only owner
-- policies and returns tenant identifiers only.

CREATE POLICY integrity_verifications_discovery_owner
  ON ephemeral.integrity_verifications FOR SELECT TO openmasu_owner USING (true);

CREATE POLICY commerce_provider_readbacks_discovery_owner
  ON ephemeral.commerce_provider_readbacks FOR SELECT TO openmasu_owner USING (true);

CREATE OR REPLACE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT registration.tenant_id
  FROM control.apple_app_registrations AS registration
  UNION
  SELECT batch.tenant_id
  FROM ledger.ingest_batches_current AS batch
  WHERE batch.status IN ('pending', 'processed')
  UNION
  SELECT lookup.tenant_id
  FROM ephemeral.adservices_lookups AS lookup
  UNION
  SELECT verification.tenant_id
  FROM ephemeral.integrity_verifications AS verification
  UNION
  SELECT verification.tenant_id
  FROM ephemeral.google_play_product_verifications AS verification
  UNION
  SELECT delivery.tenant_id
  FROM ephemeral.google_conversion_deliveries AS delivery
  WHERE delivery.state IN ('queued','http_accepted','diagnostics_processing')
  UNION
  SELECT readback.tenant_id
  FROM ephemeral.commerce_provider_readbacks AS readback
  UNION
  SELECT destination.tenant_id
  FROM control.operator_webhook_destinations_current AS destination
  WHERE destination.status='active'
  UNION
  SELECT delivery.tenant_id
  FROM ephemeral.operator_webhook_deliveries AS delivery
  WHERE delivery.state IN ('queued','retry')
  UNION
  SELECT destination.tenant_id
  FROM control.operator_bulk_export_destinations_current AS destination
  WHERE destination.status='active'
  UNION
  SELECT batch.tenant_id
  FROM ephemeral.operator_bulk_export_batches AS batch
  WHERE batch.state IN ('queued','retry')
  UNION
  SELECT job.tenant_id
  FROM control.privacy_deletion_jobs AS job
  WHERE job.status='processing'
  UNION
  SELECT schedule.tenant_id
  FROM control.metric_schedules_current AS schedule
  WHERE schedule.status='active'
  ORDER BY 1
$$;
