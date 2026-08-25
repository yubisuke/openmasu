# [Epic] Define OpenMasu Event & Metric Contract v0.1

## Background

Implementing a replacement MMP before fixing the contract would mix media-specific behavior, metric definitions, duplicate handling, late data, privacy-preserving APIs, and fraud controls. The result would be difficult to reproduce or audit.

The first milestone is a shared Event & Metric Contract for SDKs, servers, media adapters, and shadow reconciliation. Before runtime implementation, the project must define what constitutes received evidence, how it is normalized, and which inputs and policy versions produced each attribution and metric.

This issue is the tracking Epic for Contract v0.1. PostgreSQL, HTTP APIs, SDKs, and live media integrations belong to follow-up issues.

## Goals

- Define a common contract that can recalculate attribution and metrics from received evidence
- Separate raw records, deliveries, logical events, corrections, and derived decisions
- Distinguish deterministic, platform-assigned, aggregate, and unknown attribution
- Represent duplicate delivery, ID conflict, lateness, correction, and deletion without hiding them
- Split ambiguous metrics such as D0 into explicit time definitions
- Separate the public fraud-evidence contract from private live defenses

## v0.1 boundary

### Core contract

- Raw-record envelope and schema versioning
- `click`, `install`, and `session_start`
- Delivery, duplicate, conflict, timeliness, and record lifecycle
- Correction and retraction
- Attribution result
- D0 metric definitions
- Synthetic fixtures and a pure reference evaluator

### Schema-only extensions

- `ad_impression` and `ad_revenue`
- `purchase` and `refund`
- `consent_changed`
- Privacy-request control plane
- Fraud-decision envelope

Schema-only extensions define shapes and states. They do not implement SDK collection, media connectivity, the fraud engine, or the deletion execution system.

## Work package 1: Schema foundation

- Use JSON Schema Draft 2020-12
- Give every schema a stable `$id` and Semantic Version
- Reject unknown fields by default in v0.1 and document explicit extension points
- Define breaking and non-breaking changes and version resolution
- Store timestamps as UTC RFC 3339 and fix the accepted precision
- Express reporting time zones with IANA time zone names

## Work package 2: Raw-record envelope

Define at least:

- `record_id`
- `tenant_id`
- `app_id`
- `producer`
- `producer_version`
- `source`
- `source_event_id`, when available
- `event_id`
- `delivery_id`
- `event_name`
- `schema_version`
- `payload_sha256`
- `occurred_at`
- `occurred_at_source`
- `received_at`, assigned by the server
- `raw_payload_ref`

Use RFC 8785 JSON Canonicalization Scheme (JCS), UTF-8, and lowercase hexadecimal SHA-256 for `payload_sha256`. Distinguish the protected raw payload from a reference or digest that may be exposed through an audit API.

Define identifier ownership and cardinality:

- The ingestion service generates `record_id` and `delivery_id`.
- The producer generates `event_id`, which identifies one logical event within the tenant, app, and producer scope.
- `payload_sha256` hashes the canonical logical-event payload and excludes retry or transport metadata.
- The server assigns authoritative `tenant_id` and `app_id` from the authenticated SDK key or adapter configuration. Client-supplied values are non-authoritative consistency checks and a mismatch is rejected.
- `producer` values come from a versioned producer registry, initially including `sdk-android`, `redirector`, and `import:<provider>`; each registry entry defines its event-ID scope and import provenance.

## Work package 3: Idempotency and orthogonal state axes

### Idempotency

- Use `(tenant_id, app_id, producer, event_id)` as the logical-event uniqueness key
- Classify the same key and same `payload_sha256` as `duplicate_delivery`
- Classify the same key and different digest as `event_id_conflict`
- Preserve conflict evidence but exclude it from derived processing
- Treat `replay_suspected` as a fraud decision, not duplicate resolution

### State axes

- Ingestion: `received | accepted | rejected`
- Duplicate resolution: `unique | duplicate_delivery | event_id_conflict`
- Timeliness: `on_time | late`
- Record lifecycle: `active | retracted | redacted | purged`
- Attribution finality: `pending | provisional | final | superseded | retracted`
- Privacy request: `received | processing | completed | failed`

