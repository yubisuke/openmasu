-- Provider-neutral verified commerce notifications, lifecycle facts, and resumable read-back state.
CREATE TABLE control.commerce_provider_notifications (
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  notification_digest text NOT NULL CHECK (notification_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_]{2,127}$'),
  subject_digest text CHECK (subject_digest IS NULL OR subject_digest ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'encrypted:%'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  occurred_at control.canonical_timestamp NOT NULL,
  received_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (provider, notification_digest),
  UNIQUE (provider, notification_digest, tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.commerce_provider_readbacks (
  readback_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  notification_digest text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('google_subscription','google_order_refund','apple_transaction_history','apple_refund_history')),
  cursor_ref text CHECK (cursor_ref IS NULL OR cursor_ref LIKE 'encrypted:%'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL,
  requested_at control.canonical_timestamp NOT NULL,
  last_status integer CHECK (last_status IS NULL OR last_status BETWEEN 100 AND 599),
  FOREIGN KEY (provider, notification_digest, tenant_id, app_id)
    REFERENCES control.commerce_provider_notifications (provider, notification_digest, tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (provider, tenant_id, app_id, notification_digest, operation)
);

CREATE TABLE ledger.commerce_lifecycle_facts (
  lifecycle_fact_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  notification_digest text NOT NULL,
  provider_event_digest text NOT NULL CHECK (provider_event_digest ~ '^[a-f0-9]{64}$'),
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_]{2,127}$'),
  subject_digest text CHECK (subject_digest IS NULL OR subject_digest ~ '^[a-f0-9]{64}$'),
  transaction_digest text CHECK (transaction_digest IS NULL OR transaction_digest ~ '^[a-f0-9]{64}$'),
  original_transaction_digest text CHECK (original_transaction_digest IS NULL OR original_transaction_digest ~ '^[a-f0-9]{64}$'),
  subscription_state text,
  financial_effect text NOT NULL CHECK (financial_effect IN ('none','purchase','refund','refund_reversal')),
  environment text CHECK (environment IS NULL OR environment IN ('Sandbox','Production')),
  effective_at control.canonical_timestamp NOT NULL,
  recorded_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (provider, notification_digest, tenant_id, app_id)
    REFERENCES control.commerce_provider_notifications (provider, notification_digest, tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (provider, notification_digest, event_kind, transaction_digest)
);

CREATE TABLE control.commerce_purchase_bindings (
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  transaction_digest text NOT NULL CHECK (transaction_digest ~ '^[a-f0-9]{64}$'),
  original_transaction_digest text CHECK (original_transaction_digest IS NULL OR original_transaction_digest ~ '^[a-f0-9]{64}$'),
  purchase_record_id control.identifier NOT NULL,
  installation_digest text NOT NULL CHECK (installation_digest ~ '^[a-f0-9]{64}$'),
  amount_unscaled text NOT NULL CHECK (amount_unscaled ~ '^[0-9]+$'),
  amount_scale integer NOT NULL CHECK (amount_scale BETWEEN 0 AND 18),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 10000),
  bound_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (provider, transaction_digest),
  FOREIGN KEY (tenant_id, app_id, purchase_record_id)
    REFERENCES ledger.purchase_facts (tenant_id, app_id, record_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.commerce_backfill_checkpoints (
  provider text NOT NULL CHECK (provider IN ('google_play','app_store')),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]{2,127}$'),
  cursor_ref text CHECK (cursor_ref IS NULL OR cursor_ref LIKE 'encrypted:%'),
  window_start control.canonical_timestamp NOT NULL,
  window_end control.canonical_timestamp NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  updated_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (provider, tenant_id, app_id, stream),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE FUNCTION control.resolve_apple_store_registration(_bundle_id text, _app_apple_id bigint)
RETURNS TABLE (tenant_id control.identifier, app_id control.identifier)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT registration.tenant_id, registration.app_id
    FROM control.apple_app_registrations AS registration
   WHERE registration.apple_bundle_id=_bundle_id
     AND (_app_apple_id IS NULL OR registration.apple_app_adam_id=_app_apple_id)
   ORDER BY registration.tenant_id, registration.app_id
   LIMIT 2
$$;

CREATE INDEX commerce_lifecycle_scope_time_idx
  ON ledger.commerce_lifecycle_facts (tenant_id, app_id, effective_at, lifecycle_fact_id);
CREATE INDEX commerce_lifecycle_subject_idx
  ON ledger.commerce_lifecycle_facts (tenant_id, app_id, subject_digest)
  WHERE subject_digest IS NOT NULL;
CREATE UNIQUE INDEX commerce_lifecycle_idempotency_idx
  ON ledger.commerce_lifecycle_facts (provider, event_kind, provider_event_digest);
CREATE INDEX commerce_readbacks_due_idx
  ON ephemeral.commerce_provider_readbacks (tenant_id, next_attempt_at, readback_id);

ALTER TABLE control.commerce_provider_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.commerce_provider_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_notifications_tenant ON control.commerce_provider_notifications
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE ephemeral.commerce_provider_readbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.commerce_provider_readbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_readbacks_tenant ON ephemeral.commerce_provider_readbacks
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE ledger.commerce_lifecycle_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.commerce_lifecycle_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_lifecycle_facts_tenant ON ledger.commerce_lifecycle_facts
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE control.commerce_purchase_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.commerce_purchase_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_purchase_bindings_tenant ON control.commerce_purchase_bindings
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
ALTER TABLE control.commerce_backfill_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.commerce_backfill_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_backfill_checkpoints_tenant ON control.commerce_backfill_checkpoints
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER commerce_provider_notifications_append_only
  BEFORE UPDATE OR DELETE ON control.commerce_provider_notifications
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER commerce_lifecycle_facts_append_only
  BEFORE UPDATE OR DELETE ON ledger.commerce_lifecycle_facts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER commerce_purchase_bindings_append_only
  BEFORE UPDATE OR DELETE ON control.commerce_purchase_bindings
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.commerce_provider_notifications, control.commerce_purchase_bindings,
  control.commerce_backfill_checkpoints, ledger.commerce_lifecycle_facts,
  ephemeral.commerce_provider_readbacks FROM PUBLIC;
REVOKE ALL ON FUNCTION control.resolve_apple_store_registration(text, bigint) FROM PUBLIC;
GRANT SELECT, INSERT ON control.commerce_provider_notifications, control.commerce_purchase_bindings TO openmasu_app;
GRANT SELECT, INSERT, UPDATE ON control.commerce_backfill_checkpoints TO openmasu_app;
GRANT SELECT, INSERT ON ledger.commerce_lifecycle_facts TO openmasu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.commerce_provider_readbacks TO openmasu_app;
GRANT EXECUTE ON FUNCTION control.resolve_apple_store_registration(text, bigint) TO openmasu_app;
GRANT SELECT ON ledger.commerce_lifecycle_facts TO openmasu_reader;
REVOKE SELECT ON control.commerce_provider_notifications, control.commerce_purchase_bindings,
  control.commerce_backfill_checkpoints, ephemeral.commerce_provider_readbacks FROM openmasu_reader;
GRANT TRUNCATE ON control.commerce_provider_notifications, control.commerce_purchase_bindings,
  control.commerce_backfill_checkpoints, ledger.commerce_lifecycle_facts,
  ephemeral.commerce_provider_readbacks TO openmasu_seed;

CREATE OR REPLACE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT registration.tenant_id
  FROM control.apple_app_registrations AS registration
  UNION
  SELECT batch.tenant_id
  FROM ledger.ingest_batches_current AS batch
  WHERE batch.status IN ('pending', 'processed')
  UNION
  SELECT lookup.tenant_id
  FROM ephemeral.adservices_lookups AS lookup
  UNION
  SELECT verification.tenant_id
  FROM ephemeral.google_play_product_verifications AS verification
  UNION
  SELECT delivery.tenant_id
  FROM ephemeral.google_conversion_deliveries AS delivery
  WHERE delivery.state IN ('queued','http_accepted','diagnostics_processing')
  UNION
  SELECT readback.tenant_id
  FROM ephemeral.commerce_provider_readbacks AS readback
  ORDER BY 1
$$;
