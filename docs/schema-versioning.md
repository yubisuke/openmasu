# Contract and Schema Versioning

OpenMasu keeps one active pre-1.0 contract tree in the working branch. Complete
older contract lines are preserved by Git tags:

- `contract-v0.1`
- `contract-v0.2.1`
- `contract-v0.3.6`

The active tree is Contract v0.4. Schema identifiers use the v0.4 minor line;
artifact version fields use the exact contract release defined by their schema.

## Version identifiers

- Schema `$id`: `urn:openmasu:schema:<artifact>:v0.4`
- Artifact `contract_version`: exact SemVer contract release, currently `0.4.0`
  for the active artifact family
- Event `schema_version`: exact event schema release, currently `0.4.0`
- Registry filename: contract minor line, such as `*-v0.4.json`
- Metric, policy, producer, wrapper, and rule-bundle versions: independent
  identities unless a schema explicitly binds them

Consumers must select schemas and registries from the declared contract version.
They must not infer compatibility from a filename or package version alone.

## Compatibility rules

A change requires a new minor line before 1.0 when it:

- adds a required field;
- removes or narrows an enum value;
- changes an `additionalProperties` boundary;
- changes a field's type, structure, meaning, or namespace;
- changes identity, ordering, hashing, authority, time-window, privacy, or metric
  semantics.

A patch may add an optional field, enum value, independent schema, or independent
registry entry when all existing conforming artifacts retain their meaning. A
patch may also tighten validation to enforce behavior already required by the
normative specification. Every new vocabulary value must be exercised by a
synthetic fixture, recorded in the migration ledger, and kept in TypeScript/
Python parity.

## Active release history

### v0.4.0 identity migration

The project and contract namespace changed to OpenMasu. Schema URNs, contract-
owned version fields, registry and fixture paths, generated type names, and
name-derived strings changed. Field meaning, evaluator behavior, metric
arithmetic, privacy semantics, and independent metric/rule versions did not.
The mechanical proof is recorded in [Contract v0.4 migration](contract-v0.4-migration.md).

### v0.4 additive patches

The v0.4 line adds independently exercised optional vocabulary and definitions:

| Patch | Additive capability |
| --- | --- |
| 0.4.1 | source-scoped fraud decisions and public fraud categories |
| 0.4.2 | fraud-exclusion attribution provenance |
| 0.4.3 | gross/net metric fraud policy |
| 0.4.4 | explicit Play referrer click-time availability |
| 0.4.5 | bounded source-rate and client classifications |
| 0.4.6 | registered fraud-bundle binding and negative-CTIT diagnostic |
| 0.4.7 | deep-link events, engagement attribution, and daily metrics |
| 0.4.8 | installation-anchored purchase/refund net revenue |
| 0.4.9 | D30/D90 purchase-net and total-net metrics |

Existing schema `$id` values remain on `v0.4`; existing event artifact version
fields remain `0.4.0` where their schema did not change.

## Registry and golden policy

Schemas define artifact shape. Registries define closed vocabularies and
cross-field metadata. The validator proves duplicated enum surfaces agree.

Golden outputs are reviewed evidence, not generated authority. Validation is
read-only. A semantic change and its reviewed golden update should be separated
when practical, and every changed golden must have a written derivation in
`fixtures/v0.4/README.md` and the relevant migration record.