Define allowed transitions, terminal states, and reason codes. Do not combine unrelated concepts into one `data_quality_status`.

## Work package 4: Event contracts

### Core

- `click`: `click_id`, `tracking_link_id`, `campaign_id`, and redirector-recorded `redirector_click_at`
- `install`: `installation_id`, protected referrer evidence reference, `referrer_click_at_device`, `referrer_click_at_server`, `install_begin_at_device`, `install_begin_at_server`, and `referrer_read_at`
- `session_start`: `installation_id` and a session identifier

### Schema-only

- `ad_impression` and `ad_revenue`: `impression_id`, `ad_unit_id`, `ad_network`, `amount_unscaled`, `amount_scale`, `currency`, and `revenue_source`
- `purchase` and `refund`: `transaction_id`, `original_transaction_id`, `amount_unscaled`, `amount_scale`, `currency`, `financial_status`, and a correction target reference
- `consent_changed`: `consent_state`, `effective_at`, and `consent_policy_version`

Use a closed `consent_state` enum: `granted | denied | withdrawn | not_required | unknown`. Define required, optional, and prohibited fields, units, and whether negative values are valid for every event type.

For `session_start`, session timeout and background/foreground behavior are deferred to Milestone 2 SDK design and must be versioned before collection starts. Use a closed `revenue_source` confidence enum: `client_estimated | server_verified | imported_reported`.

### Time authority and clock skew

- The redirector-recorded `redirector_click_at` is authoritative for a click; Google Play server `install_begin_at_server` is authoritative for the install side of Install Referrer window evaluation.
- Device `occurred_at` and device-provided referrer timestamps are retained as evidence only; they cannot make a candidate in-window or out-of-window.
- When a client-supplied `occurred_at` is later than server `received_at + 5 minutes`, retain the raw evidence and mark `clock_skew_suspected`. Device skew alone does not reject a record and cannot affect window evaluation; timeliness remains a separate axis.
- If a required redirector or Google Play server timestamp is missing or invalid, device time cannot substitute for it. Produce no paid attribution and use `authoritative_time_missing` or `authoritative_time_invalid`.
- An unsupported or unavailable Install Referrer response must yield explicit unattributed reason codes (`install_referrer_unsupported` or `install_referrer_unavailable`), not an inferred organic result.

Define consent handling by versioned processing purpose:

- The server, not the SDK, assigns whether a configured processing purpose requires consent.
- Accepted and rejected records retain `processing_purpose_id`, `consent_evaluation_policy_version`, `consent_decision_reason_code`, and, when applicable, server-assigned `withdrawal_recognized_at` so the decision can be reproduced.
- Once the server recognizes withdrawal, it rejects an event for a consent-required purpose regardless of `occurred_at`; only non-identifying rejection metadata is retained and the payload is discarded or immediately redacted.
- `consent_changed` and privacy-control records remain acceptable so withdrawal and deletion can complete.
- Queued post-withdrawal acceptance is permitted only when a versioned server policy documents an explicit alternative legal basis for that processing purpose; occurrence before withdrawal is not itself a basis.
- On withdrawal, SDK requirements include stopping delivery and purging or immediately redacting queued consent-required events.
- Fixtures must separately cover post-withdrawal occurrence and pre-withdrawal occurrence delivered after withdrawal, including rejection and redaction.

## Work package 5: Correction and deletion

### Correction contract

- `tenant_id`
- `app_id`
- `correction_id`
- `corrects_record_id`
- `correction_type`
- `correction_reason`
- `effective_at`

Do not overwrite received evidence. Represent corrections, retractions, refunds, and recalculated decisions through causal records.

### Privacy-request control plane

- `tenant_id`
- `app_id`, when the request is app-scoped
- `privacy_request_id`
- `deletion_subject_ref`
- `deletion_scope`
- `requested_at`
- `status`

