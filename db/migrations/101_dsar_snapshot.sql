-- Internal admission metadata, never part of a contract artifact. The full XID
-- excludes transactions still in flight at export start, including backfills.
-- The server epoch makes restored/previous-server rows historical while cursors
-- from before a database restart are explicitly invalidated. Legacy NULL rows
-- predate pagination. Setting defaults separately avoids rewriting the ledger.
ALTER TABLE ledger.raw_records
  ADD COLUMN export_xid xid8, ADD COLUMN export_epoch timestamptz;
ALTER TABLE ledger.raw_records ALTER COLUMN export_xid SET DEFAULT pg_current_xact_id(),
  ALTER COLUMN export_epoch SET DEFAULT pg_postmaster_start_time();
ALTER TABLE ledger.attribution_results
  ADD COLUMN export_xid xid8, ADD COLUMN export_epoch timestamptz;
ALTER TABLE ledger.attribution_results ALTER COLUMN export_xid SET DEFAULT pg_current_xact_id(),
  ALTER COLUMN export_epoch SET DEFAULT pg_postmaster_start_time();
ALTER TABLE ledger.commerce_lifecycle_facts
  ADD COLUMN export_xid xid8, ADD COLUMN export_epoch timestamptz;
ALTER TABLE ledger.commerce_lifecycle_facts ALTER COLUMN export_xid SET DEFAULT pg_current_xact_id(),
  ALTER COLUMN export_epoch SET DEFAULT pg_postmaster_start_time();
CREATE INDEX attribution_subject_export_idx ON ledger.attribution_results
  (tenant_id,app_id,subject_ref,effective_at,attribution_id);
CREATE INDEX commerce_subject_export_idx ON ledger.commerce_lifecycle_facts
  (tenant_id,app_id,subject_digest,effective_at,lifecycle_fact_id);
