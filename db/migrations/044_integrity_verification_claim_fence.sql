-- Durable ownership for Integrity provider verification work.
ALTER TABLE ephemeral.integrity_verifications
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_until timestamptz,
  ADD CONSTRAINT integrity_verifications_claim_pair_check CHECK (
    (claim_token IS NULL AND claimed_until IS NULL)
    OR (claim_token IS NOT NULL AND claimed_until IS NOT NULL)
  );

CREATE INDEX integrity_verifications_claimable_idx
  ON ephemeral.integrity_verifications (
    tenant_id,
    next_attempt_at,
    claimed_until,
    verification_id
  );
