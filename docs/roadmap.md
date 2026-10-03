# Roadmap

This file is the canonical sequence of product milestones. It records what each
milestone established and what evidence remains outside the public repository.
Detailed current status is in [Project status](STATUS.md); execution policy is
in [Project plan](project-plan.md).

## Status vocabulary

- **Synthetic complete**: implementation and checked-in synthetic gates exist.
- **Integration hardening**: existing capability is being made safer or easier
  to operate; no new product claim is added.
- **Operator gate**: evidence requires a private environment and is not implied
  by CI.
- **Out of scope**: the capability is deliberately not planned.

## Completed contract and product milestones

| Milestone | State | Result |
| --- | --- | --- |
| Contract v0.2 | Synthetic complete | Consistent lifecycle, money, reason, timestamp, reconciliation, cost, and metric semantics |
| Contract v0.3 | Synthetic complete | Typed Android, Unity, Meta, Apple, custom-event, reporting, and fraud handoffs |
| Contract v0.4 | Synthetic complete | OpenMasu contract identity plus additive patches through the active v0.4 line |
| Shadow ledger and import foundation | Synthetic complete | PostgreSQL evidence ledger, import families, encryption, RLS, deletion, and parity |
| Cohort metrics and difference audit | Synthetic complete | Reproducible cost/revenue metrics, supersession, exports, and neutral reconciliation |
| Android, Unity, and redirector | Synthetic complete | First-party Android measurement, measurement links, SDK queue, and Unity bridge |
| Operator dashboard | Synthetic complete | Shared report queries and encoders, zero-JavaScript HTML/SVG, session security, and reader RLS |
| iOS and Apple aggregate measurement | Synthetic complete | Swift SDK, signed postback handling, current AdAttributionKit conversion targeting, and separated install/re-engagement aggregate series |
| Operational control foundation | Synthetic complete | RBAC, scheduler state, metrics, backup/restore logic, SBOMs, and release runbooks |
| Deterministic fraud controls | Synthetic complete | Replayable public rules, bundle binding, quarantine, source-day aggregates, and integrity normalization |
| Deep links and re-engagement | Synthetic complete | Direct Android/iOS links, Android deferred links, engagement attribution, and daily metrics |
| Verified commerce lifecycle | Synthetic complete | Authenticated lifecycle signals, authoritative read-back, refund corrections, and protected cursors |
| Import and financial compatibility | Synthetic complete | No-write raw/cost/revenue compatibility plus PostgreSQL cost-to-ROAS and revenue parity |
| Authenticated backend events | Synthetic complete | Provider-neutral server keys, raw-body HMAC, replay limits, durable inbox evaluation, contract rejection, and deletion-race enforcement |
| Operator event webhooks | Synthetic complete | Default-off app destinations, a closed event envelope, exact-body HMAC, public-address egress controls, durable retries, and deletion-race enforcement |
| Operator-owned bulk event exports | Synthetic complete | Default-off S3-compatible destinations, deterministic gzip NDJSON, SigV4 conditional writes, durable keyset cursors, and destination-scoped deletion notices |

The current contract gate preserves parity across 28 schemas, 8 registries,
and 66 reviewed synthetic fixtures, including explicitly versioned first-party and verified-platform acquisition cohorts, daily counts, safe cost selection, custom conversions and targeted refund cancellation.

## Completed milestone: integration and release coherence

This milestone consolidates the existing system rather than adding another
provider or attribution family.

Progress:

