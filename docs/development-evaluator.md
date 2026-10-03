# Reference evaluator boundaries

The TypeScript evaluator in `@openmasu/attribution-core` owns reference
calculation, not database or transport operations. Its public package entrypoint
remains `src/evaluator.ts`. Call `evaluate(input, candidateProviderFactory?)`;
do not import private calculation helpers from another workspace.

## Where a change belongs

| Module in `packages/attribution-core/src` | Responsibility |
| --- | --- |
| `evaluation-model.ts` | Generated artifact aliases, decision boundary types, candidate history types, and existing contract/rule version constants. No runtime imports. |
| `evaluation-utils.ts` | UTF-16 ordering, composite keys, strict explicit timestamps, calendar dates, and half-even division. |
| `candidates.ts` | Ordered attempts, array/indexed providers, logical/evidence/decision keys, payload digest and history lookups. |
| `ingestion-decisions.ts` | Scope and anchor checks, consent, duplicate/conflict decisions, purchase/refund admission, timestamp rejection, and evidence lifecycle indexing. |
| `rule-bundles.ts` | Explicit registered bundle identity/digest/hash checks and the existing fixture defaults. |
| `attribution.ts` | Installation, imported/platform/aggregate, and deep-link attribution; historical installs impacted by newly received clicks. |
| `fraud-artifacts.ts` | Bound transport/install/source decisions, clock-provisional revisions, and fraud attribution/exclusion effects. |
| `metric-runs.ts` | Reference definitions/profile guards, cost selection, snapshots, family calculations, grouping, FX rounding, and metric artifacts. |
| `reconciliation.ts` | Imported reconciliation inputs, matching, persisted explanation fields, and reason selection. |
| `evidence-artifacts.ts` | Raw/delivery/logical artifacts, refund/privacy corrections, privacy artifacts, and rejection artifacts. |
| `evaluator.ts` | Public exports and the ordered coordinator. |

Purchase/refund admission stays with ingestion decisions: its shared consent and
base-admission checks must not form a return dependency from a commerce module.
Metric family calculations remain together where they share selected evidence,
costs, and snapshot meaning. A smaller function or file is not by itself a reason
to add another layer.

## Sequence and explicit inputs

The coordinator retains this sequence:

1. Sort input attempts and construct the caller's candidate provider.
2. Check import/revenue context and scoped references, including provider history.
3. Decide current deliveries, index decisions, and validate accepted installation
   anchors. Timestamp errors become rejection decisions at this boundary.
4. Index deletion/retention state and select accepted current attempts.
5. Assemble ingestion evidence, initial attribution, and privacy/correction inputs.
6. Evaluate fraud using supplied bundle revisions and apply provisional/exclusion
   attribution revisions.
7. Assemble rejections, sort correction artifacts, and calculate cost, definition,
   metric, and reconciliation outputs in the original order.

Helpers depend on lower-level named modules, never on `evaluator.ts`. Shared
types are leaf declarations derived from `@openmasu/contracts/types`. A historical
canonical decision deliberately has less metadata than a current delivery; do
not invent delivery or consent fields for it. Current artifacts have generated
output types. The public legacy input shape and candidate server/record objects
remain unchanged; this split is not a new input admission policy or an exhaustive
`any` migration.

All evaluation times, watermarks, policies, and registered bundle definitions
are caller inputs. Calculation modules do not query PostgreSQL, import an
executable app, read environment variables, call the network, or choose a current
clock/random value. The existing shared profile validator still initializes
compiled validators from checked-in schemas in the contracts package; this
startup dependency is not a claim that importing the entire evaluator performs
no filesystem reads.

## Compatibility evidence

The structural split was checked against commit
`d15f24a9477a6690eea02444fd45ee584aa44827`: after TypeScript type erasure,
all 67 existing function/class bodies and all 46 expanded coordinator statements
match, as do final artifact fields and their evaluation order.

The two `evaluator module boundaries` unit cases check the exact public runtime
export set and constructor identities, compile the original public type imports,
and reject local runtime cycles, app/IO imports, implicit clocks, and environment
reads. They run in the existing unit suite, without another CI matrix.

Use `npm run validate` for immutable contract goldens and independent Python
parity, and the existing `test:metric-parity` and `verify:parity` runtime gates
for SQL/database paths. Python remains separately implemented; no TypeScript
source is used to generate it. See [SQL metric boundaries](development-sql-metrics.md)
and [metric profile boundaries](development-metric-profiles.md) when a calculation
or profile changes.
