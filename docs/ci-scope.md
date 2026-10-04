# CI scope and test cost

Pull requests and main pushes are classified by changed paths. The exact offline comparison
CLI, renderer, their unit tests, and synthetic example run contract/type checks
and unit tests without native builds, database integration, or performance
benchmarks. `tools/ci/changed-scope.mjs` owns this small explicit allowlist.

Shared code, dependencies, workflow changes, and unknown tools retain the
conservative full gate set. Mixed changes take the union of required checks.
Deleted paths are included. Main pushes use the complete before/after diff rather
than rebuilding unrelated SDKs after every documentation or backend merge.
Manual runs, missing revisions, empty/failed diffs and unknown paths retain all gates.
Required jobs remain visible even when their expensive steps are not relevant.

## One owner per correctness test

Runtime executes `npm test` once for all unit files and `test:integration` once
for all application integration files. Do not repeat subsets afterwards:

| Focused local command | Existing CI owner |
| --- | --- |
| `test:m2a` | Unit suite plus application integration suite |
| `test:financial-parity` | Unit suite plus application integration suite |
| `verify:consistency` / `test:dashboard-parity` | Application integration suite |

Those aliases remain useful for a focused local edit; their test files and
assertions remain unchanged. CI no longer repeats them. At the recorded baseline
(Runtime run 37169348844), these duplicate steps re-ran 83 + 8 + 9 tests and
consumed 20 seconds. This is not a promised runtime reduction on every runner.

Windows/Linux contract validation
remains; known offline comparison edits run only their three existing tool test
files on both OSes when Runtime is not already running the unit suite. They no
longer run every unrelated application's unit test. Backup/restore repetition
remains a regression check for repeated
connection cleanup. PostgreSQL parity, role isolation, and disposable Compose
tests cover different boundaries and are not replaced by evaluator unit tests.

## Keep contract validation single-pass

`npm run validate` obtains documentation inventory from the running contract
tests, not a second evaluator process. The existing inventory acceptance check
also checks documentation drift. Node's standard TAP reporter still lists each
test; a small reporter adapter prints the measured inventory last only if the
entire run succeeds. The independent fraud-artifact scan runs before the tests
so a failed scan cannot be followed by a success summary.

The standalone `check:doc-drift` and `validate:summary` commands remain available
for focused inventory inspection. Inventory-only output is not passing test
evidence, and neither command should be appended to a completed `validate` run.

Input-order checks retain up to five deterministic seed candidates per fixture,
but run only distinct canonical inputs that differ from the already-checked
baseline. With 70 fixtures, the 350 seed candidates contain 142 unchanged inputs
and 45 repeated changed orders. Removing those 187 redundant executions retains
163 distinct changed orders, all compared in TypeScript and independent Python.
Reviewed goldens, scenario assertions, acceptance criteria, schema mutations,
timestamp and UTF-16 checks remain unchanged. This is input deduplication, not
random sampling or a reduction in the number of reviewed scenarios.

On the recorded Windows checkout, the previous inventory-only evaluator pass
took 11.39 seconds. Full validation previously invoked it once for documentation
and again for the final summary; both redundant passes are now absent. That
single-process observation is not a controlled estimate of total CI savings.

## Keep expensive load checks relevant

Pure server-rendered dashboard changes still run all runtime correctness tests
and the isolated Compose pilot, but omit its optional M5 load, the 100,000-row
import benchmark and the metric performance floor in the PR. Mixed changes to
worker/runtime/shared code, dependencies, schema, ingest paths or unknown files
keep those floors. This is a small cold-path exception, not a second dependency
graph. Main pushes with runtime changes and manual runs always keep load floors.

The same baseline's import benchmark took 186 seconds; the core Compose pilot
and load together took 165 seconds. The pilot stays, so its entire time cannot be
claimed as a saving. Benchmark results from a scoped-out run must not be called
passed. Action SHAs, least-privilege permissions and required job names remain
unchanged; synthetic guardrails, privacy, money and authentication tests remain.

The intended saving is avoiding repeated suites and unrelated native/database
work, not asserting a fixed elapsed-time reduction. Actual
durations depend on runners and queueing. New shared dependencies or runtime
use of an allowlisted tool require revisiting this classification.
