-- WO-16 repairs grants for databases that applied M6/M7 before their role ACLs
-- were complete. The statements are idempotent and intentionally narrow.
GRANT USAGE ON SCHEMA control, ledger, ephemeral TO openmasu_app;
GRANT USAGE ON SCHEMA control, ledger TO openmasu_reader;
GRANT USAGE ON SCHEMA control, ledger, ephemeral TO openmasu_seed;

GRANT SELECT, INSERT ON
  control.rule_bundle_revisions,
  control.link_domains,
  control.app_link_identities,
  ledger.fraud_decisions,
  ledger.source_day_aggregates,
  ledger.integrity_verification_results,
  ledger.deep_link_open_facts
TO openmasu_app;

GRANT SELECT, INSERT, DELETE ON ephemeral.fraud_quarantines TO openmasu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ephemeral.integrity_verifications TO openmasu_app;

GRANT SELECT ON
  control.rule_bundle_revisions,
  control.link_domains,
  control.app_link_identities,
  ledger.fraud_decisions,
  ledger.source_day_aggregates,
  ledger.integrity_verification_results,
  ledger.deep_link_open_facts
TO openmasu_reader;

GRANT TRUNCATE ON
  control.rule_bundle_revisions,
  control.link_domains,
  control.app_link_identities,
  ledger.fraud_decisions,
  ledger.source_day_aggregates,
  ledger.integrity_verification_results,
  ledger.deep_link_open_facts,
  ephemeral.fraud_quarantines,
  ephemeral.integrity_verifications
TO openmasu_seed;
