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
