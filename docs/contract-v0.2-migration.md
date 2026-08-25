# Contract v0.2 Migration Guide

Contract v0.2 is an in-place contract migration from the immutable `contract-v0.1` Git tag. It is not wire-compatible with v0.1. Consumers must select a complete contract version and must not mix v0.1 schemas, registries, fixtures, or golden outputs with v0.2 artifacts.

## Version and path migration

| v0.1 | v0.2 | Reason |
| --- | --- | --- |
| Schema `$id` suffix `:v0.1` | `:v0.2` | The required fields, enums, types, and artifact set contain breaking changes. |
| `contract_version` and event `schema_version` `0.1.0` | `0.2.0` | Object versions identify the matching in-place schema set. |
| `registries/*-v0.1.json` | `registries/*-v0.2.json` | Registry values and compatibility rules are versioned with the contract. |
| `fixtures/v0.1/` | `fixtures/v0.2/` | Reviewed fixture inputs and outputs are a versioned set. |
| 11 expected output classes | 13 expected output classes | `expected_metric_definitions.json` and `expected_cost_records.json` make versioned metric definitions and append-only cost snapshots reviewable outputs. |

The `contract-v0.1` tag points to the pre-migration `main` commit. The versioning rules are in [schema-versioning.md](schema-versioning.md).

### v0.2.1 patch (R-23)

Release `0.2.1` keeps every schema `$id` and registry filename on the `v0.2` minor line. Metric-run adds optional `value_state=present | undefined` and `undefined_reason=no_attributed_cost | no_activity_events | empty_cohort`. Omitted `value_state` means present, so fixtures 01 through 36 and all of their existing goldens remain byte-for-byte unchanged. The difference-reason registry advances to `contract_version=0.2.1`; reconciliation adds `provider_modeled_conversion`, and only that reason uses `difference_reason_version=0.2.1`. Existing reasons remain `0.2.0`. Event and fixture-envelope versions remain `0.2.0` because those artifact schemas did not change.

## Contract field migration

