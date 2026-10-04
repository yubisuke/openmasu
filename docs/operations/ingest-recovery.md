# Safe ingest recovery

Open an app's **Ingest recovery** link in the dashboard after checking its
[recent measurement receipts](../measurement-health.md). This page concerns
server-side work, not the SDK's local queue. It does not contact a provider or
calculate metrics on a page read.

## Diagnose before retrying

1. Check the worker deployment's database role permissions, payload-store path
   and key configuration, enabled provider modes and required operator settings.
   The API cannot attest the worker's secrets or whether a provider is reachable.
2. Review the closed reason class and current claim/retry state. No raw exception,
   event/device identifier, evidence digest, payload, token or protected reference
   is listed. Opaque job IDs identify work receipts only.
3. Fix the configuration or temporary failure outside this public repository.
   An operator or administrator can confirm **Validate and queue one retry** for
   a terminal failed SDK/server batch, or bring an existing auxiliary retry forward.
   Read-only accounts can inspect, not mutate.
4. Refresh the page and [observe the worker](observability.md). Queued is not
   completed. Normal worker polls and provider constraints still apply.

Reads use the restricted reader pool, returning at most 50 failed/post-processing
batches and 50 auxiliary items for the selected tenant/app. Provider attempts and
manual SDK attempts are different counters. Legacy or free-form errors are folded
into `worker_failure_review_configuration`, not reconstructed from payloads.

## What confirmation does

For a failed SDK/server batch, the mutation takes the existing worker advisory
lock and shared privacy fence, refuses an active persisted lease or stale state,
checks deletion/installation authorization **before** reading protected evidence,
checks the immutable body digest, event scope and compiled contract payload schema,
and appends a new pending state plus an audit receipt in one transaction. The
original failure and any admitted records/facts are not rewritten. The normal
inbox worker reuses its original idempotency keys. At most three manual SDK
attempts per original batch are allowed.

Processed batches awaiting auxiliary enqueue already retry automatically and
cannot be manually returned to pending. Missing/purged evidence and malformed or
invalid input are refused. Fix invalid input at its producer and submit a new
valid event through the original authenticated path; do not repair stored evidence.

For AdServices, platform integrity and Google Play verification, only an existing
pending retry with prior attempts or a recorded job failure can be expedited.
Its revision, worker lease, row claim, available source and privacy eligibility
are checked again during confirmation. The operation changes only its next
attempt time and clears expired claim fields, recording a new correlated audit
receipt. It does not change provider attempt counters, token lifetime, evidence,
verdicts or worker scheduling configuration. Completed/terminal verification is
never resurrected; obtain new valid evidence through the original authenticated
path rather than reusing a consumed token. An expired token may still complete as
unavailable according to the normal worker rules; confirmation is not a validity
claim. Integrity processing can complete unavailable rather than leave a retry;
those completed results are deliberately not editable here.

## HTTP interface

`GET /v1/admin/apps/:app/ingest-recovery` returns the bounded operational view.
`POST` at the same path requires the existing bearer **operate** capability and
exactly these fields:

```json
{
  "kind": "sdk_batch",
  "job_id": "01900000-0000-7000-8000-000000000001",
  "revision": "123",
  "confirmation": "retry_once"
}
```

The synthetic ID above is illustrative: use the job ID and revision returned by
GET. Kinds are `sdk_batch`, `adservices`, `integrity`, `google_play`. SDK revisions
are append-only state sequence strings; auxiliary revisions are opaque 32-character
tokens, not evidence digests. No query parameters are accepted. A successful
mutation returns 202 with a `receipt_id`, `kind`, `job_id` and `status: queued`.
The receipt ID is the audit row ID; its target is the opaque job, scoped to the app.
Stale/double submissions and active claims return 409; unknown or completed jobs
return 404. Public failures use closed codes, never database/payload errors.

Dashboard GET/POST use `/dashboard/apps/:app/ingest-recovery`. GET is reader-only;
POST additionally requires the existing synchronizer CSRF token, same-origin
check and explicit confirmation. Dashboard ignores bearer authentication and
`/v1` ignores cookies. No JavaScript, service, queue table or dependency is added.

## Evidence boundary

The synthetic regression follows a temporary payload-store failure through
configuration recovery and normal inbox processing, verifies double-click/claim
refusal, retained admission idempotency, invalid and deleted evidence, restricted
reader projection, auxiliary retry/terminal behavior and HTTP/CSRF boundaries.
No real credentials, device, provider connection, retry SLA or production recovery
is implied. These operations do not bypass deletion, contracts or provider policy.
