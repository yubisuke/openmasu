# CI scope and test cost

Pull requests are classified by changed paths. The exact offline comparison
CLI, renderer, their unit tests, and synthetic example run contract/type checks
and unit tests without native builds, database integration, or performance
benchmarks. `tools/ci/changed-scope.mjs` owns this small explicit allowlist.

Shared code, dependencies, workflow changes, and unknown tools retain the
conservative full gate set. Mixed changes take the union of required checks.
Deleted paths are included. Main pushes and manual runs still run all gates.
Required jobs remain visible even when their expensive steps are not relevant.

No tests were deleted for this optimization. Windows/Linux contract validation
remains; offline unit tests run there only when Runtime is not already running
the unit suite. Backup/restore repetition remains a regression check for repeated
connection cleanup. PostgreSQL parity, role isolation, and disposable Compose
tests cover different boundaries and are not replaced by evaluator unit tests.

The intended saving is avoiding unrelated native and database work on known
offline-only changes, not asserting a fixed elapsed-time reduction. Actual
durations depend on runners and queueing. New shared dependencies or runtime
use of an allowlisted tool require revisiting this classification.
