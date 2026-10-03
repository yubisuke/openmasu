# Ingestion Boundaries

Production ingestion and synthetic fixture preparation have separate entrypoints.
They still use the same evaluator and ledger writers. This is responsibility and
privilege separation, not a second ingestion engine or a new service.

## Entry and dependency direction

`apps/worker/src/ingestion.ts` preserves `ingestRuntimeBatch` and its result type.
SDK, store, and import callers continue using that path. The application function
receives attempts, a pool, bounded historical candidates, and optional persistence
settings explicitly; importing a helper does not create a connection or read
deployment configuration.

```text
production entry -> application -> admission / candidate reads / ledger writers
                             -> contract evaluator and registered rule bundles

seed and parity -> test-support -> the same application helpers and ledger writers
```

Production value imports never point back to `test-support`. Tests and seed tools
import fixture helpers directly from that directory; there is no lazy-import or
re-export facade connecting privileged fixture operations to the production entry.

| Module under `apps/worker/src/` | Responsibility |
| --- | --- |
| `ingestion/application.ts` | Scope partitioning, registered bundle resolution, evaluation order, current-artifact selection and transaction ownership |
| `ingestion/model.ts` | Generated artifact types, payload-validation proof and closed value-free failure metadata |
| `ingestion/admission.ts` | The existing compiled event validator, rejected delivery/rejection projection and explicit runtime evaluation input |
| `ingestion/input.ts` | Legacy input traversal, explicit timestamp/policy lookup and resolved refund-target selection |
| `ingestion/candidate-queries.ts` | Scoped deep-link and historical-purchase reads, including the existing caller-client option |
| `ingestion/record-repository.ts` | Client-only raw record, delivery, logical event, correction and rejection writes |
| `ingestion/fact-projections.ts` | Event-specific fact writes and bulk row mapping; shared acquisition-dimension fallback |
| `ingestion/derived-repository.ts` | Client-only attribution, fraud and reconciliation writes with recorded fraud-revision checks |
| `ingestion/bulk-repository.ts` | Existing bulk preparation and ordered JSON-row SQL through the supplied client |
| `test-support/fixture-ingestion.ts` | Fixture candidate staging, reset, capture, parity metadata and fixture orchestration |
| `test-support/fraud-bundle-seed.ts` | Synthetic default-bundle preparation, separate from production revision resolution |
| `test-support/seed-safety.ts` | The existing privileged seed lock and bounded deadlock retry |

The legacy envelope remains open for compatibility. `PayloadValidatedAttempt`
means its event payload passed the contract validator, not that a second stricter
envelope policy ran. Runtime result families use generated contract types. Failed
admission emits only the existing delivery/rejection metadata and schema field
paths; it never emits payload values, device identifiers or an error-message copy
of the source. Fixture family dispatch uses explicit type assertions because
TypeScript cannot correlate the family key with an indexed evaluator-output union.

## Transaction ownership

The application coordinator owns production write transactions. Repository and
fact helpers accept `PoolClient` and do not connect, begin, commit, or roll back a
transaction. Existing scope, validation, evaluation, and write order are retained.

| Path | Existing unit retained |
| --- | --- |
| Ordinary row persistence | One scoped transaction for an attempt's raw record, available payload state, delivery, logical event, fact projection and rejection |
| Bulk import persistence | One scoped transaction for the selected chunk's record, fact and derived artifacts; ordered JSON inserts retain the 1,000-row SQL chunk size |
| Caller-owned persistence client | The supplied client receives writes without a nested transaction; the caller retains commit/rollback and privacy-fence ownership |
| Ordinary auxiliary artifacts | Existing separately scoped attribution, correction, fraud and reconciliation transactions |
| Synthetic fixture preparation | The explicit privileged seed coordinator retains its lock/reset/capture lifecycle and calls the same ledger writers |

App preparation and candidate/bundle reads retain their existing boundaries. This
refactor does not make the entire import job or an ordinary batch one new atomic
transaction. Caller-owned persistence still requires one tenant/app scope and
rejects bulk mode and unsupported auxiliary artifacts.

Bulk mapping, revision checks and delivery-attempt ID preparation remain before
the transaction begins. Redirector clicks and deep-link opens retain their
specialized projection/read/audit path; purchase-before-refund ordering and
historical refund-target constraints remain unchanged. Share mapping only where
its meaning is identical; do not replace these paths with a generic repository.

## Adding or changing an ingestion feature

1. Keep transport authentication and normalization at the existing entry adapter.
   Reuse the compiled contract payload validator before evaluation or ledger writes.
2. Add domain decisions to the evaluator, not SQL or a fixture-only calculation.
   Pass scope, policy revision, time and historical evidence explicitly.
3. Add a coherent fact/record mapping through the supplied client. Preserve the
   coordinator's transaction and privacy fence and the supported bulk path.
4. Keep synthetic preparation under `test-support`; do not expose it through a
   production barrel. Update test-only import paths explicitly when moving it.
5. Reuse existing runtime tests. Add a small case only for a missing boundary;
   do not duplicate the whole import or database suite for each module.

`npm run check:module-boundaries` follows transitive value imports from the actual
worker and ingestion entries. It rejects reachable seed/test-support modules,
testing-schema SQL and seed-pool use, and transaction ownership inside the four
client-only repository modules. Type-only references and an unused seed-pool
factory declaration in the shared runtime library are not executed seed access.
This is a static guard for checked imports, not proof of every dynamic execution.

Run the existing gates after a change:

```bash
npm run typecheck
npm test
npm run validate
npm run test:integration
npm run test:db-invariants
npm run seed
npm run verify:parity
npm run test:metric-parity
npm run test:financial-parity
npm run benchmark:import
```

Database gates require the documented separated roles. Use the existing runtime
CI when the local environment has no PostgreSQL/Compose setup; a skipped test is
not a pass. The benchmark is a 100,000-row synthetic floor, not production-scale
capacity evidence. Structural changes must leave schemas, registries, spec and
reviewed golden fixtures unchanged and preserve the external HTTP/CLI/SDK surface.
