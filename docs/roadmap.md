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
| Scheduler leases cannot consume the job pool; MAX processing works with a one-connection job pool | Complete |
| Android and iOS queues share duplicate and event-ID conflict vectors | Complete |
| One disposable synthetic command is the canonical first run | Complete |
| Current documentation excludes unexplained review, work-order, and decision references | Complete |
| CI cancels superseded runs and routes expensive gates without hiding required contexts | Complete |
| Release notes, SDK identity, tagged evidence, and source revision describe one exact candidate | Complete for v0.2.0-rc.4 |
| App backends can submit selected first-party events without SDK-key reuse or advertising identifiers | Complete with synthetic server-key lifecycle, ingestion, rejection, idempotency, and privacy tests |
| Operators can receive a closed subset of accepted events without raw identifiers or provider-specific wire coupling | Complete with synthetic destination lifecycle, DNS/SSRF, signature, retry, privacy, and disablement tests |
| Operators can receive delayed deterministic files without adopting a provider-specific export layout | Complete with synthetic SigV4 vectors, object replay, durable cursor, credential boundary, privacy-notice, and lifecycle tests |
| App metrics advance without an external cron wrapper | Complete with immutable app schedules, UTC lag/watermark policy, bounded catch-up, exact crash replay, and report/dashboard integration tests |
| Queue-only tenants are discoverable before tenant-scoped processing begins | Complete for Google Play and integrity verification plus commerce provider read-back, with SELECT-only owner discovery policies and drain-to-terminal integration evidence |
| A slow tenant does not globally block independent tenant cycles | Synthetic source-level complete within one worker process with a bounded FIFO coordinator, same-tenant deduplication, unchanged per-tenant job order, bounded shutdown, and concurrent scheduler-lease evidence; full process shutdown and multi-replica tenant-wide ordering remain operational boundaries |
| One SDK or MAX backlog does not create an unbounded tenant cycle | Complete with configurable 1-1000 row FIFO slices, default 100, and synthetic 2-then-1 drain evidence |
| One active Google conversion claim cannot be concurrently finalized by another worker | Complete with a per-row database-clock lease, token-fenced transactional completion, expired-claim recovery, and stable transaction-ID evidence; provider-side exactly-once behavior remains unverified |
| One active platform-integrity verification cannot race another worker or completed deletion | Complete with a per-row database-clock lease, bounded provider wait, token-fenced transactional completion, source-lifecycle recheck, deletion-first and completion-first privacy evidence, and restored-evidence purge; provider-side exactly-once behavior remains unverified |
| One active Google Play verification cannot race another worker or completed deletion | Complete with a per-row database-clock lease, bounded provider reads, token-fenced retry and completion, source-lifecycle recheck, deletion-first and completion-first privacy evidence, and restored-evidence purge; provider-side exactly-once behavior remains unverified |

Candidate v0.2.0-rc.4 satisfied the release-coherence exit gate at green `main`
commit `2a2f6b5`. Authenticated backend events and operator event webhooks were
then followed by bounded operator-owned bulk event exports and durable daily
metric execution. These are
integration milestones rather than provider or attribution claims. The next
repository work is selected from current-code
audits of compatibility, failure recovery, reconciliation completeness, and
operational correctness.

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
