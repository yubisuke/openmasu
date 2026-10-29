-- Renewable provider credentials fail closed without retrying revoked grants.
ALTER TABLE control.cost_schedule_checkpoints DROP CONSTRAINT cost_schedule_checkpoints_safe_reason_check;
ALTER TABLE control.cost_schedule_checkpoints ADD CONSTRAINT cost_schedule_checkpoints_safe_reason_check
  CHECK (safe_reason IN ('source_unavailable','source_rejected','source_invalid',
    'acquisition_timeout','retry_exhausted','reauth_required'));
