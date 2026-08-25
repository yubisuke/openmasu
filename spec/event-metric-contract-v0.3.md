# Open MMP Event & Metric Contract v0.3

Contract release: `0.3.6`.

This document is normative for the v0.3 schemas, registries, fixtures, and reference evaluators. It defines synthetic, vendor-neutral measurement behavior; it does not define a production ingestion service.

## Serialization and versioning

- JSON Schemas use Draft 2020-12.
- Schema identifiers use `urn:open-mmp:schema:<artifact>:v0.3`.
- Contract objects are closed. A documented `extensions` object is the only open extension point. The fixture envelope's payload container is dispatched by `event_name` and then validated by the corresponding closed event schema.
- Runtime importers validate the normalized payload with that same event-schema dispatch before any raw, logical, or fact write. A failure emits only delivery and rejection artifacts with `reason_code=payload_schema_invalid`, `payload_disposition=discarded`, and non-identifying decision metadata; it emits no raw record, logical event, fact, attribution, or metric input.
- Accepted contract timestamps use UTC RFC 3339 with exactly millisecond precision and a trailing `Z`, for example `2026-08-12T00:00:00.000Z`.
- An importer that receives a higher-precision upstream timestamp truncates, and never rounds, the fractional part to milliseconds before creating a contract object. The resulting normalized millisecond string is the canonical contract timestamp; protected upstream evidence may be retained outside this normalized field. Digests cover that canonical string exactly. An implementation must not parse it into a native time type and re-render it before hashing, comparison, snapshot construction, or output.
- Ingress timestamp strings first pass the millisecond-`Z` syntax boundary. Evaluators then require a real UTC calendar instant. A syntactically shaped but calendrically invalid value follows the formal `timestamp_invalid` rejection path before window, skew, or bucket evaluation; its payload is discarded and only non-identifying delivery/rejection metadata is emitted. Accepted output timestamps also satisfy the schema `date-time` format.
- A server context may set the closed `timestamp_stale_policy` object. Its server-authoritative `before` boundary, `policy_version`, and `authority=server` are bound by `policy_digest=SHA-256(JCS({authority,before,policy_version}))`. A calendar-valid event whose `occurred_at` is strictly earlier than `before` follows the `timestamp_stale` rejection path; equality is accepted. The policy does not compare `provider_confirmed_at`. Absence of the object explicitly disables stale rejection. A stale rejection carries the policy version, digest, and authority, discards the payload, and remains distinct from `timestamp_invalid`.
- String ordering in evaluator outputs is by UTF-16 code unit.
- Payload and snapshot digests are lowercase SHA-256 over RFC 8785 JCS UTF-8 bytes.
- Money and identifiers are never represented with floating-point JSON numbers.

## Artifact separation

The contract keeps these append-only or derived concepts separate:

1. A raw record identifies protected evidence and its payload digest.
2. An event delivery records an ingestion decision, duplicate state, consent provenance, and payload disposition.
3. A logical event is the tenant-scoped accepted identity used by derived processing.
4. A correction causally references the record it corrects, retracts, or redacts.
5. Privacy requests and privacy tombstones document lawful evidence removal without retaining the removed payload.
6. Attribution, metric, fraud-decision, rejection, and reconciliation results are versioned derived artifacts.

Consent and scope rejections are not written as raw records. Their delivery and rejection artifacts retain only non-identifying decision metadata and `payload_disposition=discarded`. A same-scope event-ID conflict is the deliberate exception: both payload digests remain protected as conflict evidence, while only the first logical event is eligible for derived processing.

## Tenant scope and idempotency

The authenticated server context assigns `tenant_id` and `app_id`. Client-declared scope must match it. Every defensive record reference (privacy affected record, correction target, refund target, evidence lookup, and metric installation join) resolves in that authenticated tenant/app scope; an unqualified cross-scope lookup is invalid.

The authenticated app context may declare `audience=general | mixed | child_directed`; absence is semantically `general`. A `child_directed` context structurally rejects payloads containing any of these reserved device-advertising-identifier field names at any depth, including under `extensions`: `advertising_id`, `advertising_identifier`, `google_advertising_id`, `android_advertising_id`, `advertising_tracking_id`, `gaid`, `aaid`, `idfa`, and `rdid`. The rule applies independently to every authenticated batch. `mixed` does not relax platform, consent, or child-directed handling obligations; runtime age-gating policy remains deployment-specific. Apple Ads `adservices_context.ad_id` is an advertising-object identifier, not a device advertising identifier, and is not part of this reserved-name list.

`record_id` is generated by the server and is globally unique across the ledger. It is not a client idempotency key. A repeated `record_id`, including one presented in another tenant or app, is a `record_id_collision`: every colliding delivery is rejected, no winner is chosen, and only non-identifying rejection metadata is retained. Evaluators must key intermediate decisions by delivery context rather than by `record_id` alone. `delivery_id` identifies a transport delivery attempt, but it is not guaranteed to be unique within an output stream: a collision can produce multiple rejected rows carrying the same `delivery_id`. Persistence and output consumers therefore must not use `delivery_id` alone as a primary key. Every emitted evidence reference carries `tenant_id`, `app_id`, and `ref`; the scope must equal the enclosing artifact scope.

The logical idempotency key is:

`(server tenant_id, server app_id, producer, event_id)`

- The first digest is `unique`.
- A later delivery with the same key and payload digest is `duplicate_delivery`; it preserves delivery evidence but creates no second raw or logical record.
- A later delivery with the same key and a different digest is `event_id_conflict`; the conflicting payload is rejected.
- The same producer and event ID in different authenticated tenants are independent identities and cannot join across tenants.