| Artifact or field | v0.2 change | Reason / work-order authority |
| --- | --- | --- |
| Logical event `lifecycle` | Renamed to `record_lifecycle`; values remain `active | retracted`. | Separates record state from payload availability (A-02, R-2). |
| Raw `payload_lifecycle_status` and evidence `lifecycle_status` | Values are `available | redacted | purged`; state-transition axes match schema enums. | Payload availability is orthogonal to logical-record lifecycle (A-02, R-2). |
| Money `amount_unscaled` | All event money is nonnegative and uses `common#/$defs/money`; direction comes from event type and `financial_status`. | Removes contradictory signed/unsigned definitions (A-03, A-07, R-3). |
| Reason fields | Attribution, rejection, correction, consent decision, and public fraud values are schema enums equal to their registry sets. | Closes free-text and dual-source drift (A-04, F-06, R-4). |
| Evidence reference | `access_class` is required; the unused standalone evidence-reference schema is removed. | One canonical evidence type and explicit disclosure class (A-06, F-04). |
| Identifier fields | Click, tracking-link, campaign, installation, and session identifiers use common types; `click_id` requires at least 22 base64url-compatible characters. | Type consistency and secure redirector identifiers (A-15, A-18, F-08). |
| Attribution `subject_ref` | `installation_level` requires `installation:`; `aggregate` requires `aggregate:`. | Prevents namespace confusion structurally (F-09). |
| `canonical_record_id` | Points to the first accepted record for duplicate/conflict delivery; absent on `record_id_collision`. | Defines previously emitted but undocumented identity (A-08). |
| Metric-run FX | `fx_rate` becomes `fx_rate_unscaled` plus `fx_rate_scale`. | Makes integer FX representation typed and reproducible (A-09). |
| Privacy request completion | `deletion_subject_ref` is forbidden and `deletion_subject_digest` is required. | Removes the subject reference while preserving deployment-private HMAC correlation (F-01, R-5). |
| Privacy tombstone | `reason_digest` and `policy_digest` become plaintext `reason_code` and `policy_version`; `provenance_digest` has an exact JCS input. | Digests are not secrecy controls (F-05, R-6). |
| Invalid calendar timestamp | Emits `timestamp_invalid` delivery and rejection with discarded payload. | Formalizes the former evaluator exception path (B-01, R-8). |
| Public fraud reason | Adds `replay_suspected`. | Keeps replay suspicion separate from delivery idempotency (A-12). |
| Metric reproducibility | Retention expiry can produce `retention_affected` replacement runs without a privacy request. | Makes lawful retention effects auditable (A-14). |
| Imported attribution | Adds `method=imported`, `model=provider_reported`, and five `provider_*` attribution reasons. | Preserves provider-reported judgment without misclassifying it as first-party Install Referrer evidence (WO-3 A1). |
| Import context | Adds a closed optional `import_context` to click, install, session-start, and ad-revenue events. The work-order proposals `network`, `site_ref`, and `country` are implemented as the canonical closed-context fields `provider_network`, `provider_site_ref`, and `provider_country`. | Retains typed provider attribution and dimension evidence without using `extensions`, while following the WO-2 namespace convention (WO-3 A3). |
| Producer vocabulary | Adds `sdk-ios`, `adapter:<network>`, and `postback:<kind>`; preserves `sdk-android`, `redirector`, and `import:<provider>`. | Distinguishes event origin and deployment-private adapter classes (WO-3 A4). |
| Stale timestamp policy | Adds optional closed server-context `timestamp_stale_policy` and rejection `timestamp_stale`; stale delivery/rejection artifacts carry the server authority plus the version and digest bound to the boundary. | Separates calendar-valid evidence outside the configured retention boundary from invalid timestamps with reproducible policy provenance (WO-3 A5). |
| Import reconciliation | Maps payload `provider_click_ref` to the existing `provider_click_id` matching-key type, derives reconciliation input from accepted imported installs, and emits only provider-namespaced SHA-256 key values with protected access classification. | Preserves the WO-2 matching-key vocabulary, prevents cross-provider key collisions and raw-reference disclosure, and removes fixture/caller-authored reconciliation as a prerequisite for Shadow import (WO-3 A2). |
| Click and install dimensions | Adds typed optional reporting dimensions to click and install, including first-party `attribution_confirmed_at`. | Keeps reporting dimensions in closed schemas and distinguishes first-party confirmation from imported provider confirmation (WO-3 B1/B2). |
| Advertiser-side view event | Adds `ad_view`; `ad_impression` remains mediation-side evidence. | Prevents two different observation points from becoming aliases (WO-3 B4). |
| Ad-revenue scope | Requires `subject_scope`; installation-level revenue requires `installation_id`, aggregate revenue forbids it. Adds optional mediation/country/ad-unit evidence, S2S-only `anchor_source`, and `currency_source`. | Makes cohort eligibility and default-currency provenance explicit (WO-3 B3/B9). |
| Cost record | Adds append-only imported-reported cost with exact dimension and report-snapshot digests. The work-order term `spend` uses the existing v0.2 money names `amount_unscaled`, `amount_scale`, and `currency`. | Reuses the canonical money representation and makes revision selection reproducible (WO-3 B5). |
| Metric definition and run | Replaces the fixed three-name contract with typed data-driven calculations and grouping; adds money, ratio, and count run shapes. | Supports D1/D3/D7 ROAS, D1/D7 retention, cohort LTV, and cohort size without hard-coded metric-name branching (WO-3 B6/B7). |
| FX aggregation | Converts and half-even rounds each source event before summing target units. | Prevents aggregate-first rounding drift (WO-3 B8). |
| Import normalization | Higher-precision timestamps truncate to canonical milliseconds; missing upstream currency is supplied by deployment policy with `currency_source=default`. | Makes import-boundary normalization explicit and reproducible (WO-3 B9). |
| Platform compatibility | Adds aggregate `skadnetwork` and `adattributionkit`, installation-level `meta_install_referrer` last-click/view-through, and installation-level `apple_adservices` last-click rows. | Makes the Stage C attribution methods and scopes structurally valid (WO-3 C1). |
| Apple aggregate postbacks | Adds closed `skan_postback` and `adattributionkit_postback` event schemas with normalized platform fields and a separate signature-verification result. | Represents privacy-preserving aggregate attribution without installation identity (WO-3 C2). |
| Meta Install Referrer | Adds `meta_referrer_status` and a minimal closed `meta_referrer_context` containing only normalized last-click/view-through semantics. Exact provider-decrypted fields remain unverified and absent. | Preserves verified contract semantics without inferring unavailable primary-source fields or using extensions (WO-3 C3). |
| Apple AdServices | Adds a closed install `adservices_context` for attributed and token-expired normalized outcomes. | Represents Apple Ads attribution separately from first-party and imported-provider methods (WO-3 C1/C3). |
| Processing purpose | Adds `processing-purposes-v0.2.json` and closes every `processing_purpose_id` to `attribution | fraud_prevention | analytics | revenue_measurement`. Registry defaults are illustrative and deployment-overridable. | Gives self-hosters a versioned purpose catalog without treating it as legal advice or runtime authorization (WO-3 D1/F-07). |

