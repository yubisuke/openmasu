# Project Status

Status date: 2026-10-02.

`v0.3.0-rc.1` is the current published source and SDK release (prerelease).
Its annotated tag,
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.1),
eight public SDK assets and every required full platform gate identify green
commit `90a0f5f`. The [publication receipt](validation/v0.3.0-rc.1-publication.md)
records public re-download verification. This document describes the
current `main` source tree; tagged release notes
and evidence manifests remain authoritative only for the exact source revision
they name.

## Release snapshot

| Source line | Contract patch ledger | Reviewed inventory | Release meaning |
| --- | --- | --- | --- |
| `v0.2.0-rc.3` tag | through v0.4.9 | 56 fixtures / 728 golden artifacts | Previously published prerelease and frozen historical evidence |
| `v0.2.0-rc.4` tag | through v0.4.10 | 57 fixtures / 741 golden artifacts | Previously published prerelease and frozen exact-commit evidence |
| `v0.2.0` tag | through v0.4.10 | 57 fixtures / 741 golden artifacts | Published non-prerelease at green commit `68b8c48`; frozen exact-commit evidence |
| `v0.3.0-rc.1` tag | through v0.4.10 | 57 fixtures / 741 golden artifacts | Current published prerelease at green commit `90a0f5f`; eight SDK assets and exact-commit synthetic evidence |
| Current development source | through v0.4.14 | 61 fixtures / 793 golden artifacts | Adds selected acquisition, safe cost denominators, commerce cohorts and explicit custom conversion; not included in the published SDK release |

The Contract wire and package identity remains `0.4.0`; v0.4.14 is the latest
additive patch ledger entry. The published SDK version is `0.3.0-rc.1`.
Its [distribution guide](sdk-distribution.md) separates compiled Android
modules from source-distributed Swift and Unity. Publication has a matching
annotated tag, exact-commit full CI and verified Release assets; later `main`
commits do not alter this record or substitute for its evidence.
The rc.4 tag, GitHub prerelease, and exact-commit platform evidence remain
frozen at `2a2f6b5`; the stable v0.2.0 record is independently frozen at
`68b8c48`. A version string alone never proves publication or exact-commit
validation.

## How to read status

- **Implemented**: the code and public interfaces exist.
- **Synthetically verified**: checked-in synthetic inputs pass the named local
  or CI gate.
- **Operator verification open**: a private deployment, device, domain,
  provider account, or store environment is still required.
- **Out of scope**: the project deliberately does not provide the capability.

A synthetic pass proves contract and code behavior only. It does not prove live
provider connectivity, real-device or campaign delivery, platform approval,
production capacity, operator acceptance, or metric equivalence with another
MMP.

## Current capability status

