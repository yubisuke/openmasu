-- Add the non-identifying AdAttributionKit conversion type to the protected
-- Apple fact projection. Existing rows predate re-engagement support and remain
-- readable with NULL, which the install-series query treats as a legacy install
-- postback.
ALTER TABLE ledger.apple_postback_facts
  ADD COLUMN IF NOT EXISTS conversion_type text
  CHECK (
    conversion_type IS NULL
    OR conversion_type IN ('download', 'redownload', 're-engagement')
  );

DROP INDEX IF EXISTS ledger.apple_postback_facts_metric_idx;

CREATE INDEX apple_postback_facts_metric_idx
  ON ledger.apple_postback_facts (
    tenant_id, app_id, event_name, conversion_type, received_at, conversion_bucket
  );
