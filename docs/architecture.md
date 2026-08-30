# Architecture

## Design goal

OpenMasu separates received evidence, normalized facts, decisions, and reports
so that a historical result can be reproduced and audited. PostgreSQL is the
default durable store. Pure TypeScript and independent Python evaluators define
contract behavior; runtime SQL must match them.

## Deployment shape

```text
mobile apps / platform callbacks / import files
                 |
                 v
      API and redirector trust boundaries
                 |
                 v
       durable inbox and payload store
                 |
                 v
     worker normalization and evaluation
                 |
                 v
   PostgreSQL ledger, control, and facts
                 |
                 v
      reporting API and HTML dashboard
```

The default Compose deployment contains PostgreSQL, bootstrap/migrations, API,
redirector, worker, and one-shot seed services. A Cloudflare redirector adapter
is a documented future deployment option over the same core; it is not currently
implemented or shipped, and Cloudflare is not the database or application
runtime.

## Runtime components

<!-- m1-component:admin-api -->
**Management and reporting API.** Authenticates tenant administrators, app and
SDK management, imports, reports, privacy requests, and server-rendered
dashboard sessions. Mutating routes use the application role; read-only report
routes use the reader role.

<!-- m1-component:redirector -->
**Redirector.** Resolves stored tracking links, enforces destination and host
policy, records click evidence, and redirects without trusting request-supplied
destinations.

<!-- m1-component:sdk-ingestion -->
**SDK ingestion.** Verifies SDK-key and installation credentials, HMAC body
signatures, timestamp and nonce replay windows, request limits, and durable
inbox admission before asynchronous evaluation. Routine drains decrypt only
new or explicitly retryable work. Related accepted history is reconstructed at
a captured ledger position: available normalized facts supply semantic context,
while redacted or purged records contribute only their immutable identity and
payload digest for duplicate/conflict classification. Processed SDK batch bodies
are never reopened by the routine drain. Admission and post-decode projection
take one tenant-scoped privacy barrier shared with deletion recognition. A
deletion therefore either includes a completed projection in its snapshot or
commits first and causes the pending batch to finish as `privacy_suppressed`.

<!-- m1-component:server-event-ingestion -->
**Server event ingestion.** Accepts selected first-party events from an app
operator's backend through an app-scoped, immutable-producer server key. It
binds the exact body, route, app, key, timestamp, and nonce with HMAC-SHA-256,
then writes the normalized batch to the same durable inbox used by the contract
evaluator. Tenant, app, producer, purpose, receipt time, and contract identity
are server-assigned. Platform/provider authority claims and mixed-installation
batches fail closed. Pending bodies carry only a deployment-private subject
digest so deletion can purge them before projection without retaining a second
plaintext subject index.

<!-- m1-component:import-worker -->
**Import worker.** Applies the mapping DSL, validates normalized payloads against
the active event schemas, preserves row-level rejection, and writes each
logical record atomically and idempotently.

<!-- m1-component:max-receiver -->
**Mediation receiver.** Authenticates bounded AppLovin MAX revenue evidence and
places it on the same durable evaluation path without turning it into install
attribution evidence.

<!-- m1-component:payload-store -->
**Encrypted payload store.** Keeps protected raw material outside public
artifacts and supports purge or crypto-erasure when required by lifecycle
policy.

<!-- m1-component:postgres-ledger -->
**PostgreSQL ledger.** Separates control, append-only evidence, normalized facts,
ephemeral credentials/sessions, and testing data. Tenant row-level security and
role-specific grants constrain access.

<!-- m1-component:sdk-android -->
**Android SDK.** Persists a bounded queue, signs batches, reads Install Referrer,
and exposes optional measurement adapters without collecting advertising IDs by
default. Queue duplicate and conflict classification is defined by a shared
Android/iOS vector set.

<!-- m1-component:sdk-ios -->
**iOS SDK.** Provides the corresponding queue, signed delivery, consent/reset
lifecycle, AdServices and Apple conversion hooks, privacy manifest, and Unity
bridge. It consumes the same queue identity vectors as Android. The server-side
AdServices worker claims one due lookup with a database-clock lease before
network I/O. It holds no database or privacy lock while waiting for Apple, then
uses the tenant privacy barrier to verify the current claim and available source
record before writing the protected response, superseding attribution, result,
and queue transition in one transaction. A stale or deletion-raced completion
writes no derived result. Lease recovery can repeat a provider read and is not
a provider-side exactly-once guarantee.

