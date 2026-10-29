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
versions `0.1.0`, `0.2.0-rc.1` through `0.2.0-rc.4`, `0.2.0`, `0.3.0-rc.1`,
`0.3.0-rc.2`, configured candidate `0.3.0-rc.3` and
`other`. The shared classifier folds arbitrary or unsupported strings into
`other` before storage and again when querying. There are at most 420 distinct
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
The Android `diagnosticsSnapshot` callback, iOS `diagnosticsSnapshot()` actor
method and Unity `GetDiagnosticsSnapshot` return a typed, local-only snapshot.
Existing queue-health getters remain available. These values are **not uploaded**
and are not derived from server receipts. The snapshot contains:

- Explicit collection enablement, the persisted consent barrier, reset-pending
  and enrolled flags. Enabled collection does not override a consent/reset fence.
- Queue pending count, logical bytes, cumulative eviction and rejection totals.
- Last observed enrollment, delivery, deletion or deletion-status attempt time;
  a closed result; and HTTP class (`none`, `http_2xx`, `http_4xx`, `http_5xx`, `other`).
- Retry state: `none`, `pending`, `collection_blocked`, `consent_blocked` or
  `reset_pending`. `pending` means retained work, not a timer, delivery guarantee,
  or permission to bypass collection/consent policy.

Results distinguish not attempted, in flight, HTTP admission (`accepted`), other
HTTP responses, authentication rejection (401/403), rate limiting (429), network
unavailability, server/request errors, unexpected responses and custom transport
success/failure. Network unavailability covers connection, DNS, TLS and timeout
failures; it is not a connectivity probe or proof that the device is offline.
**HTTP 202 acceptance is not ledger completion, attribution or recognized revenue.**
A successful custom transport is not assumed to have received HTTP 202.

Only the last attempt's closed metadata is persisted, not a diagnostic history.
An old `in_flight` record after process termination is the last observed state,
not proof that a request still runs. SDK storage reset may clear this metadata.
Queue and policy reads are local observations, not a transactional server view.
Getters never generate IDs, enroll, send or read provider evidence, and expose no
identifiers, credentials, URLs, payloads, raw exception text or provider bodies.
Unity's Editor shim explicitly reports that device diagnostics are unavailable.
Inspect the snapshot in the consumer app and compare with bounded server receipts;
there is no new diagnostic endpoint or upload service.

## Disposable synthetic validation sessions

From **Recent measurement**, open **Validate synthetic SDK receipts**. This
feature is available only when the database was created with the immutable
`synthetic_disposable` deployment purpose. An environment override or a request
field cannot enable it on a persistent deployment. Use synthetic inputs and
isolated deployment keys only; this is not a real-device or production diagnostic
upload path.

An administrator creates a session with
`POST /v1/admin/apps/<app-id>/synthetic-validations`, for example:

```json
{
  "ttl_seconds": 600,
  "expected_events": ["install", "session_start", "custom_event"],
  "expected_custom_keys": ["synthetic_checkout"]
}
```

The response contains `session_id`, `session_token` and `expires_at`. The opaque
32-byte base64url token is shown only in this creation response, never a URL or
subsequent status result. The closed event vocabulary is `install`,
`session_start`, `custom_event`, `ad_revenue`, `purchase`, `refund` and
`deep_link_open`. Optional custom keys match exactly; they are declarations,
not a shared catalog or fuzzy matching. At most 16 keys of 64 characters are
accepted, and declaring keys requires the `custom_event` expectation.

In the SDK's explicit synthetic validation configuration, supply that token and
expiry. The wire protocol adds `validation_session_token` only at the top level
of the existing `{ "records": [...] }` batch envelope. The entire raw envelope
is covered by the existing SDK HMAC, installation credential and nonce checks.
The server removes this operational field before durable event-body storage;
neither the token nor a validation session reference enters contract artifacts.
Collection, consent, enrollment, normal event validation and privacy fences
remain independent and unchanged.

An admitted opt-in batch receives an additional opaque `validation_receipt` in
its HTTP 202 response. **This is queued admission, not ledger acceptance.**
Quota consumption and receipt association commit atomically with the durable
batch. An invalid, foreign, expired or over-limit session cannot leave a partial
batch; its protected staged body is purged on rollback. There is no fallback
that silently drops an invalid explicit label while still admitting its batch.
An unlabelled batch follows its existing behavior and has no validation receipt.

Read `GET /v1/admin/apps/<app-id>/synthetic-validations/<session-id>` with an
authorized read-capable bearer key, or reload the dashboard detail page using
its session cookie. Reads use the database reader role and never start jobs,
sweep data, prolong expiry or contact a provider. Each result describes only
this session's admitted receipts and their recorded batch/delivery/rejection
evidence. It distinguishes queued, processed, failed and post-processing states;
accepted, rejected, duplicate and unresolved attempt counts; and closed rejection
reasons. Unknown/foreign app or session references do not disclose another scope.

The optional metric observation is `saved_input_reference`: the receipt's own
accepted record is referenced by a saved metric's input snapshot. **It does not
prove a causal contribution to that metric's numeric value.** A duplicate never
borrows its canonical record from another receipt or session. Inspection is
limited to the latest 100 saved metric runs in the same app; no match at that
limit is `unknown_limit`, not a zero result or proof of absence. No event,
installation or raw payload identifiers, credential values, provider responses
or protected references appear in the status projection. Expected events with
no observations remain missing, not an automatic pass or fail verdict.

Lifetime defaults to 10 minutes and is bounded to 1–30 minutes, with no sliding
extension. A session permits at most 50 batches and 200 submitted events; a tenant
has at most 20 retained sessions. The server's database clock is authoritative:
expired status reads fail immediately and admission refuses expired tokens.
`POST /v1/admin/apps/<app-id>/synthetic-validations/<session-id>/close` requires
administrator authority and immediately removes its ephemeral associations.
The dashboard mutations also require CSRF and Origin checks.

At the beginning of each successful tenant worker cycle, up to 50 expired
sessions are deleted with their receipt associations. The ordinary poll interval
defaults to five seconds, but worker downtime, database unavailability or queued
work can delay physical cleanup; this is not a hard wall-clock erasure SLA.
Expired sessions are independently discovered even after their ingest work is
finished. Creation also performs a bounded expired-session sweep. Expiry,
closing and cleanup delete only the association, not the underlying synthetic
ledger. A disposable seed reset clears both its ledger and validation sessions.

The existing SDK HTTP integration test covers receipt admission, rejection,
duplicate classification, scoping, expiry, cap races, rollback and read-only
status. The existing scheduled-metric test connects signed SDK events to real
SQL-generated input references and verifies that a different validation session's
duplicate cannot claim those references. These are synthetic server proofs,
not evidence of real-device or live-provider delivery.

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
