-- Pace Google Data Manager requests per tenant destination across worker replicas.
ALTER TABLE control.google_data_manager_destinations
  ADD COLUMN next_request_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz;

CREATE INDEX google_data_manager_destinations_request_pacing_idx
  ON control.google_data_manager_destinations (tenant_id, next_request_at, destination_id)
  WHERE enabled=true;
