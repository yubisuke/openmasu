# Project Status

Updated: 2026-10-29. This page describes the current `main` source tree.
Implementation and synthetic verification are not live operational qualification.

## Release snapshot

| Line | Identity and evidence |
| --- | --- |
| Published prerelease | `v0.3.0-rc.3` at `2d689dc`; eight verified SDK assets and exact-commit full CI |
| Synthetic SDK onboarding | Publication receipt records the downloaded Android SDK/backend journey separately from emulator and provider-shim evidence |
| Latest stable source release | `v0.2.0`; later features belong to newer source, not this tag |
| Current source | Contract patch ledger through v0.4.29; wire/package identity `0.4.0`, schema URNs `:v0.4`; 28 schemas, 8 registries, 76 fixtures, 988 golden artifacts |

`v0.3.0-rc.3` is the current published source and SDK release, marked as a
prerelease. Its [release page](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.3)
and [publication receipt](validation/v0.3.0-rc.3-publication.md) identify source
`2d689dc63546e5a2121fd0026d83f04aa8cc3f7d`, exact-commit CI and eight public
assets re-downloaded and verified on 2026-10-26. Frozen candidate notes and
older release records remain unchanged. Current source adds rc.2 backup recognition
and its existing-suite migration/privacy rehearsal
([upgrade guide](operations/upgrade.md)). This is not in the frozen rc.3 release:
deployment from rc.2 still requires a new annotated release. Use a new disposable
synthetic instance for rc.3 rather than resetting an existing ledger.

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
| Operator access | Optional single-app restriction on existing roles; shared API/session/list/export/job gates; atomic audited key issuance/retirement with immediate session revocation | Backend reader credentials remain trusted tenant-scoped SQL access, not app-scoped user logins; no SSO or general IAM |
| Retention expiry | Default-off policy, read-only aggregate preview, fixed bounded receipt, interruption-safe protected-object/expired-nonce expiry and retention-affected replay disclosure | No blanket ledger/credential cleanup, legal duration, backup erasure or live-expiry qualification |
| Receipt and import | Durable SDK/backend admission; explicit raw-event, cost and revenue mappings; atomic records, schema rejection, idempotency and bounded bulk import | Real exports/credentials are not repository evidence; mappings remain explicit |
| Attribution | First-party Install Referrer, verified platform evidence and imported provider judgments remain separate; optional versioned 1/7/30-day first-party window with evidence-bound preview and activation | Historical receipts keep their recorded revision; platform/imported/engagement rules are not reinterpreted; no probabilistic identity or external-equivalence claim |
| Apple aggregate measurement | Signed synthetic receivers, separate bounded observations, registered event/revenue meaning profiles and window-local SDK state | Postbacks are not unique installs; selected-schema decoding is unverified, not actual revenue or a verified postback binding; live delivery is unverified |
| Acquisition and money | Selected native/platform/imported profiles; safe cost grain; purchase/refund/reversal, ROAS/LTV, saved FX and native D7 same-set KPIs | Profiles have explicit source, currency and window limits; no inferred cost ownership/allocation or live FX service |
| Retention and outcomes | Opt-in D3/D14/D30 retained-installation horizons and multiple custom D7 outcome keys | Incomplete windows are not zero; native/platform/imported populations stay separate |
| Calendar metrics | Explicit UTC, Tokyo and New York calendar definitions coexist with historical elapsed definitions | Other zones are not qualified; time-zone-data upgrades require boundary requalification |
| Daily activity | Separate UTC session-start/custom-event counts and distinct active installations, saved schedules and CSV | Recorded gross activity only; installations are not people, daily uniques are not period uniques, and acquisition dimensions are not inferred |
| Ongoing calculation | Durable daily schedules, bounded target discovery, Google/Apple cost refresh, saved replay and explicit/opt-in automatic corrections | Not every profile supports discovery or automatic correction; no implicit all-history scan; live cost access and billing agreement remain unverified |
| Dashboard and comparison | Server-rendered reader-only reports; saved filters, bounded previous-period views and operands; external revenue/ROAS/LTV, retention and outcome declarations via the same offline/web comparator | External meaning remains operator-declared; no provider completeness, imported-binding or engagement-equivalence claim; incompatible/missing/undefined/zero remain distinct |
| Setup and diagnostics | Recommended measurement form, recent event/SDK-version classes and confirmation-bound ingest recovery | SDK versions are client-declared; absent receipts do not prove an outage; invalid/deleted/claimed evidence is not replayed |
| SDKs and verified commerce | Android/iOS/Unity queues and bridges; native verified purchases, Swift submission and typed Unity purchase binding in rc.2 assets; synthetic Unity 6 Android export | Real devices/stores/providers, all-platform onboarding and Unity 2022.3 are unverified; queued/pending does not mean verified |
| Deep links and re-engagement | Deterministic direct links on both OSes, Android deferred links; preserved 24-hour outcomes plus explicit-window/recorded-inactivity and verified purchase-net profiles | No iOS deferred links or engagement ROAS; recorded inactivity is not human inactivity, insufficient history stays unknown, device-reported opens can be forged |
| Fraud controls | Recorded public rules, registered fraud bundle hashes, diagnostics and synthetic Integrity/App Attest verification | No physical-device-farm or reset-fraud guarantee; private threshold calibration and live platform projects unverified |
| Privacy and recovery | Role isolation, protected payloads, deletion, saved-manifest metric replay; matched backup/freshness and isolated restore CLI with all-tenant privacy reapplication and a dedicated synthetic gate | External recipients retain their own deletion duty; live recovery time, authoritative boundary custody and secret custody unverified |
| Outbound delivery | Default-off signed webhooks, S3-compatible bulk exports and bounded Google conversion delivery with local fencing/health | Live quotas and permissions unverified; no provider-side exactly-once guarantee |
| Runtime and operation | Cross-process tenant-cycle ordering and commit fencing, bounded inbox slices, authenticated logs/metrics, five optional monitoring rules and recovery runbooks, operator-scheduled backup commands, upgrade and single-host procedures | Live multi-replica capacity, backup scheduling and alert delivery remain unverified; in-flight external requests cannot be recalled |

