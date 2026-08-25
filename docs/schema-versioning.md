# Contract and Schema Versioning

Open MMP publishes one active contract tree while the project has no production contract consumers. The Git tags `contract-v0.1` and `contract-v0.2.1` preserve the complete earlier contract lines; the working tree contains v0.3 in place.

Contract v0.3 is a breaking minor line relative to v0.2.1. Consumers must migrate schemas, registries, fixtures, and evaluator behavior as one unit. The in-place policy does not make artifacts from different minor lines interoperable.

## Version identifiers

- A schema `$id` ends in the contract minor line, for example `urn:open-mmp:schema:raw-record:v0.3`.
- `contract_version` is the exact SemVer contract release implemented by an artifact. Existing v0.3 event artifacts declare `0.3.0`; the active package release is `0.3.6` and does not rewrite those conforming artifacts.
- `schema_version` is the exact SemVer version of an input record's event schema. The v0.3 fixtures use `0.3.0`.
- Registry filenames carry the contract minor line. Their `contract_version` field identifies the exact release.
- Policy, producer, and rule-bundle versions are independent deployment or fixture identifiers unless a schema explicitly binds them.

An implementation MUST select schemas and registries by the declared contract version. It MUST NOT infer compatibility from a filename alone.

## Compatibility rules

The following changes are breaking and require a new contract minor line before 1.0:

- adding a required field;
- narrowing or removing an enum value;
- changing an `additionalProperties` boundary;
- changing a field's type, structure, meaning, or namespace;
- changing identity, ordering, hashing, time-window, privacy, or metric semantics.

The following changes are non-breaking when they do not alter existing meanings:

- adding an optional field;
- adding an enum value;
- improving descriptions or examples;
- adding a new independent schema or registry entry that existing artifacts need not use.

Patch releases may correct validation defects only when every existing conforming artifact retains the same meaning. A constraint that rejects inputs the normative contract already prohibited may be a patch fix; a new behavioral decision is not.

R-23 is an explicit patch exception authorized to close two already documented M1 audit outcomes without changing existing artifact meaning. In `0.2.1`, metric-run adds optional `value_state` and `undefined_reason`; omission remains equivalent to a present v0.2.0 value. The difference-reason registry advances to `0.2.1`, and only the added `provider_modeled_conversion` reconciliation reason uses `difference_reason_version=0.2.1`; older reasons remain `0.2.0`. Schema `$id` values and registry filenames continue to identify the `v0.2` minor line. Existing event `contract_version`, event `schema_version`, metric-definition versions, rule-bundle versions, and conforming v0.2.0 goldens do not change merely because the release package advances to `0.2.1`.

R-27 is the corresponding v0.3 patch exception for M3. In `0.3.1`, metric definition, metric run, and fixture evaluation schemas add the optional `metric_date` grouping dimension. The metric-definition calculation and numerator enums add `event_count` and `events`, with an explicit optional `event_names` set used only by new daily definitions. Existing v0.3.0 artifacts retain the same meaning, schema `$id` values remain on the `v0.3` minor line, and no existing golden output changes.

R-27 also authorizes the additive M4 handoff in `0.3.2`. The install event adds the optional iOS first-launch origin, the not-applicable platform-referrer state, and two non-attributed AdServices outcomes. AdAttributionKit adds an optional signing-key environment and SKAdNetwork accepts later minor versions within supported majors 3 and 4. The new enum values and optional field are each exercised by synthetic fixture 43. Existing v0.3.0 and v0.3.1 artifacts retain their meaning, schema `$id` values remain on the `v0.3` minor line, and no existing golden output changes.

The same R-27 patch authority covers `0.3.3`, which adds only new Apple aggregate metric definitions and an optional `apple_conversion_bucket` grouping dimension. Existing event-count definitions retain their click/install and `occurred_at` semantics. The new SKAN/AdAttributionKit definitions use UTC server `received_at`, the new bucket is required only for the SKAN distribution definition, and synthetic fixture 44 exercises every added value. Existing schema `$id` values remain on the `v0.3` minor line and no earlier golden changes.

R-27 also covers the additive iOS conversion-schema handoff in `0.3.4`. The closed custom-event vocabulary admits the reserved `openmmp.conversion_value_updated` lifecycle event. M4-D-20 deliberately makes no typed install-schema change: synthetic fixture 45 carries the deployment-private conversion-schema version and SHA-256 digest in the existing `install.extensions` evidence surface. Existing schema `$id` values remain on the `v0.3` minor line, existing event-version constants retain `0.3.0`, and no earlier golden changes.

R-27 also covers the additive platform-integrity reservation in `0.3.5`. Raw records and fixture ingress records add an optional, server-assigned `integrity_verdict` evidence object. Its closed provider/verdict vocabulary is exercised by synthetic fixture 46; it carries no raw provider assertion or identifying value and does not change attribution, fraud, or metric semantics. Existing schema `$id` values remain on the `v0.3` minor line, existing event-version constants retain `0.3.0`, and no earlier golden changes.

R-27 also covers the additive import-hardening patch in `0.3.6`. Delivery and rejection reason enums add `payload_schema_invalid`, and the fixture envelope adds an independent pre-ingestion rejection input used only to prove that output. Runtime imports dispatch normalized payloads through the same compiled event schemas as the contract gate before any raw or logical evidence write. Existing schema `$id` values remain on the `v0.3` minor line, existing event-version constants retain `0.3.0`, and all 598 earlier goldens remain unchanged.

## Compatibility registry

`registries/compatibility-v0.3.json` closes the allowed attribution combinations of subject scope, method, model, and status. It does not replace schema versioning. Schemas define artifact shape, registries define closed cross-field vocabularies and metadata, and the validator proves that duplicated enum surfaces agree.

## Fixture and golden policy

Fixtures are versioned with the active contract. The v0.3 migration moves `fixtures/v0.2/` to `fixtures/v0.3/` and updates reviewed golden artifacts to v0.3 semantics. The immutable v0.2.1 evidence remains available from the `contract-v0.2.1` tag.

Golden output files are human-reviewed evidence, not generated validation authority. A semantic evaluator or schema change and its reviewed golden update SHOULD be separate commits. Every v0.3 golden change is recorded in [the migration ledger](contract-v0.3-migration.md) with its field-level reason and governing decision.
