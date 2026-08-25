ALTER TABLE ledger.install_facts
  ADD COLUMN occurred_at control.canonical_timestamp,
  ADD COLUMN occurred_at_ts timestamptz
    GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  ADD COLUMN campaign_id text,
  ADD COLUMN network text,
  ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

CREATE INDEX install_facts_cohort_idx
  ON ledger.install_facts (tenant_id, app_id, campaign_id, country, occurred_at_ts);

CREATE INDEX session_facts_activity_idx
  ON ledger.session_facts (tenant_id, app_id, installation_id, occurred_at_ts);

CREATE INDEX cost_records_watermark_idx
  ON ledger.cost_records (tenant_id, app_id, cost_key_digest, as_of, cost_record_id);

CREATE FUNCTION ledger.half_even_div(numerator numeric, denominator numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  absolute_numerator numeric;
  quotient numeric;
  remainder numeric;
  rounded numeric;
BEGIN
  IF denominator <= 0 OR denominator <> trunc(denominator) THEN
    RAISE EXCEPTION 'half_even_div denominator must be a positive integer';
  END IF;
  IF numerator <> trunc(numerator) THEN
    RAISE EXCEPTION 'half_even_div numerator must be an integer';
  END IF;

  absolute_numerator := abs(numerator);
  quotient := trunc(absolute_numerator / denominator);
  remainder := mod(absolute_numerator, denominator);
  rounded := quotient;

  IF remainder * 2 > denominator
    OR (remainder * 2 = denominator AND mod(quotient, 2) = 1)
  THEN
    rounded := quotient + 1;
  END IF;

  IF numerator < 0 THEN
    RETURN -rounded;
  END IF;
  RETURN rounded;
END
$$;

REVOKE ALL ON FUNCTION ledger.half_even_div(numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.half_even_div(numeric, numeric)
  TO openmmp_app, openmmp_reader, openmmp_seed;
