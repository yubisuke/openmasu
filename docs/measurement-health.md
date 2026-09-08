# Measurement health

Open an app in the dashboard to see **Measurement health**, or read
`GET /v1/admin/apps/<app-id>/measurement-health` with an authorized bearer key.
All administrator roles can read this app-scoped view. Dashboard sessions and
API bearer authentication remain separate. Neither operation starts jobs or
contacts a provider.

## What the observations mean

The view uses a read-only repeatable-read database snapshot. Its observation
time is independent of the report's filters and watermark. Counts cover
retained history, including historical failures and superseded metric runs;
they do not represent a recent reporting window or a unique-user funnel.

| Observation | Unit and interpretation | Next step |
| --- | --- | --- |
| Active SDK keys | Currently active configuration, not successful device delivery | Issue a key in app settings if using an SDK |
| Batches | SDK/backend batches; pending includes unfinished post-processing | Check worker progress and oldest pending receipt |
| Import runs | Recorded file import runs, with latest start/completion | Review the import result and use `npm run import:preview` to validate a mapping |
| Logical events | Retained logical events, not deliveries or installations | Check metric definitions and calculation scope |
| Rejections | Rejection artifacts, grouped by source and a closed safe reason vocabulary | Correct the input using the validation result before retrying |
| Metric runs | All retained run revisions; schedules are counted separately | Check the latest run's cohort date and source cutoff, then open the report |

Unknown timestamps are `null` in JSON and **Not observed** in HTML. Count zero
means no matching retained row, not a confirmed zero business result. Counts
are decimal strings so large histories do not lose integer precision.

An active SDK key is optional for file imports. Local mapping configuration is
not persisted in the same database and cannot be diagnosed by this view.
Batch counts also include authenticated backend submissions. A running import
or an old pending batch alone does not establish a worker outage; no latency
SLA is inferred. Historical failures may already have been resolved.

When events exist without metric runs, check `npm run metrics:run` with the
intended date, definition and watermark, or the app's metric schedule. A latest
run describes only its own cohort and cutoff, not all cohorts or all received
data. No provider completeness, real-device delivery, or production readiness
is implied by recorded results.

## Privacy and cost boundaries

The endpoint uses the existing reader role and explicit tenant/app predicates.
It selects no payload, secret, artifact, event/installation identifier or source
reference. Unknown rejection reasons are collapsed to `other` in SQL. Queries
have a five-second per-statement timeout; large histories can fail rather than
silently return partial counts. This is not a replacement for deployment
monitoring or a real-data diagnostic upload tool.

The existing dashboard/API integration tests exercise real reader grants,
app isolation and safe output using synthetic rows. Small unit tests cover
observation states and rendering. No new service or database is required.