| Integration gate | State |
| --- | --- |
| A saved ROAS result can be explained from its original operands | Implemented for elapsed-window ad-revenue ROAS: atomic aggregate evidence, reader-only JSON/HTML detail, exact rounding and history tests; legacy/unsupported/removed evidence remains explicit |
| Comparison is bound to saved calculation meaning, not metric names | Implemented: atomic aggregate-only definition/FX context, supported semantic equivalence and conservative maturity; unknown/legacy inputs produce no ordinary deltas, declaration-only compatibility is explicit |
| Dashboard selections can be saved for offline comparison | Implemented through existing session/reader access and the shared pure converter, with fixed all-page read-only acquisition, scope/selection receipts, bounds and privacy refusal; upstream completeness remains unknown |
| External aggregate CSV can become an explicit comparison input | Implemented offline for one neutral CSV format: closed column/grouping/units/undefined mapping, strict exact-money reuse, canonical keys and input/mapping digests; declarations are not verified calculation meaning |
| Newcomers can follow receipt → units → saved evidence → comparison | Implemented through one purpose-based guide and the existing demo/pilot/dashboard/SDK paths; fixture-derived CSV/JSON/HTML demonstrate equal/different/incomparable/unknown without hand-edited values or fabricated runtime evidence |
| Existing provider cost can refresh without publishing partial acquisition | Implemented default-off for one bounded adapter: immutable app configuration, fixed lookback, token-fenced claims/retries/stop and atomic cost/checkpoint commit; empty is not zero and old cost history remains |
| Selected cost corrections can replace affected saved runs without rewriting history | Implemented bounded requests, saved-definition replay, input-revision/pending labels, atomic new-run completion and immutable supersession; no all-history automation or causal inference |
| Metric units and analysis selections are readable without changing audited values | Implemented: exact decimal display, SSR filters and scope-preserving CSV links; chart groups stay separate; window/maturity remain explicitly unknown without readable definition evidence |
| App ingestion and calculation observations are understandable without raw payload access | Implemented: reader-only measurement health for batches, imports, rejections and metric runs; synthetic API/role and state-rendering gates |
| Scheduler leases cannot consume the job pool; MAX processing works with a one-connection job pool | Complete |
| Android and iOS queues share duplicate and event-ID conflict vectors | Complete |
| One disposable synthetic command is the canonical first run | Complete |
| Current documentation excludes unexplained review, work-order, and decision references | Complete |
| CI cancels superseded runs and routes expensive gates without hiding required contexts | Complete |
| Release notes, SDK identity, tagged evidence, and source revision describe one exact release | Complete for published v0.3.0-rc.1 at green commit `90a0f5f`; earlier release records remain frozen |
| SDK consumers can obtain verified archives without rebuilding the repository | Complete for v0.3.0-rc.1: eight public assets, exact-SHA manifest/checksums/SBOMs, standalone UPM consumer and public re-download verification |
| An existing supported database can be upgraded without inventing legacy meaning or losing privacy state | Read-only frozen-source/backup preflight, unchanged forward migration transactions and one version-to-version restore/resume case in the existing backup gate; traffic restart remains manual |
| A service can use one supported host layout without inheriting disposable-demo behavior | One existing Compose stack, exact annotated release, operator HTTPS proxy and private volume/secret custody; static preflight refuses unsuitable declarations, and the existing isolated pilot proves normal restart retention without reseeding; live TLS/deployment remains unverified |
| Operators can see current storage layers without exposing cross-tenant capacity or triggering retention | Read-only privileged CLI reports allocated DB bytes, estimated rows and payload file metadata with explicit scope/time/unavailable states and bounds; no automatic purge, growth extrapolation or cost claim |
| External backends and analysis tools can read the existing HTTP usage contract | Limited OpenAPI 3.1.1 covers backend HMAC admission and three aggregate report routes, derives existing schemas/allowlists/columns and reuses one real-route client acceptance case; no all-API, SDK generation or external-send claim |
| App backends can submit selected first-party events without SDK-key reuse or advertising identifiers | Complete with synthetic server-key lifecycle, ingestion, rejection, idempotency, and privacy tests |
| Operators can receive a closed subset of accepted events without raw identifiers or provider-specific wire coupling | Complete with synthetic destination lifecycle, DNS/SSRF, signature, retry, privacy, and disablement tests |
| Operators can receive delayed deterministic files without adopting a provider-specific export layout | Complete with synthetic SigV4 vectors, object replay, durable cursor, credential boundary, privacy-notice, and lifecycle tests |
| App metrics advance without an external cron wrapper | Complete with immutable app schedules, UTC lag/watermark policy, bounded catch-up, exact crash replay, and report/dashboard integration tests |
| Queue-only tenants are discoverable before tenant-scoped processing begins | Complete for Google Play and integrity verification plus commerce provider read-back, with SELECT-only owner discovery policies and drain-to-terminal integration evidence |
| A slow tenant does not globally block independent tenant cycles | Synthetic source-level complete within one worker process with a bounded FIFO coordinator, same-tenant deduplication, unchanged per-tenant job order, bounded shutdown, and concurrent scheduler-lease evidence; full process shutdown and multi-replica tenant-wide ordering remain operational boundaries |
| One SDK or MAX backlog does not create an unbounded tenant cycle | Complete with configurable 1-1000 row FIFO slices, default 100, and synthetic 2-then-1 drain evidence |
| Google conversion delivery is locally owned, paced, and operationally visible across worker replicas | Complete with a per-row database-clock lease, token-fenced transactional completion, expired-claim recovery, stable transaction-ID evidence, a destination-scoped database pacing slot, bounded `Retry-After` propagation, and a reader-safe API/dashboard state view; live quota allocation and provider-side exactly-once behavior remain unverified |
| Operator-owned outbound delivery state is visible without exposing protected references | Complete with one app-scoped API/dashboard view, complete webhook and bulk-export state counts, bounded recent rows, tenant RLS, and column-level reader grants; live receiver/storage effects and exactly-once behavior remain unverified |
| One active platform-integrity verification cannot race another worker or completed deletion | Complete with a per-row database-clock lease, bounded provider wait, token-fenced transactional completion, source-lifecycle recheck, deletion-first and completion-first privacy evidence, and restored-evidence purge; provider-side exactly-once behavior remains unverified |
| One active Google Play verification cannot race another worker or completed deletion | Complete with a per-row database-clock lease, bounded provider reads, token-fenced retry and completion, source-lifecycle recheck, deletion-first and completion-first privacy evidence, and restored-evidence purge; provider-side exactly-once behavior remains unverified |
| One active commerce read-back cannot race another worker or completed deletion | Complete with a per-row database-clock lease, token-fenced retry, transactional Google refund and Apple financial/cursor completion, expired-claim recovery, stale-completion rejection, binding/cursor cleanup, and Google/Apple deletion-race evidence; live StoreKit delivery and provider-side exactly-once behavior remain unverified |

