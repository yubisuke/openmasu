# Project Status

Updated: 2026-10-04. This page describes the current `main` source tree.
Implementation and synthetic verification are not live operational qualification.

## Release snapshot

| Line | Identity and evidence |
| --- | --- |
| Published prerelease | `v0.3.0-rc.1` at `90a0f5f`; eight SDK assets and exact-tag publication evidence |
| Latest stable source release | `v0.2.0`; later features belong to newer source, not this tag |
| Current source | Contract patch ledger through v0.4.24; wire/package identity `0.4.0`, schema URNs `:v0.4`; 28 schemas, 8 registries, 71 fixtures, 923 golden artifacts |

`v0.3.0-rc.1` is the current published source and SDK release, marked as a
prerelease. Its [release page](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.1),
[synthetic evidence](validation/v0.3.0-rc.1-synthetic-evidence.md) and
[publication receipt](validation/v0.3.0-rc.1-publication.md) describe that exact tag.
Configured SDK version remains `0.3.0-rc.1`; current source is not a newly
published SDK. [Unreleased scope](releases/next.md) summarizes the difference.

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
| Apple aggregate measurement | Signed synthetic SKAdNetwork/AdAttributionKit receiver, replay protection and separated aggregate series | Postbacks are not unique installs; richer window/suppression views and conversion semantics remain planned |
| Acquisition and money | Selected native/platform/imported profiles; safe cost grain; purchase/refund/reversal, ROAS/LTV, saved FX and native D7 same-set KPIs | Profiles have explicit source, currency and window limits; no inferred cost ownership/allocation or live FX service |
| Retention and outcomes | Opt-in D3/D14/D30 retained-installation horizons and multiple custom D7 outcome keys | Incomplete windows are not zero; native/platform/imported populations stay separate |
| Calendar metrics | Explicit UTC, Tokyo and New York calendar definitions coexist with historical elapsed definitions | Other zones are not qualified; time-zone-data upgrades require boundary requalification |
| Ongoing calculation | Durable daily schedules, bounded target discovery, cost refresh, saved replay and explicit/opt-in automatic corrections | Not every profile supports discovery or automatic correction; no implicit all-history scan |
| Dashboard and comparison | Server-rendered, reader-only reports; saved operands, receipt freshness, bounded downloads and explicit offline/web comparisons | Unknown/missing/undefined/zero are distinct; saved views and broader comparison families remain planned |
| Setup and diagnostics | Recommended measurement form, recent event/SDK-version classes and confirmation-bound ingest recovery | SDK versions are client-declared; absent receipts do not prove an outage; invalid/deleted/claimed evidence is not replayed |
| SDKs and verified commerce | Android/iOS/Unity queues and bridges; native verified purchases and Swift submission; synthetic Unity 6 Android export | Real devices/stores/providers and Unity 2022.3 are unverified; Unity purchase helpers remain planned |
| Deep links and re-engagement | Deterministic direct links on both OSes, Android deferred links, separate latest-open 24-hour outcome profiles | No iOS deferred links; no engagement ROAS/purchase model; device-reported opens can be forged |
| Fraud controls | Recorded public rules, registered fraud bundle hashes, diagnostics and synthetic Integrity/App Attest verification | No physical-device-farm or reset-fraud guarantee; private threshold calibration and live platform projects unverified |
| Privacy and recovery | Role isolation, protected payloads, deletion, saved-manifest metric replay, actual dump/restore and privacy reapplication | External recipients retain their own deletion duty; live recovery time and secret custody unverified |
| Outbound delivery | Default-off signed webhooks, S3-compatible bulk exports and bounded Google conversion delivery with local fencing/health | Live quotas and permissions unverified; no provider-side exactly-once guarantee |
| Runtime and operation | One-worker tenant fairness, bounded inbox slices, authenticated logs/metrics, upgrade and single-host procedures | Multi-replica tenant-wide ordering, packaged alert rules, scheduled backup and live capacity remain open |

Detailed limits belong to the [product guides](README.md), [product scope](product-scope.md),
[privacy/security policy](privacy-security.md) and [threat model](threat-model.md).

## Current development focus

The [functional plan](https://github.com/yubisuke/openmasu/issues/218) has
15 of 35 child issues complete; 20 remain as of this update. The earlier
integration plan is complete, not a second backlog. The dependency, controller,
presentation, evaluator and ingestion foundations are also implemented.

Next: **minimal monitoring rules** ([#248](https://github.com/yubisuke/openmasu/issues/248)),
then **scheduled backup and recovery evidence**
([#250](https://github.com/yubisuke/openmasu/issues/250)). After that, prioritize
bounded daily analysis/comparison, Apple aggregate usability and Unity purchase
binding before promoting an integrated candidate. The [roadmap](roadmap.md)
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
