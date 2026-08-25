# Contract and Schema Versioning

Open MMP publishes one active contract tree while the project has no runtime users. The Git tag `contract-v0.1` preserves the complete v0.1 contract; the working tree contains v0.2 in place.

The v0.2 tree remains a pre-release composition while its ordered contract work orders are being reviewed on the designated review branch. Those work orders may complete the same `0.2.0` schema set before it is accepted into the public release baseline. After v0.2 is accepted as a release baseline, any change classified as breaking below requires a new minor line; this composition exception no longer applies. R-23 publishes the first non-breaking patch of that minor line as release `0.2.1`.

## Version identifiers

- A schema `$id` ends in the contract minor line, for example `urn:open-mmp:schema:raw-record:v0.2`.
- `contract_version` is the exact SemVer contract release implemented by an artifact. Unchanged v0.2 artifact shapes retain `0.2.0`; a changed registry or versioned result surface declares `0.2.1` where its schema permits that patch.
- `schema_version` is the exact SemVer version of an input record's event schema. The v0.2 fixtures use `0.2.0`.
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

## Compatibility registry

`registries/compatibility-v0.2.json` closes the allowed attribution combinations of subject scope, method, model, and status. It does not replace schema versioning. Schemas define artifact shape, registries define closed cross-field vocabularies and metadata, and the validator proves that duplicated enum surfaces agree.

## Fixture and golden policy

Fixtures are versioned with the active contract. The v0.2 migration moves `fixtures/v0.1/` to `fixtures/v0.2/` and updates reviewed golden artifacts to v0.2 semantics. The immutable v0.1 evidence remains available from the `contract-v0.1` tag.

Golden output files are human-reviewed evidence, not generated validation authority. A semantic evaluator or schema change and its reviewed golden update SHOULD be separate commits. Every v0.2 golden change is recorded in [the migration ledger](contract-v0.2-migration.md) with its field-level reason and governing decision.