`event_name` is deliberately absent from the logical idempotency key. A producer therefore owns one event-ID namespace across every event type in an authenticated tenant/app scope. Reusing an ID for a different event type is still `duplicate_delivery` when the payload digest is identical and `event_id_conflict` when it differs. The first accepted event name remains canonical; a later cross-type delivery creates no second logical event or fact projection. Conflict payload digests remain protected evidence under the rule above, but they are never eligible for attribution or metrics. Import mappings that route one source ID column into multiple event types should add stable, event-type-specific prefixes or provide an equivalent disjoint namespace.

For `duplicate_delivery` and `event_id_conflict`, `canonical_record_id` is the `record_id` of the first accepted delivery for that logical idempotency key. It identifies the accepted canonical record without replacing later delivery evidence. A `record_id_collision` has no canonical record and therefore must not emit `canonical_record_id`.

## Install anchors and click matching

`installation_id` is an explicit, tenant/app-scoped metric anchor. Exactly one accepted install record may name an installation anchor. Revenue joins only to that single anchor in the same tenant and app; an ambiguous anchor fails closed.

`first_install` must not name `prior_installation_id`. `reinstall` and `redownload` must name a different, already known installation as `prior_installation_id` and create a new `installation_id`. Install type describes the installation lifecycle; it does not decide attribution. A valid paid click/referrer/time chain on a reinstall or redownload is non-organic. A reinstall or redownload with `referrer_status=none` is organic for `no_referrer`. Optional `install_origin=play_first_launch | identifier_reset` records how the SDK established the local installation anchor; omission means `play_first_launch` and does not change attribution.

`click_id` is generated by the redirector from a cryptographically secure random source. Its base64url-compatible representation is at least 22 characters, providing at least 128 bits of source entropy when generated without bias. It is unique within a tenant and app. Install matching considers accepted, unique click deliveries in that scope: zero candidates return `unknown_click_id`, one candidate is evaluated, and two or more return `ambiguous_click_id`. Contract v0.3 never chooses the first candidate. If a future version deliberately permits candidate selection, it must sort by `redirector_click_at` descending, `received_at` descending, and `record_id` ascending, then emit the selected and excluded candidates under a new versioned reason contract.

`referrer_status=third_party` means a referrer exists but does not carry an Open MMP first-party click ID. The closed `third_party_referrer_classification` distinguishes a deployment-confirmed `play_organic_marker`, which yields `organic/no_first_party_referrer`, from `foreign`, which yields `unattributed/foreign_referrer_unresolved`. A first-party-shaped `click_id` that has no accepted ledger click remains `unattributed/unknown_click_id`. The classifier is normalized evidence; raw referrer text remains protected. Detection of a Play organic marker is a deployment mapping and is not guaranteed by the Android Install Referrer API.

## Event names and time authority

Canonical event names are defined by `registries/event-names-v0.3.json`. Each payload is validated by the event-specific schema selected from that registry.

Producer values are closed by `registries/producer-values-v0.3.json`:

| Producer | Contract purpose |
| --- | --- |
| `sdk-android` | Android SDK event delivery. |
| `sdk-ios` | iOS SDK event delivery. |
| `redirector` | First-party redirector evidence. |
| `import:<provider>` | Deployment-private raw-export importer. The public placeholder does not name an incumbent provider. |
| `adapter:<network>` | Deployment-private media API adapter, including cost collection in later Stage B work. |
| `postback:<kind>` | S2S or platform postback receiver, including later SKAN or AdAttributionKit work. |

The provider, network, and postback-kind suffixes are deployment-private mappings. Registry patterns validate syntax only; they do not authorize a source. An M1 runtime must enforce a tenant-scoped private allowlist before contract evaluation. Public fixtures and their golden outputs use only synthetic suffixes.

Raw records may carry `producer_variant` and `wrapper_version` as separate optional provenance fields. `producer_version` remains the core producer version; wrappers such as Unity must not encode their own version by concatenating a delimiter onto `producer_version`.

For Install Referrer attribution:

- `redirector_click_at` is the authoritative click time.
- `install_begin_at_server` is the authoritative install-side time.
- The seven-day window is half-open: `[redirector_click_at, redirector_click_at + 7 days)`. Exactly seven days is expired.
- Device `occurred_at` and device referrer timestamps are evidence only.
- A client timestamp exactly five minutes after receipt is normal. A later value is retained with `clock_skew_suspected=true`.
- Missing authority yields `authoritative_time_missing`; explicitly invalid protected authority evidence yields `authoritative_time_invalid`. Device time never substitutes.

Click payloads may carry the typed reporting dimensions `ad_group_id`, `creative_id`, `network`, `country`, `site_id`, and the protected opaque `remote_click_ref`. Install payloads may carry `country`, `app_version`, `os_version`, `sdk_version`, `ad_tracking_limited`, and `attribution_confirmed_at`. The last field records first-party confirmation time and is distinct from imported `import_context.provider_confirmed_at`.

`referrer_client_response` is evidence-only. Its closed values are `ok`, `service_unavailable`, `feature_not_supported`, `developer_error`, `service_disconnected`, and `permission_error`; none changes attribution by itself. The first five normalize Android Install Referrer client response outcomes. `permission_error` is a defensive integration diagnostic and was not found in the Android client response-code reference checked for this contract.

`ad_impression` is mediation-side impression evidence. `ad_view` is the advertiser-side view event. The two names are not aliases and are retained independently. Ad revenue declares `subject_scope=installation_level | aggregate`; installation-level revenue requires `installation_id`, while aggregate revenue forbids it and is never joined into an installation cohort. Optional mediation, country, and ad-unit dimensions remain evidence. `anchor_source` is accepted only from an authenticated `postback:<kind>` producer because it denotes server-to-server anchoring.

`custom_event` is a closed installation-level envelope. It requires a deployment-catalog key matching `^[a-z][a-z0-9_]{0,63}$`, permits optional contract money, and permits at most 20 scalar attributes whose keys use the same form. Strings are limited to 256 characters; nested objects and arrays are rejected. The public contract validates only this shape. Authorization of a deployment-private event catalog remains a runtime responsibility.

## Consent and withdrawal