Replace identifiable raw payloads subject to a valid deletion request with non-identifying redacted tombstones. Append-only design must not preserve identifiable deleted payloads. Define how derived attribution and aggregates are recalculated and how non-identifying audit evidence remains.

Reproducibility is guaranteed only for the lawful evidence set available to a run. If retention expiry or a valid redaction removes evidence, mark affected historical runs `superseded_by_recalculation` and mark affected `evidence_refs` as `purged` or `redacted`; the resulting redaction-caused difference must be explainable.

Correction and privacy references must resolve only within the same tenant and, when applicable, the same app.

## Work package 6: Attribution result

Define at least:

- `attribution_id`
- `tenant_id`
- `app_id`
- `subject_scope`: `installation_level | aggregate`
- `subject_ref`
- `status`: `organic | non_organic | unattributed`
- `method`
- `model`
- `reason_code`
- `reason_code_version`
- `evidence_refs`
- `effective_at`
- `decided_at`
- `input_cutoff_at`
- `finality`
- `rule_bundle_id`
- `rule_bundle_version`
- `rule_bundle_hash`
- `supersedes_attribution_id`, when recalculated

Freeze the following behavior through a compatibility table and versioned reason-code registry:

- `organic`: the required inputs show that no valid paid candidate exists
- `unattributed`: missing, conflicting, expired, or otherwise insufficient inputs prevent a valid attribution
- `aggregate`: `installation_id` is prohibited; aggregate evidence must not be forced into an installation-level record
- Valid combinations of `method`, `model`, `subject_scope`, and `status`

Represent a media API as provenance, not as an ambiguous `method=media_api` value.

## Work package 7: Metric definitions

Each metric definition and run includes:

- Metric name and `metric_definition_version`
- Anchor event
- Half-open window
- Aggregation time zone
- Attribution rule-bundle ID, version, and digest
- `input_received_at_watermark`
- `input_snapshot_id` or an immutable `input_ledger_position`
- `computed_at`
- Data freshness
- `reproducibility_status`: `fully_reproducible | redaction_affected | retention_affected`
- Optional `supersedes_metric_run_id`; the reverse `superseded_by` view is derived from immutable supersession records rather than by overwriting an earlier run
- Versioned evidence references with `lifecycle_status`: `available | redacted | purged`

Represent source money without precision loss using integer-string `amount_unscaled`, integer `amount_scale`, and ISO 4217 `currency`. For example, `amount_unscaled="123"` and `amount_scale=6` represents `0.000123` currency units. ISO 4217 currency exponent and media-reported precision are separate concepts. A display-oriented `amount_minor` may be derived but is not the source value. Converted results include `fx_rate`, `fx_rate_source`, `fx_rate_as_of`, `fx_policy_version`, and `rounding_mode`.

The input snapshot fixes the exact eligible record set, including ordering, retractions, and redactions. A timestamp watermark remains a freshness indicator but is not sufficient to identify the input set. If a ledger position is used, define a total ordering such as `(received_at, record_id)` and an inclusive upper bound.

Define at least these separate v0.1 metrics:

- `d0_install_to_24h_ad_revenue_usd`: `[install.occurred_at, install.occurred_at + 24h)`
- `d0_utc_install_calendar_ad_revenue_usd`
- `d0_jst_install_calendar_ad_revenue_usd`

The D1 and D7 catalogs are follow-up issues. v0.1 only needs to prove that the same contract can add them without changing raw records.

Metric names are explicit aliases for a definition instance. The definition remains authoritative for aggregation time zone, currency conversion, FX policy, and rounding; a name suffix must not override those parameters.

## Work package 8: Fraud-decision envelope

The public contract includes only the following types:

- `fraud_decision_id`
- `subject_ref`
- `decision`: `clear | suspected | confirmed`
- `action`: `allow | flag | exclude | quarantine`
- Versioned reason code
- `evidence[]`: `type`, `captured_at`, `digest`, and `access_class`
- Rule-bundle ID, version, digest, and hash algorithm
- `evaluated_at`
- `supersedes_fraud_decision_id`

