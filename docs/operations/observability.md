# Runtime Observability

OpenMasu exposes sanitized logs, authenticated fixed-label metrics, and durable
scheduler state. It does not send email, webhook, pager, or chat notifications.
A production operator must connect these surfaces to an external monitoring
system.

## Health and metrics

- Service health is exposed by the API health route and Compose health checks.
- Authenticated `/metrics` output uses Prometheus text format.
- Metrics include fixed-label request, import, scheduler success/failure,
  consecutive-failure, active-lease, and overdue-job state.
- The `operator_webhooks` backlog and `operator_webhook_delivery` job metrics
  expose pending work and terminal scheduler health without destination,
  tenant, app, event, or subject labels.
- The `operator_bulk_exports` backlog and `operator_bulk_export` job metrics
  expose queued/retry work and scheduler health with the same fixed-label
  boundary. Object keys, endpoints, buckets, destinations, tenant/app values,
  event names, subject references, and credentials never become metric labels.
- The `privacy_purges` backlog and `privacy_purge` scheduler metrics expose
  only a processing count, oldest age, and bounded job state. Payload
  references, deletion subjects, request IDs, tenants, and apps never become
  labels. A nonzero backlog with repeated failures means deletion is
  fail-closed but not physically complete and requires immediate operator
  investigation.
- The `metric_run` scheduler health exposes terminal success, failure,
  consecutive-failure, active-lease, and overdue state without metric names,
  schedule identifiers, tenant/app values, groupings, or report values as
  labels. Inspect the admin schedule list for its last completed target date.
- The `sdk_batches` ingest backlog includes both batches waiting for base
  ingestion and batches whose base ledger records are complete but whose
  server-side AdServices, platform-integrity, or Google Play verification work
  still needs durable queue installation. The worker retries the latter from
  the append-only `post_processing_pending` batch state.
- Labels must not contain tenant data, app IDs, event IDs, provider identifiers,
  payloads, or raw paths.

## Scheduler behavior

The worker stores next-run, retry, lease, completion, and failure state in
PostgreSQL. Tenant/job advisory locks and expiring leases prevent two replicas
from concurrently executing the same tenant/job pair. A failed job writes a
sanitized stderr event and becomes eligible at its persisted retry time.

The worker polls for tenant work without waiting for already-active tenant
cycles to finish. A FIFO coordinator runs four tenant cycles by default,
deduplicates tenants that are active or queued, and keeps each tenant's jobs in
their original serial order within one worker process.
`OPENMASU_WORKER_CONCURRENCY` accepts 1 through 16; use `1` as the rollback
mode. The scheduler pool reserves one connection per slot and the job pool
reserves two because privacy purge can temporarily need a record-lock
connection and a tenant transaction together.

A scheduled job failure emits `worker_job_failed` and uses its durable retry.
An unexpected exception outside that scheduled-job boundary emits
`worker_tenant_cycle_failed` without a tenant identifier and does not cancel
queued tenants. On SIGTERM or SIGINT, new submissions stop and active work gets
30 seconds to drain by default. `OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS` accepts
1000 through 300000 milliseconds; exceeding it emits
`worker_shutdown_deadline_exceeded` and exits unsuccessfully instead of hanging
indefinitely. A slow tenant still occupies one slot, and a single-tenant
workload or enough slow tenants can still delay future cycles. External
monitoring should alert on process health, overdue jobs, consecutive failures,
forced shutdowns, and database availability. If the worker process or database
is unavailable, no in-process notification can be emitted; the monitor must
observe from outside that failure domain.

The shutdown deadline is a hard process exit, not cooperative cancellation of
an active provider or database operation. A scheduler lease held by that work
remains unavailable until its persisted lease expiry, after which a supervisor-
restarted worker can retry it. The ordinary lease is at least five minutes and
some jobs intentionally use a longer policy, so forced shutdown should be an
alerted exceptional path rather than a routine deployment mechanism.

Scheduler leases are scoped to a tenant and job, not to an entire tenant.
Multiple worker replicas can therefore interleave different jobs for the same
tenant even though each replica preserves its own serial tenant order. Run one
worker replica unless a deployment has separately validated that interleaving.
The global MAX inbox and dashboard-session sweep are attached to the configured
MAX tenant cycle and may overlap work for other tenants; neither is a barrier
for all tenant cycles.

