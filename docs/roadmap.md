# Roadmap

OpenMasu is an auditable Shadow MMP and first-party measurement toolkit.
The objective is a coherent, maintainable measurement workflow, not a promise
to replace every feature of an existing provider.

[Project status](STATUS.md) owns current capabilities and release boundaries.
[Project plan](project-plan.md) gives the acceptance crosswalk for the sequence
below. Updated: 2026-10-24.

## Status vocabulary

**Implemented** means source exists; **synthetically verified** means the relevant
repository/CI evidence passed. Neither implies live-provider, physical-device,
store or production qualification. Those remain separate operator evidence.

## Completed contract and product milestones

The contract gate preserves deterministic artifacts across 28 schemas,
8 registries, and 73 reviewed synthetic fixtures. Patch definitions and
derivations are in the [specification](../spec/event-metric-contract-v0.4.md)
and [fixture guide](../fixtures/v0.4/README.md).

These canonical milestone names are shared with security and threat-model
ownership. Completion refers to their declared synthetic scope.

| Milestone | Implemented scope |
| --- | --- |
| Contract v0.2 | Coherent event, attribution, metric and reconciliation contract |
| Contract v0.3 | Android/platform referrer, revenue and device-producer vocabulary |
| Contract v0.4 | OpenMasu identity and additive patch ledger, currently through v0.4.26 |
| Shadow ledger and import foundation | Durable admission, atomic ledger writes, explicit three-family imports and privacy controls |
| Cohort metrics and difference audit | SQL/reference parity, saved snapshots, exact arithmetic and aggregate exports |
| Android, Unity, and redirector | SDK queues, credentials, redirect evidence and synthetic bridges |
| Operator dashboard | Reader-only SSR, shared report queries and saved values |
| iOS and Apple aggregate measurement | Swift SDK, Apple receivers and separate aggregate series |
| Operational control foundation | Roles, restore/privacy reapplication, authenticated observability and operator procedures |
| Deterministic fraud controls | Bound fraud definitions, public rules and synthetic integrity verification |
| Deep links and re-engagement | Direct links on both OSes, Android deferred links and separate engagement outcomes |
| Verified commerce lifecycle | Native verified purchase/refund/reversal and financial projections |
| Import and financial compatibility | Explicit mappings, exact money, backfill cutoffs and bounded import throughput |
| Authenticated backend events | Dedicated server credentials and ordinary durable ingestion |
| Operator event webhooks | Encrypted outbox, exact-body signing and bounded retries |
| Operator-owned bulk event exports | Deterministic NDJSON batches, S3-compatible delivery and keyset checkpoints |

## Completed milestone: integration and release coherence

The current source connects selected acquisition evidence, safe cost grain,
commerce, late-input corrections, daily schedules, saved calculation evidence,
dashboard comparison and cohort presentation. Later additions include explicit
platform/imported profiles, qualified calendar cohorts, fixed FX, same-set KPIs,
standard retention, multiple outcomes, guided setup and safe ingest recovery.

The prior integration plan is complete. It must not be reused as a future
backlog. `v0.3.0-rc.2` is the published source and SDK prerelease; see the
[publication receipt](validation/v0.3.0-rc.2-publication.md),
[post-release scope](releases/next.md) and [SDK distribution](sdk-distribution.md).
The downloaded Android SDK/backend journey has also passed on JVM/Robolectric
API 24, with its later harness revision recorded separately in the receipt.

## Next product sequence

[Daily recorded activity](calendar-activity.md) is implemented in current source:
UTC session starts, all custom events and distinct installations remain separate
from acquisition cohorts, with no sum presented as a period-unique audience.

[Verified payer metrics](payer-metrics.md) are implemented: D7 purchase count,
distinct paying installations, payer rate and purchase-net ARPPU with explicit
verified-projection and refund/undefined boundaries.

The [functional plan](https://github.com/yubisuke/openmasu/issues/218) has 27 of
35 child implementations complete and 8 optional extensions remaining. Backup and
recovery ([#250](https://github.com/yubisuke/openmasu/issues/250)) is implemented;
the dedicated Runtime gate owns its synthetic evidence. Follow individual issue
dependencies; the phases below are priorities, not extra refactoring gates.

| Order | Workstream | Remaining issues / exit |
| --- | --- | --- |
| When needed | Optional measurement and operator extensions | Detailed costs/discovery, another ILR bridge, engagement policies, app access scope, retention expiry, multiple workers and fraud previews; see the [crosswalk](project-plan.md#next-product-slices) |

[Unity purchase binding](../sdk/unity/README.md#protected-store-purchases)
is implemented through the existing native helpers. Queued/pending callbacks are
not verification or entitlement evidence. These helpers are included in rc.2.

Apple [postback observations](apple-postback-observations.md), [registered conversion meanings](apple-conversion-meaning.md)
and [scoped campaign cost](cost-refresh.md#apple-ads-campaign-cost) are implemented.
Selected decoding remains unverified; live provider access is not established.

Saved daily analysis and [broader external cohort comparison](cohort-comparison.md#expanded-closed-declaration)
are implemented; external declarations remain distinct from captured execution.
Integrated candidate acceptance
([#252](https://github.com/yubisuke/openmasu/issues/252)) is complete within its
declared synthetic scope. Select the remaining optional extensions only when
their usage conditions apply. The downloaded Android SDK journey does not
relabel existing fixture-projected campaign/cost/revenue tests or establish
physical-device, all-platform onboarding or live-provider acceptance.

Minimal monitoring rules/runbooks and the operator-scheduled backup, freshness and
isolated restore workflow are implemented in existing tools; see
[monitoring](operations/monitoring.md) and [backup/recovery](operations/backup-restore.md).
Live alert delivery, backup scheduling/custody and recovery time remain separate
operator evidence, not a new service prerequisite.

## Next development foundations

The dependency, metric-profile, SQL, pure evaluator, HTTP/ViewModel and ingestion
boundaries are implemented. Ordinary deletion and restored privacy reapplication
share saved-manifest replay. Do not create another architecture-preparation
backlog before using these seams.

Use [Development](development.md) to place a change. Keep the existing services,
public entrypoints and test ownership; one bounded workflow per PR.
A contract addition still needs versioning, reviewed derivation and evaluator
parity. SDK and operator work does not need unrelated structural prerequisites.

## Optional operator evidence

These checks require separate authorization and private infrastructure:

- comparison with another measurement system under matching definitions;
- live cost, revenue, platform callbacks and provider permissions;
- physical devices, store distribution and real domain association;
- production TLS, alert delivery, backup custody, restore time and capacity;
- live integrity projects and fraud-threshold calibration.

They are not prerequisites for synthetic integration development. Use the
[operator checklists](validation/README.md), and do not count unperformed checks
as successful.

## Deliberate boundaries

No fingerprinting, probabilistic identity, cross-device graph, blanket partner
attribution or iOS deferred deep linking. First-party, platform-assigned,
imported, aggregate, estimated and unknown evidence remain distinct. See
[Product scope](product-scope.md) and [Privacy and security](privacy-security.md).