Candidate v0.2.0-rc.4 satisfied the historical release-coherence exit gate at
green `main` commit `2a2f6b5`. Published v0.2.0 now consolidates the
authenticated backend event, operator webhook, bounded bulk export, durable
daily metric, privacy, and queue-hardening work completed afterward. It becomes
an exact release record because its platform gates, tag, evidence manifest,
and GitHub Release agree at `68b8c48`. These are integration milestones rather
than provider or attribution claims. Subsequent repository work is selected
from current-code audits of compatibility, failure recovery, reconciliation
completeness, and operational correctness.

## Next product sequence

The integration batch in [plan #155](https://github.com/yubisuke/openmasu/issues/155)
is complete, including [v0.3.0-rc.1 publication](validation/v0.3.0-rc.1-publication.md).
[Plan #172](https://github.com/yubisuke/openmasu/issues/172) records sixteen
development slices: the eight workflow improvements selected from `1c7c223`, plus
eight core integration and follow-up slices identified during the `ce7b056`
review and subsequent synthetic reproductions on
2026-10-02. The selected-acquisition slice now has opt-in v0.4.11 definitions,
fixture 58, and native-inbox/SQL acceptance tests. Explicit safe-cost definitions
add dated revision selection and overlap refusal, exercised by fixture 59.
Explicit commerce definitions connect that selected source to purchase/refund
and total-net cohorts, exercised by fixture 60. Bounded explicit late-input
requests now connect revenue and commerce arrivals to saved-run corrections.
Daily schedules discover bounded frozen campaign targets. The external ad-ROAS
declaration bridge and bounded dashboard comparison flow are also source
implemented, followed by reader-only recorded attribution analysis and admin
dashboard controls for the existing daily schedules. A forward-only runtime fix
also permits schedule re-registration over identical inputs while preserving
run-ID uniqueness, exact replay, old evidence and explicit supersession
([#200](https://github.com/yubisuke/openmasu/issues/200)). A separate reference
retention correction aligns the numerator with its selected and fraud-filtered
cohort ([#202](https://github.com/yubisuke/openmasu/issues/202)). These two fixes
extend the original sixteen slices. Explicit custom-event outcomes and D30
total-net ROAS evidence, correction controls and the bounded saved-retention matrix
now have source implementation. The four scoped follow-ups (App Store purchase
binding, explicit refund reversal, detailed acquisition grain and first-party
re-engagement outcomes) also have synthetic implementation and connection gates.

The first priority is a connected measurement path: tracking link, SDK install,
selected acquisition source, campaign revenue and cost, daily ROAS, late-input
correction, and saved explanation. Passing existing component gates or adding
comparison screens alone does not establish that end-to-end path.

| Priority / issue | Core slice | Exit gate / project-plan crosswalk |
| --- | --- | --- |
| Source implemented / [#182](https://github.com/yubisuke/openmasu/issues/182) | Selected acquisition source reaches install cohorts | Opt-in definitions, fixture 58 and native inbox/SQL tests cover campaign installs/ad-revenue ROAS, fixed snapshots and privacy / Acquisition projection |
| Source implemented / [#183](https://github.com/yubisuke/openmasu/issues/183) | Overlapping cost grains cannot inflate the denominator | Explicit v0.4.12 selection accepts disjoint partitions and dated revisions, refuses overlapping candidates, and binds evidence/replay/comparison without changing historical definitions / Cost grain safety |
| Source implemented / [#191](https://github.com/yubisuke/openmasu/issues/191) | Selected acquisition also reaches purchase and total-net cohorts | Explicit v0.4.13 definitions, fixture 60 and SQL tests reuse selected source and safe costs without reinterpreting old definitions / Commerce acquisition projection |
| Source implemented / [#184](https://github.com/yubisuke/openmasu/issues/184) | Late advertising revenue, purchases and refunds can correct past runs | Explicit bounded receipt discovery or record selection, immutable replay through the existing worker, and visible pending/unavailable states / Late-input correction |
| Source implemented / [#185](https://github.com/yubisuke/openmasu/issues/185) | New campaigns enter daily calculation without manual enumeration | Bounded opt-in discovery with a frozen per-job target set, exact retry and explicit unknown/empty/overflow states / Campaign discovery |
| Source implemented / [#186](https://github.com/yubisuke/openmasu/issues/186) | Verified App Store purchases reach installation cohorts | Public Swift preparation/submission, authenticated admission and history-to-financial projection connect with synthetic gates; live StoreKit delivery and Unity C# purchase helpers remain outside this connection / App Store purchase binding |
| Source implemented / [#209](https://github.com/yubisuke/openmasu/issues/209) | Verified refund reversals cancel only their target deductions | Explicit targets, opt-in v0.4.15 metrics, verified App Store projection and late correction; ambiguous multi-part refunds remain unavailable / Refund reversal correction |
| Source implemented / [#187](https://github.com/yubisuke/openmasu/issues/187) | Ad-group and creative outcomes share the cost grain | Explicit v0.4.16 contract, TS/Python/SQL, manual creative-cost CLI, API/HTML/CSV filters, explicit schedules and bounded cost/late-input corrections; no creative discovery or inferred allocation / Detailed acquisition grain |
| Implemented (synthetic) / [#188](https://github.com/yubisuke/openmasu/issues/188) | First-party re-engagement has separate outcome measures | Explicit v0.4.17 latest-open 24h conversion/ad-revenue policy, CLI/schedules, separated API/HTML/CSV and privacy-aware recalculation; no ROAS/purchase/automatic discovery / Re-engagement outcomes |

#182 and #183 precede #191, then #184 and #185; #186 follows #184, #209 follows #186,
and #187 follows #182/#183,
and #188 follows #182/#177. This dependency order kept the core calculation
connections ahead of the workflow batch below. These extensions are scoped follow-ups, not prerequisites
for the initial Android-first campaign workflow. App Store cohort-purchase
coverage is source implemented with synthetic evidence in #186, not live-store
proof; refund-reversal recovery is limited to a uniquely linked prior refund,
not general multi-part refund accounting. #209 precedes #187/#188. Re-engagement ROAS is not delivered
by the initial #188 conversion/revenue slice.

The workflow batch addresses comparison between a captured OpenMasu calculation and an
external aggregate. The CSV converter and pure comparator now support explicit
external calculation declarations for one elapsed ad-revenue ROAS family,
retaining the different evidence levels and requiring opt-in. A bounded SSR
flow connects this path to the dashboard. Unknown or incompatible conditions remain blocked.
It does not make an external calculation authenticated or independently verified.

| Order | Planned slice | User outcome / exit gate | Project-plan crosswalk |
| --- | --- | --- | --- |
| Source implemented | [External calculation declarations #173](https://github.com/yubisuke/openmasu/issues/173) | A saved elapsed ad-revenue ROAS and a fully declared external calculation produce exact deltas with explicit mixed evidence; unknown/mismatched conditions cannot | External comparison meaning |
| Source implemented | [Dashboard comparison #174](https://github.com/yubisuke/openmasu/issues/174) | Bounded SSR input, condition review and JSON/HTML download reuse CLI pure functions, preserve evidence levels and perform no server-side persistence | Comparison workflow |
| Source implemented | [Attribution reason counts #175](https://github.com/yubisuke/openmasu/issues/175) | Bounded fixed-watermark API/SSR reads one eligible stored acquisition decision per retained install, with current privacy and no inferred causes | Attribution analysis |
| Source implemented | [Metric schedule controls #176](https://github.com/yubisuke/openmasu/issues/176) | Admin-only SSR registration, saved definition/checkpoint inspection and disablement reuse the existing immutable schedule service and worker | Daily calculation controls |
| Source implemented | [Schedule re-registration recovery #200](https://github.com/yubisuke/openmasu/issues/200) | Run-ID uniqueness permits distinct schedules/cutoffs/definitions over identical inputs; exact crash replay, reader pagination and explicit-only supersession preserve old evidence | Schedule recovery |
| Source implemented | [Retention cohort correction #202](https://github.com/yubisuke/openmasu/issues/202) | Retention activity joins the same selected/fraud-filtered cohort as its denominator, with TS/Python/SQL arithmetic parity and unchanged goldens | Retention population |
| Source implemented | [Custom-event conversion #177](https://github.com/yubisuke/openmasu/issues/177) | Explicit v0.4.14 definitions count distinct D7 converters in the same eligible cohort, with fixed key/replay/comparison meaning and TS/Python/SQL parity | Cohort outcomes |
| Source implemented | [Total-net ROAS evidence #178](https://github.com/yubisuke/openmasu/issues/178) | Version 2 evidence explains existing D30 total-net ROAS from its saved advertising, purchase, refund and cost operands without HTTP recalculation | Commerce calculation evidence |
| Source implemented | [Correction controls #179](https://github.com/yubisuke/openmasu/issues/179) | Review conditions before requesting an existing bounded cost-driven recalculation; follow reader-visible job and original/replacement details | Correction workflow |
| Source implemented | [Retention matrix #180](https://github.com/yubisuke/openmasu/issues/180) | Current-page retention by saved cohort/date horizon, exact values/details, explicit page gaps and per-observation maturity; incompatible meanings remain separate | Cohort presentation |

Within the workflow batch, slice 2 depends on slice 1. The remaining slices
reuse existing foundations; the table gives their relative priority after
the five core slices above.
Slices 7 and 8 are lower priority. Keep each slice in a bounded PR and add
behavioral evidence to existing suites. The
[project-plan crosswalk](project-plan.md#next-product-slices) specifies the
corresponding acceptance focus.

Use the existing PostgreSQL, worker, SSR session/roles and exact arithmetic.
Do not introduce a comparison-history service, SPA, general funnel builder or
another metric engine. Tests and checked-in examples remain synthetic. Real
providers, devices and private shadow pilots are not required. Additional
adapters, predictive analytics, multi-cloud hosting and another release are
not selected by this plan. Numeric differences alone never establish causes.

## Next development foundations

The current source has the dependency, calculation, HTTP/presentation and
ingestion boundaries needed for the next supported MMP workflows, together with
ordinary privacy metric recalculation. Keep these seams when adding features.
The structural plan and its acceptance records are
[issue #254](https://github.com/yubisuke/openmasu/issues/254); the functional plan
is [issue #218](https://github.com/yubisuke/openmasu/issues/218).

| Current source status | Boundary to retain | Ownership |
| --- | --- | --- |
| Source implemented | Declared workspace dependencies, public lightweight helpers, no executable-app cross-imports, unchanged contract results | Dependency boundaries #255 |
| Source implemented | Ordinary deletion invalidates and actually recomputes every affected saved metric group | Privacy correction #219 |
| Source implemented | Shared profile validation; separate SQL selection/calculation/persistence and pure evaluator responsibilities | #257, #258, #259 |
| Source implemented | Feature controllers over the existing authentication and typed view-model boundaries | #256 |
| Source implemented | Runtime ingestion separated from privileged seed support, preserving atomic bulk writes | #260 |

Unrelated SDK and operational work does not wait for every structural item.
Use bounded PRs and existing regression suites. The matching
[project-plan crosswalk](project-plan.md#next-development-foundations) describes
the same source state and acceptance boundaries. These structural changes do not
complete the functional backlog or prove live-provider or production readiness.

## Optional operator evidence

These gates remain useful but require separate authorization and private
infrastructure:

- controlled comparison with an existing MMP under identical definitions;
- live cost, revenue, platform callback, and provider-permission validation;
- physical-device and store-distribution checks;
- real domain association and deep-link observation;
- production TLS, alert routing, backup recovery, incident response, and load;
- live integrity projects and fraud-threshold calibration.

They are not prerequisites for synthetic integration hardening.

## Deliberate boundaries

The roadmap does not include device fingerprinting, probabilistic identity,
cross-device graphs, partner-only attribution presented as open support, or iOS
deferred deep linking. OpenMasu remains an auditable Shadow MMP rather than a
general promise to replace an existing provider.
