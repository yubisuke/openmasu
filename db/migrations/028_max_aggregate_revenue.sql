-- Append-only MAX Reporting API aggregate-revenue snapshots.
-- This provider-reported aggregate series is intentionally separate from
-- installation-level and aggregate S2S ad-revenue evidence.
CREATE TABLE ledger.aggregate_revenue_snapshots (
  aggregate_revenue_snapshot_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  provider control.identifier NOT NULL CHECK (provider = 'applovin-max'),
  source_series text NOT NULL CHECK (source_series = 'provider_reported_aggregate'),
  revenue_date date NOT NULL,
  max_ad_unit_id text NOT NULL CHECK (length(max_ad_unit_id) BETWEEN 1 AND 256),
  network text NOT NULL CHECK (length(network) BETWEEN 1 AND 256),
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL CHECK (amount_scale = 6),
  currency text NOT NULL CHECK (currency = 'USD'),
  as_of control.canonical_timestamp NOT NULL,
  as_of_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(as_of)) STORED,
  report_snapshot_digest text NOT NULL CHECK (report_snapshot_digest ~ '^[0-9a-f]{64}$'),
  retained_dimension_digest text NOT NULL CHECK (retained_dimension_digest ~ '^[0-9a-f]{64}$'),
  import_run_id uuid NOT NULL REFERENCES control.import_runs (import_run_id),
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, report_snapshot_digest, retained_dimension_digest)
);

CREATE INDEX aggregate_revenue_snapshots_history_idx
  ON ledger.aggregate_revenue_snapshots (
    tenant_id, app_id, provider, source_series, retained_dimension_digest,
    as_of_ts DESC, report_snapshot_digest DESC, aggregate_revenue_snapshot_id DESC
  );

ALTER TABLE ledger.aggregate_revenue_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.aggregate_revenue_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY aggregate_revenue_snapshots_tenant ON ledger.aggregate_revenue_snapshots
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER aggregate_revenue_snapshots_append_only
  BEFORE UPDATE OR DELETE ON ledger.aggregate_revenue_snapshots
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

CREATE VIEW ledger.aggregate_revenue_snapshots_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (
  tenant_id, app_id, provider, source_series, retained_dimension_digest
)
  *
FROM ledger.aggregate_revenue_snapshots
ORDER BY
  tenant_id, app_id, provider, source_series, retained_dimension_digest,
  as_of_ts DESC, report_snapshot_digest DESC, aggregate_revenue_snapshot_id DESC;

REVOKE ALL ON ledger.aggregate_revenue_snapshots FROM PUBLIC;
REVOKE ALL ON ledger.aggregate_revenue_snapshots_current FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.aggregate_revenue_snapshots TO openmasu_app;
GRANT SELECT ON ledger.aggregate_revenue_snapshots_current TO openmasu_app;
GRANT SELECT ON ledger.aggregate_revenue_snapshots, ledger.aggregate_revenue_snapshots_current TO openmasu_reader;
GRANT TRUNCATE ON ledger.aggregate_revenue_snapshots TO openmasu_seed;
