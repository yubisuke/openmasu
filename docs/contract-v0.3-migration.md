# Contract v0.3 Migration Guide

Contract v0.3 is an in-place migration from the immutable `contract-v0.2.1` Git tag. It is not wire-compatible with v0.2.1. Consumers must select one complete contract version and must not mix v0.2 schemas, registries, fixtures, evaluator behavior, or golden outputs with v0.3 artifacts.

## Version and path migration

| v0.2.1 | v0.3.0 | Reason |
| --- | --- | --- |
| Schema `$id` suffix `:v0.2` | `:v0.3` | WO-5.5 changes closed attribution, event, fraud, and metric semantics. |
| Contract and event schema versions `0.2.0` or patch result versions `0.2.1` | `0.3.0` | One exact SemVer identifies the complete v0.3 contract set. |
| `registries/*-v0.2.json` | `registries/*-v0.3.json` | Registry values and compatibility rules are versioned with the minor line. |
| `fixtures/v0.2/` | `fixtures/v0.3/` | Reviewed inputs and golden outputs are a versioned set. |
| `spec/event-metric-contract-v0.2.md` | `spec/event-metric-contract-v0.3.md` | The normative specification follows the active minor line. |

The `contract-v0.2.1` tag points to the pre-migration `main` commit. Versioning rules are defined in [schema-versioning.md](schema-versioning.md).

## Version-only golden migration

The base in-place move preserves each v0.2.1 scenario and meaningful value. Empty golden arrays change path only. Non-empty artifacts change only the version fields applicable to their artifact class before the semantic changes listed below:

- `contract_version`, event `schema_version`, attribution/rejection/fraud `reason_code_version`, reconciliation `difference_reason_version`, metric `metric_definition_version`, and the fixture metric `rule_bundle_version` advance to `0.3.0`;
- derived identifiers, payload digests, snapshot digests, metric values, evidence references, and policy versions do not change solely because of the minor-line move;
- every semantic or digest change beyond these version fields is listed by fixture and file in the completed golden ledger below.

## Contract field migration

