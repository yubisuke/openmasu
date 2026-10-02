# Contract v0.4 Migration

Contract v0.4.0 completed the identity migration from the immutable
`contract-v0.3.6` tag to the OpenMasu namespace. The migration changed public
contract identity but did not change field meaning, attribution behavior, metric
arithmetic, ordering, hashing, privacy, or fraud semantics.

## Complete-set migration

Consumers must move the complete contract set together:

| v0.3.6 surface | v0.4.0 surface |
| --- | --- |
| schema suffix `:v0.3` | schema suffix `:v0.4` |
| namespace `urn:open-mmp:schema:` | namespace `urn:openmasu:schema:` |
| contract-owned `0.3.0` values | contract-owned `0.4.0` values |
| `registries/*-v0.3.json` | `registries/*-v0.4.json` |
| `fixtures/v0.3/` | `fixtures/v0.4/` |
| v0.3 specification | `spec/event-metric-contract-v0.4.md` |
| generated `V03` types | generated `V04` types |

Metric-definition versions, rule-bundle versions, policy versions, producer
versions, and other independently governed values did not advance unless their
literal identity contained the former project name.

## Schema identifier rule

Every schema maps mechanically:

```text
urn:open-mmp:schema:<artifact>:v0.3
urn:openmasu:schema:<artifact>:v0.4
```

This applies to common, raw-record, delivery, logical-event, correction,
privacy, attribution, fraud, rejection, reconciliation, cost, metric,
fixture-input, and every event schema. The complete exact list can be recovered
from the tagged schemas and verified against the active tree.

## Mechanical proof

Run:

```bash
npm run verify:contract-rename
```

The verifier reads the immutable tag with `git cat-file`, compares every current
JSON artifact structurally, and rejects any change outside the closed identity
mapping. Its accepted migration classified:

- 27 schemas;
- 8 registry path moves;
- 47 fixture inputs and 611 reviewed golden files;
- contract SemVer, schema URN/title, path, and name-derived changes;
- zero semantic differences.

Conversion-schema resources embedded in Swift and Unity were required to remain
byte-identical. Fixture 45 contained the only name-derived digest updates. No
attribution status, candidate, window, join, metric value, money value, snapshot,
grouping, privacy state, or fraud meaning changed.

## Additive v0.4 patch ledger

| Patch | Additive surface | First fixture |
| --- | --- | ---: |
| 0.4.1 | source-scoped fraud decisions and public categories | 48 |
| 0.4.2 | fraud-exclusion attribution provenance | 49 |
| 0.4.3 | gross/net metric fraud policy | 50 |
| 0.4.4 | Play referrer click-time availability | 51 |
| 0.4.5 | source-rate and client classifications | 52 |
| 0.4.6 | registered fraud-bundle binding and CTIT clock diagnostic | 53 |
| 0.4.7 | deep-link event and engagement attribution | 54 |
| 0.4.8 | installation-anchored purchase/refund net revenue | 55 |
| 0.4.9 | D30/D90 purchase-net and total-net metrics | 56 |
| 0.4.10 | AdAttributionKit re-engagement and current conversion targeting | 57 |
| 0.4.11 | selected first-party acquisition grouping, explicit metric/rule identity, attribution-bound snapshots | 58 |

These patches leave active schema IDs on the v0.4 minor line. Each new vocabulary
or definition is exercised by synthetic evidence. Earlier goldens remain
byte-identical except for the documented fraud-bundle binding correction, which
replaced placeholder or partial hashes in seven fraud-decision files with the
registered composite definition.

Patch 0.4.10 adds the `re-engagement` value to the AdAttributionKit postback
enum with conditional click-only and winner-only constraints. It also adds the
closed `aak_attributed_reengagements` definition so the existing
`aak_attributed_installs` series remains limited to `download` and
`redownload`. The database fact projection adds a nullable, non-identifying
`conversion_type` column; NULL is retained only for pre-patch rows that could
not have been re-engagement postbacks. Fixture 57 adds 13 reviewed golden files.
Fixtures 1 through 56 and their goldens remain byte-identical.

## Current source of truth

Patch 0.4.11 adds optional `acquisition_basis=selected_first_party_click` to
metric definitions. Absence preserves recorded-dimension grouping exactly.
The new `metric-selected-acquisition` bundle and definitions use independent
version `0.4.11`; no existing definition or stored run is reinterpreted. The
wire contract remains `0.4.0` and all schema URNs remain `v0.4`. No event field,
SDK claim, stored install fact, attribution authority, or Apple aggregate
semantics changes. Selected acquisition is currently supported for installation
count, advertising-revenue ROAS/LTV, and retention; purchase-net and total-net
definitions retain their prior meaning.

Fixture `58-selected-native-acquisition` adds `input.json` and all 13
`expected_*.json` artifact classes. There are **no changed pre-existing golden
files**. Compare `git diff --name-status 164ead2 -- fixtures/v0.4/` to confirm
only fixture 58 and its README derivation were added/updated. The three new run
values are independently derived as one accepted installation, USD 20 / 1 =
USD 20 LTV, and USD 20 / USD 10 = 2 ROAS. Attribution/record provenance and
digest construction are documented in `fixtures/v0.4/README.md`.