<!-- m1-component:unity-bridge -->
**Unity bridge.** Presents one C# surface backed by the Android and iOS native
SDKs.

<!-- m1-component:app-association -->
**Association files and deep-link routing.** Generate public Android App Links
and Apple Universal Links declarations and validate tenant-owned link hosts.
Association files are public and never use click-path IP classification.

<!-- m1-component:dashboard -->
**Dashboard.** Renders HTML, CSS, and SVG on the server with no client-side
JavaScript. It shares query parsing, SQL builders, and encoders with the API so
the visible value and exported value use the same implementation.

<!-- m1-component:apple-postback-receiver -->
**Apple postback receivers.** Verify supported synthetic SKAdNetwork and
AdAttributionKit signature shapes, reject replay/conflict, and persist aggregate
series separately from installation attribution.

<!-- m1-component:fraud-engine -->
**Fraud engine.** Applies deterministic public rules to recorded evidence,
binds decisions to registered rule-bundle definitions and hashes, and keeps
default action separate from metric exclusion.

<!-- m1-component:integrity-verifier -->
**Integrity verifier.** Normalizes protected Play Integrity or App Attest
responses through server-side verification boundaries. Each provider request
is preceded by a one-row database-clock claim. Completion holds the tenant
privacy barrier, revalidates the claim and source lifecycle, and commits the
protected response, result, and queue removal in one transaction. An expired
claim can be recovered; a stale or deletion-raced worker writes no result.
Lease recovery can repeat a provider request and is not a provider-side
exactly-once guarantee. Live projects remain an operator configuration.

<!-- m1-component:google-play-product-verifier -->
**Google Play product verifier.** Converts authenticated notifications into
non-financial state signals and uses authoritative read-back before emitting
settled money. A worker claims one due verification with a database-clock
lease, performs the bounded provider reads without holding a database lock,
and starts each read only after a short privacy-barrier recheck confirms the
current claim and available source. It then completes only while that token
and source remain current. Completion shares the tenant privacy barrier with deletion and
keeps the result, renewal-order state, purchase binding, and queue removal in
one database transaction; the settled purchase projection is produced while
that barrier is held. Lease recovery can repeat provider reads and is not a
provider-side exactly-once guarantee.

<!-- m1-component:verified-commerce-lifecycle -->
**Verified commerce lifecycle.** Tracks Google and Apple lifecycle revisions,
refund corrections, encrypted cursors, and privacy coverage without exposing
provider transaction identifiers publicly. The provider read-back worker claims
one due row with a database-clock lease, starts the provider request only while
that claim is current under the tenant privacy barrier, and commits lifecycle
facts, Google refund projections, Apple cursor/checkpoint transitions, and the
queue transition in one token-fenced transaction. Expired work can be reclaimed;
a stale or deletion-raced worker commits no derived state. Lease recovery can
repeat provider reads and is not a provider-side exactly-once guarantee. A
verified App Store transaction is installation-bound only when its signed
original transaction identity matches exactly one settled iOS purchase already
in the ledger; unmatched or ambiguous notifications remain removable only by
app- or tenant-scoped privacy requests.

<!-- m1-component:google-data-manager-delivery -->
**Conversion delivery.** Produces a bounded, authenticated Google Data Manager
delivery path from eligible stored evidence. Each provider operation first
claims one durable row with a database-clock lease. Completion updates the row
and appends its result in one transaction only while the claim token is still
current; an expired claim can be reclaimed and a stale worker cannot overwrite
the newer result. The request retains one stable, digest-checked transaction
ID across retries. This is a local concurrency and recovery boundary, not a
claim that the provider's POST endpoint is exactly-once.

<!-- m1-component:operator-event-webhooks -->
**Operator event webhooks.** Select an app-scoped, closed event subset from
accepted ledger facts, build a minimal destination-scoped envelope, and place
its encrypted exact bytes in a durable outbox. The worker rechecks destination
and privacy lifecycle under a per-record lock, pins an allowlisted public DNS
address, signs the exact body with the destination secret, and appends bounded
delivery results. Redirects are rejected and receiver bodies are discarded.