| Capability | Repository state | Open operational evidence |
| --- | --- | --- |
| Contract and deterministic evaluator | Implemented and synthetically verified across 28 schemas, 8 registries, 61 fixtures, and 793 goldens | Real input representativeness and external implementation adoption |
| Shadow ledger and imports | Implemented for raw events, manual/bounded provider cost, and advertising or verified-commerce revenue | Authorized real export compatibility, account permissions, completeness, latency, and reconciliation |
| Server-to-server events | Implemented for selected first-party backend events with app-scoped rotatable HMAC keys, durable inbox admission, contract rejection, replay controls, and deletion-race enforcement | Production TLS, secret custody, sustained load, backend integration, and operator acceptance |
| Operator event webhooks | Implemented as a default-off, app-scoped export of selected accepted events with exact-origin egress policy, destination-scoped references, exact-body HMAC, durable retry, deletion-race enforcement, and bounded reader-safe delivery health | Production receiver, DNS/TLS, capacity, alerting, secret custody, downstream retention/deletion, and operator acceptance |
| Operator bulk event exports | Implemented as a default-off, app-scoped deterministic gzip NDJSON export to allowlisted S3-compatible operator storage, with SigV4, conditional create, digest-verified replay, durable keyset cursors, destination-scoped deletion rows, and bounded reader-safe batch health | Live Amazon S3/Cloudflare R2 account, IAM policy, DNS/TLS, lifecycle/replication, throughput, cost, alerting, downstream deletion, and operator acceptance |
| Attribution and difference audit | Implemented for supported deterministic and aggregate evidence families | Same-cohort comparison with an existing MMP under frozen definitions |
| Cohort metrics and exports | Implemented for versioned revenue, cost, FX, retention, ROAS, LTV, JSON, CSV, dashboard output, and app-scoped durable daily schedules with exact replay | Real currency/time-zone coverage, source-dashboard reconciliation, schedule/alert operation, and operator acceptance |
| Selected cost correction | Implemented through bounded app/import/date/watermark requests, SSR condition review and reader-visible jobs, saved-definition replay, input-revision/pending labels and atomic old/new run supersession | Live revision completeness, unavailable legacy meaning, production load and operator acceptance; value differences do not prove causes |
| Android, iOS, and Unity SDKs | Implemented with JVM, emulator, Swift, simulator, reproducible packaging, standalone UPM dependency resolution, and a synthetic Unity 6 Android export/APK gate | Physical devices, Unity 2022.3, iOS Unity export, store delivery, and live provider signals |
| Dashboard and management API | Implemented with server-rendered HTML, RBAC, sessions, RLS, and shared report encoders | Production TLS, browser/operator acceptance, and deployment-specific identity integration |
| External HTTP usage contract | Limited OpenAPI description covers backend HMAC admission and three read-only report routes; generated schema/query/column references and one real-loopback client case reuse existing gates | Full API coverage, third-party generator/validator compatibility, real backend/network operation; no new gateway or SDK |
| Fraud and integrity evidence | Implemented with deterministic public rules, bundle provenance, aggregates, and synthetic provider normalization | Live integrity projects, threshold calibration, false-positive measurement, and device-farm coverage |
| Deep links and re-engagement | Implemented for direct Android/iOS and deferred Android flows plus separate aggregate AdAttributionKit re-engagement postbacks | Real domains, association propagation, devices, stores, Apple delivery, and long-running observation |
| Verified commerce lifecycle | Implemented with authenticated synthetic Google and Apple lifecycle/read-back paths plus per-row claims and privacy-fenced completion | Live credentials, quotas, delivery, key rotation, unmatched App Store installation linkage, entitlement, tax, payout, and provider-side duplicate behavior |
| Operations and release | Implemented for bootstrap, migration, scheduler state, metrics, DB-first durable privacy purge and restore reapplication, SBOMs, and release packaging | Production hosting, alerts, real backup recovery, incident response, and measured capacity |
| Storage visibility | Read-only privileged CLI reports scoped/timestamped DB allocation and row estimates plus encrypted-object/key file metadata, with safe unavailable states and bounded reads | Host free space, remote/backup copies, actual growth and representative capacity/cost; no automatic retention/purge policy |

## Product direction

OpenMasu continues as an auditable Shadow MMP and first-party measurement
toolkit. Its purpose is to explain evidence and measurement differences while
running beside an existing provider. Replacing an existing MMP is not a project
goal and must not be inferred from feature coverage.

Compatibility results apply only to the supplied artifact and mapping. They do
not score a provider, certify its product, or recommend migration.

## Current engineering focus

New elapsed-window ad-revenue ROAS and D30 total-net ROAS runs include
[saved calculation evidence](metric-explanations.md) for their exact numerator,
denominator, FX and window. D30 total-net retains advertising, settled purchases
and refund deductions separately in version 2 evidence. Reader-only JSON/HTML details
retain historical cost selection and withhold operands when source evidence is
redacted or purged. Older and unsupported runs show unavailable evidence explicitly.
This addition is outside the frozen v0.2.0 release evidence.

New SQL runs also capture [comparison meaning](cohort-comparison.md) from their
actual definition and FX policy. Supported equivalence is separate from
internal execution IDs; gross/net, window and conversion differences stop
ordinary deltas. Old or unsupported runs remain unknown. Declaration-only
compatibility requires an explicit flag and is never labeled definition-backed.
Temporal window maturity is conservative and does not prove upstream
completeness. This addition is outside the frozen v0.2.0 release evidence.

