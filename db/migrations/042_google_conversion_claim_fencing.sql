-- Lease outbound Google conversion work before network I/O and fence stale workers.
ALTER TABLE ephemeral.google_conversion_deliveries
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_until timestamptz;

ALTER TABLE ephemeral.google_conversion_deliveries
  ADD CONSTRAINT google_conversion_deliveries_claim_pair_check
  CHECK ((claim_token IS NULL) = (claimed_until IS NULL)),
  ADD CONSTRAINT google_conversion_deliveries_terminal_unclaimed_check
  CHECK (
    state IN ('queued','http_accepted','diagnostics_processing')
    OR (claim_token IS NULL AND claimed_until IS NULL)
  );

CREATE INDEX google_conversion_deliveries_claimable_idx
  ON ephemeral.google_conversion_deliveries (
    tenant_id, next_attempt_at, claimed_until, delivery_id
  )
  WHERE state IN ('queued','http_accepted','diagnostics_processing');
