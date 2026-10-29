-- Window profiles share a contract version; their full definition hashes identify
-- their meaning. Each explicit activation (including 1 -> 30 -> 1) needs its own
-- immutable revision and receipt time. Other bundle families retain version uniqueness.
ALTER TABLE control.rule_bundle_revisions
  DROP CONSTRAINT rule_bundle_revisions_tenant_id_app_id_rule_bundle_id_rule__key;
CREATE UNIQUE INDEX rule_bundle_version_once_except_first_party_window
  ON control.rule_bundle_revisions(tenant_id,app_id,rule_bundle_id,rule_bundle_version)
  WHERE rule_bundle_id <> 'attribution-first-party-window';
