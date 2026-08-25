-- Protected Google Play one-time-product verification queue and append-only outcomes.
CREATE TABLE control.google_play_purchase_tokens (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  verification_id uuid NOT NULL UNIQUE,
  registered_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE ephemeral.google_play_product_verifications (
  verification_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_record_id control.identifier NOT NULL,
  token_ref text NOT NULL CHECK (token_ref LIKE 'encrypted:%'),
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 255),
  verified_record_id control.identifier NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  requested_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, app_id, subject_record_id),
  UNIQUE (token_digest)
);

CREATE INDEX google_play_product_verifications_due_idx
  ON ephemeral.google_play_product_verifications (next_attempt_at, verification_id);

CREATE TABLE ledger.google_play_purchase_verification_results (
  verification_result_id uuid PRIMARY KEY,
  verification_id uuid NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  subject_record_id control.identifier NOT NULL,
  verified_record_id control.identifier,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  verdict text NOT NULL CHECK (verdict IN ('verified','failed','unavailable')),
  provider_purchase_state text,
  product_matched boolean NOT NULL,
  evidence_ref text,
  response_digest text,
  decided_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (verification_id),
  UNIQUE (token_digest),
  CHECK (
    (verdict IN ('verified','failed') AND evidence_ref LIKE 'encrypted:%'
      AND response_digest ~ '^[a-f0-9]{64}$')
    OR
    (verdict='unavailable' AND evidence_ref IS NULL AND response_digest IS NULL)
  ),
  CHECK ((verdict='verified') = (verified_record_id IS NOT NULL))
);

CREATE INDEX google_play_purchase_results_subject_idx
  ON ledger.google_play_purchase_verification_results (
    tenant_id, app_id, subject_record_id, decided_at
  );

ALTER TABLE ephemeral.google_play_product_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ephemeral.google_play_product_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_product_verifications_tenant
  ON ephemeral.google_play_product_verifications
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

-- The worker discovers due work before it has a tenant RLS context. The
-- SECURITY DEFINER function below returns tenant identifiers only.
CREATE POLICY google_play_product_verifications_discovery_owner
  ON ephemeral.google_play_product_verifications FOR SELECT TO openmasu_owner
  USING (true);

ALTER TABLE control.google_play_purchase_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_play_purchase_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_purchase_tokens_tenant
  ON control.google_play_purchase_tokens
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.google_play_purchase_verification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.google_play_purchase_verification_results FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_purchase_verification_results_tenant
  ON ledger.google_play_purchase_verification_results
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER google_play_purchase_verification_results_append_only
  BEFORE UPDATE OR DELETE ON ledger.google_play_purchase_verification_results
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

CREATE TRIGGER google_play_purchase_tokens_append_only
  BEFORE UPDATE OR DELETE ON control.google_play_purchase_tokens
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON
  ephemeral.google_play_product_verifications,
  control.google_play_purchase_tokens,
  ledger.google_play_purchase_verification_results
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ephemeral.google_play_product_verifications TO openmasu_app;
GRANT SELECT, INSERT ON control.google_play_purchase_tokens TO openmasu_app;
REVOKE SELECT ON control.google_play_purchase_tokens FROM openmasu_reader;
GRANT SELECT, INSERT
  ON ledger.google_play_purchase_verification_results TO openmasu_app;
GRANT SELECT
  ON ledger.google_play_purchase_verification_results TO openmasu_reader;
GRANT TRUNCATE
  ON ephemeral.google_play_product_verifications,
     control.google_play_purchase_tokens,
     ledger.google_play_purchase_verification_results TO openmasu_seed;

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
  ORDER BY 1
$$;
