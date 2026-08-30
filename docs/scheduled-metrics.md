# Scheduled Metric Runs

OpenMasu can run versioned metric definitions from the durable worker instead
of relying on an external cron command. A schedule belongs to one application,
stores an immutable definition and its RFC 8785 digest, and advances one UTC
target date at a time.

Use the manual `npm run metrics:run` command for an operator-controlled one-off
calculation or a deliberately selected historical backfill. Use a durable
schedule when the worker should calculate a stable metric set every day.

## Register a schedule

The synthetic example calculates D7 ROAS and D7 retention. Its lag is eight
days: at the current UTC midnight, the full seven-day elapsed window for the
target cohort has closed.

```bash
export OPENMASU_PUBLIC_BASE_URL=http://localhost:8080
export OPENMASU_APP_ID=app-local
export OPENMASU_ADMIN_KEY='<the bootstrap admin key>'

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${OPENMASU_ADMIN_KEY}" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/synthetic/metric-schedule.json \
  "${OPENMASU_PUBLIC_BASE_URL}/v1/admin/apps/${OPENMASU_APP_ID}/metric-schedules"
```

The response contains the immutable schedule identifier, normalized definition,
definition digest, initial status, and target-date checkpoint. The admin key is
a secret; do not put its value in source files, copied logs, or shell history.

The registration API rejects:

- a lag outside 1 through 365 days;
- a start date later than the currently eligible target date;
- malformed FX or metric definitions;
- static `cohort_date` or `metric_date` values in the grouping;
- identifying grouping fields;
- a metric name already owned by another active schedule for the same app.

Multiple active schedules are allowed only when their metric-name sets are
disjoint. This prevents duplicate report series while allowing cohort and
calendar-day metrics to use different lags.

## Inspect or disable schedules

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${OPENMASU_ADMIN_KEY}" \
  "${OPENMASU_PUBLIC_BASE_URL}/v1/admin/apps/${OPENMASU_APP_ID}/metric-schedules"

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${OPENMASU_ADMIN_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{}' \
  "${OPENMASU_PUBLIC_BASE_URL}/v1/admin/apps/${OPENMASU_APP_ID}/metric-schedules/<schedule-id>/disable"
```

Definitions are immutable. To change a lag, grouping, metric definition, or FX
snapshot, disable the old schedule and register a new one. Existing metric runs
remain reproducible under the old definition digest.

## Execution and recovery model

For each active schedule, the worker:

1. derives the eligible target date as `current UTC date - lag_days`;
2. fixes the input watermark to the current UTC midnight;
3. persists the pending target date, watermark, and definition digest before
   metric evaluation;
4. writes each metric run through the ordinary repeatable-read cohort engine;
5. advances the checkpoint only after all expected artifacts and replay
   manifests commit.

Metric run identifiers are deterministic for the schedule, target date,
watermark, definition digest, evaluation, and metric name. If the worker stops
after a metric transaction commits but before checkpoint finalization, the next
attempt recomputes without persistence and requires every stored artifact to be
RFC 8785 byte-identical before advancing. A partial or conflicting run fails
closed.

One cycle processes at most 31 dates per schedule. A larger historical backlog
remains pending and the durable scheduler retries it; the worker does not hide
the backlog by skipping dates. Disabling a schedule prevents new claims but an
already claimed date may finish. Disablement does not delete prior results.

The `metric_run` scheduler job writes sanitized success or failure health rows.
Monitor overdue work and consecutive failures as described in
[Runtime observability](operations/observability.md). The public repository
does not configure an external alert receiver.

## Evidence boundary

Runtime CI registers schedules with synthetic data, exercises both cohort-date
and metric-date definitions, verifies report and dashboard visibility, simulates
the post-commit crash window, and checks disablement. This is durable scheduling
evidence for the repository implementation. It is not evidence of production
capacity, provider freshness, currency coverage, or an operator's alerting.
