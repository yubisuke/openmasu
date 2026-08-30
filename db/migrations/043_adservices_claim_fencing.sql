-- Lease AdServices work before network I/O and fence stale completions.
ALTER TABLE ephemeral.adservices_lookups
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_until timestamptz;

ALTER TABLE ephemeral.adservices_lookups
  ADD CONSTRAINT adservices_lookups_claim_pair_check
  CHECK ((claim_token IS NULL) = (claimed_until IS NULL));

CREATE INDEX adservices_lookups_claimable_idx
  ON ephemeral.adservices_lookups (
    tenant_id, next_attempt_at, claimed_until, token_created_at, lookup_id
  );
