-- M7 link-domain registration, association identities, deferred-link definitions, and engagement projections.
CREATE TABLE control.link_domains (
  tenant_id control.identifier PRIMARY KEY,
  host text NOT NULL CHECK (host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  registered_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  UNIQUE (host)
);

CREATE TABLE control.app_link_identities (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  android_package_name text CHECK (android_package_name IS NULL OR android_package_name ~ '^[A-Za-z][A-Za-z0-9_.]{2,254}$'),
  android_sha256_fingerprints text[] NOT NULL DEFAULT '{}',
  apple_team_id text CHECK (apple_team_id IS NULL OR apple_team_id ~ '^[A-Z0-9]{10}$'),
  apple_bundle_id text CHECK (apple_bundle_id IS NULL OR apple_bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$'),
  registered_at control.canonical_timestamp NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (android_package_name),
  UNIQUE (apple_team_id, apple_bundle_id),
  CHECK (cardinality(android_sha256_fingerprints) <= 8),
  CHECK ((apple_team_id IS NULL AND apple_bundle_id IS NULL) OR (apple_team_id IS NOT NULL AND apple_bundle_id IS NOT NULL))
);

-- Host-based routing needs a deployment-wide lookup before a tenant RLS context exists.
-- This boundary returns only the tenant identifier and never exposes registration rows.
CREATE FUNCTION control.resolve_link_host(request_host text)
RETURNS control.identifier
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, control
AS $$
  SELECT tenant_id
    FROM control.link_domains
   WHERE host = lower(trim(trailing '.' from request_host))
   LIMIT 1
$$;

ALTER TABLE control.tracking_links
  ADD COLUMN deep_link_value text
    CHECK (deep_link_value IS NULL OR (length(deep_link_value) <= 256 AND deep_link_value ~ '^(/[A-Za-z0-9._~-]{1,64}){1,8}$')),
  ADD COLUMN deep_link_param_names text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(deep_link_param_names) <= 10),
  ADD COLUMN deferred_deep_link_ttl_seconds integer NOT NULL DEFAULT 604800
    CHECK (deferred_deep_link_ttl_seconds BETWEEN 0 AND 7776000);

ALTER TABLE ledger.click_facts
  ADD COLUMN tracking_link_id control.identifier REFERENCES control.tracking_links (tracking_link_id);

CREATE TABLE ledger.deep_link_open_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  installation_id text NOT NULL,
  tracking_link_id control.identifier,
  campaign_id text,
  open_source text NOT NULL CHECK (open_source IN ('android_app_link','ios_universal_link','custom_scheme','android_deferred_referrer')),
  occurred_at control.canonical_timestamp NOT NULL,
  occurred_at_ts timestamptz GENERATED ALWAYS AS (control.canonical_timestamp_value(occurred_at)) STORED,
  days_since_last_session integer CHECK (days_since_last_session IS NULL OR days_since_last_session >= 0),
  artifact jsonb NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

CREATE INDEX deep_link_open_facts_dimensions_idx
  ON ledger.deep_link_open_facts (tenant_id, app_id, campaign_id, occurred_at_ts);

ALTER TABLE control.link_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.link_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY link_domains_tenant ON control.link_domains
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE control.app_link_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.app_link_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY app_link_identities_tenant ON control.app_link_identities
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

ALTER TABLE ledger.deep_link_open_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.deep_link_open_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY deep_link_open_facts_tenant ON ledger.deep_link_open_facts
  USING (tenant_id=current_setting('openmasu.tenant_id', true))
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));

CREATE TRIGGER link_domains_append_only BEFORE UPDATE OR DELETE ON control.link_domains
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER app_link_identities_append_only BEFORE UPDATE OR DELETE ON control.app_link_identities
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE TRIGGER deep_link_open_facts_append_only BEFORE UPDATE OR DELETE ON ledger.deep_link_open_facts
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();

REVOKE ALL ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts FROM PUBLIC;
REVOKE ALL ON FUNCTION control.resolve_link_host(text) FROM PUBLIC;
GRANT SELECT, INSERT ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts TO openmasu_app;
GRANT EXECUTE ON FUNCTION control.resolve_link_host(text) TO openmasu_app;
GRANT SELECT ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts TO openmasu_reader;
GRANT TRUNCATE ON control.link_domains, control.app_link_identities, ledger.deep_link_open_facts TO openmasu_seed;