Consent is evaluated per server-configured `processing_purpose_id`.

`registries/processing-purposes-v0.3.json` closes the public purpose vocabulary:

| Purpose | Meaning | Illustrative consent default | Illustrative legal-basis category |
| --- | --- | --- | --- |
| `attribution` | Associate eligible evidence with an installation-level or aggregate attribution result. | Required | Consent |
| `fraud_prevention` | Detect and respond to measurement abuse, replay, injection, and invalid traffic. | Not required | Legitimate interests |
| `analytics` | Produce product and measurement analytics outside a provider-reported attribution judgment. | Required | Consent |
| `revenue_measurement` | Process purchase, refund, advertising-revenue, and cost evidence for financial measurement. | Not required | Legitimate interests |

These defaults are contract guidance, not legal advice or runtime authorization. Every deployment must document, version, and approve its purpose-specific policy for each applicable jurisdiction. A deployment may override either default in server configuration; the resulting `consent_required` and `policy_version` are preserved on delivery and raw evidence. An unregistered purpose fails schema validation.

- The server records whether the purpose requires consent and the policy version used.
- A withdrawal has `withdrawal_recognized_at` and a monotonic `withdrawal_recognized_sequence`.
- For a consent-required purpose, a record processed at or after the recognition sequence is rejected regardless of `occurred_at`.
- `consent_changed` and privacy control records remain processable.
- A queued record may be accepted only when it names a server-configured alternative legal-basis ID whose purpose, policy version, and effective time match. Client-supplied legal-basis prose is not sufficient.
- Raw records, deliveries, and rejections preserve the policy version, decision reason, and applicable withdrawal-recognition time.

## Attribution

Every attribution result records:

- tenant and app scope
- `subject_scope`
- status, method, model, and versioned reason
- evidence lifecycle references
- effective, decision, and input-cutoff times
- finality
- rule-bundle ID, version, and digest

`subject_scope` is `installation_level` or `aggregate`. An aggregate result cannot contain installation identity. Compatibility is closed by `registries/compatibility-v0.3.json`.

`organic` means required evidence shows no paid candidate. `unattributed` means evidence is missing, conflicting, expired, unavailable, unsupported, or excluded.

### Imported provider attribution

An accepted install produced by `import:<provider>` may carry the closed `import_context` object. Imported attribution records the provider-reported judgment with `method=imported` and `model=provider_reported`; it never reinterprets that judgment as first-party Install Referrer evidence.

- `provider_attributed=true` with `provider_attribution_strategy=click_through`, `view_through`, `modeled`, or `self_attributed_network` produces `non_organic/provider_attributed` when `provider_confirmed_at` is present, except that `modeled` uses the more specific reason below.
- A provider-attributed modeled conversion produces `non_organic/provider_modeled_conversion`.
- A provider-attributed row without `provider_confirmed_at` produces `non_organic/provider_time_authority_unavailable`; it does not fall through to first-party `authoritative_time_missing`.
- `provider_attributed=false` with strategy `organic` produces `organic/provider_organic`.
- `provider_attributed=false` with strategy `unattributed` produces `unattributed/provider_unattributed`.
- An imported install without `import_context` fails closed as `unattributed/imported/provider_reported/provider_unattributed`; it never falls through to first-party referrer logic.

`import_context` is optional on `click`, `install`, `session_start`, and `ad_revenue`. It preserves the provider name, provider attribution flag and strategy, opaque provider install/click references, opaque campaign/ad-group/creative/site references, network, country, and provider confirmation time. It is closed and protected as raw evidence. The four event schemas reserve and reject `import`, `imported`, `import_*`, `imported_*`, `provider`, and `provider_*` names inside `extensions`; extension values never create imported attribution or reconciliation semantics. `provider_install_ref` is the provider-side install reference used to derive the existing `provider_install_id` matching key. For an imported record, `import_context.provider` must equal the authenticated `import:<provider>` producer suffix.

When an imported attributed install carries `provider_click_ref`, the evaluator resolves it against an accepted, unique first-party `redirector` click in the same tenant and app whose protected `remote_click_ref` equals that value. A unique match adds both click and install records to `evidence_refs`. Zero or multiple matches leave the provider judgment intact without adding a click reference and remain visible to reconciliation. Provider references never turn an imported judgment into first-party Install Referrer attribution.

The canonical provider dimension field names are `provider_network`, `provider_site_ref`, and `provider_country`. They implement the Stage A work-order proposals `network`, `site_ref`, and `country` while preserving the v0.2 closed-context namespace.

### Platform attribution envelopes

Platform attribution remains separate from imported provider judgments and first-party Install Referrer attribution. The compatibility registry permits aggregate SKAdNetwork and AdAttributionKit results, installation-level Meta Install Referrer last-click and view-through results, and installation-level Apple AdServices last-click results.

`skan_postback` and `adattributionkit_postback` are protected, aggregate event envelopes. Their authenticated producer uses a deployment-private `postback:<kind>` mapping; public fixtures use only `postback:synthetic-*` values. Signature material and `signature_verified` are separate fields. Contract v0.3 supports SKAdNetwork major versions 3 and 4, including later minor versions such as 4.1; legacy v1/v2 and future major versions are outside this contract. Version 3 uses `campaign_id` and does not accept v4-only source, sequence, or coarse-value fields. Version 4 requires `postback_sequence_index`, forbids `campaign_id`, and permits at most one of fine and coarse conversion value; fine conversion value is accepted only in sequence 0. AdAttributionKit conversion types are limited to download and redownload; re-engagement is intentionally outside this work order. The optional `signing_key_environment=production | development` records which verified Apple public-key set selected the JWS `kid`; development keys MUST be rejected unless deployment policy explicitly enables them. The reference evaluator emits:

