# Development Guide

This guide defines the normal local workflow and the evidence required for a
change. Repository instructions in `AGENTS.md` remain authoritative.

## Before editing

1. Start from a clean, current local branch.
2. Create a topic branch; do not edit `main` directly.
3. Keep real data and credentials outside the repository.
4. Identify whether the change affects the contract, runtime, SDKs, security,
   documentation, or release packaging.
5. Read the corresponding current design and validation documents.

## Common gates

Install the pinned toolchains and dependencies described in
[Getting started](getting-started.md).

```bash
npm run typecheck
npm test
npm run validate
```

`npm run validate` is read-only. It must not regenerate or rewrite fixture
goldens.

Runtime and database changes normally require:

```bash
npm run test:integration
npm run test:db-invariants
npm run verify:parity
```

Reporting and metric changes normally require:

```bash
npm run test:metric-parity
npm run test:dashboard-parity
```

Privacy and recovery changes normally require:

```bash
npm run test:privacy-e2e
npm run test:backup-restore
```

Android, iOS, and Unity gates are described in their SDK READMEs and pinned
GitHub Actions workflows. A Windows or Linux contributor must not claim an iOS
build passed locally when only the macOS workflow provides that evidence.

## Contract changes

The active contract consists of:

- `schemas/` and `schemas/events/`;
- `registries/`;
- `fixtures/v0.4/`;
- `spec/event-metric-contract-v0.4.md`;
- the TypeScript and Python evaluators.

Follow [Schema versioning](schema-versioning.md). Existing `$id` values and
version constants are public identities. Reviewed golden outputs are immutable
evidence; changing one is a contract-behavior change and requires a written
derivation in `fixtures/v0.4/README.md`.

## Documentation changes

Write documentation for a reader who knows only the repository. Define an
acronym or internal term at first use. Do not rely on issue comments, review
meetings, work-order numbers, or decision IDs to explain current behavior.

Use these categories:

- current user and contributor guidance in `README.md` and `docs/`;
- normative behavior in `spec/`, schemas, and registries;
- tagged release records in `docs/releases/`;
- historical planning and review records in `issue-drafts/` and
  `docs/review/`.

When status, roadmap order, or a validation inventory changes, update every
linked summary in the same change. Run:

```bash
npm run check:doc-drift
npm run check:doc-links
npm run check:threat-model
```

## Evidence language

Use the narrowest accurate claim:

- **implemented** means code exists;
- **synthetically verified** means checked-in synthetic evidence passed;
- **simulator- or emulator-verified** is not real-device verification;
- **operator-verified** requires the named private checklist;
- **production-verified** requires an actual deployment record.

Do not use synthetic evidence to claim live provider support, production
capacity, store approval, device delivery, or equivalence with another MMP.
