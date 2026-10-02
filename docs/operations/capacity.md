# Read-only storage observation

Run `npm run ops:capacity` in the operator's private runtime environment, using
`OPENMASU_MIGRATION_DATABASE_URL` and `OPENMASU_PAYLOAD_STORE_DIR`. The connection
is the privileged bootstrap/operator connection, not an application or dashboard
reader. This CLI is deliberately not an HTTP route: whole-database totals can
disclose activity across tenants. Do not grant BYPASSRLS to readers to use it.
No master key is needed, no payload is opened, and no retention action occurs.

The closed aggregate JSON contains observation times, scope, layer, count and
bytes. Integer quantities are decimal strings to avoid precision loss. It does
not contain tenant/app identifiers, database names, paths, file names, payload
references, protected content or credentials.

| Measurement | State and meaning |
| --- | --- |
| DB layer `bytes` | `exact`: current `pg_total_relation_size`, including indexes and TOAST, summed across known application schemas; not logical payload size or free host space |
| DB layer `count` | `estimate`: `pg_stat_all_tables.n_live_tup`; delayed/stale statistics are not an exact event count |
| DB layer `tables` | Exact catalog relation count, not the number of apps or tenants |
| Payload object/key count and bytes | `exact`: file metadata in the two configured directories, with no decryption; not filesystem allocation or backup volume size |
| Refused or incomplete observation | `unavailable` with a reason, never a fabricated zero |

DB reads run in a read-only transaction with a five-second statement timeout and
at most 1,000 relations. A nonprivileged connection receives only
`privileged_operator_required`, not sizes. Payload traversal allows at most
50,000 files and a three-second checked elapsed budget; it rejects symlinks,
nested/nonregular entries and missing stores. Filesystem I/O itself depends on
the host. DB and filesystem observations are not an atomic cross-store snapshot:
quiesce writers when a matched boundary is required. Partial results exit 2;
complete observations exit 0. Operational errors are closed reasons, not raw
database/filesystem error messages.

## Interpret the layers before deciding retention

- `raw_evidence` holds receipt, delivery and rejection state. Removing evidence
  can remove the ability to explain old decisions; a smaller payload store does
  not imply removal of append-only receipt metadata.
- `logical_facts` and `derived_results` hold normalized facts, saved calculations,
  cost history and immutable replacements. Preserve the original definitions,
  snapshot/rule context and privacy boundaries needed for reproducibility.
- `privacy_state` holds durable recognized requests, tombstones and purge work.
  A backup restored without recognized requests must not serve data. Deleting
  this state is not a safe capacity cleanup.
- `control`, `queues` and `ledger_other` separate configuration, temporary work
  and other retained ledger metadata. New ledger tables remain visible in the
  conservative `ledger_other` layer until deliberately classified.
- `synthetic_testing` and `migration_metadata` are not product event volume.
- `payload_objects` and `payload_keys` measure encrypted objects and wrapped
  keys separately. Protected purge removes both in the local store; it does not
  prove that copies in archives, remote exports or restored snapshots are gone.

No default retention duration, automatic purge, cold-storage migration, new
storage engine or cloud-cost estimate is added. Choose legal retention and
operator policy privately. This command does not run VACUUM, ANALYZE, DELETE or
TRUNCATE. Freed rows do not imply that PostgreSQL immediately returns disk space.

Growth is `not_calculated`. If comparing privately saved observations, record
both times, comparable scope and paused/active workload. Do not extrapolate a
brief burst into a representative daily/cloud-cost claim. Reuse
[existing synthetic load evidence](../validation/m5-load-results.md),
[runtime observability](observability.md), [storage design](../design/m1-baseline.md)
and [backup/restore](backup-restore.md); no heavy benchmark is added to PRs.

## Synthetic acceptance and remaining boundary

Two unit tests prove big-integer aggregation and exact-versus-estimated labels,
and metadata-only protected write/purge/limit behavior. One case in the existing
runtime integration suite proves allocation grows for a small synthetic table,
the observer does not delete its rows, and a reader receives no all-tenant totals.
There are no real-data measurements. Host free space, remote/backup volume size,
physical storage allocation, representative throughput and costs remain unknown.

Primary references checked on 2026-10-02:

- https://www.postgresql.org/docs/17/functions-admin.html
- https://www.postgresql.org/docs/17/monitoring-stats.html