- `unattributed/skan_signature_invalid` when signature verification fails;
- `unattributed/postback_not_winner` when a verified postback has `did_win=false`;
- `unattributed/crowd_anonymity_suppressed` when a winning postback omits its source identifier;
- `unattributed/conversion_value_null` when a winning postback contains neither a fine nor coarse conversion value; or
- `non_organic/skan_postback_verified` when the verified winning aggregate envelope contains both source and conversion evidence.

`postback_not_winner` is distinct from crowd-anonymity suppression: a losing-copy signal does not claim that Apple withheld a field for privacy. Only `did_win=true` postbacks contribute to attributed-install or conversion metrics. Advertiser postback copies do not expose the denominator of all eligible impressions, so win rate and impression share MUST NOT be derived. SKAdNetwork `transaction_id` and AdAttributionKit `postback_identifier` are the source deduplication identifiers. Their signature verification, duplicate rejection, and any deployment-private key material occur before contract evaluation; the public contract stores the normalized result and protected evidence, never a private verification key.

The install envelope may carry a closed `adservices_context`. `status=attributed` requires `attribution=true` and yields `non_organic/apple_adservices/last_click/adservices_attributed`. `status=token_expired`, `status=not_attributed`, and `status=lookup_unavailable` require `attribution=false` and respectively yield `adservices_token_expired`, `adservices_not_attributed`, and `adservices_lookup_unavailable`. An iOS install uses `install_origin=ios_first_launch` and `referrer_status=not_applicable`; that referrer state alone yields `unattributed/none/none/platform_referrer_not_available` when no higher-priority Apple evidence exists. `conversion_type`, when present, is closed to Apple's `Download | Redownload | PreOrder` values. Campaign, ad-group, keyword, ad, placement, country, conversion, claim, click-date, and impression-date values are retained only when supplied by the verified Apple response.

The install envelope may carry one of six `meta_referrer_status` values: `provider_unavailable` when the content provider cannot be resolved, `app_version_unsupported` when the installed provider cannot satisfy the integration, `no_campaign_data` when the provider returns no campaign row, `decrypt_failed` for malformed decrypted content, `auth_failed` for an authentication-tag or key failure, and `decrypted` for validated normalized evidence. Only `decrypted` creates Meta attribution. `decrypt_failed` and `auth_failed` yield `unattributed/meta_install_referrer/<model>/meta_referrer_decrypt_failed`; the other non-decrypted states continue through ordinary first-party evidence rules. If decrypted Meta evidence and a resolvable first-party click coexist, Meta Install Referrer wins and emits `meta_referrer_decrypted`; the first-party click remains protected evidence and is not selected. This ordering follows Meta's documented deduplication guidance.

For `decrypted`, the closed `meta_referrer_context` may retain `campaign_group_id`, `campaign_id`, `adgroup_id`, `ad_id`, `account_id`, `ad_objective_name`, `is_instagram`, `publisher_platform`, and `platform_position`. Free-form `*_name` fields are deliberately excluded. The outer `is_ct` evidence is `1` for click-through and `0` for impression; `actual_timestamp` is the source click or impression time in seconds. These two outer values are evidence and do not replace the authoritative Install Referrer timestamps used by first-party window evaluation.

The following primary Apple documentation was rechecked on 2026-08-20:

- SKAdNetwork postback parameters: <https://developer.apple.com/documentation/storekit/identifying-the-parameters-in-install-validation-postbacks>
- SKAdNetwork signature verification: <https://developer.apple.com/documentation/storekit/verifying-an-install-validation-postback>
- SKAdNetwork multiple conversion windows: <https://developer.apple.com/documentation/storekit/receiving-postbacks-in-multiple-conversion-windows>
- AdAttributionKit postback parameters: <https://developer.apple.com/documentation/adattributionkit/identifying-the-parameters-in-a-postback>
- AdAttributionKit postback verification: <https://developer.apple.com/documentation/adattributionkit/verifying-a-postback>
- AdAttributionKit advertised-app configuration and the literal `AttributionCopyEndpoint` property: <https://developer.apple.com/documentation/adattributionkit/configuring-an-advertised-app>
- AdAttributionKit and SKAdNetwork interoperability: <https://developer.apple.com/documentation/adattributionkit/adattributionkit-skadnetwork-interoperability>
- Apple AdServices attribution token and response: <https://developer.apple.com/documentation/AdServices/AAAttribution/attributionToken%28%29>

The following Android and Meta primary documentation was checked on 2026-08-19:

- Android Install Referrer client response codes: <https://developer.android.com/reference/com/android/installreferrer/api/InstallReferrerClient.InstallReferrerResponse>
- Android Install Referrer response fields: <https://developer.android.com/reference/com/android/installreferrer/api/ReferrerDetails>
- Android Install Referrer service contract: <https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice>
- Meta Install Referrer: <https://developers.facebook.com/documentation/app-ads/meta-install-referrer>
- Meta Google Play Install Referrer integration: <https://developers.facebook.com/documentation/app-ads/install-referrer>

Meta documents the outer `is_ct` mapping, the seconds unit for `actual_timestamp`, the normalized decrypted fields above, and its deduplication guidance. Optional Instagram fields and their possible values are documented as samples rather than an exhaustive future-proof enum. Android documents no organic-result enum; the `play_organic_marker` classification therefore remains an explicit deployment mapping. `permission_error` remains a defensive integration diagnostic rather than an Android-documented client response code.

## Money, FX, cost, and cohort metrics

Source money is:

- `amount_unscaled`: nonnegative integer string
- `amount_scale`: integer from 0 through 18
- `currency`: uppercase ISO 4217 code

The reference evaluator joins installation-level revenue to one explicit accepted installation anchor with the same authenticated tenant, app, and `installation_id`. It converts each source event independently to the metric currency with integer arithmetic and half-even rounding, then sums the rounded target units. Rounding only after summing unrounded source values is not conforming. Metric runs record the FX rate, source, as-of time, rate-snapshot digest, policy version, and rounding mode.