## Existing fixture input migration

Every input in fixtures 01 through 19 changes `contract_version` and event `schema_version` to `0.2.0`. Fixture identifiers that populate `click_id` are lengthened to the v0.2 secure-ID shape; the affected protected payload digests consequently change. Stage A further replaces provider matching-key source values in fixture inputs 01, 03, and 19 with provider-namespaced SHA-256 values plus `value_encoding=sha256` and `access_class=protected`. Fixture 12 now contains a lexically shaped but calendrically invalid authoritative timestamp to distinguish `authoritative_time_invalid` from missing authority. Fixture 17 replaces the completed deletion subject reference with the reviewed synthetic HMAC digest. No real or provider-derived data is introduced.

## Existing golden-output ledger

The following table is exhaustive for content changes to the golden files inherited from fixtures 01 through 19. All 19 fixtures also add `expected_metric_definitions.json` containing the three definitions at `metric_definition_version=0.2.0` and `rule_bundle_version=0.2.0`. Any other inherited `expected_*.json` file is byte-for-byte unchanged apart from its Git move from `fixtures/v0.1/` to `fixtures/v0.2/`.

Abbreviations in the field column are exact field names: `cv=contract_version`, `sv=schema_version`, `rcv=reason_code_version`, `rbv=rule_bundle_version`, `drv=difference_reason_version`.

| Fixture | Golden file | Fields changed | Reason |
| --- | --- | --- | --- |
| 01 | `expected_attributions.json` | `rcv`, `rbv` -> `0.2.0` | Versioned attribution contract. |
| 01 | `expected_deliveries.json` | `cv` -> `0.2.0` | Versioned delivery contract. |
| 01 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | v0.2 version and lifecycle split. |
| 01 | `expected_raw_records.json` | `cv`, `sv`; `payload_sha256` | v0.2 versions and secure click-ID payload. |
| 01 | `expected_reconciliation.json` | `drv` -> `0.2.0`; provider-key `value` -> namespaced SHA-256; add `value_encoding`, `access_class`; encoded join text | Versioned reconciliation reason and protected provider reference. |
| 02 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 02 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 02 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 02 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID-shaped evidence. |
| 03 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 03 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 03 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 03 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID-shaped evidence. |
| 03 | `expected_reconciliation.json` | `drv`; provider-key `value` -> namespaced SHA-256; add `value_encoding`, `access_class` | v0.2 reason version and protected provider-click reference. |
| 04 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 04 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 04 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 04 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID payloads. |
| 05 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 05 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 05 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID payloads. |
| 06 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 06 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 06 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID payloads. |
| 06 | `expected_rejections.json` | `reason_code_version` -> `0.2.0` | Versioned rejection registry. |
| 07 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 07 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 07 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID payloads. |
| 07 | `expected_rejections.json` | `reason_code_version` | Versioned rejection registry. |
| 08 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 08 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 08 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 08 | `expected_metric_runs.json` | `metric_definition_version`, `rbv`; `fx_rate` -> `fx_rate_unscaled` + `fx_rate_scale` | Versioned definitions and structured FX. |
| 08 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versioned raw records and changed install payload digest. |
| 09 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 09 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 09 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 09 | `expected_metric_runs.json` | `metric_definition_version`, `rbv`; structured FX fields | Versioned definitions and structured FX. |
| 09 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versioned raw records and changed payload digest. |
| 10 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 10 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 10 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 10 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID payloads. |
| 11 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 11 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 11 | `expected_raw_records.json` | `cv`, `sv` | Versioned raw records. |
| 12 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 12 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 12 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 12 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions, secure IDs, and explicit invalid-authority evidence. |
| 13 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 13 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 13 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 13 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID payloads. |
| 14 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 14 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 14 | `expected_raw_records.json` | `cv`, `sv` | Versioned raw records. |
| 14 | `expected_rejections.json` | `reason_code_version` | Versioned rejection registry. |
| 15 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 15 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 15 | `expected_raw_records.json` | `cv`, `sv` | Versioned raw records. |
| 15 | `expected_rejections.json` | `reason_code_version` | Versioned rejection registry. |
| 16 | `expected_corrections.json` | `cv` | Versioned correction contract. |
| 16 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 16 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 16 | `expected_raw_records.json` | `cv`, `sv` | Versioned raw records. |
| 17 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 17 | `expected_corrections.json` | `cv` | Versioned correction contract. |
| 17 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 17 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 17 | `expected_metric_runs.json` | `metric_definition_version`, `rbv`; structured FX fields | Versioned definitions and structured FX. |
| 17 | `expected_privacy_requests.json` | `cv`; remove `deletion_subject_ref`; add `deletion_subject_digest`; completed-state ordering | Completed-request identifier removal (F-01, R-5). |
| 17 | `expected_privacy_tombstones.json` | `cv`; `reason_digest` -> `reason_code`; `policy_digest` -> `policy_version`; recompute `provenance_digest` | Transparent tombstone provenance (F-05, R-6). |
| 17 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versioned raw records and secure ID payload. |
| 17 | `expected_reconciliation.json` | `drv`, matching-key `value` | v0.2 reason version and secure provider-click key. |
| 18 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 18 | `expected_rejections.json` | `reason_code_version` | Versioned rejection registry. |
| 19 | `expected_attributions.json` | `rcv`, `rbv` | Versioned attribution contract. |
| 19 | `expected_deliveries.json` | `cv` | Versioned delivery contract. |
| 19 | `expected_fraud_decisions.json` | `reason_code_version`, `rbv` | Versioned public fraud contract. |
| 19 | `expected_logical_events.json` | `cv`; `lifecycle` -> `record_lifecycle` | Lifecycle split. |
| 19 | `expected_raw_records.json` | `cv`, `sv`, `payload_sha256` | Versions and secure click-ID payload. |
| 19 | `expected_reconciliation.json` | `drv`; provider-key `value` -> namespaced SHA-256; add `value_encoding`, `access_class`; encoded join text | v0.2 reason version and protected provider-click reference. |