Publish schemas, high-level reason categories, synthetic fixtures, and visibility classes. Keep actual production evidence, IP and User-Agent values, device or operator watchlists, live thresholds, model weights, keys, and response timing private and access-controlled.

Reserve public `bot_prefetch` reason-code categories for link-preview, crawler, and messenger-prefetch evidence. Their thresholds, detection signals, and response timing remain private.

## Work package 9: Synthetic fixtures and reference evaluator

Cover at least:

1. Valid Install Referrer attribution
2. Organic install with no referrer
3. Unknown click ID
4. Immediately before, exactly at, and immediately after the seven-day boundary
5. Duplicate delivery
6. Same event ID with a different payload
7. Same ID across tenants
8. Late ad revenue and an input watermark
9. UTC and JST calendar-boundary difference
10. Reinstall or redownload
11. Client clock skew: exactly +5 minutes remains normal; later than +5 minutes is retained with `clock_skew_suspected`
12. Device timestamps cross the seven-day boundary while redirector and Google Play server times remain authoritative; missing or invalid authoritative server time produces no paid attribution
13. Unsupported or unavailable Install Referrer
14. Withdrawal after occurrence but before delivery, rejected and payload-redacted by default
15. Event after consent withdrawal
16. Out-of-order correction and refund
17. Redaction, evidence-reference lifecycle state, reproducibility status, and recalculation after deletion or retention expiry
18. Rejection of an aggregate result joined to an installation
19. Bot or messenger link prefetch classified through the public `bot_prefetch` category

Each fixture contains:

- `input.json`
- `expected_raw_records.json`
- `expected_deliveries.json`
- `expected_logical_events.json`
- `expected_corrections.json`
- `expected_privacy_requests.json`
- `expected_privacy_tombstones.json`
- `expected_attributions.json`
- `expected_metric_runs.json`
- `expected_fraud_decisions.json`
- `expected_rejections.json`
- `expected_reconciliation.json`

With fixed time, FX, and rule digests, run a pure evaluator twice and require identical canonicalized output.

Although `ad_revenue` is a schema-only integration extension, the reference evaluator must validate its schema and use its high-precision source amount in D0 fixture calculations. No live media connection is required.

## Work package 10: Shadow reconciliation contract

Define the public reconciliation shapes used by Milestone 1 before implementation:

- A versioned difference-reason registry, including `candidate_missing`, `candidate_excluded`, `window_mismatch`, `join_key_missing`, `join_key_ambiguous`, `freshness_mismatch`, `external_row_unmatched`, and `redaction_caused_recalculation`.

This list reflects the WP10 design draft; the normative set is `registries/difference-reasons-v0.1.json`.
- Typed external-row matching keys: `external_row_id`, `provider_install_id`, `provider_click_id`, `tracking_link_id`, `campaign_id`, `transaction_id`, `impression_id`, and a tenant/app-scoped composite key. Each key declares provider, scope, normalization, cardinality, and whether it is protected.
- An `OpenMasu Shadow Import Profile v0.1` with format contract and synthetic fixtures only. Public docs do not identify deployment providers; provider mappings and certification remain deployment-private, and the profile must not contain operational data or create a live connection.
- A reconciliation result that records input snapshots, matching keys used, candidates, exclusions, windows, joins, freshness, reason-code version, and supersession history.

Difference reasons describe measurement semantics and available evidence, never provider quality, correctness, or comparative performance.

Live import connectivity and provider approval remain follow-up work. This package changes neither the no-fingerprinting boundary nor the public/private fraud boundary.

## Deliverables