<!-- m1-component:operator-bulk-exports -->
**Operator bulk event exports.** Reuse the webhook event object as a closed row
type, prepend a versioned manifest row, and write deterministic gzip NDJSON to
an app-scoped, operator-owned S3-compatible destination. Credentials and queued
object bytes stay encrypted. The worker resolves an active destination under a
transaction lock, selects accepted events with the durable
`(received_at, record_id)` keyset cursor, emits destination-scoped deletion rows
before later event rows, and advances both cursors only after a conditional
object create or digest-verified replay succeeds.

<!-- m1-component:production-control-plane -->
**Production control plane.** Holds tenant/app configuration, RBAC, rule-bundle
history, keys, durable schedules, and audited administrative changes.

<!-- m1-component:scheduled-metrics -->
**Scheduled metrics.** Stores immutable app-scoped metric definitions, fixed
UTC lag policy, definition digests, active/disabled history, and mutable
checkpoints. The worker persists a pending target date and watermark before
calling the repeatable-read cohort engine. Deterministic IDs and exact artifact
replay close the crash window between metric commit and checkpoint advancement.
Active schedules for one app must have disjoint metric-name sets.

<!-- m1-component:privacy-restore -->
**Privacy deletion and restore path.** Recognition commits a durable deletion
job, fail-closed evidence lifecycle, installation-credential deletion, and one
row per protected payload reference before touching the external payload store.
The worker purges and verifies each reference idempotently; only an explicitly
absent object or wrapped key satisfies the erasure postcondition, and only an
empty queue can append the completed privacy artifact and audit row. Restore
processing first drains durable jobs and then reapplies every completed
deletion before the restored system is released to normal service. External
deletion never runs inside a PostgreSQL transaction, so a later rollback
cannot erase its database provenance. Subject-bearing SDK and server admission
and SDK projection share one tenant-scoped barrier with installation, app, and
tenant deletion recognition. Admission and projection recheck durable deletion
state while holding that barrier. Provider-completion queues have separate
claim and deletion-race boundaries and are not covered by the SDK projection
barrier.

<!-- m1-component:operational-observability -->
**Operational observability.** Emits closed structured logs and authenticated
fixed-label Prometheus metrics without raw payloads or identifiers.

<!-- m1-component:integrity-evidence -->
**Integrity evidence boundary.** Stores only bounded verdict, policy, time, and
protected opaque evidence references in public-contract artifacts.

<!-- m1-component:runtime-ci -->
**Runtime CI.** Migrates PostgreSQL, checks the role/grant matrix, seeds synthetic
fixtures, proves ledger and metric parity, exercises API/worker/redirector paths,
and checks SBOM, threat-model, and real-data guardrails.

## Evidence flow

1. A trust-boundary adapter authenticates and bounds an input.
2. Protected bytes are encrypted and referenced by an opaque token.
3. The input enters a durable inbox or import run.
4. Schema validation happens before ledger persistence.
5. A transaction writes the raw record, delivery, logical event, and applicable
   fact projection or records a non-identifying rejection.
6. Evaluators resolve supported attribution, fraud, reconciliation, and metric
   results under registered rule and metric versions.
7. Derived artifacts append; a newer artifact names the artifact it supersedes.
8. Reports select an explicit watermark and supersession mode.

## Data layers

- **Control:** tenants, apps, credentials, configuration, rule bundles,
  schedules, import runs, and audit records.
- **Ledger:** received evidence and append-only decision artifacts.
- **Facts:** normalized queryable projections derived from ledger artifacts.
- **Ephemeral:** replay nonces, sessions, queues, quarantine state, and other
  bounded operational state.
- **Payload store:** encrypted protected evidence referenced from the database.
- **Testing:** synthetic fixture and parity records only.

`received_at` and server/platform authoritative times determine selection and
windows. Device `occurred_at` remains evidence but is not silently promoted to
server authority.

## Tenant and role isolation