## New fixture and golden ledger

Each row below adds `input.json` and all 13 reviewed golden files: `expected_raw_records.json`, `expected_deliveries.json`, `expected_logical_events.json`, `expected_corrections.json`, `expected_privacy_requests.json`, `expected_privacy_tombstones.json`, `expected_attributions.json`, `expected_metric_definitions.json`, `expected_metric_runs.json`, `expected_cost_records.json`, `expected_fraud_decisions.json`, `expected_rejections.json`, and `expected_reconciliation.json`. Empty arrays are explicit expected results.

Stage A also hardens the provider-key inputs introduced with fixtures 21 through 23: fixtures 21 and 23 change their reconciliation golden as described below, while fixture 22 changes only its unmatched candidate input and therefore has no golden change. The exact synthetic source-to-digest calculations for fixtures 01, 03, 19, 21, 22, 23, and 28 through 31 are listed in `fixtures/v0.2/README.md`.

| Fixture | Meaningful non-empty golden fields | Authority |
| --- | --- | --- |
| 20 `timestamp-invalid` | Delivery/rejection `reason_code=timestamp_invalid`, `payload_disposition=discarded`, retained non-identifying metadata; all evidence/derived arrays empty. | B-01, R-8. |
| 21 `reconciliation-window-mismatch` | Accepted organic install plus reconciliation `difference_reason_code=window_mismatch`, protected SHA-256 key, candidate, encoded join, out-of-window state, current freshness. | A-11 and WO-3 A2 provider-key hardening. |
| 22 `reconciliation-join-key-missing` | Accepted organic install plus reconciliation `difference_reason_code=join_key_missing` with empty key/candidate/join sets. | A-11. |
| 23 `reconciliation-freshness-mismatch` | Accepted organic install plus reconciliation `difference_reason_code=freshness_mismatch`, protected SHA-256 key, joined in-window candidate, stale freshness. | A-11 and WO-3 A2 provider-key hardening. |
| 24 `attribution-supersession` | Redaction correction/tombstone and replacement attribution with `supersedes_attribution_id` and `finality=superseded`. | A-10. |
| 25 `replay-suspected` | Unique accepted click plus public fraud `reason_code=replay_suspected`, protected categorical evidence, and exclude action. | A-12. |
| 26 `retention-affected` | Retention tombstone, no privacy request, and three immutable replacement metric runs with `retention_affected`, zero value, purged revenue evidence, and supersession IDs. | A-14. |
| 27 `ad-impression-revenue-link` | Accepted install/impression/revenue evidence and three metric runs of `3000000` scale-6 USD citing the shared impression evidence. | A-19. |
| 28 `imported-provider-attributed` | Imported non-organic provider judgment plus namespaced SHA-256 provider install/click matching keys, a single normalized candidate, `not_applicable` first-party window, and `matched` reconciliation. | WO-3 A1, A2, A3, A6(a). |
| 29 `imported-provider-organic` | Imported organic provider judgment, matched provider-install reconciliation, imported session context, and accepted `sdk-ios` producer evidence. | WO-3 A1, A3, A4, A6(b). |
| 30 `imported-time-authority-unavailable` | Imported non-organic judgment with `provider_time_authority_unavailable`, imported ad-revenue context, and accepted `postback:synthetic-kind` evidence. | WO-3 A1, A3, A4, A6(c). |
| 31 `imported-reconciliation-derived` | Empty authored reconciliation input; evaluator-derived `matched` and `join_key_missing` rows, plus `provider_modeled_conversion`, `provider_unattributed`, and accepted `adapter:synthetic-network` evidence. | WO-3 A1, A2, A4, A6(d). |
| 32 `timestamp-stale` | Rejected delivery/rejection with `timestamp_stale`, server-authoritative policy version/digest provenance, discarded payload, and no raw/logical evidence. | WO-3 A5. |
| 33 `stage-b-cohort-metrics` | Typed click/install/ad-view evidence, installation and aggregate revenue, current append-only cost revision, seven data-driven metric definitions, and independently reviewed D1/D3/D7 ROAS, D1/D7 retention, D7 LTV, and cohort-size runs. | WO-3 B1-B9. |
| 34 `stage-c-apple-meta-attribution` | Eleven accepted synthetic events and eleven attributions exercise SKAdNetwork, AdAttributionKit, Meta Install Referrer, Apple AdServices, both new aggregate event names, every Stage C compatibility method/model row, and every Stage C reason including the distinct non-winner reason. | WO-3 C1-C3. |
| 35 `privacy-request-auth-scope` | Two synthetic session records exercise authenticated tenant-admin deletion and an active same-installation on-device request. The completed admin path yields one correction and tombstone; the on-device path retains only a non-identifying authentication-decision reference. | R-19 / WO-3 D2. |

