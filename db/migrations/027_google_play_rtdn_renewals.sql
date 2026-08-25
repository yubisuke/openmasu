-- Authenticated Google Play RTDN renewal queue and deployment-wide replay boundaries.
ALTER TABLE control.google_play_purchase_tokens
  ADD COLUMN product_id text CHECK (product_id IS NULL OR length(product_id) BETWEEN 1 AND 255),
  ADD COLUMN purchase_kind text CHECK (purchase_kind IS NULL OR purchase_kind IN ('one_time_product','subscription_initial'));

ALTER TABLE ephemeral.google_play_product_verifications
  DROP CONSTRAINT google_play_product_verifications_purchase_kind_check,
  DROP CONSTRAINT google_play_product_verifications_token_digest_key,
  ADD CONSTRAINT google_play_product_verifications_purchase_kind_check
    CHECK (purchase_kind IN ('one_time_product','subscription_initial','subscription_renewal'));

ALTER TABLE ledger.google_play_purchase_verification_results
  DROP CONSTRAINT google_play_purchase_verification_results_purchase_kind_check,
  DROP CONSTRAINT google_play_purchase_verification_results_token_digest_key,
  ADD CONSTRAINT google_play_purchase_verification_results_purchase_kind_check
    CHECK (purchase_kind IN ('one_time_product','subscription_initial','subscription_renewal'));

CREATE TABLE control.google_play_rtdn_messages (
  message_digest text PRIMARY KEY CHECK (message_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  verification_id uuid NOT NULL UNIQUE,
  subject_record_id control.identifier NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'encrypted:%'),
  notification_type integer NOT NULL CHECK (notification_type = 2),
  event_time control.canonical_timestamp NOT NULL,
  received_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE TABLE control.google_play_order_digests (
  order_digest text PRIMARY KEY CHECK (order_digest ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  verification_id uuid NOT NULL UNIQUE,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 255),
  status text NOT NULL CHECK (status IN ('pending','verified')),
  claimed_at control.canonical_timestamp NOT NULL,
  verified_at control.canonical_timestamp,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  CHECK ((status='verified') = (verified_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION control.resolve_android_package(request_package text)
RETURNS TABLE (tenant_id control.identifier, app_id control.identifier)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT identity.tenant_id, identity.app_id
    FROM control.app_link_identities AS identity
   WHERE identity.android_package_name=request_package
   LIMIT 1
$$;

DROP POLICY app_link_identities_tenant ON control.app_link_identities;
CREATE POLICY app_link_identities_tenant ON control.app_link_identities
  USING (
    tenant_id=current_setting('openmasu.tenant_id', true)
    OR current_user='openmasu_owner'
  )
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.google_play_rtdn_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_play_rtdn_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_rtdn_messages_tenant ON control.google_play_rtdn_messages
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.google_play_order_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.google_play_order_digests FORCE ROW LEVEL SECURITY;
CREATE POLICY google_play_order_digests_tenant ON control.google_play_order_digests
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER google_play_rtdn_messages_append_only
  BEFORE UPDATE OR DELETE ON control.google_play_rtdn_messages
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

CREATE TRIGGER google_play_order_digests_append_only_delete
  BEFORE DELETE ON control.google_play_order_digests
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.google_play_rtdn_messages, control.google_play_order_digests FROM PUBLIC;
REVOKE ALL ON FUNCTION control.resolve_android_package(text) FROM PUBLIC;
GRANT SELECT, INSERT ON control.google_play_rtdn_messages TO openmasu_app;
GRANT SELECT, INSERT, UPDATE ON control.google_play_order_digests TO openmasu_app;
GRANT EXECUTE ON FUNCTION control.resolve_android_package(text) TO openmasu_app;
REVOKE SELECT ON control.google_play_rtdn_messages, control.google_play_order_digests FROM openmasu_reader;
GRANT TRUNCATE ON control.google_play_rtdn_messages, control.google_play_order_digests TO openmasu_seed;
