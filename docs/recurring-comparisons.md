# Scheduled aggregate comparisons

Save two aggregate snapshots and an immutable comparison definition in an
operator-controlled PostgreSQL deployment. The existing worker compares each UTC
target date at its fixed receipt cutoff. This is optional private runtime storage,
not a new service, provider connection or notification system.

The [one-off comparator](cohort-comparison.md) remains stateless and reader-only.
Both paths use the same parser, meaning checks and exact integer delta engine.
Uploaded captured contexts are operator-supplied assertions; their hashes bind
contents, not provider authenticity or proof that a report came from this server.
This feature does not independently attest or recalculate uploaded values.

## Start with synthetic inputs

Open **Reports → Scheduled aggregate comparisons** as an operator or administrator.
Choose **Register or replace a comparison**, enter the inclusive target dates,
UTC cutoff lag, retention, evidence mode and absolute threshold, then select two
aggregate snapshot JSON files. **Review definition and evidence** displays each
side's meaning, time zone, cutoff, units and maturity before **Confirm and save**.
No command JSON needs to be pasted. Replacement uses the active-revision selector;
the separate deposit form accepts one dated side, and deletion requires its own
confirmation. Saved revisions link to the same stored JSON results as the API.

For a synthetic example, the `registration.left_snapshot` and
`registration.right_snapshot` objects in
[`examples/synthetic/recurring-comparison.json`](../examples/synthetic/recurring-comparison.json)
are aggregate-only files to select. That example uses fixture33's reviewed D7
ROAS definition: 1.50 versus 1.75, delta 0.25, threshold integer 300000 / scale 6.
The initial result is `within_threshold`. These are synthetic operator uploads,
not fresh event ingestion or actual provider measurements.

The worker runs after ordinary metric processing and considers at most ten due
dates per app in one cycle. A target of `2026-08-01` with lag 9 uses exactly
`2026-08-10T00:00:00.000000Z`, not the worker's current time. This delay also
respects the comparator's conservative elapsed-window maturity. The comparison
date range is one UTC target date: `[date, date + 1)`. The source metric may have
a different declared aggregation time zone; the schedule's cutoff stays UTC.

External aggregate inputs are **explicitly deposited**, not automatically fetched.
Use the existing complete, privacy-fenced `comparison.json` export or normalize an
external aggregate file with the existing one-off workflow. Deposit the resulting
snapshot, not CSV bytes. No automatic external authentication or data transfer is
performed. Keep real inputs, private commands and credentials outside this public
checkout; checked-in examples and tests are synthetic only.

## HTTP and dashboard commands

Bearer API: `POST /v1/admin/apps/:app/comparisons`, JSON body. Dashboard: typed
multipart forms translate to that same command and service, under session/CSRF
protection. The GET form and POST `/dashboard/apps/:app/comparisons/preview` use
the reader role and never store inputs, definitions or results. A failed CSRF
check can still produce the existing security audit entry. Preview requires
`operate` but does not reserve state; confirmation revalidates current privacy,
revision and storage constraints. Writes require `operate`; all routes retain
tenant/app scope. `/v1` never authenticates with cookies. Existing URL-encoded
command clients remain compatible; the dashboard no longer displays that editor.

- **Register:** `{ "action": "register", "registration": { ... } }`. Registration
  has exactly `name`, `first_date`, `last_date` (both inclusive),
  `watermark_lag_days`, `retention_days`, `mode`, `threshold`, `left_snapshot`,
  `right_snapshot`, and `supersedes_id` (explicit null initially). The two initial
  snapshots must match `first_date` and its fixed cutoff. The service records each
  side's definition/meaning digest and the complete comparison-definition digest.
- **Deposit:** `{ "action": "deposit", "comparison_id": "<returned revision>",
  "target_date": "2026-08-02", "side": "left", "snapshot": { ... } }`.
  Deposit the right side independently. Each revision/date/side is immutable;
  byte-equivalent normalized input is idempotent, changed content conflicts.
- **Replace:** register again with `supersedes_id` pointing to an active revision.
  This deactivates that revision and creates a new one. Old results remain
  readable until their expiry; definitions and values are not overwritten.
- **Delete:** `{ "action": "delete", "comparison_id": "<revision>" }` removes
  that revision's stored inputs and results atomically and deactivates it.
  Only nonnumeric revision/policy metadata remains for history. Delete individual
  revisions explicitly; replacing a revision does not delete its history.

`GET /v1/admin/apps/:app/comparisons` lists up to 100 recent revision metadata
records and 200 recent result summaries. Full stored results are separately read
with `GET /v1/admin/apps/:app/comparison-runs/:run_id`; the dashboard offers the
same stored result as a JSON download. GET does not schedule, write or recalculate.

## Result states and reproducibility

- `missing_input`: one or both dated operands have not arrived. A later deposit
  produces a new content-addressed result without replacing the missing record.
- `incomparable`: a definition changed or the existing comparator cannot establish
  matching meaning/conditions. No numerical threshold decision is invented.
- `unknown`: declaration-only, empty, missing-row or undefined values do not
  establish a numerical threshold decision. Row-level states remain in the result.
- `within_threshold` / `threshold_exceeded`: absolute right-minus-left delta is
  compared exactly at aligned integer scales. Equality is within the threshold.
  External-declaration mode remains explicitly operator-declared, not verified.

Modes are `captured` (default comparison checks), `external_declared` (explicit
external declaration opt-in) or `declared_only` (diagnostic deltas only; threshold
state remains unknown). Different units are not silently converted. Comparability
and row states are retained beside threshold outcomes. Identical normalized
operands, revision and date produce the same canonical result bytes and run ID;
wall-clock timestamps are storage metadata outside the canonical result.

## Storage, retention and privacy

Limits: 20 active revisions per tenant, at most 366 target dates, lag 1–366 days,
explicit retention 1–90 days, 10,000 rows / 4 MiB per snapshot, 4 MiB per result,
and 64 MiB of stored snapshot/result values per app. Readers receive bounded
summaries rather than every result body. Retention is measured from receipt of
each snapshot and creation of each result; expired values are immediately hidden
and physically removed by the next tenant worker cycle. Revisions remain.

Only closed aggregate grouping dimensions are stored. Event rows, installation
identifiers, payload references, original CSV bytes and unknown fields are refused.
The feature preserves aggregate report run references/definition contexts and
optional mapping digests, not the underlying file. Tiny aggregate groups are still
potentially sensitive; this is private operator storage, not public publication.

All reads/writes and worker publication share the existing tenant privacy fence.
A pending deletion hides results. Any new tenant deletion record invalidates all
older comparison revisions conservatively, including other apps in that tenant:
old values become unreadable, the worker deletes their snapshots/results and
deactivates the revisions. It does not try to subtract an unknown individual's
contribution from an uploaded aggregate. An operator must explicitly register new,
post-deletion aggregates. Restoring stale numeric rows does not restore permission
to publish them once authoritative privacy requests have been reapplied. Use the
ordinary [isolated restore procedure](operations/backup-restore.md), never expose a
restored database before privacy reapplication. Local deletion does not delete an
operator's original files, previous downloads or external recipient copies.

Synthetic acceptance covers stored byte identity, next-date deltas, late operands,
changed definitions, replacement history, conflicts, role/CSRF/RLS, expiry and
privacy suppression including stale-row restoration. No live provider, real data,
device, alert delivery or production retention qualification is claimed.
