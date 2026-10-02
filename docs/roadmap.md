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
and 57 reviewed synthetic fixtures.

## Current milestone: integration and release coherence

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
| One active commerce read-back cannot race another worker or completed deletion | Complete with a per-row database-clock lease, token-fenced retry, transactional Google refund and Apple cursor completion, expired-claim recovery, stale-completion rejection, existing-binding cursor cleanup, and Google/Apple deletion-race evidence; App Store binding creation and provider-side exactly-once behavior remain unverified |

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

The [measurement comparison requirements](integrations/mmp-landscape.md) motivate three
ordered slices: an [offline same-cohort comparison](cohort-comparison.md) (implemented with synthetic tests) with explicit definitions and
exact values; integration with saved metric runs and report provenance; then
durable cost refresh and historical corrections. The offline CLI includes a
static HTML report and conversion from saved report JSON with input provenance.
Saved-run semantics, bounded dashboard download, neutral aggregate CSV conversion
and the integrated first-use journey are implemented. Default-off bounded cost
refresh and selected correction-driven recalculation are implemented.
Exact-tag SDK publication is complete for v0.3.0-rc.1, with a
[public receipt](validation/v0.3.0-rc.1-publication.md). Supported-source upgrades, one single-host
configuration path, read-only capacity observation and the limited HTTP contract
are implemented as integration slices. Unknown source/backup combinations are
refused before mutation; real recovery, deployment and capacity remain operator
gates. The distribution tool and [consumer guide](sdk-distribution.md) are
implemented and published for v0.3.0-rc.1 at the exact verified tag.
Each has a synthetic acceptance gate and requires no live provider
credentials. Numeric differences alone must never become inferred causal reasons.

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
