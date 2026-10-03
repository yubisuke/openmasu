# SQL Metric Engine Boundaries

The PostgreSQL metric engine lives in `apps/worker/src/metrics`. Its output must
remain byte-identical, under JSON Canonicalization Scheme (JCS), to the contract
evaluator. This is a module layout, not a second metric contract or a generic
database framework.

## Where to place a change

| Module | Responsibility |
|---|---|
| `cohort.ts` | Compatible public entrypoints and the pool-owned repeatable-read transaction |
| `input.ts` | Legacy scope inference, existing definition admission and bounded calculation input |
| `model.ts` | Definitions, grouping, FX, evaluation, snapshot, result and replay boundary types |
| `snapshot.ts` | Watermark/privacy-scoped record scan, cost selection and snapshot hashing |
| `event-values.ts` | Calendar event counts and custom conversion calculations |
| `cohort-values.ts` | Cohort, retention, ad revenue, purchase/refund and total-net calculations |
| `engagement.ts` | First-party engagement evidence and credited outcomes |
| `persistence.ts` | Metric, immutable replay manifest and calculation-evidence writes |
| `execution.ts` | Application coordinator: select inputs, calculate, assemble artifacts and persist |

Total-net revenue delegates to the ad-revenue and purchase calculations. Keep
that family together rather than creating one file per function or a circular
calculator dependency. Selected-acquisition SQL remains shared through the
existing runtime export.

## Execution and replay

CLI, scheduled runs, late corrections and privacy replay reach
`computeSqlMetricRuns` or `computeSqlMetricRunsWithClient`. Each path still owns
its authentication, claim, privacy fence and failure handling. Sharing a
calculation boundary must not erase those protections.

`computeSqlMetricRuns` opens one repeatable-read transaction, sets the tenant,
commits on success and rolls back on failure. The client-based entrypoint and
every helper borrow that same client; they never create a pool, open a nested
transaction, acquire another fence or commit independently. Metric artifacts,
replay manifests and calculation evidence stay in the caller's atomic write.

`prepareMetricCalculation` retains the existing admission rules. Its typed
result is not a claim that legacy fixtures passed a closed schema. Do not add
closed validation, strip unknown saved evaluation/FX metadata, invent missing
ratio scales or normalize timestamps during a structural move.

Replay retains the original definition, FX snapshot, grouping and watermark.
Correction paths may change run identity, freshness, privacy state and the
supersession link according to their existing rules. Never reconstruct a result
by copying the old numeric value. HTTP code uses the shared runtime replay
operation and worker calculator callback; it must not import worker internals.

SQL rows are interpreted at the read boundary. Snapshot records expose only
the fields used by calculation; policy digests remain part of snapshot hashing,
not a database-row property leaking into the application model. Preserve
UTF-16 ordering, streaming cursor cleanup and per-event half-even rounding.
Missing, undefined and zero are distinct. Apple aggregate and deterministic
acquisition series remain separate.

## Verification

Use the existing gates rather than introducing another test harness:

```bash
node --import tsx --test apps/worker/src/metrics/structure.unit.test.ts
npm run validate
npm run test:metric-parity
npm run verify:consistency
npm run test:integration
```

The focused boundary test covers shared CLI/schedule/saved-manifest/privacy
meaning, tenant scope, a caller-owned client, commit/rollback and cursor cleanup.
Database suites retain their actual calculation, privacy, late-correction,
supersession and atomicity assertions.

The existing synthetic SQL performance floor can compare a local earlier commit
against this checkout, with the same dependencies, database settings and row
count:

```bash
OPENMASU_BENCHMARK_ROWS=100000 npm run benchmark:metric-floor \
  --workspace @openmasu/worker -- --base-ref=<full-local-commit-SHA>
```

PR CI supplies its base commit. Empty or absent `--base-ref` retains the ordinary
single-run command. The comparison stages one benchmark source file under ignored
`build/`, removes it after execution, and reports both timings and the fixed
environment. It neither clones a repository nor creates a worktree.

This floor measures synthetic SQL aggregation, not the whole application or
production throughput. Review moved SQL and bound parameter expressions for
identity, use parity tests for output correctness, and do not interpret noisy
before/after timings as a new capacity guarantee.
