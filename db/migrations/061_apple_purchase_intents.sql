-- Protected purchase preparation, not financial or entitlement evidence.
CREATE TABLE control.apple_purchase_intents (
  intent_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  request_id uuid NOT NULL,
  installation_key_id control.identifier NOT NULL REFERENCES control.installation_credentials (installation_key_id),
  installation_id_digest text NOT NULL CHECK (installation_id_digest ~ '^[a-f0-9]{64}$'),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 255),
  environment text NOT NULL CHECK (environment IN ('Sandbox','Production')),
  bundle_id text NOT NULL CHECK (length(bundle_id) BETWEEN 1 AND 255),
  app_apple_id bigint NOT NULL CHECK (app_apple_id > 0),
  anchor_ref text NOT NULL CHECK (anchor_ref ~ '^encrypted:[A-Za-z0-9._-]+$' AND position('..' in anchor_ref)=0),
  created_at control.canonical_timestamp NOT NULL,
  UNIQUE (tenant_id,app_id,installation_id_digest,request_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
ALTER TABLE control.apple_purchase_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.apple_purchase_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY apple_purchase_intents_tenant ON control.apple_purchase_intents
  USING (tenant_id=current_setting('openmasu.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
REVOKE ALL ON control.apple_purchase_intents FROM PUBLIC, openmasu_reader;
GRANT SELECT, INSERT, DELETE ON control.apple_purchase_intents TO openmasu_app;
GRANT TRUNCATE ON control.apple_purchase_intents TO openmasu_seed;
