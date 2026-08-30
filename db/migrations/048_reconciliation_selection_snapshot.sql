-- Keep stored-difference pagination on the row set selected by its first page.
CREATE SEQUENCE ledger.reconciliation_selection_seq;

-- The temporary default backfills existing committed rows while ALTER TABLE
-- holds its exclusive lock. New rows are numbered by the trigger below only
-- after the tenant/app selection lock has been acquired.
ALTER TABLE ledger.reconciliation_results
  ADD COLUMN reconciliation_selection_seq bigint NOT NULL
    DEFAULT nextval('ledger.reconciliation_selection_seq');

ALTER TABLE ledger.reconciliation_results
  ALTER COLUMN reconciliation_selection_seq DROP DEFAULT;

CREATE INDEX reconciliation_results_selection_idx
  ON ledger.reconciliation_results (tenant_id, app_id, reconciliation_selection_seq);

CREATE FUNCTION ledger.acquire_reconciliation_selection_lock(
  p_tenant_id text,
  p_app_id text
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(
    'openmasu:reconciliation-selection:'
      || length(p_tenant_id)::text || ':' || p_tenant_id || ':' || p_app_id,
    0
  ))
$$;

CREATE FUNCTION ledger.lock_reconciliation_selection_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM ledger.acquire_reconciliation_selection_lock(
    NEW.tenant_id::text,
    NEW.app_id::text
  );
  NEW.reconciliation_selection_seq := nextval('ledger.reconciliation_selection_seq');
  RETURN NEW;
END
$$;

CREATE TRIGGER reconciliation_results_selection_lock
  BEFORE INSERT ON ledger.reconciliation_results
  FOR EACH ROW EXECUTE FUNCTION ledger.lock_reconciliation_selection_insert();

REVOKE ALL ON FUNCTION ledger.acquire_reconciliation_selection_lock(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.lock_reconciliation_selection_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.acquire_reconciliation_selection_lock(text, text)
  TO openmasu_app, openmasu_reader;
GRANT USAGE, SELECT ON SEQUENCE ledger.reconciliation_selection_seq TO openmasu_app;
GRANT SELECT ON SEQUENCE ledger.reconciliation_selection_seq TO openmasu_reader;
