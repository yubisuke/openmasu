# Minimal monitoring and recovery

Use the five optional rules in [config/monitoring](../../config/monitoring)
with an operator-owned Prometheus and Alertmanager. OpenMasu itself gains no
dependency, container or notification sender. The examples monitor existing
authenticated metrics; they do not establish a production alerting service.

## Configure privately

1. Copy `prometheus.yml`, `alerts.yml` and `alertmanager.yml` from that directory
   to an operator-owned configuration directory outside the repository.
2. Create a separate admin key with the `read` capability. Mount its value as
   `/run/secrets/openmasu-monitor-token`, readable only by Prometheus. Never put
   it in a URL, label, committed file or evidence report.
3. Set the scrape target. The example uses loopback HTTP; use HTTPS with verified
   certificates for a remote API. Set a unique, non-identifying `instance` alias
   for each endpoint/key scope. Do not use a tenant or app identifier as an alias.
   `/metrics` observes the authenticated key's tenant, not every deployment
   tenant. Monitor each intended scope explicitly.
4. Keep `job_name: openmasu` and `honor_labels: false`. Prometheus then renames
   the application's bounded `job` label to `exported_job`; the rules depend on
   that distinction. Leave redirects disabled so credentials cannot follow an
   unexpected redirect.
5. Set the Alertmanager address and configure the `configure-me` receiver
   privately. The shipped receiver has no delivery integration and sends
   **nothing**. Run the checks below before starting the external monitor.
6. Confirm successful scrapes and configured scheduler state after initial
   worker startup. Exercise a synthetic failure and recovery through the chosen
   private receiver before treating delivery as qualified.

Do not scrape the same scope under the same alias more than once. Recording
rules and alerts retain only `instance`; alerts add fixed `severity` and
`alertname` labels. They do not copy queue, job, tenant, app, event or credential
values into notifications. Additional labels added by an operator are outside
this guarantee.

## Five rules, operator-controlled thresholds

Edit thresholds and `for` durations in the private copy of `alerts.yml`.
These defaults are conservative examples, not service or privacy deadlines.

| Alert | Signal | Continuous hold |
| --- | --- | --- |
| `OpenMasuMetricsUnavailable` | Configured target cannot be scraped | 2 minutes |
| `OpenMasuPrivacyPurgeStalled` | Privacy backlog is positive and oldest age exceeds 15 minutes or purge failures reach 3 consecutive attempts | 5 minutes |
| `OpenMasuScheduleStalled` | A configured job is more than 15 minutes overdue without an active lease, or has 3 consecutive failures | 5 minutes |
| `OpenMasuIngestDelayed` | Positive MAX, SDK or AdServices backlog has oldest age above 15 minutes | 5 minutes |
| `OpenMasuDeliveryDelayed` | Positive webhook or bulk-export backlog has oldest age above 1 hour | 15 minutes |

Signals are coalesced per monitored instance. An unavailable scrape suppresses
all queue/schedule alerts; a privacy stall suppresses schedule and backlog alerts;
a schedule stall suppresses ingest and delivery alerts. Suppression starts when
the higher-priority signal is present, including its hold period. This is a
triage priority, **not proof of a shared root cause**: inspect all jobs and queues
while the higher-priority incident is open. Ingest and delivery can both fire
when neither higher-priority signal is present.

The Alertmanager example groups by `instance`, waits 30 seconds before the first
notification, groups changes for 5 minutes and repeats unresolved notifications
every 4 hours. This reduces duplicate symptom notifications; it is not an
exactly-once delivery guarantee. Receiver support for resolved notifications
must be configured privately.

For maintenance, create a time-limited Alertmanager silence matching only the
affected `instance`, with an owner, reason and explicit end time. Keep scrapes
and rule evaluation running. Remove the silence after checking recovery; do not
use a permanent global mute.

### Low traffic and missing evidence

