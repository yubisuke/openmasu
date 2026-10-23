# Project Status

Updated: 2026-10-24. This page describes the current `main` source tree.
Implementation and synthetic verification are not live operational qualification.

## Release snapshot

| Line | Identity and evidence |
| --- | --- |
| Published prerelease | `v0.3.0-rc.2` at `d775cc9`; eight verified SDK assets and exact-commit full CI |
| Synthetic SDK onboarding | Published rc.2 Android SDK/backend journey passed on JVM/Robolectric API 24; later harness evidence is recorded separately |
| Latest stable source release | `v0.2.0`; later features belong to newer source, not this tag |
| Current source | Contract patch ledger through v0.4.24; wire/package identity `0.4.0`, schema URNs `:v0.4`; 28 schemas, 8 registries, 71 fixtures, 923 golden artifacts |

`v0.3.0-rc.2` is the current published source and SDK release, marked as a
prerelease. Its [release page](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.2)
and [publication receipt](validation/v0.3.0-rc.2-publication.md) identify source
`d775cc950bdc06c0c929c9d17e2274ec4afbe9cf`, exact-commit CI and eight public
assets re-downloaded and verified on 2026-10-24. The
[frozen integration record](validation/v0.3.0-rc.2-synthetic-evidence.md) and
[release notes](releases/v0.3.0-rc.2.md) retain their pre-publication evidence
boundaries; the separate receipt records publication without rewriting them.

## What the status means

- **Implemented:** code exists.
- **Synthetically verified:** the relevant repository or CI gate passed.
- **Operator-verified:** a named private deployment/device/provider check passed.
- **Unverified:** the required evidence has not been collected; it is not a pass.

All capabilities below are implemented with synthetic evidence unless a narrower
qualification is stated. No row establishes production readiness.

## Current capabilities and limits

| Capability | Current source | Residual boundary |
| --- | --- | --- |
| Contract and evaluator | Reviewed fixtures, deterministic TypeScript/Python, canonical artifacts and independent SQL metric parity | Real-input representativeness and external adoption |
| Receipt and import | Durable SDK/backend admission; explicit raw-event, cost and revenue mappings; atomic records, schema rejection, idempotency and bounded bulk import | Real exports/credentials are not repository evidence; mappings remain explicit |
| Attribution | First-party Install Referrer, verified platform evidence and imported provider judgments remain separate; recorded exclusions and reasons | No probabilistic identity, blanket partner coverage or external-equivalence claim |
| Apple aggregate measurement | Signed synthetic receivers, separate bounded observations, registered event/revenue meaning profiles and window-local SDK state | Postbacks are not unique installs; selected-schema decoding is unverified, not actual revenue or a verified postback binding; live delivery is unverified |
| Acquisition and money | Selected native/platform/imported profiles; safe cost grain; purchase/refund/reversal, ROAS/LTV, saved FX and native D7 same-set KPIs | Profiles have explicit source, currency and window limits; no inferred cost ownership/allocation or live FX service |
| Retention and outcomes | Opt-in D3/D14/D30 retained-installation horizons and multiple custom D7 outcome keys | Incomplete windows are not zero; native/platform/imported populations stay separate |
| Calendar metrics | Explicit UTC, Tokyo and New York calendar definitions coexist with historical elapsed definitions | Other zones are not qualified; time-zone-data upgrades require boundary requalification |
| Ongoing calculation | Durable daily schedules, bounded target discovery, Google/Apple cost refresh, saved replay and explicit/opt-in automatic corrections | Not every profile supports discovery or automatic correction; no implicit all-history scan; live cost access and billing agreement remain unverified |
| Dashboard and comparison | Server-rendered reader-only reports; saved filters, bounded previous-period views and operands; external revenue/ROAS/LTV, retention and outcome declarations via the same offline/web comparator | External meaning remains operator-declared; no provider completeness, imported-binding or engagement-equivalence claim; incompatible/missing/undefined/zero remain distinct |
| Setup and diagnostics | Recommended measurement form, recent event/SDK-version classes and confirmation-bound ingest recovery | SDK versions are client-declared; absent receipts do not prove an outage; invalid/deleted/claimed evidence is not replayed |
| SDKs and verified commerce | Android/iOS/Unity queues and bridges; native verified purchases, Swift submission and typed Unity purchase binding in rc.2 assets; synthetic Unity 6 Android export | Real devices/stores/providers, all-platform onboarding and Unity 2022.3 are unverified; queued/pending does not mean verified |
| Deep links and re-engagement | Deterministic direct links on both OSes, Android deferred links, separate latest-open 24-hour outcome profiles | No iOS deferred links; no engagement ROAS/purchase model; device-reported opens can be forged |
| Fraud controls | Recorded public rules, registered fraud bundle hashes, diagnostics and synthetic Integrity/App Attest verification | No physical-device-farm or reset-fraud guarantee; private threshold calibration and live platform projects unverified |
| Privacy and recovery | Role isolation, protected payloads, deletion, saved-manifest metric replay; matched backup/freshness and isolated restore CLI with all-tenant privacy reapplication and a dedicated synthetic gate | External recipients retain their own deletion duty; live recovery time, authoritative boundary custody and secret custody unverified |
| Outbound delivery | Default-off signed webhooks, S3-compatible bulk exports and bounded Google conversion delivery with local fencing/health | Live quotas and permissions unverified; no provider-side exactly-once guarantee |
| Runtime and operation | One-worker tenant fairness, bounded inbox slices, authenticated logs/metrics, five optional monitoring rules and recovery runbooks, operator-scheduled backup commands, upgrade and single-host procedures | Multi-replica tenant-wide ordering, live backup scheduling, alert delivery and capacity remain unverified |

