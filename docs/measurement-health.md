# Measurement health

Open an app in the dashboard to see **Recent measurement**, or read
`GET /v1/admin/apps/<app-id>/measurement-health?window_hours=24` with an authorized bearer key.
All administrator roles can read this app-scoped view. Dashboard sessions and
API bearer authentication remain separate. Neither operation starts jobs or
contacts a provider.

## Recent receipt windows

The default window is 24 hours. The dashboard's receipt-window links open
`/dashboard/apps/<app-id>/measurement-health?window_hours=<hours>`; only `1`,
`24` and `168` are supported by both this session-only page and the bearer API.
Unknown filters, repeated window arguments and other window values return 400.
Report filters and report watermarks are independent.

The additive JSON `recent` object declares `[received_from, received_to)` and
the preceding equally sized `[previous_from, received_from)` window, using
server receipt time in one repeatable-read snapshot. Each `groups` entry has
closed `producer`, `producer_version` and `event_name` classes and two count
sets: `current` and `previous`.

| Count | Meaning |
| --- | --- |
| `accepted` | Accepted delivery attempts excluding duplicate deliveries |
| `rejected` | Rejected delivery attempts, including invalid event payloads |
| `duplicate` | Accepted attempts classified as duplicate delivery; not another logical event |
| `late` | An overlapping timeliness property, not a fourth exclusive outcome |
| `metadata_not_recorded` | Attempts from before operational header metadata was recorded |
| `latest_received_at` | Latest matching server receipt, or null |

The event classes are the 13 contract event names plus `other`. SDK producer
classes are `sdk-android`, `sdk-ios` and `other`. Version classes are the public
versions `0.1.0`, `0.2.0-rc.1` through `0.2.0-rc.4`, `0.2.0`, `0.3.0-rc.1` and
`other`. The shared classifier folds arbitrary or unsupported strings into
`other` before storage and again when querying. There are at most 336 distinct
groups. Versions are client-reported, not verified device identities. Update
the closed version vocabulary when introducing another supported public SDK
release; unknown versions remain readable as `other` meanwhile.

Safe classification is recorded on single-record and bulk delivery writes and
durable batch admission. It does not change contract artifacts or evaluated
outcomes. Legacy rows remain unknown: historical protected payloads are not
decrypted to reconstruct classification.

`pending_groups` counts **submitted events** with unfinished processing in the
current receipt window, separately by the same classes. It also gives the
oldest matching receipt and the subset with unfinished post-processing. Such
events may already have been admitted; pending submissions and delivery
attempts are different grains and must not be summed into a funnel. Older
pending work remains visible in retained history.

Notices distinguish a group observed only in the preceding window, increased
rejection **counts**, fewer than five attempts, and unfinished submissions.
They do not assert an outage, a rejection-rate increase, traffic expectation,
device delivery or an SLA. A late event belongs to its receipt window, not its
occurrence window. A past resolved failure is not a current-window alarm.

## Local SDK diagnostics are separate

The response declares `client_diagnostics: on_device_only_not_received`.
Existing SDK queue-health getters expose pending count, logical bytes,
eviction and rejection totals locally. These values are **not uploaded** by
this feature and are not derived from server receipts. Inspect them on the
device or consumer app and compare against the bounded server view. This
distinguishes a local queue problem from missing server observations without
adding identifiers, diagnostic payload uploads or another endpoint/service.

## Retained history is background context

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

For the next step after ingestion, use [recorded attribution reason counts](attribution-reasons.md)
to read installation-level acquisition by stored status, method and reason at
an explicit cohort period and cutoff. That denominator is separate from these
retained-history operational counts.

## Privacy and cost boundaries

The endpoint uses the existing reader role and explicit tenant/app predicates.
It selects no payload, secret, artifact, event/installation identifier or source
reference. Unknown rejection reasons are collapsed to `other` in SQL. Queries
have a five-second per-statement timeout; large histories can fail rather than
silently return partial counts. This is not a replacement for deployment
monitoring or a real-data diagnostic upload tool.

Recent queries are bounded to at most two 168-hour windows and 336 closed
groups, with tenant/app receipt indexes and bound parameters. They never
return partial groups. Retained-history queries keep their original grain;
they can still time out on a large ledger.

The existing dashboard/API integration tests exercise real reader grants,
app isolation and safe output using synthetic rows. Small unit tests cover
observation states and rendering. No new service or database is required.
