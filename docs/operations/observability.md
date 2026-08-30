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