Use `schemas/`, `registries/`, `fixtures/v0.4/`, and
`spec/event-metric-contract-v0.4.md` together. This migration document explains
compatibility; it is not a substitute for active validation.

## Optional disjoint-cost selection (0.4.12)

Optional metric-definition `cost_selection_policy=reject_overlapping_grains`
uses independent `metric-disjoint-cost` version `0.4.12`. It adds
`overlapping_cost_grains` to the undefined-reason enum and an additive database
constraint migration. The database revision uniqueness key also gains
`cost_date`: historical dimension digests omit date, so equal-grain rows for
different acquisition dates at one `as_of` must coexist. The same dated cell
and `as_of` remain unique. This relaxes admission without rewriting existing
rows or changing historical replay selection. All schema URNs and wire/package
versions stay unchanged.
No existing definition, cost digest, raw record, or saved metric changes meaning.
Historical definitions without the policy retain their previous selection.

Fixture `59-disjoint-cost-grains` is the complete golden change inventory:
one new input and 13 new `expected_*.json` files. No pre-existing golden changes.
Use `git diff --name-status 703ae43 -- fixtures/v0.4/` to verify this inventory;
only fixture 59 and the shared README should differ. The README gives the
seven hand-calculated runs and independent snapshot derivation. Runtime SQL
uses the same selected costs for arithmetic, evidence and replay, while the
independent Python implementation exercises the contract selection separately.

## Selected acquisition commerce (0.4.13)

The additional `metric-selected-commerce` independent definition version 0.4.13
extends the already optional acquisition basis to existing purchase-net and
total-net series. Its ROAS definitions require explicit disjoint-cost selection.
This is a non-breaking supported-definition extension: no new event or output
field, database migration, dependency, schema URN, or wire/package version.
Historical definitions and previously stored runs retain their exact meaning.

The complete new golden inventory is `60-selected-commerce/input.json` and its
13 `expected_*.json` files. The shared fixture README records every artifact
family's derivation, the four values and independently calculated snapshot hash.
`git diff --name-status d985c7a -- fixtures/v0.4/` must show only fixture 60 and
that README; no prior fixture or golden may change. Candidate TS/Python bytes
were compared without writing either evaluator's output into golden files.

## Explicit custom-event conversion (0.4.14)

Optional `conversion_event_key`, the `converted_installations` numerator and
the `converted_installations` / `converted_installations_over_cohort`
calculations are tied to independent `metric-custom-conversion` version 0.4.14.
The full new profile requires the key, selected acquisition, UTC and elapsed D7;
existing profiles cannot silently ignore a key. This is additive optional
vocabulary with conditional requirements only on new profiles. All existing
schema URNs, artifact/package versions, definitions and saved runs are unchanged.
No registry, database migration, dependency or SDK version changes.

Complete golden inventory: new `61-custom-conversion/input.json` and thirteen
new `expected_*.json` files. No existing input or golden is modified.
`git diff --name-status b5231b9 -- fixtures/v0.4/` must list only the fixture-61
files and shared README. The README records the independent 3/10 arithmetic,
each artifact family's construction, grouping and input snapshot digests.
Candidate TS/Python output was compared before the independently constructed
expected files were promoted in a commit separate from behavior changes.
Runtime SQL additionally covers boundary, duplicate, late, privacy, native
selected-campaign and gross/net inputs, and saves the key in replay/comparison
context. Earlier tagged release evidence is not reissued by this source patch.

## Explicit targeted refund cancellation (0.4.15)

Optional refund-event `reverses_refund_record_id` is valid only for an
installation-anchored reversed refund. Its existing purchase correction target
keeps its meaning. Admission requires an earlier settled refund in the same
scope, purchase, installation, original transaction and currency with equal
money. Invalid targets retain the existing `refund_target_invalid` rejection.
Unlinked reversed refunds preserve their historical admission and metric meaning.

Optional metric-definition `refund_reversal_policy` is tied to independent
`metric-refund-reversal` version `0.4.15`. Only explicitly selected definitions
cancel their target refund's original contribution at the input watermark.
Old definitions, saved runs, schema URNs and wire/package versions are unchanged.
This is additive conditional behavior; no registry, dependency or database
migration is introduced. The existing protected refund-fact artifact carries
the optional link; normalized money and purchase-reference columns are unchanged.
Saved explanation version 3 and comparison context retain the policy and the
separate deduction/cancellation operands. Old evidence versions remain readable.

Complete golden change inventory: new `62-explicit-refund-reversal/input.json`
and all thirteen new `expected_*.json` files; the shared fixture README records
their independent derivation. **No pre-existing input or golden changes.**
Use `git diff --name-status b7984b0 -- fixtures/v0.4/` to confirm only fixture 62
and that README differ. The three snapshots independently calculate purchase
net 10 / 6 / 10, total net and LTV 30 / 26 / 30, and ROAS 3 / 2.6 / 3.
Each payload and snapshot digest was constructed from the specified canonical
inputs, then compared to both evaluators before promotion. The new expected
files are committed separately from behavior changes. Synthetic cases also
cover duplicate claims, unrelated partial refunds, invalid or out-of-order
targets, different scales, window boundaries and deletion of each linked record.
