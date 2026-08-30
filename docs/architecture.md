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
are never reopened by the routine drain.

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
bridge. It consumes the same queue identity vectors as Android.

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
responses through server-side verification boundaries. Live projects remain an
operator configuration.

<!-- m1-component:google-play-product-verifier -->
**Google Play product verifier.** Converts authenticated notifications into
non-financial state signals and uses authoritative read-back before emitting
settled money.

<!-- m1-component:verified-commerce-lifecycle -->
**Verified commerce lifecycle.** Tracks Google and Apple lifecycle revisions,
refund corrections, encrypted cursors, and privacy coverage without exposing
provider transaction identifiers publicly.

<!-- m1-component:google-data-manager-delivery -->
**Conversion delivery.** Produces a bounded, authenticated Google Data Manager
delivery path from eligible stored evidence with idempotent delivery state.

<!-- m1-component:operator-event-webhooks -->
**Operator event webhooks.** Select an app-scoped, closed event subset from
accepted ledger facts, build a minimal destination-scoped envelope, and place
its encrypted exact bytes in a durable outbox. The worker rechecks destination
and privacy lifecycle under a per-record lock, pins an allowlisted public DNS
address, signs the exact body with the destination secret, and appends bounded
delivery results. Redirects are rejected and receiver bodies are discarded.

<!-- m1-component:production-control-plane -->
**Production control plane.** Holds tenant/app configuration, RBAC, rule-bundle
history, keys, durable schedules, and audited administrative changes.

<!-- m1-component:privacy-restore -->
**Privacy restore path.** Reapplies completed deletion state after a database
restore before the restored system is released to normal service.

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

Undefined values remain absent with a closed reason. Organic, non-organic,
unattributed, deterministic installation-level, and aggregate platform series
are never merged implicitly.

## Known architectural limits

- The default worker runs job types serially; slow tenant or provider work can
  delay later jobs until bounded concurrency is introduced.
- An operator-webhook attempt holds its per-record privacy lock and delivery
  row lock through the bounded network request. This gives deletion a precise
  before-or-after boundary but means a slow receiver can temporarily increase
  database lock contention.
- Scheduler advisory leases use a dedicated one-connection pool. Job work uses
  a separate bounded pool, and lease completion or failure is committed on the
  held scheduler connection. A lease therefore cannot consume the connection
  budget needed by nested tenant transactions.
- PostgreSQL is the only supported primary store. Additional analytical stores
  require measured evidence and a separate design.
- Live provider credentials, alert routing, TLS termination, and production
  hosting remain deployment responsibilities.

Security controls and residual risks are listed in
[Threat model](threat-model.md). Subsystem details are in `docs/design/`.