- `spec/event-metric-contract-v0.1.md`
- `schemas/raw-record.schema.json`
- `schemas/event-delivery.schema.json`
- `schemas/logical-event.schema.json`
- `schemas/events/*.schema.json`
- `schemas/attribution-result.schema.json`
- `schemas/metric-definition.schema.json`
- `schemas/metric-run.schema.json`
- `schemas/evidence-reference.schema.json`
- `schemas/correction.schema.json`
- `schemas/privacy-request.schema.json`
- `schemas/privacy-tombstone.schema.json`
- `schemas/fraud-decision.schema.json`
- `schemas/rejection.schema.json`
- `schemas/reconciliation-result.schema.json`
- `schemas/fixture-input.schema.json`
- `schemas/common.schema.json`
- `registries/event-names-v0.1.json`
- `registries/reason-codes-v0.1.json`
- `registries/producer-values-v0.1.json`
- `registries/difference-reasons-v0.1.json`
- `registries/state-transitions-v0.1.json`
- `registries/compatibility-v0.1.json`
- `registries/matching-key-types-v0.1.json`
- `fixtures/v0.1/**`
- State-transition and method/model/subject compatibility tables
- External-row matching-key type table and reconciliation-result schema
- Deterministic TypeScript evaluator, independently implemented Python evaluator, and one validation command
- GitHub Actions validation on Linux and Windows

## Acceptance criteria

- [x] Every schema validates under Draft 2020-12 and has a stable `$id` and version
- [x] `event_name` is canonical across documents, examples, and schemas
- [x] Raw record, delivery, logical event, correction, and derived result are separate concepts
- [x] Tenant-scoped idempotency, duplicate delivery, and event-ID conflict are covered by fixtures
- [x] Authoritative tenant and app scope comes from server authentication context, and a client mismatch is rejected
- [x] Orthogonal state axes and allowed transitions are fixed in a machine-readable form or table
- [x] Attribution requires scope, method, model, reason, policy version, and input cutoff
- [x] Fixtures distinguish organic from unattributed
- [x] A fixture attaching `installation_id` to an aggregate result is rejected
- [x] `subject_scope=installation_level` is used consistently; `user_level` is not a contract value
- [x] D0 24-hour, UTC calendar-day, and JST calendar-day metrics recalculate independently
- [x] Currency, FX, rounding, and input watermark produce reproducible results
- [x] High-precision source amounts survive ingestion without conversion to currency minor units
- [x] An immutable input snapshot or ledger position fixes the exact records used by each metric run
- [x] Correction, retraction, redaction, and post-deletion recalculation are fixture-tested
- [x] Clock-skew, unsupported-referrer, bot-prefetch, and both withdrawal timing paths are fixture-tested
- [x] Events requiring consent are rejected and payload-redacted after server-recognized withdrawal regardless of `occurred_at`, while consent and privacy control records remain processable
- [x] Lawful redaction or purge marks affected evidence and supersedes affected metric runs rather than claiming bit-identical replay
- [x] Difference reasons and typed external-row matching keys reproduce the same reconciliation result from the same snapshots
- [x] The public fraud schema and private live-policy boundary are documented
- [x] One documented command validates every schema and fixture
- [x] Running the same fixture twice produces identical canonicalized output

## Out of scope

- PostgreSQL ledger and HTTP ingestion implementation
- Unity, Android, and iOS SDKs
- Live Install Referrer, MAX, or media-API connectivity
- Dashboard, RBAC, monitoring, and backup implementation
- Production fraud engine and live thresholds
- API keys, signing keys, media tokens, real campaigns, and real user data
- Disabling an existing MMP
- ClickHouse, Kafka, and other scaling infrastructure
- Final project name, repository visibility, and package identifiers

## Follow-up issue candidates

1. Implement the PostgreSQL Shadow ledger
2. Import existing MMP raw output and expose discrepancy evidence
3. Implement the Unity C# SDK and Android Kotlin bridge
4. Implement the Google Play Install Referrer vertical slice
5. Connect MAX ad-revenue events to the common contract
6. Implement privacy deletion and redaction end to end
7. Implement the fraud rule-bundle and audit-history boundary
8. Implement adapter support status and fixture certification
9. Add the D1 and D7 metric catalogs
10. Implement the Reporting API and dashboard
11. Implement backup, restore, observability, and RBAC
12. Define the Shadow pilot and primary-migration evidence gate

## Primary references

- https://developer.android.com/google/play/installreferrer
- https://developer.apple.com/documentation/AdAttributionKit
- https://developers.google.com/app-conversion-tracking/api
- https://developers.applovin.com/en/max/advanced-features/s2s-impression-level-api/