Imported source money with an absent or empty upstream currency is normalized before contract ingress. The deployment supplies an uppercase ISO 4217 `currency`, and the event records `currency_source=default`; an explicit upstream value records `currency_source=reported`. Empty currency strings are never accepted by the closed event schema.

All amounts are nonnegative; direction is expressed by event type and `financial_status`. A refund is a refund event, not a negative purchase or ad-revenue amount.

An ad-revenue event may record `revenue_precision=exact | estimated | publisher_defined | undefined`. Precision is source provenance: it does not change the money representation, FX calculation, rounding, or aggregation rule. This vocabulary follows the MAX Android impression-level revenue API checked on 2026-08-19: <https://support.applovin.com/en/max/android/overview/advanced-settings>.

The three baseline v0.2 definitions are:

- `d0_install_to_24h_ad_revenue_usd`: `[install.occurred_at, install.occurred_at + 24 hours)`
- `d0_utc_install_calendar_ad_revenue_usd`
- `d0_jst_install_calendar_ad_revenue_usd`

Metric names are stable aliases; the definition fields remain authoritative.

Apple aggregate postback metrics use three closed v0.3.3 definitions: `skan_attributed_installs`, `skan_conversion_value_distribution`, and `aak_attributed_installs`. Despite the historical `*_installs` aliases, these values count qualified, accepted, deduplicated postback events; they do not claim a unique-device or unique-install denominator that Apple does not expose. A postback qualifies only when its aggregate attribution is `non_organic`, which requires a verified signature, `did_win=true`, a source identifier, and a fine or coarse conversion value. The metric day is derived from the protected server `received_at` in UTC because the aggregate postback does not carry an occurrence time. `attribution_status` grouping is forbidden for these already-qualified aggregate series.

`skan_conversion_value_distribution` emits one scalar count row per `apple_conversion_bucket`. The closed bucket encoding is `fine:0` through `fine:63` or `coarse:low | coarse:medium | coarse:high`; a definition and evaluation for this metric must include exactly one bucket. The two aggregate count metrics forbid the bucket. Deterministic click/install event counts continue to use their event `occurred_at` and cannot use `apple_conversion_bucket`, so deterministic and platform aggregate measurement cannot be combined in one metric definition.

Metric definitions are data, not hard-coded evaluator branches. A definition declares its name and version, anchor, time zone, value type, structured calculation, window, activity-event set when applicable, grouping dimensions, and rule-bundle identity. `activity_events` defaults semantically and in the schema annotation to `session_start` for retention when omitted by a deployment-owned definition. When both a normalized direct event dimension and the corresponding imported evidence dimension are present, the direct field is authoritative for grouping; the imported value remains protected evidence. Metric runs repeat the value type and include either money fields, a ratio scale, or a count value. Optional grouping stores typed dimensions and `dimension_digest=SHA-256(JCS(dimensions))` over exactly the dimensions present. `attribution_status=organic | non_organic | unattributed` is a closed grouping dimension; records from different statuses cannot be blended into one cohort row. Organic and unattributed ROAS groups do not inherit non-organic acquisition cost and therefore emit `undefined/no_attributed_cost` when no eligible cost exists.

Cost records are append-only imported reports. Their required identity is tenant, app, network, campaign, acquisition date, money, source, `as_of`, report-snapshot digest, and a dimension digest. `ad_group_id` and `country` are optional. `dimension_digest` is SHA-256 over RFC 8785 JCS of exactly the present ordered-key object drawn from `network`, `campaign_id`, `ad_group_id`, and `country`. For each `(tenant_id, app_id, dimension_digest)`, the current row is the latest `as_of` at or before the metric watermark. Revisions do not overwrite older rows.

The reference definitions support elapsed-window D1, D3, and D7 ROAS, activity-day D1 and D7 retention, cohort LTV, and cohort installation count. Cohort grouping is anchored to the install and may include campaign, network, country, and the install date in the metric time zone. Revenue windows are half-open from install time through `install + (N + 1) days`; retention counts installations with an accepted configured activity event on activity day N; cohort LTV divides cumulative rounded revenue by cohort size; ROAS divides cumulative rounded revenue by the current acquisition-date cost snapshot.

Metric-run values have an optional `value_state=present | undefined`. Absence of `value_state` is semantically `present`, preserving every v0.2.0 metric run. A present run requires `value_unscaled` and forbids `undefined_reason`. An undefined run requires exactly one versioned reason from `no_attributed_cost`, `no_activity_events`, or `empty_cohort` and omits `value_unscaled`; money currency, amount-scale, and FX fields are no longer required for that undefined result. Its `value_type`-specific structural field such as `ratio_scale` remains present. Missing eligible cost therefore yields `undefined/no_attributed_cost`; it never becomes zero or infinity. `no_activity_events` means the approved import profile cannot supply a configured activity event, while `empty_cohort` means the selected cohort contains no eligible installation.

## Input snapshots and recalculation

Each metric evaluation sets an inclusive `input_received_at_watermark`. Its input set contains accepted unique records whose `received_at` is at or before the watermark.

Snapshot rows are sorted by `(received_at, record_id)` and contain:

- `received_at`
- `record_id`
- evidence lifecycle status for that evaluation
- policy digest

When a metric uses cost, the snapshot also includes the selected current cost row as `['cost', as_of, cost_record_id, report_snapshot_digest, dimension_digest]`. Cost rows participate in `input_snapshot_id`, evidence, and reproducibility even though the raw-event `input_ledger_position` remains the last accepted event record.

`input_snapshot_id` is the JCS/SHA-256 digest of those rows. `input_ledger_position` is the final `received_at|record_id` pair. A later eligible record produces a different snapshot and an immutable replacement run with `supersedes_metric_run_id`.

## Corrections, privacy, and reproducibility

Refund corrections identify `correction_target_record_id`. Out-of-order arrival does not change the causal target.