An empty queue, a short backlog spike and a zero last-success timestamp do not
trigger an alert. Never-configured work is **unobserved**, not failed or healthy;
the rules cannot detect a worker that has never registered any schedule. An
active lease is not overdue work; repeated failures remain actionable.

These examples detect an unreachable metrics endpoint and delayed registered
worker jobs, not every process exit. A removed scrape target, a failed monitor,
a redirector-only failure and a never-started worker need external target
inventory or host supervision. A daily job may not become overdue until its
next due time. Terminal discarded/failed records are not pending backlog;
inspect the existing health/recovery pages for them. The delivery rule covers
webhooks and bulk exports, not provider-wide acceptance or every conversion
queue. No-event traffic alone is not an outage signal.

## Recovery runbooks

Keep incident details and deployment-specific commands outside this public
repository. Inspect sanitized logs and bounded reader views first. Do not delete
queue rows, steal leases, disable privacy controls or reseed a deployment.

### Metrics unavailable

Check the Prometheus target error, API/Compose health, database reachability,
TLS and monitoring key permissions. Authentication failure is also a scrape
failure; do not make `/metrics` public to clear it. Restore the missing dependency
or restart the failed service through the deployment supervisor. Recovery means
scrapes succeed again, not that every downstream queue has drained.

### Privacy purge stalled

Inspect `privacy_purges` count/age, `privacy_purge` failures and sanitized worker
logs. Check payload-store access, key availability and database reachability.
Deletion remains fail-closed while physical purge is incomplete. Fix the
dependency and let the durable job retry; verify the backlog drains and the
request completes. The isolated-restore drain procedure is documented in
[backup/restore](backup-restore.md); never clear a failure by deleting its evidence.

### Schedule stalled

Check worker health and the bounded `exported_job` metrics to identify affected
jobs. Inspect the app's schedule list, last completed target date, retry time
and active lease. Restore dependencies, then let the worker reclaim work after
lease expiry. For forced shutdowns, follow
[scheduler behavior](observability.md#scheduler-behavior).
Do not add replicas or advance checkpoints to hide a stalled job.

### Ingest delayed

Check queue count and oldest age, worker/database health and provider
availability. SDK backlog also includes unfinished auxiliary work. Keep the
bounded batch limits; fix the dependency before requesting
[safe ingest recovery](ingest-recovery.md).
Verify age and count decrease and new work completes. An empty queue alone is
not proof that source data arrived or passed validation.

### Delivery delayed

Use the app's operator delivery health page or its
`GET /v1/admin/apps/<app-id>/operator-delivery-health` reader endpoint. Check
local retries, destination availability and permissions without exposing payloads
or credentials. Follow [webhook](../operator-event-webhooks.md) or
[bulk-export](../operator-bulk-exports.md) recovery guidance. Let bounded retries
resume after fixing the dependency. A drained queue or local success is not
proof of exactly-once effects at the recipient.

## Synthetic validation

CI uses Prometheus `3.15.0` and Alertmanager `0.34.1` tools with checksum-verified
downloads. These are external check tools, not application dependencies.
From the repository root, run:

```sh
promtool check config --syntax-only config/monitoring/prometheus.yml
promtool check rules config/monitoring/alerts.yml
promtool test rules config/monitoring/alerts.test.yml
amtool check-config config/monitoring/alertmanager.yml
```

Six native Prometheus scenarios cover scrape failure/recovery; privacy priority;
stopped-scheduler priority; short versus sustained ingest backlog; delivery
retry/drain; and empty/never-started work with an active lease. Assertions check
both the expected alert and total firing count, so duplicate symptom alerts fail.
They use synthetic series and no receiver, server, database, device or credential.
Configuration syntax and series tests do not verify real notification delivery,
deployment thresholds or recovery times.

## Primary references

Confirmed 2026-10-11:

- [Prometheus scrape configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/):
  authentication files and conflicting label handling.
- [Alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/):
  pending/firing state and hold durations.
- [Native rule tests](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/):
  synthetic series and expected alerts.
- [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/):
  notification grouping and receivers.
