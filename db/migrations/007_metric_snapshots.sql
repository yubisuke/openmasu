ALTER TABLE ledger.raw_records
  ADD COLUMN policy_digest text CHECK (policy_digest IS NULL OR length(policy_digest) > 0);

CREATE INDEX raw_records_metric_snapshot_idx
  ON ledger.raw_records (tenant_id, app_id, received_at, record_id)
  INCLUDE (policy_digest);

COMMENT ON COLUMN ledger.raw_records.policy_digest IS
  'Server policy digest used by M1b snapshot identity. NULL marks pre-M1b rows that cannot be recomputed.';
