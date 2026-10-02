# Recorded attribution reason counts

Open an app and choose **Read attribution reason counts**. Select an install
cohort date range, time zone and fixed UTC cutoff, then read the stored status,
method and reason counts. The equivalent reader API is:

```text
GET /v1/admin/apps/<app-id>/attribution?date_from=2026-08-01&date_to=2026-08-02&time_zone=UTC&watermark_at_most=2026-08-03T00%3A00%3A00Z
```

The API requires an authorized bearer key; the dashboard requires a session.
All three administrator roles can read it. Unknown, duplicate and identifying
filters are rejected. The dashboard initially shows an empty selection form,
not an automatically chosen period or a zero count. Both surfaces use the same
query and report model. Neither calculates attribution, starts a job or
contacts a provider.

## Population and cutoff

The denominator is the number of retained accepted installation facts for the
selected app. Cohort dates come from the recorded install occurrence converted
to `UTC` or `Asia/Tokyo`; `date_from` is inclusive and `date_to` exclusive.
The accepted logical install's raw receive time must be at or before
`watermark_at_most`. Deliveries, retries, rejected input and sessions are not
additional installations. A distinct reinstall installation ID is a distinct
subject. The response includes the selection, population, current-privacy
policy, selection rule, exact decimal-string denominator and bucket counts.

For each installation, the report reads at most one **stored installation-level
acquisition** decision:

1. Decision time and input cutoff must be at or before the requested cutoff.
2. The install and every referenced event must have been received within the
   same tenant/app by that cutoff. Late evidence cannot rewrite an earlier view.
3. Exclude decisions superseded by another eligible decision for the same
   subject. Choose the greatest decision timestamp, then greatest attribution
   ID in C collation, when multiple candidates remain.

The eligibility and supersession builder is shared with selected-acquisition
metrics. This read-only report compares timestamps as instants, including
microsecond query cutoffs and equivalent UTC spellings; historical metric
definitions and their existing comparison rules are not changed or recomputed.

No eligible decision produces `recording_state: not_recorded` with null status,
method and reason. It does **not** become organic or unattributed. Otherwise,
the status, method and reason are the stored contract vocabulary. An
unrecognized database value is collapsed to `unrecognized` before it leaves
SQL, never echoed as free-form text. Bucket counts sum to the denominator.

Aggregate Apple postbacks and first-party deep-link re-engagement are different
populations and are excluded. Return to the cohort dashboard for the separate
Apple aggregate series and to measurement links for first-party engagement
configuration. An unavailable referrer is a recorded observation, not proof of
fraud, an SDK defect or media fault. No upstream completeness or causal
explanation is inferred from these counts.

## Privacy and bounds

The report uses the reader role with explicit tenant/app predicates and a
read-only transaction. A shared privacy fence protects the read; pending
tenant deletion work returns `attribution_privacy_pending` (409), not partial
counts. A currently redacted or purged install is excluded even when the
requested cutoff predates deletion. The report does not recover evidence
payloads or expose subject IDs, record IDs, references or campaign strings;
it reads only the retained closed decision categories.

The period is capped at 366 days and the retained cohort at 100,000
installations. Overflow returns `attribution_cohort_limit` (413); each database
statement has a five-second timeout and an unavailable/failed query returns
503 without counts. Narrow the selection instead of interpreting an error as
zero. A successful response is a bounded snapshot of currently retained rows,
not an immutable saved metric run. Responses use `no-store`.

Synthetic acceptance in the existing reporting integration suite covers known
status/reason counts, missing decisions, decision revisions at microsecond
query cutoffs, late decisions/cutoffs/evidence, duplicate delivery, timezone
boundaries, current redaction/purge, app/tenant isolation and API/SSR identity.
Unit cases cover strict selection, honest rendering and refusal of
overflow/backlog/failure.