| Handoff | v0.3 contract change | Exercised by |
| --- | --- | --- |
| H-1 | `install.meta_referrer_context` adds typed campaign/account/objective/platform identifiers and classifications; outer `is_ct` and `actual_timestamp` preserve documented source evidence. Free-form `*_name` fields remain excluded. | Fixture 34. |
| H-2 | `referrer_status=third_party` plus `third_party_referrer_classification=play_organic_marker | foreign` separates a deployment-confirmed organic marker from unresolved foreign evidence. | Fixtures 02 and 39. |
| H-3 | Adds the closed `custom_event` envelope with a catalog-shaped key, optional money, and bounded typed scalar attributes. | Fixture 40. |
| H-4 | Replaces the former three-state Meta status with six explicit coverage/decryption states. Only `decrypted` creates Meta attribution. | Fixture 34. |
| H-5 | Adds evidence-only `referrer_client_response`; Android-documented response states plus the defensive `permission_error` value do not decide attribution. | Validator response-matrix mutation over fixture 13. |
| H-6 | Adds public `click_injection_suspected`; CTIT is computed only from canonical `redirector_click_at` (the work-order's `referrer_click_at_server`) and `install_begin_at_server`, with the threshold policy in server context. | Fixture 41 and the 9.999/10.000-second mutation. |
| H-7 | Adds optional `install_origin=play_first_launch | identifier_reset`; omission means first Play launch and does not change attribution. | Fixture 10 and validator mutations. |
| H-8 | Raw records add separate optional `producer_variant` and `wrapper_version`; `producer_version` remains the core version. | Fixture 40. |
| H-9 | A decrypted Meta referrer takes precedence over a simultaneously resolvable first-party click; the first-party evidence remains protected and unselected. | Fixture 34. |
| H-10 | Ad revenue adds optional `revenue_precision=exact | estimated | publisher_defined | undefined` without changing money arithmetic. | Fixture 27 and enum mutations. |
| H-11 | `candidate_missing` means a provider attribution reference lacks the expected first-party record; `external_row_unmatched` means an external row has no internal candidate under any matching key. | Fixture 03. |
| H-12 | Metric definition and run grouping add closed `attribution_status=organic | non_organic | unattributed`; organic and unattributed cohorts cannot inherit paid cost. | Fixture 33. |
| F11 | Imported attribution strategy adds `self_attributed_network` without converting provider judgment into first-party evidence. | Fixture 28 validator coverage. |
| F12 | A uniquely resolved `provider_click_ref` adds the matching first-party redirector click to imported-attribution evidence. | Fixture 28. |

The public schema uses the canonical matching-key name `provider_click_id`; the imported payload field remains `provider_click_ref`. This preserves the established v0.2 key vocabulary while distinguishing the protected source reference from its namespaced digest.

## Existing golden-output ledger

All 38 inherited fixtures move from `fixtures/v0.2/<fixture>/` to `fixtures/v0.3/<fixture>/`. Empty arrays are path-only moves. Every inherited `input.json` advances its contract and event schema versions to `0.3.0`. For non-empty golden files, these artifact-wide version fields advance and no other value changes unless the file appears in the semantic table below:

| Golden class | Version-only fields |
| --- | --- |
| `expected_raw_records.json` | `contract_version`, `schema_version` |
| `expected_deliveries.json`, `expected_logical_events.json`, `expected_corrections.json`, `expected_privacy_requests.json`, `expected_privacy_tombstones.json`, `expected_cost_records.json` | `contract_version` where the artifact defines it |
| `expected_attributions.json`, `expected_fraud_decisions.json`, `expected_rejections.json` | `reason_code_version`, `rule_bundle_version` where present |
| `expected_metric_definitions.json` | `metric_definition_version`, `rule_bundle_version` |
| `expected_metric_runs.json` | `metric_definition_version`, `rule_bundle_version` and embedded contract-owned version references where present |
| `expected_reconciliation.json` | `difference_reason_version` |

The following table is exhaustive for inherited golden changes beyond those path and version updates:

| Fixture | Golden file | Changed fields or rows | Reason |
| --- | --- | --- | --- |
| 02 | `expected_attributions.json` | `reason_code: no_referrer -> no_first_party_referrer` | The normalized third-party Play organic marker is explicit rather than inferred from an empty first-party referrer. |
| 02 | `expected_raw_records.json` | `payload_sha256` | The install payload adds `referrer_status=third_party` and `third_party_referrer_classification=play_organic_marker`. |
| 03 | `expected_reconciliation.json` | Existing row becomes `candidate_missing`; adds a second `external_row_unmatched` row and its matching key | H-11 makes the two neutral failure meanings independently testable. |
| 27 | `expected_raw_records.json` | Revenue `payload_sha256` | The ad-revenue payload adds `revenue_precision=exact`; the amount and metric outputs are unchanged. |
| 28 | `expected_attributions.json` | Adds the resolved `import-click-28` evidence reference | F12 requires imported attribution to retain a uniquely matched first-party click. |
| 28 | `expected_logical_events.json` | Click producer becomes `redirector`; logical ID and ordering follow that producer | The synthetic click is now first-party redirector evidence rather than an imported click row. |
| 28 | `expected_raw_records.json` | Click producer/time source/payload digest; imported install payload digest | Adds first-party `remote_click_ref` evidence and `self_attributed_network` strategy while preserving the provider-reported attribution. |
| 33 | `expected_attributions.json` | Adds the organic installation attribution | H-12 needs an independently grouped organic cohort. |
| 33 | `expected_deliveries.json` | Adds the organic install delivery | New accepted synthetic source row. |
| 33 | `expected_logical_events.json` | Adds the organic install logical event | New accepted synthetic source row. |
| 33 | `expected_metric_definitions.json` | Adds `attribution_status` grouping to the applicable ROAS definition | Contract grouping must declare the emitted cohort dimension. |
| 33 | `expected_metric_runs.json` | Non-organic rows add grouping/dimension digests; adds organic undefined ROAS with `no_attributed_cost`; affected snapshots/evidence and supersession IDs change | Organic and paid cohorts are separated without representing undefined ROAS as zero or infinity. Existing non-organic metric values remain unchanged. |
| 33 | `expected_raw_records.json` | Adds the organic install row; affected payload digests include the v0.3 SDK version and normalized attribution evidence | New source row and changed normative payload inputs. |
| 33 | `expected_reconciliation.json` | Candidate/reason output follows the v0.3 distinction and versioned imported evidence | H-11 reconciliation semantics are applied consistently. |
| 34 | `expected_attributions.json` | Adds first-party-evidence precedence coverage plus provider-unavailable, version-unsupported, and auth-failure outcomes; former absent status becomes `no_campaign_data` | H-4 and H-9 expose Meta coverage and deterministic precedence. |
| 34 | `expected_deliveries.json` | Adds deliveries for the new synthetic first-party click and Meta status branches | New accepted synthetic source rows. |
| 34 | `expected_logical_events.json` | Adds logical events for the new synthetic first-party click and Meta status branches | New accepted synthetic source rows. |
| 34 | `expected_raw_records.json` | Adds the new records; Meta click/view payload digests change for typed context, `is_ct`, and `actual_timestamp` | H-1 typed evidence and H-4 coverage states alter normative payloads. |

The inherited input files with semantic changes are exactly fixtures 02, 03, 27, 28, 33, and 34. All other inherited input changes are version-only. No inherited golden outside the table changes meaning.

## New fixture and golden ledger

Every new fixture uses synthetic values and includes one input plus all 13 reviewed expected-output classes. Empty arrays are deliberate reviewed results.

| Fixture | Meaningful derived output | Derivation |
| --- | --- | --- |
| 39 `foreign-referrer-unresolved` | `unattributed/foreign_referrer_unresolved` | A third-party referrer classified as foreign has neither a first-party click ID nor a deployment-confirmed Play organic marker. |
| 40 `custom-event-wrapper` | One accepted raw and logical `custom_event` | The closed payload has a synthetic event key, optional USD money, four bounded scalar attributes, and separate Unity wrapper provenance; it creates no attribution or metric. |
| 41 `click-injection-suspected` | One paid attribution plus one public fraud decision | Server CTIT is `9.999` seconds, strictly below the synthetic 10-second policy threshold. Exactly 10 seconds is covered by a negative mutation and emits no suspicion. |

The authoritative derivation details for fixtures 39-43 are also recorded in `fixtures/v0.3/README.md`. No fixture is generated by the validator.

## v0.3.1 patch ledger (R-27)

The active package advances from `0.3.0` to `0.3.1`. Schema `$id` values and registry filenames retain the `v0.3` minor identity. Existing event contract/schema versions and all 533 pre-existing golden files remain byte-for-byte unchanged.

| Surface | v0.3.1 change | Compatibility |
| --- | --- | --- |
| Metric definition, metric run, fixture evaluation | Adds optional `metric_date` to the closed grouping vocabulary | Additive; existing grouping objects retain their meaning. |
| Metric definition | Adds `event_count`, `events`, and optional `event_names`; new event-count definitions require calendar-day/count semantics and a non-empty event set | Enum and optional-field expansion used only by new definitions. |
| Spec | Aggregate attribution method is displayed as rule-bundle identity plus `attribution_status` breakdown | Clarifies existing artifact semantics; no schema field is added. |

Fixture 42 adds one synthetic input plus the following 13 human-reviewed golden artifacts. It changes no existing golden:

| Golden artifact | Derivation |
| --- | --- |
| `42-daily-metric-date/expected_raw_records.json` | Two accepted source records with JCS payload digests. |
| `42-daily-metric-date/expected_deliveries.json` | Two unique, on-time protected deliveries. |
| `42-daily-metric-date/expected_logical_events.json` | One click and one install logical event. |
| `42-daily-metric-date/expected_corrections.json` | Empty; no correction input exists. |
| `42-daily-metric-date/expected_privacy_requests.json` | Empty; no privacy request exists. |
| `42-daily-metric-date/expected_privacy_tombstones.json` | Empty; no lifecycle transition exists. |
| `42-daily-metric-date/expected_attributions.json` | The install is organic from the explicit third-party Play organic marker. |
| `42-daily-metric-date/expected_cost_records.json` | Empty; daily counts consume no cost. |
| `42-daily-metric-date/expected_metric_definitions.json` | Three preserved base definitions plus the two v0.3.1 daily event-count definitions. |
| `42-daily-metric-date/expected_metric_runs.json` | One click and one organic install on `2026-08-20` UTC; both values are `1`, with reviewed dimension and snapshot digests. |
| `42-daily-metric-date/expected_fraud_decisions.json` | Empty; no public fraud category applies. |
| `42-daily-metric-date/expected_rejections.json` | Empty; both records conform. |
| `42-daily-metric-date/expected_reconciliation.json` | Empty; no external import row exists. |

## v0.3.2 patch ledger (R-27)

The active package advances from `0.3.1` to `0.3.2`. Schema `$id` values and registry filenames retain the `v0.3` minor identity. Existing event contract/schema versions and all 546 pre-existing golden files remain byte-for-byte unchanged.

| Surface | v0.3.2 change | Compatibility |
| --- | --- | --- |
| Install event | Adds optional `install_origin=ios_first_launch`, `referrer_status=not_applicable`, and AdServices statuses `not_attributed` / `lookup_unavailable` | Additive enum expansion; existing Android and Apple inputs retain their meaning. |
| Attribution result and reason registry | Adds `platform_referrer_not_available`, `adservices_not_attributed`, and `adservices_lookup_unavailable` | Additive closed-vocabulary expansion exercised by fixture 43. |
| AdAttributionKit postback | Adds optional `signing_key_environment=production | development` | Optional evidence field; existing postbacks remain valid. |
| SKAdNetwork postback | Accepts later minor versions in supported majors 3 and 4 | Validation correction for the already documented major-version boundary; v1, v2, and unknown future majors remain rejected. |

Fixture 43 adds one synthetic input plus the following 13 human-reviewed golden artifacts. It changes no existing golden:

| Golden artifact | Derivation |
| --- | --- |
| `43-m4-ios-contract-handoffs/expected_raw_records.json` | Four accepted source records with independently checked JCS payload digests. |
| `43-m4-ios-contract-handoffs/expected_deliveries.json` | Four unique, on-time protected deliveries. |
| `43-m4-ios-contract-handoffs/expected_logical_events.json` | Two installation events and two aggregate Apple-postback events. |
| `43-m4-ios-contract-handoffs/expected_corrections.json` | Empty; no correction input exists. |
| `43-m4-ios-contract-handoffs/expected_privacy_requests.json` | Empty; no privacy request exists. |
| `43-m4-ios-contract-handoffs/expected_privacy_tombstones.json` | Empty; no lifecycle transition exists. |
| `43-m4-ios-contract-handoffs/expected_attributions.json` | Two distinct neutral AdServices outcomes plus one verified AAK and one verified SKAN aggregate outcome. |
| `43-m4-ios-contract-handoffs/expected_cost_records.json` | Empty; no cost input exists. |
| `43-m4-ios-contract-handoffs/expected_metric_definitions.json` | The three unchanged base metric definitions. |
| `43-m4-ios-contract-handoffs/expected_metric_runs.json` | Empty; no metric evaluation exists. |
| `43-m4-ios-contract-handoffs/expected_fraud_decisions.json` | Empty; no public fraud category applies. |
| `43-m4-ios-contract-handoffs/expected_rejections.json` | Empty; every synthetic record conforms. |
| `43-m4-ios-contract-handoffs/expected_reconciliation.json` | Empty; no external import row exists. |

## v0.3.3 patch ledger (R-27)

The active package advances from `0.3.2` to `0.3.3`. Schema `$id` values, registry filenames, and event `contract_version` / `schema_version` constants retain the `v0.3` identity. All 559 pre-existing golden files remain byte-for-byte unchanged.

| Surface | v0.3.3 change | Compatibility |
| --- | --- | --- |
| Metric definition | Extends `event_count.event_names` with `skan_postback` and `adattributionkit_postback`; binds the three new aggregate metric names to their event, UTC receipt date, and closed grouping shape | Additive definitions only; existing click/install definitions retain their `occurred_at` semantics. |
| Metric definition, metric run, fixture evaluation | Adds optional `apple_conversion_bucket=fine:0..63 | coarse:low | coarse:medium | coarse:high` | Additive grouping field required only by `skan_conversion_value_distribution`; it is forbidden for deterministic and aggregate-count definitions. |
| Reference evaluators | Counts only accepted, deduplicated postbacks whose aggregate attribution is `non_organic`; uses server `received_at` as `metric_date` | New metrics only; existing evaluator outputs are unchanged. |

Fixture 44 adds one synthetic input plus the following 13 human-reviewed golden artifacts. It changes no existing golden:

| Golden artifact | Derivation |
| --- | --- |
| `44-apple-aggregate-metrics/expected_raw_records.json` | Three accepted postbacks with independently checked RFC 8785 payload digests. |
| `44-apple-aggregate-metrics/expected_deliveries.json` | Three unique, on-time protected deliveries. |
| `44-apple-aggregate-metrics/expected_logical_events.json` | Two SKAN events and one AAK event, each retaining aggregate-event separation. |
| `44-apple-aggregate-metrics/expected_corrections.json` | Empty; no correction input exists. |
| `44-apple-aggregate-metrics/expected_privacy_requests.json` | Empty; no privacy request exists. |
| `44-apple-aggregate-metrics/expected_privacy_tombstones.json` | Empty; no lifecycle transition exists. |
| `44-apple-aggregate-metrics/expected_attributions.json` | Three verified, winning, source-bearing aggregate results with conversion evidence. |
| `44-apple-aggregate-metrics/expected_cost_records.json` | Empty; aggregate postback counts do not use advertiser cost. |
| `44-apple-aggregate-metrics/expected_metric_definitions.json` | Three unchanged base definitions plus the three v0.3.3 aggregate definitions. |
| `44-apple-aggregate-metrics/expected_metric_runs.json` | SKAN count `2`, AAK count `1`, fine-21 count `1`, and coarse-low count `1`; grouping and input-snapshot digests are independently checked from RFC 8785 inputs. |
| `44-apple-aggregate-metrics/expected_fraud_decisions.json` | Empty; no public fraud category applies. |
| `44-apple-aggregate-metrics/expected_rejections.json` | Empty; all three synthetic postbacks conform. |
| `44-apple-aggregate-metrics/expected_reconciliation.json` | Empty; no external import row exists. |

## v0.3.4 patch ledger (R-27)

The active package advances from `0.3.3` to `0.3.4`. Schema `$id` values, registry filenames, and event `contract_version` / `schema_version` constants retain the `v0.3` identity. All 572 pre-existing golden files remain byte-for-byte unchanged.

| Surface | v0.3.4 change | Compatibility |
| --- | --- | --- |
| Install event | Makes no schema change; fixture 45 uses the existing `extensions` evidence surface for the deployment-private conversion-schema version and SHA-256 digest | M4-D-20 keeps deployment-private policy metadata out of the typed public event vocabulary. |
| Custom event | Admits the exact reserved key `openmmp.conversion_value_updated` in addition to the existing public-key pattern | Additive lifecycle event used only when conversion-value logging is explicitly enabled; existing custom events retain their meaning. |

Fixture 45 adds one synthetic input plus the following 13 human-reviewed golden artifacts. It changes no existing golden:

| Golden artifact | Derivation |
| --- | --- |
| `45-ios-conversion-schema/expected_raw_records.json` | One iOS first-launch install carrying conversion-policy evidence in `extensions` and one reserved conversion-update event, each with an independently checked RFC 8785 payload digest. |
| `45-ios-conversion-schema/expected_deliveries.json` | Two unique, on-time protected deliveries. |
| `45-ios-conversion-schema/expected_logical_events.json` | One install and one custom event, each retaining SDK-iOS producer provenance. |
| `45-ios-conversion-schema/expected_corrections.json` | Empty; no correction input exists. |
| `45-ios-conversion-schema/expected_privacy_requests.json` | Empty; no privacy request exists. |
| `45-ios-conversion-schema/expected_privacy_tombstones.json` | Empty; no lifecycle transition exists. |
| `45-ios-conversion-schema/expected_attributions.json` | The iOS install remains neutral with `platform_referrer_not_available`; conversion policy does not imply attribution. |
| `45-ios-conversion-schema/expected_cost_records.json` | Empty; no advertiser cost exists. |
| `45-ios-conversion-schema/expected_metric_definitions.json` | The three unchanged base definitions. |
| `45-ios-conversion-schema/expected_metric_runs.json` | Empty; conversion logging does not create a deterministic or aggregate metric run. |
| `45-ios-conversion-schema/expected_fraud_decisions.json` | Empty; no public fraud category applies. |
| `45-ios-conversion-schema/expected_rejections.json` | Empty; both synthetic records conform. |
| `45-ios-conversion-schema/expected_reconciliation.json` | Empty; no external import row exists. |

## v0.3.5 patch ledger (R-27)

The active package advances from `0.3.4` to `0.3.5`. Schema `$id` values, registry filenames, and event `contract_version` / `schema_version` constants retain the `v0.3` identity. All 585 pre-existing golden files remain byte-for-byte unchanged.

| Surface | v0.3.5 change | Compatibility |
| --- | --- | --- |
| Raw record and fixture ingress record | Adds optional, server-assigned `integrity_verdict` with closed platform/verdict vocabulary, evaluated time, policy version, and a protected opaque evidence reference when evidence exists | Additive evidence only; existing artifacts and attribution, fraud, and metric semantics are unchanged. |
| Reference evaluators | Copies the optional evidence envelope into the raw-record artifact without consuming it in any decision | New field only; absence preserves every earlier output. |

Fixture 46 adds one synthetic input plus the following 13 human-reviewed golden artifacts. It changes no existing golden:

| Golden artifact | Derivation |
| --- | --- |
| `46-integrity-verdict-reservation/expected_raw_records.json` | Three accepted records preserve verified and failed Play Integrity evidence plus unavailable App Attest evidence; protected references contain no provider token or device identifier. |
| `46-integrity-verdict-reservation/expected_deliveries.json` | Three unique, on-time protected deliveries. |
| `46-integrity-verdict-reservation/expected_logical_events.json` | Three independent installation logical events. |
| `46-integrity-verdict-reservation/expected_corrections.json` | Empty; no correction input exists. |
| `46-integrity-verdict-reservation/expected_privacy_requests.json` | Empty; no privacy request exists. |
| `46-integrity-verdict-reservation/expected_privacy_tombstones.json` | Empty; no lifecycle transition exists. |
| `46-integrity-verdict-reservation/expected_attributions.json` | The installs remain organic or unattributed solely from their platform-referrer evidence; integrity evidence does not determine attribution. |
| `46-integrity-verdict-reservation/expected_cost_records.json` | Empty; no cost input exists. |
| `46-integrity-verdict-reservation/expected_metric_definitions.json` | The three unchanged base metric definitions. |
| `46-integrity-verdict-reservation/expected_metric_runs.json` | Empty; integrity evidence is not a metric input. |
| `46-integrity-verdict-reservation/expected_fraud_decisions.json` | Empty; integrity evidence is not a public fraud decision by itself. |
| `46-integrity-verdict-reservation/expected_rejections.json` | Empty; every synthetic record conforms. |
| `46-integrity-verdict-reservation/expected_reconciliation.json` | Empty; no external import row exists. |

## v0.3.6 patch ledger (R-27)

The active package advances from `0.3.5` to `0.3.6`. Schema `$id` values, registry filenames, and event `contract_version` / `schema_version` constants retain the `v0.3` identity. All 598 pre-existing golden files remain byte-for-byte unchanged.

| Surface | v0.3.6 change | Compatibility |
| --- | --- | --- |
| Delivery and rejection reasons | Adds `payload_schema_invalid` to both closed reason vocabularies | Additive enum expansion; existing artifacts preserve their values. |
| Fixture ingress | Adds optional `pre_ingestion_rejections`, mutually exclusive with runtime records and aggregate postback records | Additive synthetic proof surface; every existing fixture keeps its original input mode. |
| Runtime import admission | Dispatches each normalized event payload through the same compiled event schema used by the contract gate before raw or logical persistence | Invalid rows now fail closed as discarded, non-identifying rejection evidence. Valid rows are unchanged. |

Fixture 47 adds one synthetic input plus the following 13 human-reviewed golden artifacts. It changes no existing golden:

| Golden artifact | Derivation |
| --- | --- |
| `47-payload-schema-invalid/expected_raw_records.json` | Empty; schema-invalid payloads are never admitted to raw evidence. |
| `47-payload-schema-invalid/expected_deliveries.json` | One rejected delivery retains only scope, record/delivery identifiers, receipt time, consent-policy provenance, and discarded payload disposition. |
| `47-payload-schema-invalid/expected_logical_events.json` | Empty; no logical event is created. |
| `47-payload-schema-invalid/expected_corrections.json` | Empty; no accepted source or correction exists. |
| `47-payload-schema-invalid/expected_privacy_requests.json` | Empty; no privacy request exists. |
| `47-payload-schema-invalid/expected_privacy_tombstones.json` | Empty; no identifiable payload is retained or transitioned. |
| `47-payload-schema-invalid/expected_attributions.json` | Empty; rejected payloads cannot be attribution evidence. |
| `47-payload-schema-invalid/expected_cost_records.json` | Empty; no cost input exists. |
| `47-payload-schema-invalid/expected_metric_definitions.json` | The three unchanged base metric definitions. |
| `47-payload-schema-invalid/expected_metric_runs.json` | Empty; rejected payloads cannot enter a metric snapshot. |
| `47-payload-schema-invalid/expected_fraud_decisions.json` | Empty; schema failure is an ingestion rejection, not a public fraud classification. |
| `47-payload-schema-invalid/expected_rejections.json` | One non-identifying `payload_schema_invalid` rejection with discarded payload disposition. |
| `47-payload-schema-invalid/expected_reconciliation.json` | Empty; no external row is reconciled. |

## Inventory reconciliation

The final migration must reconcile this ledger against:

```bash
git diff --name-status --find-renames contract-v0.2.1..HEAD -- fixtures/
git diff --stat contract-v0.2.1..HEAD -- fixtures/
```

The expected new-side inventory is 47 `input.json` files, `47 * 13 = 611` golden files, and one README. The first 38 fixture directories correspond to the v0.2.1 set; fixtures 39-41 add the v0.3 minor-line inputs and 39 goldens, fixture 42 adds the v0.3.1 patch input and 13 goldens, fixture 43 adds the v0.3.2 M4 handoff input and 13 goldens, fixture 44 adds the v0.3.3 aggregate-metric input and 13 goldens, fixture 45 adds the v0.3.4 iOS conversion-schema input and 13 goldens, fixture 46 adds the v0.3.5 integrity-evidence reservation and 13 goldens, and fixture 47 adds the v0.3.6 runtime schema-rejection proof and 13 goldens. Git rename detection may pair identical metric-definition files across fixture numbers, so reconciliation uses the destination inventory plus the semantic ledger rather than rename similarity alone.

## Consumer migration

1. Pin the previous implementation to the `contract-v0.2.1` tag while preparing the migration.
2. Upgrade schemas, registries, evaluator behavior, fixtures, and golden outputs as one v0.3 unit.
3. Recompute payload, dimension, and snapshot digests only when their normative JCS inputs change; never translate a digest by string substitution.
4. Reject mixed-version artifacts and validate the complete v0.3 suite before accepting deployment-private inputs outside this public repository.
