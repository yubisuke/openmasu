# Documentation

Start with [Getting started](getting-started.md) for a synthetic walkthrough.
These documents describe current source unless they explicitly name a release.

## Where to look

| Question | Read |
| --- | --- |
| What is implemented, and what remains unverified? | [Project status](STATUS.md) |
| What is the product boundary? | [Product scope](product-scope.md) |
| What should be developed next? | [Roadmap](roadmap.md) and [Project plan](project-plan.md) |
| Where should a code change go, and which test owns it? | [Development](development.md) and [CI scope](ci-scope.md) |
| How do the services fit together? | [Architecture](architecture.md) and [Design index](design/README.md) |
| What is normative contract behavior? | [Specification](../spec/event-metric-contract-v0.4.md), [fixtures](../fixtures/v0.4/README.md) and [schema versioning](schema-versioning.md) |
| Which release contains a feature? | [Release index](releases/README.md) and [unreleased scope](releases/next.md) |

## Measurement guides

- **Receive and diagnose:** [measurement health](measurement-health.md),
  [backend events](server-to-server-events.md), [import mappings](import-mappings.md),
  [safe ingest recovery](operations/ingest-recovery.md).
- **Choose attribution evidence:** [recorded reasons](attribution-reasons.md),
  [first-party acquisition](selected-acquisition-metrics.md),
  [verified platform acquisition](verified-platform-acquisition.md),
  [imported acquisition](imported-acquisition-metrics.md),
  [detailed acquisition](acquisition-detail-metrics.md).
- **Define calculations:** [acquisition KPIs](acquisition-kpis.md),
  [retention](standard-retention.md), [custom outcomes](custom-conversion-metrics.md),
  [calendar cohorts](calendar-cohort-metrics.md), [FX snapshots](fx-snapshots.md),
  [cost selection](cost-selection.md), [re-engagement outcomes](engagement-outcomes.md).
- **Keep results current:** [scheduled metrics](scheduled-metrics.md),
  [freshness](metric-freshness.md), [cost refresh](cost-refresh.md),
  [explicit corrections](metric-corrections.md),
  [automatic corrections](automatic-metric-corrections.md).
- **Read and compare:** [dashboard analysis](dashboard-analysis.md),
  [saved calculation evidence](metric-explanations.md),
  [cohort comparison](cohort-comparison.md).
- **Send selected events:** [operator webhooks](operator-event-webhooks.md),
  [bulk exports](operator-bulk-exports.md).
- **Use APIs and SDKs:** [HTTP API](api/README.md),
  [Android](../sdk/android/README.md), [iOS](../sdk/ios/README.md),
  [Unity](../sdk/unity/README.md), [SDK distribution](sdk-distribution.md).

## Development and operations

The [development guide](development.md) links the existing dependency, HTTP,
metric, evaluator and ingestion boundaries. Use those seams rather than another
framework or parallel service.

For deployment and recovery, see [single-host operation](operations/single-host.md),
[upgrades](operations/upgrade.md), [backup/restore](operations/backup-restore.md),
[observability](operations/observability.md), [capacity](operations/capacity.md)
and [release publishing](operations/release.md).

[Privacy and security](privacy-security.md) and the [threat model](threat-model.md)
define the safety boundary. [Validation checklists](validation/README.md) separate
synthetic evidence from optional private operator checks.

## History

Migration ledgers, tagged release notes, publication receipts, `issue-drafts/`
and `docs/review/` are historical records, not current instructions. They must
not make later source changes appear to be part of an older release.
