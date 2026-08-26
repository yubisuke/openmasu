# Documentation

This directory describes the current OpenMasu product and how to work with it.
No document assumes access to project conversations, review sessions, or
private provider material.

## New contributor path

Read these documents in order:

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

## Current references

- [Import mapping DSL](import-mappings.md)
- [Privacy and security](privacy-security.md)
- [Threat model](threat-model.md)
- [Schema versioning](schema-versioning.md)
- [Primary external references](references.md)
- [Roadmap](roadmap.md)
- [Project plan](project-plan.md)

The files under `docs/design/` describe the implemented design by subsystem.
They document current behavior and residual boundaries, not an approval or work
order process.

## Operator documentation

- [Backup and restore](operations/backup-restore.md)
- [Runtime observability](operations/observability.md)
- [Release runbook](operations/release.md)
- [Validation checklists](validation/README.md)

Operator checklists separate repository-controlled synthetic evidence from
checks that require a private deployment, device, domain, provider account, or
store environment. Completing a synthetic gate never completes an operator
gate automatically.

## Version and history documents

- `docs/releases/` records tagged source and SDK release candidates.
- `docs/contract-v0.*-migration.md` records contract migrations.
- `issue-drafts/` and `docs/review/` are historical planning and review
  records. They are not current instructions and are not part of the newcomer
  reading path.
- Git tags preserve complete older contract lines.

When a historical document conflicts with the active schema or specification,
the active files in `schemas/`, `registries/`, `fixtures/v0.4/`, and
`spec/event-metric-contract-v0.4.md` take precedence.
