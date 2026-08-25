# MVP Product Scope

## Problem

Small app teams need a self-hosted way to measure ad clicks, installs, and key in-app events while retaining enough evidence to audit the SDK, server, attribution rules, and reported totals.

## Initial users

- Developers operating their own mobile apps
- Growth operators validating campaign-level installs
- Data teams reconciling an existing MMP, media reports, and first-party raw data

Serving as a third-party measurement provider for unrelated advertisers is outside the initial MVP.

## Product entry point: Shadow MMP

The first useful product runs alongside an existing MMP rather than replacing it.

- Store first-party events independently
- Import existing MMP and media outputs
- Normalize inputs into a versioned event and metric contract
- Recalculate attribution and revenue using explicit rules
- Explain differences through candidate evidence, exclusions, windows, joins, and data freshness
- Reduce dependency only after a real shadow pilot validates a specific measurement path

Difference reasons are neutral measurement-semantic categories (such as window, join, freshness, scope, redaction, currency, or policy); they do not score provider quality.

## Phase 1 native vertical slice

### Android and Unity SDK

- App-scoped random `installation_id`
- Google Play Install Referrer retrieval
- `install`, `session_start`, and custom event delivery
- Persistent offline queue, retry, and batching
- On consent withdrawal, purge or immediately redact queued events for consent-required purposes; post-withdrawal acceptance requires a documented alternative legal basis per purpose
- Event-level idempotency
- Collection disablement and local identifier reset
- Unity C# surface backed by an Android Kotlin bridge

### Measurement links

- Links containing `app_id`, `campaign`, `ad_group`, and `creative`
- Cryptographically random `click_id`
- Google Play `referrer` containing the click ID
- Minimal metadata for abuse investigation
- No persistent storage of raw IP addresses in the application database

### Ingestion and attribution

- Deterministic click-to-install matching
- Seven-day last-click window for the MVP
- Explicit organic and unattributed classifications for missing, expired, conflicting, or unknown evidence
- Explicit unattributed classifications for unsupported or unavailable Install Referrer paths
- Required attribution method, reason code, input cutoff, and rule version
- Recalculation from immutable or lawfully redacted source records

### Reporting

- Clicks, installs, and key events by date, app, and campaign
- Organic, non-organic, and unattributed separation
- JSON and CSV export
- UTC storage with an explicit reporting time zone
- Attribution method and data freshness in every aggregate

## Explicit non-goals

- Device fingerprinting
- Presenting probabilistic estimates as deterministic attribution
- Initial ad-cost API coverage for every media network
- Real-time bidding, ad delivery, or audience targeting
- User-level cross-app tracking on iOS
- Persistent device identifiers justified as fraud prevention
- Immediate replacement of an existing production MMP

## MVP evidence gates

1. A test measurement link can reproduce the redirect flow used by Google Play.
2. A test Android app can retrieve the referrer on first launch.
3. Duplicate deliveries normalize to one logical install without hiding conflicts.
4. In-window clicks attribute to a campaign; other cases receive explicit organic or unattributed reasons.
5. Raw records and aggregate totals can be reconciled through a documented query or evaluator.
6. The SDK sends no new events after collection is disabled.
7. An installation-scoped deletion request removes identifiable data and triggers aggregate recalculation.
8. Shadow results remain labeled as unverified until compared against real campaigns for an adequate observation period.
9. Android Auto Backup/device-transfer testing shows that an `installation_id` is not restored onto another device.

## Measurement terminology

Deterministic Install Referrer results and delayed, noisy, or aggregate platform privacy reports are separate data series. A combined view must preserve their individual methods and uncertainty.