### Stage B golden-change ledger

This subsection is exhaustive relative to the accepted Stage A commit `c5c41b3c0cc6bd08c565dd0376ce1b4f5d64105d`.

| Fixtures | Golden file | Exact Stage B change |
| --- | --- | --- |
| 01-32 | `expected_cost_records.json` | Adds the thirteenth output class as an explicit empty array. |
| 01-32 | `expected_metric_definitions.json` | Replaces the three fixed-name records with structured `value_type` and `definition` fields while preserving the same baseline metric semantics and names. |
| 08, 09, 17, 26, 27 | `expected_metric_runs.json` | Adds `value_type=money`; values and prior lifecycle/supersession semantics remain unchanged. |
| 08, 09, 27, 30 | `expected_raw_records.json` | Recomputes `payload_sha256` after the synthetic ad-revenue inputs add required `subject_scope` and fixture 30 adds `currency_source=reported`. |
| 33 | all 13 `expected_*.json` files | Adds the new Stage B scenario. Non-empty cost, event, metric-definition, and metric-run artifacts are derived in `fixtures/v0.2/README.md`; all empty arrays are explicit reviewed results. |

Stage B input changes are exact: fixtures 08, 09, 17, 26, and 27 add `subject_scope=installation_level` to each ad-revenue payload; fixture 30 adds that scope plus `currency_source=reported`; fixture 33 is new. No other Stage A input or golden content changes in this stage.

### Stage C golden-change ledger

Stage C does not change any fixture 01-33 input or golden file. Fixture 34 adds one synthetic `input.json` and all 13 reviewed `expected_*.json` files. Its meaningful non-empty results are raw records, deliveries, logical events, baseline metric definitions, and eleven attribution results; the remaining output classes are explicit empty arrays. Producer suffixes are synthetic. The candidate outputs were accepted only after closed-schema validation, TypeScript/Python canonical parity, input-permutation invariance, and a field-by-field review of all eleven method/model/status/reason combinations.

### Stage D golden-change ledger

This ledger is exhaustive relative to the final Stage C commit `d3eb86b`.

