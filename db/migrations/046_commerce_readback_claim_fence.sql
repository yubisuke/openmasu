-- Durable ownership for commerce provider read-back work.
ALTER TABLE ephemeral.commerce_provider_readbacks
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_until timestamptz,
  ADD CONSTRAINT commerce_provider_readbacks_claim_pair_check CHECK (
    (claim_token IS NULL AND claimed_until IS NULL)
    OR (claim_token IS NOT NULL AND claimed_until IS NOT NULL)
  );

CREATE INDEX commerce_provider_readbacks_claimable_idx
  ON ephemeral.commerce_provider_readbacks (
    tenant_id,
    next_attempt_at,
    claimed_until,
    readback_id
  );
