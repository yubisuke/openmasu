-- Safe receipt on the existing append-only audit, not a second configuration store.
-- NULL means historical field-level details were not recorded.
ALTER TABLE ledger.audit_logs ADD COLUMN configuration_change jsonb
  CHECK (configuration_change IS NULL OR
    (jsonb_typeof(configuration_change) = 'object' AND octet_length(configuration_change::text) <= 8192));
CREATE INDEX audit_logs_configuration_history_idx
  ON ledger.audit_logs (tenant_id, app_id, occurred_at DESC, audit_log_id DESC)
  WHERE actor_type = 'admin_key';
