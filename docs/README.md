# Documentation

For opt-in refresh of saved cohort results from retained input receipts, see
[Automatic metric corrections](automatic-metric-corrections.md). Upstream
arrival/completeness remains unknown.

This directory describes the current OpenMasu product and how to work with it.
No document assumes access to project conversations, review sessions, or
private provider material.

## Choose a starting point

| Goal | Start here |
| --- | --- |
| Run OpenMasu safely with synthetic data | [Getting started](getting-started.md) |
| Understand what the project does and does not claim | [Product scope](product-scope.md) and [Project status](STATUS.md) |
| Understand services, data flow, and trust boundaries | [Architecture](architecture.md) |
| Make a change and select the right gates | [Development](development.md) and [Contributing](../CONTRIBUTING.md) |
| Implement or review contract behavior | [Contract specification](../spec/event-metric-contract-v0.4.md), [Schema versioning](schema-versioning.md), and [Contract v0.4 migration ledger](contract-v0.4-migration.md) |
| Integrate a platform or provider | [Provider capability matrix](integrations/provider-capability-matrix.md) and [Primary references](references.md) |
| Send events from an app backend | [Server-to-server events](server-to-server-events.md) |
| Use backend receipt or report HTTP from another tool | [Limited OpenAPI contract and client example](api/README.md) |
| Download and integrate a versioned SDK | [SDK distribution](sdk-distribution.md) |
| Check the published SDK's exact source and download evidence | [v0.3.0-rc.1 publication receipt](validation/v0.3.0-rc.1-publication.md) |
| Deliver accepted events to an operator receiver | [Operator event webhooks](operator-event-webhooks.md) |
| Deliver deterministic event files to operator storage | [Operator bulk event exports](operator-bulk-exports.md) |
| Run daily cohort or calendar metrics | [Scheduled metric runs](scheduled-metrics.md) |
| Refresh cost and recalculate selected affected cohorts | [Cost refresh](cost-refresh.md) and [Metric corrections](metric-corrections.md) |
| Distinguish mature windows, empty receipts and pending calculations | [Metric freshness](metric-freshness.md) |
| Operate or release a deployment | [Operator documentation](#operator-documentation) and [Release records](releases/README.md) |

For a complete newcomer reading path, use this order:

1. [Getting started](getting-started.md) — run the isolated synthetic system.
2. [Product scope](product-scope.md) — understand what the project supports and
   what it deliberately does not claim.
3. [Project status](STATUS.md) — distinguish implementation, synthetic
   evidence, tagged releases, and unverified operational work.
4. [Architecture](architecture.md) — understand services, data flow, and trust
   boundaries.
5. [Development](development.md) — choose the correct validation gates and make
   safe changes.
6. [Contract specification](../spec/event-metric-contract-v0.4.md) — read the
   normative event, attribution, reconciliation, fraud, and metric behavior.

## Current product and engineering documents

- [Import mapping DSL](import-mappings.md)
- [Server-to-server events](server-to-server-events.md)
- [Operator event webhooks](operator-event-webhooks.md)
- [Operator bulk event exports](operator-bulk-exports.md)
- [Scheduled metric runs](scheduled-metrics.md)
- [Bounded cost refresh](cost-refresh.md)
- [Selected metric corrections](metric-corrections.md)
- [Measurement health and missing results](measurement-health.md)
- [Metric maturity, local acquisition and recalculation observations](metric-freshness.md)
- [Recorded attribution reason counts](attribution-reasons.md)
- [Reading and filtering dashboard metrics](dashboard-analysis.md)
- [Selected ad-group and creative metrics](acquisition-detail-metrics.md)
- [Verified platform acquisition cohorts](verified-platform-acquisition.md)
- [Imported provider acquisition cohorts](imported-acquisition-metrics.md)
- [Explicit local-calendar cohorts](calendar-cohort-metrics.md)
- [First-party re-engagement outcomes](engagement-outcomes.md)
- [Explaining a saved ROAS result](metric-explanations.md)
- [Privacy and security](privacy-security.md)
- [Threat model](threat-model.md)
- [Schema versioning](schema-versioning.md)
- [Primary external references](references.md)
- [Provider capability matrix](integrations/provider-capability-matrix.md)
- [Measurement comparison priorities](integrations/mmp-landscape.md)
- [Cohort comparison in the dashboard and CLI](cohort-comparison.md)
- [CI scope and test cost](ci-scope.md)
- [Roadmap](roadmap.md)
- [Project plan](project-plan.md)

The [design index](design/README.md) links the implemented subsystem designs
for ledger/import/metrics, Android/Unity/redirector, dashboard/reporting,
iOS/Apple, fraud, deep links, verified commerce, privacy, and rule provenance.
These documents describe current behavior and residual boundaries, not an
approval or work-order process.

## Operator documentation

- [Backup and restore](operations/backup-restore.md)
- [Safe version-to-version upgrade](operations/upgrade.md)
- [Single-host deployment and normal restart](operations/single-host.md)
- [Read-only storage and retention boundaries](operations/capacity.md)
- [Runtime observability](operations/observability.md)
- [Release runbook](operations/release.md)
- [Validation checklists](validation/README.md)

Operator checklists separate repository-controlled synthetic evidence from
checks that require a private deployment, device, domain, provider account, or
store environment. Completing a synthetic gate never completes an operator
gate automatically.

## Version and history documents

- [Release records](releases/README.md) describe exact tagged source and SDK
  candidates. They are immutable evidence for the named tag, not current-main
  documentation.
- `docs/contract-v0.*-migration.md` records contract migrations.
- [Issue drafts](../issue-drafts/README.md) and [review records](review/README.md)
  are historical planning material. They are not current instructions and are
  not part of the newcomer reading path.
- Git tags preserve complete older contract lines.

When a historical document conflicts with the active schema or specification,
the active files in `schemas/`, `registries/`, `fixtures/v0.4/`, and
`spec/event-metric-contract-v0.4.md` take precedence.