Detailed limits belong to the [product guides](README.md), [product scope](product-scope.md),
[privacy/security policy](privacy-security.md) and [threat model](threat-model.md).

## Current development focus

The [functional plan](https://github.com/yubisuke/openmasu/issues/218) has
24 of 35 child implementations complete; 11 optional extensions remain. The earlier
integration plan is complete, not a second backlog. The dependency, controller,
presentation, evaluator and ingestion foundations are also implemented.

The [minimal monitoring rules](operations/monitoring.md) are implemented with
synthetic transition tests; receiver setup and live delivery remain external.
[Backup and recovery](operations/backup-restore.md)
([#250](https://github.com/yubisuke/openmasu/issues/250)) is implemented with a
dedicated synthetic gate; live scheduling/custody remain operator work.
Saved bounded daily analysis and previous-period cohort views are implemented;
see [the guide](dashboard-analysis.md#saved-daily-analyses-and-previous-periods).
Broader [external cohort comparison](cohort-comparison.md#expanded-closed-declaration)
is implemented, with declared versus captured evidence kept separate.
The [Apple postback observation view](apple-postback-observations.md) now separates
windows, unsigned values, verification, retries and missing metadata.
[Apple conversion meanings](apple-conversion-meaning.md) share a registered
digest with the SDK and expose ranges without inventing postback bindings.
[Apple Ads campaign cost](cost-refresh.md#apple-ads-campaign-cost) now uses the
existing bounded refresh and correction path with explicit UTC days and currency.
[Unity purchase binding](../sdk/unity/README.md#protected-store-purchases) now reuses
native preparation/submission and consent boundaries without claiming verification
from queued/pending callbacks. **Integrated candidate acceptance**
([#252](https://github.com/yubisuke/openmasu/issues/252)) is complete within its
declared synthetic scope. Exact-commit platform gates, both published-source
upgrade paths and rc.2 publication are verified. The downloaded Android SDK also
passed the native Room queue/HMAC HTTP path through durable backend processing
to a daily install value and saved analysis/CSV on JVM/Robolectric API 24.
The [publication receipt](validation/v0.3.0-rc.2-publication.md) records the later
harness revision separately from the frozen SDK source. Existing fixture-projected
campaign/cost/revenue tests remain separate; no physical-device or all-platform
onboarding acceptance is implied.
The [roadmap](roadmap.md)
owns the sequence; the [project plan](project-plan.md) records its acceptance
crosswalk. Optional expansions are not all release prerequisites.

Keep development simple: one bounded workflow per PR, existing services and
test owners, focused iteration and one applicable full gate at handoff.
Skipped native/runtime steps are not fresh platform evidence. Historical
test counts and per-commit receipts belong to their PR/release records, not
this current-state page.

## Separate operator evidence

Live provider permissions/connections, real campaigns/data, physical devices,
store approval, public domain associations, production TLS, alert delivery,
backup custody and deployment capacity remain unverified. Such work requires
separate authorization and private records; it is not required to continue
synthetic repository development.
