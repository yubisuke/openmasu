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
PostgreSQL. Tenant/job advisory locks and expiring leases prevent concurrent
internal execution across worker replicas. A failed job writes a sanitized
stderr event and becomes eligible at its persisted retry time.

Jobs currently run sequentially inside one worker tick. A slow provider or
tenant can delay later jobs. External monitoring should alert on process health,
overdue jobs, consecutive failures, and database availability. If the worker
process or database is unavailable, no in-process notification can be emitted;
the monitor must observe from outside that failure domain.

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
