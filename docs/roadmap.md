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
| Release notes, SDK identity, tagged evidence, and post-tag development describe one exact candidate | Open for the next prerelease |

The next release candidate is the only open exit gate. It must receive a new
version and evidence manifest; post-tag `main` must not reuse rc.3 identity as
published release evidence.

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
