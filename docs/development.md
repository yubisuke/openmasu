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

## Placing a change

- HTTP and dashboard behavior starts in `apps/api/src/routes.ts` and its feature
  handler. Keep authentication and response parsing at that boundary. Build a
  typed view model before calling a dashboard renderer; rendering does not query
  PostgreSQL or read environment variables.
  [HTTP and dashboard boundaries](development-http.md) locates the exhaustive
  controller registry, shared authentication, bounded decoders, validated
  application adapter, and pure presentation modules.
- A metric definition belongs in `packages/contracts/src`; its closed shape is
  validated through `@openmasu/contracts/validation`. Calculation changes require
  the reference evaluator, independent Python implementation, and SQL engine in
  `apps/worker/src/metrics` to agree. Use the existing metric-parity suite.
  [Metric profile boundaries](development-metric-profiles.md) describes the shared
  metadata, entry-specific validators and frozen admission table. Extend those
  declarations rather than copying a profile guard into another entrypoint.
  [SQL metric boundaries](development-sql-metrics.md) locates input selection,
  family calculations and persistence inside the existing worker. Keep the
  caller's client, transaction, privacy fence and saved replay meaning intact.
  [Reference evaluator boundaries](development-evaluator.md) locates candidate
  selection, ingestion/commerce decisions, attribution, fraud, metrics,
  reconciliation and artifact assembly inside the pure calculation package.
  Preserve the public entrypoint and explicit input order when extending it.
- A provider adapter belongs in the corresponding worker import/job module and
  receives bounded synthetic responses in tests. Reuse the existing ingestion,
  privacy fence, and job lifecycle rather than introducing another queue.
  [Ingestion boundaries](development-ingestion.md) locates admission, candidate
  reads, client-only ledger writers and application-owned transactions. Synthetic
  reset/seed/capture belongs to its separate test-support entrypoint, never the
  production import graph.
- Shared IO belongs in an explicit `@openmasu/runtime` export. Shared pure CSV
  and decimal operations use `@openmasu/runtime/import-normalization`; hashes use
  `@openmasu/attribution-core/canonical`. Do not import a sibling application's
  private source just to reuse a helper.
- Privacy metric corrections use the shared runtime selection/replay operation
  and a typed calculator callback. HTTP queues the existing durable worker;
  restore owns its exclusive tenant transaction. Do not copy saved numbers or
  add a sibling-app import to make a deletion appear recalculated.
- Use `@openmasu/contracts/types` for type-only imports and
  `@openmasu/contracts/definitions` for metadata. Import the validation subpath
  when validation is required; a metadata import must not compile schemas.

Declare each imported workspace dependency in its own `package.json` and update
the lockfile. Runtime imports require runtime dependencies. Review SBOM component
changes explicitly, including newly declared dependencies that code already
used. `npm run check:module-boundaries` checks production import declarations,
cross-workspace boundaries, the pure entrypoints, and runtime workspace cycles.
Tests and generated declarations are outside the production import graph.

## Common gates

Install the pinned toolchains and dependencies described in
[Getting started](getting-started.md).

```bash
# While iterating: type-check or run the affected existing test file.
npm run typecheck
# Before handoff: run the applicable full gate once.
npm run validate
```

`npm run validate` is read-only. It must not regenerate or rewrite fixture
goldens.

Use the narrowest existing command while implementing; do not stack focused
aliases after their containing suite has already passed. `validate` already
type-checks. CI owns the full unit/integration suites once; see
[CI scope and test cost](ci-scope.md) for redundant subsets and load policy.
Contract validation checks documentation with its measured inventory and prints
the final summary from that same run. Do not follow it with `check:doc-drift` or
`validate:summary`. New tests should cover a distinct behavior or failure boundary,
not another seed that yields an existing input, a source-text spelling, or a
fixed test-count target.

Choose a command for the boundary being changed, not every command in this table.
These are local alternatives and CI ownership references, not a cumulative
checklist:

| Change | Focused local check | Full CI owner |
| --- | --- | --- |
| Pure behavior or input parsing | `node --import tsx --test <affected.unit.test.ts>` | Runtime's single `npm test` run |
| HTTP, ingestion, privacy or persistence | The affected `.integration.test.ts` file with a synthetic database | Runtime's single `test:integration` run |
| Metric calculation | `npm run test:metric-parity` | SQL metric-parity step; do not copy its cases into a second suite |
| Dashboard/report consistency | `npm run test:dashboard-parity` | Already inside `test:integration`; do not run both for the same edit |
| Ledger constraints and role grants | `npm run test:db-invariants` | Separate database-invariant step |
| Persisted contract artifacts | `npm run verify:parity` after synthetic seed | PostgreSQL golden-parity step |
| Backup and restored privacy state | `npm run test:backup-restore` with its opt-in restore environment | One dedicated backup/restore run; idempotency and connection cleanup are asserted within the suite |

`test:privacy-e2e`, `test:m2a` and `test:financial-parity` are convenience subsets.
Do not run them after their containing suites have already passed. A database
test skipped for lack of an environment is not evidence that it passed. Keep
iteration focused; the applicable full gates belong at handoff and in CI, not
after each edit.

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
linked summary in the same change. The full `validate` command already checks
documentation drift, links and threat-model coverage. For a focused
documentation-only edit, use the relevant standalone command instead of the
full gate:

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
