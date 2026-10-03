# Metric profile boundaries

Metric definitions describe a calculation; they do not supply executable code.
The closed schema is authoritative for wire shape. Registered bundle definitions
are authoritative for bundle identity and digest. Runtime profile checks describe
which series each calculation entrypoint supports. Schedule-specific lag, date,
grouping, discovery and identity checks belong to the API adapter.

Keep TypeScript, Python and SQL calculations independent. Sharing declaration
metadata and boundary checks must not turn parity into a comparison of the same
calculation called twice.

## Compatibility baseline

Before moving the checks, `metric_profile_boundary_equivalence` recorded the
public definition-admission paths at main
`cb40f05c5d4c19415c70003ba95203db80773199`. It checks 100 existing declarations
across eleven families. Each declaration has six cases: unchanged, hash,
definition version, window, acquisition basis and grouping mutations. The
600 ordered results include schema validation and API, reference and SQL
admission. Their JCS SHA-256 is fixed in the test:

```text
1a598046536dc8bb704a846a8c473d7eca176d1e8f3fa2fde74e65e8fe54a1ac
```

The following counts include mutations, not only valid declarations. Acceptance
in one column does not mean the definition is valid or supported by every
entrypoint.

| Family | Cases | Schema accepts | Schedule accepts | Reference accepts | SQL accepts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reference advertising revenue | 18 | 12 | 12 | 0 | 15 |
| Historical cohort | 138 | 56 | 92 | 79 | 79 |
| Selected acquisition | 66 | 22 | 33 | 33 | 33 |
| Disjoint cost | 36 | 10 | 12 | 16 | 16 |
| Selected commerce | 72 | 12 | 24 | 24 | 24 |
| Refund reversal | 72 | 12 | 24 | 12 | 12 |
| Acquisition detail | 126 | 30 | 30 | 30 | 30 |
| Custom conversion | 12 | 2 | 2 | 2 | 2 |
| First-party engagement | 12 | 2 | 2 | 2 | 2 |
| Daily events | 24 | 12 | 16 | 18 | 18 |
| Apple aggregates | 24 | 8 | 16 | 16 | 16 |

The probe admits definitions without calculating values or querying PostgreSQL.
It supplies an unrelated schedule evaluation to isolate definition admission
from schedule-specific rules. Reference advertising definitions deliberately
collide with the reference evaluator's built-in names; that public entrypoint
rejects duplicates, while SQL replaces definitions by name. This is not a
failure of the advertising calculation.

Legacy operation admission is broader than closed opt-in profiles. Some shape
or profile mutations therefore differ between schema, schedule and evaluation
checks. Preserve those differences during structural movement; do not silently
claim that legacy admission constitutes schema validation or registered bundle
support. Unknown calculations or identifiers are not new supported profiles.
Changing an existing entrypoint's acceptance requires a separate behavior change
and corresponding evidence, not an updated baseline hash to conceal it.

## Required evidence for a structural change

Run the lightweight boundary table, existing schedule tests and type checking,
then the contract gate and SQL metric parity. Keep contract, registry, spec and
reviewed fixture files unchanged. A public metadata import must remain free of
schema compilation, filesystem, database and network IO. Rendering consumes
metadata only; it must not decide calculation eligibility.

## Editing a profile

- `packages/contracts/src/m1b-metric-definitions.ts` and
  `m3-metric-definitions.ts` retain the existing declaration factories.
  `rule-bundle-provenance.ts` owns registered bundle identities and hashes.
- `metric-profiles.ts` derives identity metadata and named-series tables from
  those declarations. Purchase and total-revenue horizons therefore do not need
  another name/day table in the evaluators. Metadata resolves the bundle triple,
  not the metric definition version: the two versions are independent.
  Admission modes describe existing operation, manual-profile, named-series and
  schema-profile guards; none is a blanket claim that every calculator supports
  every shape allowed by the schema.
- `metric-profile-validation.ts` owns the shared schedule admission guard and
  the reference/SQL series guard. The public `@openmasu/contracts/validation`
  entrypoint also exposes the existing compiled schema validators. API lag,
  date, identity, discovery and schedule-name uniqueness stay in the API.
- Validated schedule input uses `ScheduledMetricDefinition`, a bounded shape
  with unknown optional values. It intentionally does not pretend legacy input
  passed the closed schema. Schema validation separately narrows to the generated
  `OpenMasuMetricDefinitionV04` type. New shared modules do not introduce `any`.
- Dashboard schedule presentation consumes `metricProfileMetadata`. An unknown
  bundle triple is explicitly unregistered, not silently assigned a default.
  Historical Apple aggregate fixtures use external declaration identities and
  remain supported by the named-series guard; they are not registered non-fraud
  bundle metadata. Do not invent a registered identity for them in a refactor.

`metric_profile_schema_consistency` covers all 100 unchanged declarations,
all registered metadata entries, legacy/external identities and malformed or
unregistered closed opt-ins. The legacy operation path can admit an unregistered
syntactically valid bundle, as before. Tightening it globally is a compatibility
change, not part of structural movement. Missing ratio fields in that broad
legacy path are likewise not repaired by this refactor; the persisted evidence
assembly retains its existing required-ratio assumption without inventing a scale.