Tenant scope is set from authenticated server configuration, not from an
untrusted cookie or query parameter. PostgreSQL row-level security is forced on
tenant tables. The runtime roles `openmasu_app`, `openmasu_reader`, and
`openmasu_seed` receive different minimum grants, and CI compares the complete
table/grant matrix after migrations. Migrations use the privileged bootstrap
connection named by `OPENMASU_MIGRATION_DATABASE_URL`, then transfer object
ownership to the NOLOGIN `openmasu_owner` role; that connection is never an
application runtime role.

## Reporting consistency

Metric definitions, SQL cohort evaluation, raw-record aggregation, API rows,
CSV export, dashboard views, and rendered values use a fixed watermark and
shared types. `ledger_seq` may support internal ordering but is not part of a
public reproducibility digest.

Metric rows, aggregate record counts, and stored difference-audit rows are all
bounded with route-specific keyset cursors. JSON pages carry `next_cursor`,
paged CSV responses carry `X-Next-Cursor`, and complete CSV exports fail rather
than silently truncating. Stored reconciliation artifacts have no selection
watermark today; their pagination is deterministic, but it is not described as
a fixed-watermark snapshot.

Undefined values remain absent with a closed reason. Organic, non-organic,
unattributed, deterministic installation-level, and aggregate platform series
are never merged implicitly.

Durable schedules advance dates without embedding the mutable scheduler lease
or database sequence in a result digest. Each cycle is bounded to 31 dates; a
larger backlog stays pending for retry rather than being skipped. Calendar-day
metrics receive `metric_date` only, while cohort metrics receive `cohort_date`
only.

## Known architectural limits

- The worker uses a FIFO tenant coordinator with four concurrent tenant cycles
  by default. `OPENMASU_WORKER_CONCURRENCY` accepts 1 through 16; `1` restores
  the former globally serial behavior. An active or queued tenant is not
  submitted twice, while each tenant keeps the existing privacy, ingestion,
  provider, metric, and fraud job order within one worker process. A slow tenant
  therefore occupies one bounded slot instead of blocking every other tenant.
- Work inside one tenant remains serial. SDK and MAX inbox work is sliced to 100
  durable rows per cycle by default; both limits accept 1 through 1000 and
  preserve FIFO order. A single slow row, a large backlog spanning many cycles,
  or enough slow tenants to fill every slot can still delay later work and
  requires deployment-specific capacity monitoring.
- Scheduler leases are tenant/job scoped. Multiple worker replicas may
  interleave different jobs for the same tenant, so the reference deployment
  uses one worker replica. Tenant-wide distributed ordering is not claimed.
- Graceful shutdown stops new submissions and gives discovered and active work
  a bounded drain window. The default is 30000 milliseconds and
  `OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS` accepts 1000 through 300000; expiry is a
  failed forced exit rather than an indefinite process hang. It does not abort
  the active operation cooperatively, and its durable scheduler lease remains
  unavailable until the configured lease expiry.
- The global MAX inbox and dashboard-session sweep are part of the configured
  MAX tenant cycle. They can overlap independent tenant cycles and are not
  global before/after barriers.
- An operator-webhook attempt holds its per-record privacy lock and delivery
  row lock through the bounded network request. This gives deletion a precise
  before-or-after boundary but means a slow receiver can temporarily increase
  database lock contention.
- An operator bulk-export attempt holds the destination and batch state while
  performing a bounded object-store request. Conditional create plus digest
  verification makes an identical retry safe, but object-store latency can
  delay that destination. Deletion rows communicate a downstream obligation;
  they cannot recall objects already copied or processed by the operator.
- Scheduler advisory leases use a dedicated pool sized to the tenant
  concurrency limit. Job work uses a separate pool with twice that connection
  budget because privacy purge can hold one record-lock connection while using
  one tenant transaction. Lease completion or failure is committed on the held
  scheduler connection, so leases cannot consume the job connection budget.
- PostgreSQL is the only supported primary store. Additional analytical stores
  require measured evidence and a separate design.
- Live provider credentials, alert routing, TLS termination, and production
  hosting remain deployment responsibilities.

Security controls and residual risks are listed in
[Threat model](threat-model.md). Subsystem details are in `docs/design/`.
