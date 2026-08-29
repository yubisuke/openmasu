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

Use `schemas/`, `registries/`, `fixtures/v0.4/`, and
`spec/event-metric-contract-v0.4.md` together. This migration document explains
compatibility; it is not a substitute for active validation.