A privacy request carries `deletion_subject_ref` only while it is active. On completion, that reference is removed and replaced by `deletion_subject_digest`, computed as HMAC-SHA-256 over the deployment's canonical deletion-subject namespace. The HMAC key is deployment-private and is not part of the public contract. The digest supports duplicate-request control without retaining the original subject identifier.

Every privacy request records `requested_via` and an opaque, non-identifying `requester_auth_ref` that points to a server-side authentication decision; raw credentials, bearer tokens, installation IDs, device identifiers, and personal data are forbidden in that reference. `tenant_admin_api` requests rely on authenticated tenant administration. An `on_device_sdk` request is limited to `deletion_scope=installation`: before accepting it, the server MUST resolve the authentication reference to the requesting installation and verify that `deletion_subject_ref` is exactly that installation's own `installation_id`. Merely knowing or supplying an installation ID is not authorization. That equality check occurs before a completed request replaces the subject reference with its digest. The contract vocabulary does not assert that a runtime milestone exposes an on-device endpoint; a runtime without device authentication MUST reject that route explicitly at its API boundary.

A completed privacy request lists affected record IDs and whether each protected payload becomes `redacted` or `purged`. The evaluator emits:

- an immutable correction for each affected record
- a non-identifying tombstone with plaintext `reason_code` and `policy_version`, plus `provenance_digest`
- evidence references with `available | redacted | purged`
- a replacement metric run with `redaction_affected` or `retention_affected`

Affected raw and logical evidence is removed from the retained-evidence output and replaced by the tombstone. The prior run remains immutable. After lawful evidence removal, the contract promises explainable recalculation, not bit-identical replay of deleted evidence.

`provenance_digest` is a tamper-evident anchor, not a secrecy mechanism. It is lowercase SHA-256 over RFC 8785 JCS UTF-8 bytes of the ordered object `{tenant_id, app_id, privacy_request_id, record_id, completed_at}`. Its input fields remain independently governed by the privacy contract; hashing them does not make identifying input safe to publish.

## Shadow reconciliation

The public Shadow Import Profile is vendor-neutral. Deployment-specific provider mappings, formats, and operational data remain private.

Inputs contain typed matching keys, candidate rows, window status, freshness, and exclusions. The evaluator derives a versioned neutral difference reason:

- `matched`
- `candidate_missing`: a provider-side `provider_click_id` or `provider_install_id` reference requires a first-party counterpart, but no internal candidate record exists.
- `candidate_excluded`
- `window_mismatch`
- `join_key_missing`
- `join_key_ambiguous`
- `freshness_mismatch`
- `external_row_unmatched`: an external row using another approved matching-key type has no internal candidate under any supplied key.
- `redaction_caused_recalculation`
- `currency_policy_mismatch`
- `scope_mismatch`
- `provider_modeled_conversion`

Results record both snapshot IDs, matching keys used, candidates, exclusions, windows, joins, and freshness. Difference reasons describe measurement semantics and available evidence; they never rate provider quality.

For each accepted unique imported install, the evaluator also derives reconciliation input without requiring fixture- or caller-authored `reconciliation_inputs`; that fixture-envelope field is optional:

1. `provider_install_ref`, when present, becomes a protected, tenant/app-scoped, one-to-one `provider_install_id` key.
2. `provider_click_ref`, when present, maps to the existing protected, tenant/app-scoped, one-to-one `provider_click_id` matching-key type. The payload field keeps the opaque-reference name, while the WO-2 matching-key vocabulary remains canonical.
3. The normalized imported install is the candidate for the provider row and carries the same typed keys. Candidate identity is the accepted `record_id`.
4. Provider-reported attribution does not claim a first-party seven-day window, so the derived candidate window is `not_applicable`; freshness is `current` at import evaluation.
5. At least one derived key yields `matched`. No provider install or click reference normally yields `join_key_missing`. If the provider explicitly marked that keyless external row as modeled, it yields `provider_modeled_conversion` instead: the row is classified as provider-modeled without an internal candidate, not treated as an unexplained provider-quality failure.

Provider install and click key values never expose the source reference. Both automatically derived and manually supplied provider keys require `value_encoding=sha256`, `access_class=protected`, and a lowercase 64-character digest. The digest is `SHA-256(JCS({provider,type,value}))`, where `provider` is the deployment-private provider alias, `type` is the canonical matching-key type, and `value` is the raw opaque provider reference. This provider namespace prevents equal raw references from colliding across providers. Comparison, ordering, and rendered join evidence include `value_encoding`; raw references remain only in protected event evidence. Hashing prevents direct disclosure in reconciliation output but is not a secrecy guarantee for low-entropy source values.

Manually supplied reconciliation input remains supported for other synthetic contract scenarios and must apply the same provider-key digest rule before evaluation. A manual and derived row may not reuse the same tenant/app/reconciliation identity.

## Public fraud envelope

The public contract exposes only the decision, action, high-level reason category, evidence type/digest/access class, rule-bundle digest, and evaluation time. Synthetic `bot_prefetch`, `replay_suspected`, and `click_injection_suspected` fixtures demonstrate this envelope. Replay suspicion is a fraud-decision category, not a substitute for `duplicate_delivery` or idempotency classification.

Click-to-install time (CTIT) is `install_begin_at_server - redirector_click_at`, using only server-authoritative timestamps. `redirector_click_at` is the canonical v0.3 field corresponding to the work-order term `referrer_click_at_server`. The fixture server context carries a closed `click_injection_policy`; its default threshold classifies a nonnegative CTIT strictly below 10 seconds as `click_injection_suspected`. Exactly 10 seconds is outside that category. This public rule demonstrates deterministic contract behavior only. Production thresholds, features, and response policy remain deployment-private, versioned controls.

Production signals, IP or User-Agent values, live thresholds, model weights, watchlists, keys, and response timing remain private and access-controlled.

## Reviewed fixture and validation gate