`OPENMASU_SDK_INBOX_BATCH_LIMIT` and `OPENMASU_MAX_INBOX_BATCH_LIMIT` bound each
tenant cycle to 100 durable rows by default and accept 1 through 1000. Rows keep
their existing FIFO order and remaining backlog resumes on a later poll. Alert
on backlog count and oldest age: slicing prevents one cycle from being
unbounded, but does not guarantee that arrival rate stays below drain rate.

Google conversion delivery claims one row immediately before provider I/O with
a five-minute database-clock lease. A second worker skips an active claim, an
expired claim is eligible for recovery, and only the current token can update
the delivery and append its result. The claim transaction also reserves the
destination's next database-backed request slot. The default one-second
spacing is controlled by `OPENMASU_GOOGLE_DATA_MANAGER_MIN_REQUEST_INTERVAL_MS`
(0 through 60000 milliseconds); a bounded provider `Retry-After` pause extends
the shared slot for every worker replica. A locally paced row is not claimed,
does not increment attempts, and does not append a provider result. Monitor
queue due age, destination pause age, claim age, repeated
expiry, retry count, and diagnostic deadline without putting transaction IDs,
request IDs, tenants, apps, or provider values in metric labels. A crash or
lost response after provider acceptance can still cause a same-transaction-ID
resend after expiry; the local claim does not establish provider-side exactly-
once delivery. The configured spacing is a local safety control, not evidence
of a live quota allocation.

AdServices lookup uses the same local ownership boundary for one queue only.
`OPENMASU_ADSERVICES_PROVIDER_TIMEOUT_MS` bounds each network wait and must be
shorter than `OPENMASU_ADSERVICES_CLAIM_LEASE_MS`; the defaults are 30 seconds
and five minutes. Retry releases the claim, expired claims can be recovered,
and only the current claim may commit a protected response. Investigate growing
due age, repeated lease expiry, and timeout retries without logging tokens,
response bodies, campaign values, tenant/app identifiers, or payload references.
An expired lease may cause another provider read and does not establish
provider-side exactly-once behavior.

Platform-integrity verification also claims one due row before provider I/O.
The local defaults bound a request to 10 seconds and its claim to five minutes.
Only the current unexpired token may commit a result, and completion rechecks
the source under the tenant privacy barrier. Monitor due age, claim age,
repeated expiry, and unavailable verdict counts without logging tokens,
provider bodies, payload references, tenants, apps, or subjects. Lease recovery
can repeat verification and does not establish provider-side exactly-once
behavior.

Google Play purchase verification claims one due product, subscription, or
renewal row before its bounded provider reads. The local defaults bound each
read to 10 seconds and the claim to five minutes. Retry clears only the current
token; each provider request starts only after rechecking the unexpired token
and source under the tenant privacy barrier, and completion repeats that check.
Monitor due age, claim age, repeated expiry, retry count, and
unavailable verdicts without logging purchase tokens, provider bodies, order
values, payload references, tenants, apps, or installations. Lease recovery
can repeat product or order reads and does not establish provider-side
exactly-once behavior.

Commerce provider read-back claims one Google Play or App Store row with a
five-minute database-clock lease. Retry and Apple pagination clear only the
current token; terminal lifecycle, refund, cursor, checkpoint, and queue changes
share one privacy-fenced transaction. Monitor due age, claim age, repeated
expiry, retry count, and terminal failure count without logging provider bodies,
transaction values, payload references, tenants, apps, or installations. A
reclaimed lease can repeat a subscription, order, or history read and does not
establish provider-side exactly-once behavior.

Scheduled metric work uses a daily durable lease, but every artifact watermark
is the current UTC midnight rather than the wall-clock time at which a worker
obtains that lease. A schedule processes at most 31 pending dates per cycle.
Repeated `metric_run` failures or a checkpoint that does not advance require
operator investigation; the worker does not drop dates to catch up.

The `privacy_purge` job retries irreversible storage work from PostgreSQL. A
request is not completed while any reference remains queued. Operators may run
`npm run db:drain-privacy-purge -- --tenant <tenant-id>` during an isolated
restore; exit code 2 means work is stalled or remains queued.

## Logs

Structured logs use a closed event name and bounded counts or status. They must
not include raw request bodies, provider responses, credentials, payload-store
references, transaction IDs, device identifiers, campaign values, or dynamic
high-cardinality labels. `npm run check:operational-logs` checks known logging
surfaces, but it is not a general secret scanner.

## Operator responsibility

Choose alert thresholds, notification receivers, retention, redaction, and
incident response for the deployment. Record production dashboards and alerts
outside the public repository. Synthetic CI proves metric shape and selected
failure states; it does not prove a production monitor or response process.
