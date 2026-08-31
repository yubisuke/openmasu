-- Replace broad operator-delivery reader access with the exact columns used by
-- destination listings, aggregate metrics, and the bounded delivery-health API.
REVOKE SELECT ON
  control.operator_webhook_destinations,
  control.operator_webhook_destination_states,
  control.operator_webhook_destinations_current,
  ephemeral.operator_webhook_deliveries,
  ledger.operator_webhook_delivery_results,
  control.operator_bulk_export_destinations,
  control.operator_bulk_export_destination_states,
  control.operator_bulk_export_destinations_current,
  control.operator_bulk_export_checkpoints,
  ledger.operator_bulk_export_deletions,
  ephemeral.operator_bulk_export_batches,
  ledger.operator_bulk_export_results
FROM openmasu_reader;

GRANT SELECT (
  destination_id,
  tenant_id,
  app_id,
  endpoint_url,
  allowed_events,
  created_at
) ON control.operator_webhook_destinations TO openmasu_reader;

GRANT SELECT (
  destination_state_seq,
  destination_id,
  tenant_id,
  app_id,
  status,
  changed_at
) ON control.operator_webhook_destination_states TO openmasu_reader;

GRANT SELECT (
  delivery_id,
  tenant_id,
  app_id,
  destination_id,
  event_name,
  state,
  attempts,
  next_attempt_at,
  last_http_status,
  safe_reason,
  created_at,
  updated_at
) ON ephemeral.operator_webhook_deliveries TO openmasu_reader;

GRANT SELECT (
  destination_id,
  tenant_id,
  app_id,
  endpoint_url,
  bucket_name,
  object_prefix,
  region,
  allowed_events,
  start_at,
  created_at
) ON control.operator_bulk_export_destinations TO openmasu_reader;

GRANT SELECT (
  destination_state_seq,
  destination_id,
  tenant_id,
  app_id,
  status,
  changed_at
) ON control.operator_bulk_export_destination_states TO openmasu_reader;

GRANT SELECT (
  batch_id,
  tenant_id,
  app_id,
  destination_id,
  row_count,
  state,
  attempts,
  next_attempt_at,
  last_http_status,
  safe_reason,
  created_at,
  updated_at
) ON ephemeral.operator_bulk_export_batches TO openmasu_reader;
