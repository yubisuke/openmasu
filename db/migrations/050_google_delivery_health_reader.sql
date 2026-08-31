-- Expose only bounded operational Google delivery state to the read-only API role.
-- Secret-bearing request references, provider identifiers, digests, and artifacts
-- remain inaccessible because the reader retains no table-level SELECT grant.
GRANT SELECT (
  tenant_id,
  app_id,
  destination_id,
  enabled,
  next_request_at
) ON control.google_data_manager_destinations TO openmasu_reader;

GRANT SELECT (
  delivery_id,
  tenant_id,
  app_id,
  destination_id,
  state,
  attempts,
  next_attempt_at,
  diagnostics_deadline_at,
  safe_reason,
  created_at,
  updated_at
) ON ephemeral.google_conversion_deliveries TO openmasu_reader;
