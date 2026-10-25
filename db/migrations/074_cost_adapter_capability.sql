-- Public configured grain only; account IDs and selected provider IDs stay private.
ALTER TABLE control.cost_schedules ADD COLUMN adapter_capability jsonb
  CHECK (adapter_capability IS NULL OR (jsonb_typeof(adapter_capability)='object' AND octet_length(adapter_capability::text)<=2048));
GRANT SELECT(adapter_capability) ON control.cost_schedules TO openmasu_reader;
CREATE OR REPLACE VIEW control.cost_schedules_current WITH (security_invoker=true) AS
SELECT DISTINCT ON (schedule.cost_schedule_id)
  schedule.cost_schedule_id,schedule.tenant_id,schedule.app_id,
  schedule.definition_digest,schedule.created_at,state.status,state.changed_at,
  schedule.adapter_capability
FROM control.cost_schedules AS schedule JOIN control.cost_schedule_states AS state
  USING (tenant_id,app_id,cost_schedule_id)
ORDER BY schedule.cost_schedule_id,state.state_seq DESC;
-- Existing rows remain NULL: do not invent historical adapter coverage.
