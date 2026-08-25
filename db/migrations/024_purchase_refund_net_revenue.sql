-- Provider-neutral purchase/refund projections used by the additive settled net-revenue metrics.
-- Existing purchase rows predate financial-status projection and intentionally remain NULL;
-- they are excluded from settled metrics until replayed from protected payload storage.
ALTER TABLE ledger.logical_events
  ADD CONSTRAINT logical_events_record_identity_unique
    UNIQUE (tenant_id, app_id, logical_event_id, record_id);

ALTER TABLE ledger.purchase_facts
  ADD COLUMN record_id control.identifier,
  ADD COLUMN original_transaction_id text
    CHECK (original_transaction_id IS NULL OR original_transaction_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD COLUMN financial_status text
    CHECK (financial_status IS NULL OR financial_status IN ('settled', 'pending', 'reversed'));

ALTER TABLE ledger.purchase_facts
  ADD CONSTRAINT purchase_facts_projected_record_required
    CHECK (financial_status IS NULL OR record_id IS NOT NULL),
  ADD CONSTRAINT purchase_facts_source_scope_fk
    FOREIGN KEY (tenant_id, app_id, logical_event_id, record_id)
    REFERENCES ledger.logical_events (tenant_id, app_id, logical_event_id, record_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT purchase_facts_record_scope_unique UNIQUE (tenant_id, app_id, record_id);

CREATE INDEX purchase_facts_net_revenue_idx
  ON ledger.purchase_facts (tenant_id, app_id, installation_id, occurred_at_ts)
  WHERE financial_status = 'settled';

CREATE INDEX purchase_facts_refund_target_idx
  ON ledger.purchase_facts (
    tenant_id, app_id, installation_id,
    (COALESCE(original_transaction_id, transaction_id)), currency, occurred_at_ts
  )
  WHERE financial_status = 'settled';

CREATE TABLE ledger.refund_facts (
  logical_event_id text PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text NOT NULL,
  transaction_id text NOT NULL CHECK (transaction_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  original_transaction_id text NOT NULL CHECK (original_transaction_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  correction_target_record_id control.identifier NOT NULL,
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL CHECK (amount_scale BETWEEN 0 AND 18),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  financial_status text NOT NULL CHECK (financial_status IN ('settled', 'pending', 'reversed')),
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CONSTRAINT refund_facts_source_scope_fk
    FOREIGN KEY (tenant_id, app_id, logical_event_id)
    REFERENCES ledger.logical_events (tenant_id, app_id, logical_event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT refund_facts_target_scope_fk
    FOREIGN KEY (tenant_id, app_id, correction_target_record_id)
    REFERENCES ledger.purchase_facts (tenant_id, app_id, record_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION ledger.enforce_refund_target_invariant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_purchase record;
  refund_received_at_ts timestamptz;
  eligible_target_count bigint;
BEGIN
  SELECT raw.received_at_ts
    INTO refund_received_at_ts
    FROM ledger.logical_events AS logical_event
    JOIN ledger.raw_records AS raw
      ON raw.tenant_id = logical_event.tenant_id
     AND raw.app_id = logical_event.app_id
     AND raw.record_id = logical_event.record_id
   WHERE logical_event.tenant_id = NEW.tenant_id
     AND logical_event.app_id = NEW.app_id
     AND logical_event.logical_event_id = NEW.logical_event_id;

  -- A missing same-scope source is reported by refund_facts_source_scope_fk as 23503.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT purchase.financial_status,
         purchase.installation_id,
         COALESCE(purchase.original_transaction_id, purchase.transaction_id) AS original_transaction_id,
         purchase.currency,
         purchase.occurred_at_ts,
         raw.received_at_ts
    INTO target_purchase
    FROM ledger.purchase_facts AS purchase
    JOIN ledger.raw_records AS raw
      ON raw.tenant_id = purchase.tenant_id
     AND raw.app_id = purchase.app_id
     AND raw.record_id = purchase.record_id
   WHERE purchase.tenant_id = NEW.tenant_id
     AND purchase.app_id = NEW.app_id
     AND purchase.record_id = NEW.correction_target_record_id;

  -- A missing same-scope target is reported by refund_facts_target_scope_fk as 23503.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF target_purchase.financial_status IS DISTINCT FROM 'settled'
     OR target_purchase.installation_id IS DISTINCT FROM NEW.installation_id
     OR target_purchase.original_transaction_id IS DISTINCT FROM NEW.original_transaction_id
     OR target_purchase.currency IS DISTINCT FROM NEW.currency
     OR target_purchase.occurred_at_ts > NEW.occurred_at_ts
     OR target_purchase.received_at_ts > refund_received_at_ts THEN
    RAISE EXCEPTION 'refund target invariant violation'
      USING ERRCODE = '23514',
            CONSTRAINT = 'refund_facts_target_invariant';
  END IF;

  SELECT count(*)
    INTO eligible_target_count
    FROM ledger.purchase_facts AS purchase
    JOIN ledger.raw_records AS raw
      ON raw.tenant_id = purchase.tenant_id
     AND raw.app_id = purchase.app_id
     AND raw.record_id = purchase.record_id
   WHERE purchase.tenant_id = NEW.tenant_id
     AND purchase.app_id = NEW.app_id
     AND purchase.financial_status = 'settled'
     AND purchase.installation_id = NEW.installation_id
     AND COALESCE(purchase.original_transaction_id, purchase.transaction_id) = NEW.original_transaction_id
     AND purchase.currency = NEW.currency
     AND purchase.occurred_at_ts <= NEW.occurred_at_ts
     AND raw.received_at_ts <= refund_received_at_ts;

  IF eligible_target_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'refund target resolution is ambiguous'
      USING ERRCODE = '23514',
            CONSTRAINT = 'refund_facts_target_invariant';
  END IF;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION ledger.enforce_refund_target_invariant() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER refund_facts_target_invariant
  AFTER INSERT ON ledger.refund_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.enforce_refund_target_invariant();

CREATE INDEX refund_facts_net_revenue_idx
  ON ledger.refund_facts (
    tenant_id, app_id, installation_id, occurred_at_ts, correction_target_record_id
  )
  WHERE financial_status = 'settled';

ALTER TABLE ledger.refund_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.refund_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_facts_tenant ON ledger.refund_facts
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER refund_facts_append_only BEFORE UPDATE OR DELETE ON ledger.refund_facts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON ledger.refund_facts FROM PUBLIC;
GRANT SELECT, INSERT ON ledger.refund_facts TO openmasu_app;
GRANT SELECT ON ledger.refund_facts TO openmasu_reader;
GRANT TRUNCATE ON ledger.refund_facts TO openmasu_seed;