The reviewed gate compiles 27 schemas and validates 8 registries. The 47 fixture directories contain synthetic input plus 13 reviewed golden output classes: raw records, deliveries, logical events, corrections, privacy requests, privacy tombstones, attributions, metric definitions, metric runs, cost records, public fraud decisions, rejections, and reconciliation. Fixture 10 demonstrates both paid reinstall attribution and no-referrer redownload attribution. Fixtures 28 through 32 exercise imported attribution, automatically derived reconciliation, every registered producer form, and stale-evidence rejection. Fixture 33 exercises reporting dimensions, advertiser-side ad views, installation and aggregate revenue, default-currency provenance, append-only cost revisions, per-event half-even FX, attribution-status-separated ROAS, retention, and cohort LTV/count. Fixture 34 exercises every Stage C method/model row, both Apple aggregate event names, every Stage C reason, synthetic postback producers, and typed Meta evidence. Fixture 35 exercises authenticated tenant-admin and on-device privacy-request provenance plus same-installation scope enforcement. Fixture 36 exercises the child-directed audience boundary without adding an advertising identifier to the canonical event vocabulary. Fixture 37 proves that an organic cohort without attributed cost emits an undefined ROAS rather than zero or infinity. Fixture 38 classifies a modeled external row without an internal candidate as `provider_modeled_conversion`. Fixture 39 classifies a foreign third-party referrer. Fixture 40 validates the closed custom-event envelope plus wrapper provenance. Fixture 41 derives the public click-injection category from server CTIT. Fixture 42 exercises the v0.3.1 `metric_date` dimension with deterministic daily click and organic-install event counts. Fixture 43 exercises the v0.3.2 iOS first-launch, platform-referrer, AdServices outcome, AAK signing-environment, and SKAN minor-version vocabulary. Fixture 44 exercises the v0.3.3 qualified SKAN/AAK postback counts and fine/coarse SKAN conversion buckets. Fixture 45 exercises the v0.3.4 iOS conversion-schema provenance pair and the opt-in conversion-value lifecycle event. Fixture 46 reserves server-assigned Play Integrity and App Attest evidence without making it an attribution or metric input. Fixture 47 exercises the non-identifying payload-schema rejection boundary without storing the rejected payload. Fixtures 25, 33, and 34 collectively exercise every registered processing purpose. Validation also exercises invalid calendar timestamps, reconciliation reasons, attribution supersession, replay suspicion, retention expiry, impression-to-revenue evidence, reorder invariance, install-type evidence dominance, record-ID collision, click ambiguity, millisecond normalization boundaries, scoped-reference mutations, child-directed advertising-identifier rejection, CTIT boundaries, custom-event bounds, platform-integrity closure, Apple aggregate qualification and receipt-date authority, and unknown-purpose rejection; golden files remain committed review artifacts.

The literal validation summary is: `Validated 27 schemas, 8 registries, 47 reviewed fixtures, 611 golden output artifacts, 47 scenario assertions, 26 acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance.`

The validation command never writes fixture files. `npm run validate`:

1. type-checks the TypeScript implementation;
2. compiles every Draft 2020-12 schema;
3. validates registry shape, uniqueness, and cross-references;
4. validates every input event through its event schema;
5. validates all 611 golden output artifacts;
6. runs named assertions for all 47 scenarios and 26 acceptance criteria (AC01-AC26);
7. runs deliberate negative mutations;
8. runs the TypeScript evaluator twice;
9. runs the independently implemented Python evaluator;
10. compares RFC 8785 canonical output and a numeric/string conformance vector.

Environment setup is `npm ci` and `python -m pip install --require-hashes --requirement requirements-contract.txt`.

## Changes from v0.2.1

### v0.3.6 patch release

- R-27 adds the additive `payload_schema_invalid` rejection reason and a closed fixture-only pre-ingestion decision envelope. Existing event payloads and artifact meanings are unchanged.
- The contract gate and runtime importer share the same compiled event-schema dispatcher. Invalid normalized payloads are discarded before evidence or fact persistence; only non-identifying delivery and rejection artifacts remain.
- Fixture 47 exercises the new reason with synthetic metadata and no rejected payload. Schema `$id` values and event-version constants remain on the v0.3 line, and all earlier goldens remain unchanged.

### v0.3.5 patch release

- R-27 reserves optional, server-assigned `integrity_verdict` evidence on raw records and fixture ingress envelopes. The closed evidence records a platform (`play_integrity` or `app_attest`), a neutral verdict (`verified`, `failed`, or `unavailable`), evaluation time, policy version, and a protected opaque evidence reference when evidence exists.
- Integrity evidence is not client-authored and does not independently determine attribution, public fraud classification, or metric eligibility. Raw provider tokens, device identifiers, account identifiers, and provider response bodies are outside the public contract.
- Fixture 46 exercises both platforms and all three verdicts with synthetic protected references. Its attribution outputs prove that integrity evidence does not replace platform-referrer evidence. Schema `$id` values and event-version constants remain on the v0.3 line, and all earlier goldens remain unchanged.

### v0.3.4 patch release

- M4-D-20 makes no typed install-schema change. The bundled iOS conversion schema version and SHA-256 digest remain deployment-private evidence in the existing `install.extensions` surface.
- The closed custom-event vocabulary admits the exact reserved `openmmp.conversion_value_updated` key. The iOS SDK emits it only when conversion-value logging is explicitly enabled; it does not alter attribution or metric semantics.
- Fixture 45 supplies the two synthetic events and thirteen independently reviewed golden classes. Schema `$id` values and event-version constants remain on the v0.3 line, and all earlier goldens remain unchanged.

### v0.3.3 patch release