The dashboard can save a bounded all-page metric selection as comparison
JSON through the existing session and reader role. The Web path and offline
CLI share a pure converter. A repeatable-read transaction fixes scope and runs
across pages; a receipt records selected count/digests and acquisition completion.
Bounds, interruption, privacy/retention and missing/mismatched conditions are
refused without a partial file. Unknown meaning and upstream completeness are
retained, not approved by downloading. Neutral aggregate CSV conversion now
maps explicit columns/units/undefined states into canonical comparison keys
offline with input/mapping digests and value-free error codes. It does not
invent saved definitions or certify external calculation equivalence.
The [integrated first-use journey](getting-started.md) now connects existing
receipt observations, units, saved-run evidence and comparison. The same offline
demo derives equal/corrected-cost/incompatible-window/unknown CSV and HTML cases;
its declaration-only results remain separate from the existing runtime pilot.
[Bounded cost refresh](cost-refresh.md) now joins one existing adapter to
default-off immutable app schedules, fixed lookback/configuration checkpoints,
database-clock claims, bounded retry and stop. Complete acquisition publishes
costs and its checkpoint atomically; empty results never become a zero
denominator. Aggregate reader health excludes private configuration and secret
references. [Selected metric correction](metric-corrections.md) fixes an explicit
app/import/period/watermark request and reuses saved definitions in the existing
engine; pending inputs and immutable old/new runs remain visible. These are
later-source additions, not evidence for the frozen v0.2.0 release; live account
permissions, timezone, token validity and source completeness remain unverified.

Current source also includes [readable dashboard analysis](dashboard-analysis.md):
exact money/ratio/count labels, shareable server-rendered filters, selection-preserving
CSV exports and separated chart groups. Audited API/CSV integers are unchanged.
Window/maturity remain explicitly unknown rather than inferred from freshness or
metric names. This work is outside the frozen v0.2.0 release evidence.

Current `main` adds [measurement health](measurement-health.md): an app-scoped,
reader-only view of SDK/backend batches, file imports, safe rejection counts,
and metric-run/schedule observations. It distinguishes absent observations,
waiting work and recorded results without inferring live delivery or complete
measurement. This addition is not part of the frozen v0.2.0 release evidence.

The published v0.2.0 release consolidates the release-coherence work completed
after rc.4. Provider-neutral backend event submission, outbound operator event
webhooks, deterministic operator-owned bulk event exports, durable scheduled
metrics, and the queue/privacy hardening below are implemented with synthetic
evidence. Live provider and object-storage use remain operator gates. Current
work remains integration hardening rather than another broad provider claim:

Source-level synthetic tests now show that the worker admits independent tenant
cycles through a bounded FIFO coordinator while preserving the existing serial
job order inside each tenant in one worker process. The default is four
concurrent tenants, with a
documented rollback setting of one and a bounded shutdown drain. Multiple
worker replicas do not provide tenant-wide ordering. SDK and MAX inboxes use
bounded FIFO slices. Google conversion delivery and server-side AdServices
lookup now claim one durable row immediately before provider I/O and fence
completion by claim token. AdServices also rechecks source availability under
the tenant privacy barrier before persisting its protected response. Platform
integrity verification now applies the same local ownership and privacy
boundary to its own queue, including protected result purge during deletion
and backup restore reapplication. Google Play product verification now claims
one due row, bounds provider waits, rejects stale completion, and prevents a
deletion-raced result or settled purchase from becoming available again.
Commerce read-back now applies the same local ownership boundary to Google
lifecycle/refund and Apple history work, including transactional refund or
cursor completion. Google Data Manager delivery additionally reserves a
destination-scoped database request slot across worker replicas and propagates
bounded `Retry-After` pauses. Its read-only admin API and server-rendered
dashboard expose complete app-scoped state counts plus a bounded recent-row
view without exposing request references, provider IDs, digests, payloads, or
artifacts. Operator webhook and bulk-export queues expose the same bounded
local-state pattern through one app-scoped API/dashboard section, while the
reader role is limited to the exact metadata columns needed by destination
lists, fixed-label metrics, and that health view. Lease expiry can still repeat a provider
operation; live quota allocation and distributed pacing for other provider
paths remain separate operational work.

1. preserve each published version's notes, SDK identities, SBOMs, bundle
   paths, tag and evidence as one immutable record, including v0.3.0-rc.1;
2. preserve the server-event, operator-webhook, and bulk-export key, replay,
   egress, privacy, and durable-queue invariants in future product changes;
3. preserve bounded tenant concurrency, Google conversion distributed pacing
   and operator-visible delivery health,
   and the AdServices, integrity, Google Play, and commerce read-back claim-
   fencing slices while continuing provider-quota hardening for other paths;
4. preserve durable scheduled-metric checkpoints and exact replay, the
   tenant-scoped SDK admission/projection privacy barrier, and deletion-state
   rechecks while hardening the remaining provider-completion deletion races;