Detailed limits belong to the [product guides](README.md), [product scope](product-scope.md),
[privacy/security policy](privacy-security.md) and [threat model](threat-model.md).

## Current development focus

The active [usability backlog](https://github.com/yubisuke/openmasu/issues/320)
prioritizes safe setup, daily authenticated input, measurement intent and useful
saved-period decisions. Current source adds persistent seed refusal, dependency
readiness and worker recovery, explicit deployment configuration plan/apply,
renewable Google/Apple cost credentials and device-local SDK diagnostics.
The next connected workflows now include declared-event setup, complete-period
CPI/ROAS, cost join diagnostics and bounded backfill, inert link preview/resume,
typed recurring comparison setup, saved-run left operands and explicit threshold
policies. The [first-party window guide](attribution-window.md) describes the
optional 1/7/30-day profile and its retained-evidence activation boundary.
These additions do not change the frozen rc.3 release or establish live-provider
access. SDK receipt acceptance remains distinct from server measurement results.
The corresponding product guides carry operation-specific limits; PRs carry
exact-commit synthetic evidence.

The [functional plan](https://github.com/yubisuke/openmasu/issues/218) has
all 35 child implementations present in current source. The earlier
integration plan is complete, not a second backlog. The dependency, controller,
presentation, evaluator and ingestion foundations are also implemented.

[Fraud policy preview](fraud-preview.md) compares registered active/candidate
definitions on the same bounded retained evidence, with gross/net effects and
receipt-bound explicit activation. It never rewrites history or calls the
displayed counts a detection rate. Missing historical rule inputs block impact
claims and activation. This is included in rc.3.

The optional [Unity ILR sample](../sdk/unity/README.md#optional-levelplay-impression-revenue)
adds per-ad LevelPlay callbacks to existing native queues and revenue metrics.
Its provider types use an explicit shim; actual provider/device qualification
is unverified. This is included in rc.3; older assets remain unchanged.

[Daily recorded activity](calendar-activity.md) is included in rc.3.
Its UTC activity population is independent
of acquisition cohorts and does not establish human-level uniqueness.

[Verified payer metrics](payer-metrics.md) add separate D7 settled transaction
and paying-installation counts, payer rate and purchase-net ARPPU. They preserve
historical payers after full refund, exclude advertising revenue and leave
zero-payer money undefined. Store projections and privacy replay are synthetic
evidence, not live store qualification; these metrics are included in rc.3.

[Scheduled aggregate comparisons](recurring-comparisons.md) persist explicit
definition revisions and aggregate-only operands. The existing worker produces
fixed-cutoff, content-addressed results; missing/unknown/incomparable are not
threshold breaches. The rc.3 implementation uses operator-deposited inputs.
Current source additionally supports a selected saved metric schedule as the
left operand, while the right operand remains explicit, and versioned absolute
or relative threshold policies. Expiry, deletion and conservative privacy
suppression remain enforced. Provider authentication and notification delivery
are not implied by this comparison capability.

[Selected Google detail costs](cost-refresh.md#explicit-google-ad-group-and-ad-costs)
add bounded ad-group/ad acquisition and explicit creative binding. Selected child
coverage is eligible only for its matching detail grouping, never an inferred
parent or sibling denominator. Reader health describes configured capability,
not provider completeness. This is included in rc.3.

[Recorded-detail discovery](scheduled-metrics.md#discover-selected-ad-groups-or-creatives)
extends the same frozen daily target receipt to ad-group/creative tuples. Unknown
detail and parent-only costs remain explicit partial observations; overflow and
post-freeze privacy changes prevent publication. This is not provider crawling,
inferred hierarchy or a change to earlier campaign schedule identities.

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
upgrade paths and rc.3 publication are verified. The downloaded Android SDK also
passed the native Room queue/HMAC HTTP path through durable backend processing
to a daily install value and saved analysis/CSV on JVM/Robolectric API 24.
The [publication receipt](validation/v0.3.0-rc.3-publication.md) records the SDK
and harness at the same frozen source revision. Existing fixture-projected
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
