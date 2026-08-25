# Contract v0.4 Migration Guide

Contract v0.4.0 is a planned, in-place identity migration from the immutable `contract-v0.3.6` tag at commit `d79bc49ea8f017e30a5bc61bcf38b301645548ed`. It changes the project and public contract namespace to OpenMasu. It does not change artifact shape, field meaning, attribution behavior, metric arithmetic, ordering, hashing rules, privacy semantics, or public fraud semantics.

Consumers must move the complete contract set together:

| v0.3.6 surface | v0.4.0 surface | Rule |
| --- | --- | --- |
| Schema minor suffix `:v0.3` | `:v0.4` | Namespace identity only |
| Contract-owned `0.3.0` values | `0.4.0` | Applies to `contract_version`, event `schema_version`, `reason_code_version`, and `difference_reason_version` |
| `registries/*-v0.3.json` | `registries/*-v0.4.json` | Registry values and order are unchanged |
| `fixtures/v0.3/` | `fixtures/v0.4/` | All 47 synthetic inputs and 611 reviewed goldens move as one set |
| `spec/event-metric-contract-v0.3.md` | `spec/event-metric-contract-v0.4.md` | The active normative specification follows the namespace |
| Generated `V03` public types | Generated `V04` public types | Type names follow the active schema titles |

Metric-definition versions, rule-bundle versions, policy versions, producer versions, wrapper versions, and other independently governed identifiers do not advance merely because the contract namespace changes. Their unchanged values are part of the mechanical proof.

## Complete schema identifier map

| v0.3.6 identifier | v0.4.0 identifier |
| --- | --- |
| `urn:open-mmp:schema:attribution-result:v0.3` | `urn:openmasu:schema:attribution-result:v0.4` |
| `urn:open-mmp:schema:common:v0.3` | `urn:openmasu:schema:common:v0.4` |
| `urn:open-mmp:schema:correction:v0.3` | `urn:openmasu:schema:correction:v0.4` |
| `urn:open-mmp:schema:cost-record:v0.3` | `urn:openmasu:schema:cost-record:v0.4` |
| `urn:open-mmp:schema:event-delivery:v0.3` | `urn:openmasu:schema:event-delivery:v0.4` |
| `urn:open-mmp:schema:event-ad-impression:v0.3` | `urn:openmasu:schema:event-ad-impression:v0.4` |
| `urn:open-mmp:schema:event-ad-revenue:v0.3` | `urn:openmasu:schema:event-ad-revenue:v0.4` |
| `urn:open-mmp:schema:event-ad-view:v0.3` | `urn:openmasu:schema:event-ad-view:v0.4` |
| `urn:open-mmp:schema:event-adattributionkit-postback:v0.3` | `urn:openmasu:schema:event-adattributionkit-postback:v0.4` |
| `urn:open-mmp:schema:event-click:v0.3` | `urn:openmasu:schema:event-click:v0.4` |
| `urn:open-mmp:schema:event-consent-changed:v0.3` | `urn:openmasu:schema:event-consent-changed:v0.4` |
| `urn:open-mmp:schema:event-custom-event:v0.3` | `urn:openmasu:schema:event-custom-event:v0.4` |
| `urn:open-mmp:schema:event-install:v0.3` | `urn:openmasu:schema:event-install:v0.4` |
| `urn:open-mmp:schema:event-purchase:v0.3` | `urn:openmasu:schema:event-purchase:v0.4` |
| `urn:open-mmp:schema:event-refund:v0.3` | `urn:openmasu:schema:event-refund:v0.4` |
| `urn:open-mmp:schema:event-session-start:v0.3` | `urn:openmasu:schema:event-session-start:v0.4` |
| `urn:open-mmp:schema:event-skan-postback:v0.3` | `urn:openmasu:schema:event-skan-postback:v0.4` |
| `urn:open-mmp:schema:fixture-input:v0.3` | `urn:openmasu:schema:fixture-input:v0.4` |
| `urn:open-mmp:schema:fraud-decision:v0.3` | `urn:openmasu:schema:fraud-decision:v0.4` |
| `urn:open-mmp:schema:logical-event:v0.3` | `urn:openmasu:schema:logical-event:v0.4` |
| `urn:open-mmp:schema:metric-definition:v0.3` | `urn:openmasu:schema:metric-definition:v0.4` |
| `urn:open-mmp:schema:metric-run:v0.3` | `urn:openmasu:schema:metric-run:v0.4` |
| `urn:open-mmp:schema:privacy-request:v0.3` | `urn:openmasu:schema:privacy-request:v0.4` |
| `urn:open-mmp:schema:privacy-tombstone:v0.3` | `urn:openmasu:schema:privacy-tombstone:v0.4` |
| `urn:open-mmp:schema:raw-record:v0.3` | `urn:openmasu:schema:raw-record:v0.4` |
| `urn:open-mmp:schema:reconciliation-result:v0.3` | `urn:openmasu:schema:reconciliation-result:v0.4` |
| `urn:open-mmp:schema:rejection:v0.3` | `urn:openmasu:schema:rejection:v0.4` |

