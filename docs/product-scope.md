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
- Direct deep-link destinations delivered through Android App Links and iOS Universal Links
- Android-only deterministic deferred destinations carried through Google Play Install Referrer
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
- User-level attribution for a media network when access requires partner-MMP status or non-public provider evidence

## Final adapter boundary

The supported measurement boundary is first-party links and events, Meta Install
Referrer evidence, Apple Ads through AdServices, and Apple aggregate developer
postbacks. AppLovin MAX supplies impression-revenue evidence only; it is not a
user-level install-attribution adapter. TikTok, AppLovin, Unity Ads, and
Mintegral user-level attribution is structurally unavailable to this
self-hosted public implementation when the required evidence is restricted to
partner MMPs. Adding a network requires a new owner decision, current primary
documentation, a least-privilege public integration surface, synthetic
fixtures, and neutral discrepancy semantics.

Direct deep linking is deterministic on Android and iOS. Deferred deep linking is deterministic on Android only. On iOS, OpenMasu delivers deep links to users who already have the app, using Universal Links. It does not deliver a deep link to a user who installs the app after tapping a link. Every mechanism that would make that possible either requires deriving an identifier from device signals, which Apple's Developer Program License Agreement prohibits and which this project does not do, or requires a user-visible prompt on first launch. If Apple provides a channel that carries a destination through installation, OpenMasu will use it.

M5 production controls make the repository safer to operate, but they do not
turn a synthetic CI milestone into a production service. TLS termination,
external secret management, real backup recovery, real load, provider/device
validation, integrity-service projects, and incident operations remain outside
the code gate.

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