| Fixture | Input change | Golden change |
| --- | --- | --- |
| 25 `replay-suspected` | Renames `fraud-prevention` to the canonical `fraud_prevention` in server configuration and the record. | `expected_raw_records.json` and `expected_deliveries.json` rename the same purpose; no fraud-decision field changes. |
| 33 `stage-b-cohort-metrics` | Adds the `revenue_measurement` server purpose and assigns it to `revenue-33-a`. | The matching raw record and delivery change `processing_purpose_id` plus `consent_evaluation_policy_version=revenue-v0.2`; payload digest and every metric value remain unchanged. |
| 34 `stage-c-apple-meta-attribution` | Adds the `attribution` server purpose and assigns it to `meta-click-install-34`. | The matching raw record and delivery change `processing_purpose_id` plus `consent_evaluation_policy_version=attribution-v0.2`; payload digest and attribution result remain unchanged. |
| 17 `redaction-recalculation` | Adds required `requested_via=tenant_admin_api` and the synthetic non-identifying `requester_auth_ref`. | `expected_privacy_requests.json` adds the same authentication provenance; deletion, tombstone, and metric values are unchanged. |
| 24 `attribution-supersession` | Adds required `requested_via=tenant_admin_api` and the synthetic non-identifying `requester_auth_ref`. | `expected_privacy_requests.json` adds the same authentication provenance; attribution supersession is unchanged. |
| 35 `privacy-request-auth-scope` | Adds one synthetic input containing the two R-19 request routes. | Adds all 13 reviewed golden artifacts. The admin request produces one correction and tombstone; the on-device request remains active and targets only its own installation-scoped session. |
| 36 `child-directed-audience` | Adds one synthetic child-directed app context containing an ordinary session and no advertising identifier. | Adds all 13 reviewed golden artifacts. The accepted session output is unchanged by audience classification; schema mutations prove recursive reserved-field rejection. |

No other fixture input or golden file changes in Stage D. R-19 resolves D2. R-20 resolves D3 with an optional audience declaration whose absence is semantically `general`; therefore it does not change any inherited golden output.

### R-23 v0.2.1 golden ledger

This ledger is exhaustive relative to the accepted Stage D baseline. Fixtures 01 through 36 have no input or golden change.

| Fixture | Meaningful non-empty golden fields | Authority |
| --- | --- | --- |
| 37 `undefined-organic-roas` | Organic attribution plus one ratio metric run with `value_state=undefined`, `undefined_reason=no_attributed_cost`, no `value_unscaled`, and retained ratio scale/evidence. All other empty output classes remain explicit reviewed arrays. | R-23 metric-run undefined-value contract. |
| 38 `provider-modeled-reconciliation` | Imported modeled attribution plus automatically derived reconciliation `difference_reason_code=provider_modeled_conversion`, `difference_reason_version=0.2.1`, and no matching keys or candidates. | R-23 modeled-row difference classification. |

Each fixture adds one synthetic `input.json` and all 13 reviewed `expected_*.json` files. The golden values were independently compared across TypeScript and Python evaluators, schema-validated, and documented in `fixtures/v0.2/README.md`; no generated or real-world data was used.

## Inventory reconciliation

The v0.2 fixture tree contains 38 `input.json` files and `38 * 13 = 494` golden output files, plus this README: 533 paths in the resulting tree. The base migration changes every inherited fixture-tree path because the version directory moves from v0.1 to v0.2; Git may display unchanged files as renames. Relative to the completed WO-2 tree, WO-3 Stage A adds five inputs and 60 reviewed golden files, and content-updates exactly five existing reconciliation goldens: fixtures 01, 03, 19, 21, and 23. Stage B then adds one input, 13 fixture-33 goldens, 32 explicit cost-output goldens, and the exact existing-content changes listed above. Stage C adds one input and 13 fixture-34 goldens without changing fixtures 01-33. Stage D changes exactly eight existing golden files in fixtures 17, 24, 25, 33, and 34 as listed above, and adds fixtures 35 and 36 without adding an artifact class. R-23 adds fixtures 37 and 38 without changing any inherited fixture. Use:

```bash
git diff --name-status --find-renames contract-v0.1..HEAD -- fixtures/
git diff --stat contract-v0.1..HEAD -- fixtures/
```

The expected new-side inventory is 38 inputs, 494 golden files, and one README. The tables above account for every content-changed inherited golden and every new golden; all remaining inherited goldens are path-only moves.

## Consumer migration

1. Pin the v0.1 implementation to the `contract-v0.1` tag while preparing the migration.
2. Upgrade schemas, registries, evaluator behavior, and fixture expectations as one v0.2 unit.
3. Recompute protected payload digests only when the underlying synthetic or deployment-private payload changes; never translate a v0.1 digest by string substitution.
4. Reject mixed-version artifacts and validate the complete v0.2 suite before accepting production-like inputs outside this public repository.
