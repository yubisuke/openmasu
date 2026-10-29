# Read-only storage observation

Run `npm run ops:capacity` in the operator's private runtime environment, using
`OPENMASU_MIGRATION_DATABASE_URL` and `OPENMASU_PAYLOAD_STORE_DIR`. The connection
is the privileged bootstrap/operator connection, not an application or dashboard
reader. This CLI is deliberately not an HTTP route: whole-database totals can
disclose activity across tenants. Do not grant BYPASSRLS to readers to use it.
No master key is needed, no payload is opened, and no retention action occurs.

Explicit [retention preview and bounded expiry](retention.md) is a separate,
default-off operator command. Capacity observation never enables or runs it.

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

## Durable inbox admission (opt-in)

`OPENMASU_INBOX_ADMISSION_ENABLED=on` enables a separate, atomic admission gate
for `ledger.ingest_batches`: SDK events, authenticated server events, Apple
attribution postbacks, and redirector clicks. It does **not** cover the separate
MAX postback inbox, imports, commerce/provider queues, outbound queues, total
database allocation, free disk space, or retained processed payloads.

Configure the same values on **every** API and redirector replica; stop writers,
update the private environment, run bootstrap to reconcile the generated app
environment, and restart all producers together. Mixed enabled/disabled writers
cannot enforce one shared limit. The feature is off by default. Settings are
documented in `.env.example` and forwarded by Compose/bootstrap:

| Setting | Default | Meaning |
| --- | --- | --- |
| `OPENMASU_INBOX_APP_MAX_BATCHES` | 10000 | Unresolved batches per tenant/app |
| `OPENMASU_INBOX_APP_MAX_BYTES` | 268435456 | Their normalized plaintext body bytes |
| `OPENMASU_INBOX_GLOBAL_MAX_BATCHES` | 100000 | Unresolved batches across the deployment |
| `OPENMASU_INBOX_GLOBAL_MAX_BYTES` | 2147483648 | Their normalized plaintext body bytes |
| `OPENMASU_INBOX_RESUME_PERCENT` | 80 | Resume only when both counts and bytes are at/below this percentage of their limits (1–99) |
| `OPENMASU_INBOX_RETRY_AFTER_SECONDS` | 30 | Retry-After delay (1–3600 seconds) |

Counts include `pending`, `failed`, and `processed` with
`reason_code=post_processing_pending`. Ordinary `processed` rows are complete
and excluded. A failed row still retains accepted work: it consumes capacity
until successfully recovered, or its payload is purged by an independently
authorized privacy request. A queued/incomplete purge does not release space.
Use the existing [ingest recovery workflow](ingest-recovery.md) for failed work.
Do not create deletion requests just to bypass backpressure. Admission never
deletes accepted evidence, changes a fraud decision, or schedules retention.

At a high-water mark the gate latches closed. The next request checks for drain
below both low-water marks and automatically reopens; no restart or manual latch
reset is needed. App capacity returns HTTP 429; global capacity returns 503.
Both carry `Retry-After`, with closed error codes and no cross-tenant totals.
Existing SDK retry queues remain responsible for retrying unaccepted requests;
202 still means durable acceptance, not completed processing. Provider/browser
retry behavior is not guaranteed by this server-side gate.

The transaction acquires the privacy tenant fence, then one deployment-wide
admission lock before writing an encrypted body and inserting its batch/state.
Concurrent accepted requests cannot exceed either count or byte limit. A capacity
refusal writes no payload; a later transactional failure rolls its file back.
The only new control state is a hysteresis flag per app and deployment. A narrow
owner function returns a decision, not totals; ordinary readers cannot call it
or inspect those flags.

Before enabling on an upgraded database, drain pre-upgrade unresolved batches
while admission remains off. Their unknown `body_bytes` are not guessed or
backfilled as zero. Any remaining unpurged unresolved legacy row fails closed
with 503 `inbox_capacity_unknown`, including failed rows needing recovery.
Investigate worker failures and complete normal recovery first, then enable the
gate. Raising capacity is not a substitute for recovering a stalled worker.

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