## Mechanical proof and golden ledger

Run `npm run verify:contract-rename`. The verifier reads the immutable tag through `git cat-file`, compares every current JSON artifact structurally, and rejects any field, value, array order, or independent version change outside the closed identity mapping. It also verifies that the Swift and Unity conversion-schema resources are byte-identical and that fixture 45 carries their exact byte digest.

The reviewed result is:

```text
Contract v0.4 rename proof: contract-v0.3.6 (d79bc49ea8f017e30a5bc61bcf38b301645548ed)
Schemas: 27; SCHEMA_URN=31, CONTRACT_SEMVER=19, SCHEMA_TITLE=27, NAME_DERIVED=1; SEMANTIC_DIFF=0
Registries: 8; PATH_RENAME=8; CONTRACT_SEMVER=8; SEMANTIC_DIFF=0
Fixtures: 47 inputs=47 goldens=611 files=659
Fixture diff classification: PATH_RENAME=659; CONTRACT_SEMVER=820; NAME_DERIVED=3; DERIVED_DIGEST=3; SEMANTIC_DIFF=0
```

Every fixture file moves to the v0.4 path. JSON content changes are exhaustive by artifact class:

| JSON artifact | Changed files | Changed leaves | Identity reason |
| --- | ---: | ---: | --- |
| `input.json` | 47 | 288 | Contract/schema versions; three fixture-45 name-derived values and one derived resource digest |
| `expected_raw_records.json` | 43 | 208 | Contract/schema versions; two fixture-45 payload digests derived from renamed input strings |
| `expected_deliveries.json` | 47 | 116 | Contract versions |
| `expected_logical_events.json` | 43 | 102 | Contract versions |
| `expected_corrections.json` | 4 | 6 | Contract versions |
| `expected_privacy_requests.json` | 3 | 4 | Contract versions |
| `expected_privacy_tombstones.json` | 3 | 4 | Contract versions |
| `expected_attributions.json` | 32 | 61 | Reason-code versions |
| `expected_cost_records.json` | 1 | 2 | Contract versions |
| `expected_fraud_decisions.json` | 3 | 3 | Reason-code versions |
| `expected_rejections.json` | 8 | 16 | Contract and reason-code versions |
| `expected_reconciliation.json` | 13 | 16 | Difference-reason versions |
| `expected_metric_definitions.json` | 0 | 0 | Path-only move; independent metric/rule versions remain unchanged |
| `expected_metric_runs.json` | 0 | 0 | Path-only move; values, snapshots, and independent versions remain unchanged |

Fixture 45 has the only derived digest changes:

| Evidence | v0.4.0 digest |
| --- | --- |
| Bundled conversion-schema bytes | `593b3db37b01680452064eacbc32c135832c977933c2a8ac7437fd9d2a50b4ed` |
| Install payload JCS | `3165088f0016e2d7745abfce00a76707c9fb812540dd6e999455e551a3079574` |
| Conversion-update payload JCS | `b702b0728fbe7d6bf6155c711c515457c27c03e08a9fdd535cb657ed4bf98cba` |

No attribution status, reason meaning, candidate set, window, join, metric value, money value, snapshot digest, grouping digest, evidence reference, privacy state, or fraud decision changes. `SEMANTIC_DIFF=0` is a hard failure condition, not a descriptive claim.
