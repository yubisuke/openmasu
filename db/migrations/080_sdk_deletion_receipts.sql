-- A client-persisted random capability survives loss of the initial response.
-- Only its digest is stored; it authorizes status reads, never SDK operations.
ALTER TABLE control.privacy_deletion_jobs
  ADD COLUMN status_receipt_digest text,
  ADD COLUMN status_receipt_expires_at timestamptz,
  ADD CONSTRAINT privacy_status_receipt_valid CHECK (
    (status_receipt_digest IS NULL AND status_receipt_expires_at IS NULL)
    OR (status_receipt_digest IS NOT NULL AND status_receipt_digest ~ '^[a-f0-9]{64}$' AND status_receipt_expires_at IS NOT NULL)
  );
CREATE UNIQUE INDEX privacy_status_receipt_idx
  ON control.privacy_deletion_jobs (tenant_id, app_id, status_receipt_digest)
  WHERE status_receipt_digest IS NOT NULL;