5. ensure every durable runtime queue can independently make its tenant
   discoverable to the worker before a tenant RLS context exists;
6. preserve the current synthetic/operator evidence distinction.

These are preservation requirements, not another automatic audit backlog.
The published integration batch is complete. The next
[planned product sequence](roadmap.md#next-product-sequence), tracked in
[plan #172](https://github.com/yubisuke/openmasu/issues/172), now starts with
selected acquisition-source projection, overlapping cost-grain safety,
late-input correction and daily campaign discovery (#182-#185). The acquisition
gap is reproduced and addressed by explicit v0.4.11 definitions, fixture 58 and
native-inbox/SQL tests; see [selected acquisition metrics](selected-acquisition-metrics.md).
Historical definitions and saved runs retain their meaning. Explicit v0.4.12
[safe cost selection](cost-selection.md) refuses overlapping-cost denominators
and preserves disjoint siblings and dated revisions (#183). Explicit v0.4.13
definitions also connect selected acquisition to purchase/total-net cohorts
(#191), with fixture 60 fixing purchase net 6, total net 26 and ROAS 2.6.
Explicit bounded [late-input requests](metric-corrections.md#late-advertising-revenue-purchases-and-refunds)
connect accepted revenue/commerce arrivals to immutable corrections (#184).
Input discovery is requested through the API; only accepted jobs execute automatically.
Opt-in [daily campaign discovery](scheduled-metrics.md#discover-campaign-targets-automatically)
also freezes bounded acquisition/cost target sets before calculation (#185).
Unknown and cost-only inputs are explicit; a frozen date is not expanded on retry.
The [external calculation declaration bridge](cohort-comparison.md#compare-a-saved-roas-with-explicit-external-calculation-conditions)
now compares saved ad-revenue ROAS with an explicitly declared external CSV
calculation (#173). Matching conditions plus opt-in produce exact deltas while
retaining `external_declared` evidence; this is not provider verification.
The [bounded dashboard comparison flow](cohort-comparison.md#compare-through-the-dashboard)
connects saved JSON and external CSV/mapping to condition review and identical
CLI/Web JSON and HTML downloads without persisting inputs or history (#174).
[Recorded attribution analysis](attribution-reasons.md) now reads one eligible
stored acquisition decision per retained install at an explicit cohort period
and cutoff, with current privacy and no inferred causes (#175).
[Daily schedule controls](scheduled-metrics.md#manage-schedules-through-the-dashboard)
now connect SSR registration, checkpoint inspection and disablement to the
existing immutable schedule service and worker (#176), with admin-only access.
Explicit [custom-event conversion](custom-conversion-metrics.md) now counts
distinct D7 cohort converters and their rate for one saved event key (#177).
Fixture 61 fixes 3/10; boundary, receipt, privacy and gross/net cases share
independent reference and SQL arithmetic. No new service or event payload.
[D30 total-net ROAS details](metric-explanations.md) retain advertising, purchase,
refund and cost operands from the saved calculation (#178). The dashboard connects
bounded [cost-recalculation controls](metric-corrections.md) to existing jobs and
original/replacement details (#179). A definition-backed [retention matrix](dashboard-analysis.md#saved-retention-matrix)
aligns only comparable saved cohorts and horizons on the current page (#180).
App Store purchase binding (#186) is in progress: the opt-in
[purchase-preparation API](design/verified-commerce-lifecycle.md#installation-bound-purchase-preparation)
now issues protected installation-scoped tokens with retry and deletion safety.
Transaction submission, verified financial projection and the public Swift API
remain incomplete. Finer advertising grain and separate re-engagement outcomes
(#187-#188) remain scoped follow-ups. A forward-only runtime fix now permits
schedule re-registration over identical inputs while preserving run-ID
uniqueness, old evidence, exact replay and explicit-only supersession
([#200](https://github.com/yubisuke/openmasu/issues/200)). The reference retention
numerator now uses that metric's selected and fraud-filtered cohort, matching
Python/SQL rather than counting a different population
([#202](https://github.com/yubisuke/openmasu/issues/202)). Neither fix rewrites
old saved runs. Three scoped follow-up slices remain incomplete. Existing
component evidence and the published v0.3.0-rc.1 record remain unchanged;
neither proves these remaining connections.

Private real-data, real-device, and live-provider work is optional operator work
and is not required to continue repository-only hardening.