- R-27 adds Apple aggregate postback metric semantics without changing any existing event or metric definition. The `event_count` selector admits `skan_postback` and `adattributionkit_postback`; new aggregate definitions use UTC `received_at` calendar days and reject `attribution_status` grouping.
- Metric definitions, metric runs, and fixture evaluations add the optional `apple_conversion_bucket` grouping dimension. It is required only by `skan_conversion_value_distribution` and is structurally forbidden for the other aggregate counts and deterministic event-count definitions.
- Fixture 44 supplies the three new definitions, four scalar evaluations, and independent reviewed golden evidence. Schema `$id` values and contract event versions remain on the v0.3 line, and all earlier goldens remain unchanged.

### v0.3.2 patch release

- R-27 and M4-H-1 add the optional AdServices outcomes `not_attributed` and `lookup_unavailable`, each structurally requiring `attribution=false` and each retaining a distinct neutral attribution reason.
- M4-H-2 adds `referrer_status=not_applicable`, `install_origin=ios_first_launch`, and `platform_referrer_not_available`, so an iOS first launch does not pretend that the Play Install Referrer path exists.
- M4-H-3 adds the optional AdAttributionKit signing-key environment and fixes the winner-only metric boundary: an advertiser copy cannot support a win-rate denominator.
- M4-H-4 accepts later minor versions within supported SKAdNetwork majors 3 and 4 while continuing to reject v1, v2, and unknown future majors.
- Schema `$id` values and registry filenames remain on the `v0.3` minor line. Existing v0.3.0/v0.3.1 artifacts and all prior goldens remain unchanged.

### v0.3.1 patch release

- R-27 and M3-H-1 add the optional `metric_date` grouping dimension to metric definitions, metric runs, and fixture evaluations. Existing groupings and every v0.3.0 golden retain their meaning.
- Daily event counts use the additive `event_count` calculation with exactly one supported `event_names` value (`click` or `install`) and a required `metric_date` grouping. `metric_date`, the `events` numerator, and `event_names` are reserved for `event_count`; other calculations continue to use cohort dimensions. `attribution_status` is valid only for an install event count, because clicks do not carry installation-attribution status. The v0.3.1 `daily_click_count` and `daily_install_count` definitions use a UTC calendar-day anchor and emit count-valued metric runs.
- M3-H-2 resolves aggregate attribution-method display without a new artifact field: an aggregate is identified by its rule-bundle id/version/hash and broken down by `attribution_status`. A single attribution method label would be false for an aggregate that may mix decision methods.
- Schema `$id` values and registry filenames remain on the `v0.3` minor line. Existing event `contract_version`, event `schema_version`, and v0.3.0 outputs remain valid.

### Preserved v0.2.1 patch behavior

- R-23 adds the optional metric-run `value_state` and `undefined_reason` fields. Omitted `value_state` retains the v0.2.0 present-value meaning, so existing metric-run goldens are unchanged.
- In the preserved v0.2.1 line, R-23 adds `provider_modeled_conversion` to the difference-reason registry and reconciliation schema. Only that new v0.2.1 reason uses `difference_reason_version=0.2.1`; the older reasons remain `0.2.0`. The v0.3 in-place migration advances every reconciliation reason to `0.3.0`.
- Schema `$id` values and registry filenames retain the `v0.2` minor-line identity. Existing v0.2.0 event, fixture-envelope, and output artifact versions remain valid where their artifact schema did not change.

### v0.3.0 minor release

- The in-place v0.3 contract uses `:v0.3` schema identifiers, `0.3.0` object versions, v0.3 registries, and `fixtures/v0.3/`; the immutable v0.2.1 baseline is the `contract-v0.2.1` Git tag.
- Logical-record lifecycle and protected-payload availability are separate axes: `record_lifecycle` is `active | retracted`, while payload/evidence lifecycle is `available | redacted | purged`.
- Money uses the shared nonnegative type for ad revenue, purchase, and refund. FX rates are represented by integer `fx_rate_unscaled` and `fx_rate_scale` fields.
- Schema enums and registries are checked as equal sets for attribution, rejection, correction, consent-decision, and public fraud reasons.
- Evidence references require `access_class`; aggregate and installation subjects use structurally distinct `subject_ref` namespaces.
- Secure redirector click IDs require a base64url-compatible value of at least 22 characters. Relevant identifier fields use common ID definitions.
- `canonical_record_id`, invalid timestamp rejection, completed privacy-subject HMAC handling, tombstone provenance, and retention-expiry recalculation are defined explicitly.
- Metric definitions are reviewed fixture outputs. Eight additional required scenarios cover invalid timestamps, three reconciliation differences, attribution supersession, replay suspicion, retention expiry, and impression-to-revenue linkage.
- Stage A of the v0.2 extension adds provider-reported attribution as a separate imported method, closed import context, automatic import reconciliation, explicit producer forms, and `timestamp_stale`; none of these changes name or rate an incumbent provider.
- Stage B adds typed click/install reporting dimensions, advertiser-side `ad_view`, scoped ad revenue, append-only cost records, data-driven metric definitions, per-event half-even conversion, and deterministic ROAS, retention, and cohort metrics.
- Stage C adds aggregate SKAdNetwork and AdAttributionKit envelopes, a closed minimal Meta Install Referrer envelope, Apple AdServices evidence, platform-specific compatibility rows, and versioned platform attribution reasons. Provider fields that could not be verified from primary documentation are deliberately absent.
- Stage D adds the closed processing-purpose catalog and schema-level purpose validation. R-19 adds authenticated tenant-admin and same-installation on-device privacy-request provenance. R-20 adds the optional app-audience classification, preserves `general` as the default, and structurally excludes reserved advertising-identifier fields from child-directed payloads.
- Stage E aligns the public security, deployment, milestone, and serialization documentation with the completed v0.2 contract without adding runtime claims.
- Contract v0.3 adds third-party-referrer classification, explicit Meta evidence and precedence, imported click evidence, attribution-status grouping, a closed custom event, public click-injection classification, ad-revenue precision, and wrapper provenance. It also fixes the deterministic distinction between `candidate_missing` and `external_row_unmatched`.
- Full migration details and the golden-change ledger are in `docs/contract-v0.3-migration.md`.
