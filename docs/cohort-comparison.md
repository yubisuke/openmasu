# Offline cohort comparison

Run `npm run compare:cohorts -- left.json right.json` after `npm ci`.
The command reads two aggregate snapshots without database or network access.
Inputs are limited to 4 MiB and 10,000 rows each. Keep private data outside this
public repository; checked-in examples and tests must be synthetic.

Minimal declaration-only synthetic input:

```json
{
  "source": "synthetic-example",
  "conditions": {
    "date_from": "2026-01-01",
    "date_to": "2026-01-02",
    "time_zone": "UTC",
    "maturity": "fully_elapsed_d7",
    "aggregation": "cumulative",
    "attribution_scope": "organic",
    "metric_definition": "revenue_d7_v1",
    "source_cutoff": "2026-01-10T00:00:00.000Z"
  },
  "rows": [{ "key": "total", "currency": "USD", "scale": 2,
    "state": "present", "value": "100" }]
}
```

This input has no captured definition. By default it produces `incomparable`
with an unknown calculation basis and no numerical deltas. To intentionally
compare only declarations, use
`npm run compare:cohorts -- --declared left.json right.json`.
That result is labeled `declared_comparison`, never `compared` or verified.
All eight declarations must match in this compatibility mode. `--declared`
cannot bypass a missing or incompatible context on a definition-backed input.

Date ranges are half-open. Cutoffs use the contract's UTC timestamp syntax,
with zero to six fractional digits. Comparison normalizes to six digits without
truncating microseconds; equivalent zero-fraction spellings match. Coordinate
attribution and row-key conventions beforehand.
Aggregation is `cumulative` or `on_day`. Currency is an uppercase three-letter
code, or `none` for non-monetary metrics. Scale is 0 through 18.

Values are signed integer strings (up to 100 digits), never floating point.
For undefined values replace `value` with `reason` and set `state` to
`undefined`. Missing rows, undefined values, zero, and currency mismatches are
distinct. Duplicate keys and unknown fields are rejected.

Output uses canonical JSON with format `cohort-comparison-v2`. Each input has a SHA-256 digest after row sorting;
retain the original snapshots to reproduce a comparison. Deltas are right minus
left at the larger input scale. Incompatible conditions produce no deltas.
No causal explanation is inferred. Successful execution exits 0 even when
values differ or conditions are incomparable; malformed input exits 1.

This is an offline tooling format, not a new measurement contract artifact.
The CLI has no direct database or provider access. Dashboard downloads and the
CLI share the same pure report transformation and comparison implementation.
No command-line entry point runs inside the Web request.

## Calculation meaning and comparison basis

New SQL metric runs capture `comparison_context` in the same transaction as the
result. It contains a closed, aggregate-only copy of the definition, the actual
FX target, rate, timestamp and rounding policy, the privacy evaluation mode,
definition/FX digests, and run/snapshot references. It has no installation/event
IDs, raw payload, private replay manifest or free-text FX source. Reader JSON
and CSV append this field without changing the contract artifact or existing
CSV column positions. Migration 053 is additive; existing runs remain `NULL`.
Never recover an older run's missing context from today's configuration.

The explicit `openmasu-sql-metric-v1` equivalence projection compares:

- anchor, time zone, half-open window type/day and cumulative/on-day behavior;
- calculation, numerator, denominator, cost selection basis and population;
- declared grouping dimensions, activity/event sets, gross/net fraud policy
  (absent means the implemented default `gross`) and privacy mode;
- value type, currency, output precision, actual FX rate/as-of/target precision,
  half-even rounding, and per-event rounding before summation.

Definition names/versions, bundle IDs/versions/hashes and FX policy version IDs
remain **execution provenance**, not semantic equality keys. Distinct internal
references can compare only when every supported projected meaning agrees.
Changing a rate, output precision, window or gross/net policy is not equivalent
merely because the metric name stayed the same. No equivalence is inferred from
names, numeric values or an arbitrary `verified` flag.

The profile supports elapsed install-cohort revenue/ROAS/LTV, activity-day
retention, cohort size and ordinary daily click/install/deep-link counts.
Calendar-revenue and platform aggregate-postback semantics do not have a
confirmed projection here: they remain `unknown`, not silently approved.
An empty report, missing contexts, unsupported definitions, mixed meanings,
or unestablished window maturity also produces `incomparable` without deltas.
Future implementation changes to these semantics must change the profile,
not reinterpret stored contexts.

JSON `assurance` and HTML distinguish `definition_backed`, `declared` and
`unknown`. Definition-backed means consistency with the saved implementation
profile, **not** producer authentication, provider validation, a complete
population, or proof that all late events have arrived. Operator-selected date
bounds, attribution scope and source cutoff remain explicit declarations;
the report converter checks every included row against them but cannot prove
that missing cohorts should have existed.

Temporal maturity is conservative: for a cohort date, use its exclusive end
in the definition's time zone plus the complete elapsed/activity window. This
allows an install anywhere within that date and never guesses an install time.
Daily count/cohort-size maturity uses the date's exclusive end. Compare that
bound with the saved receive watermark to establish `window_elapsed`. Before
that bound, maturity is unknown: this does not prove the actual cohort remains
open, because its observed installs may have occurred earlier. It is not
inferred from `data_freshness`, nor does an elapsed window imply complete
upstream delivery. Mixed/open-ended maturity is unknown.

## Convert a saved metric report

`npm run --silent snapshot:report -- report.json template.json > snapshot.json`
converts a saved JSON metric report (`data` array) into a comparison input.
Use the snapshot format above for the template, but set `rows` to `[]` and
`metric_definition` to the exact `metric_name@metric_definition_version`
(for example, `revenue_d7@v1`). The source label and conditions are explicit.
No provider request or database connection is made.

The converter requires a complete single report: any `next_cursor`
field is rejected. It does not fetch or merge pages. Rows must share the
declared definition, watermark, time zone, and value type; each cohort/metric
date must lie within the half-open declared range and its attribution status
must match `attribution_scope`. When no status dimension exists, the template
must explicitly select `all`; no organic/non-organic classification is guessed.
Rows without a date are rejected. Only non-superseded, fully reproducible runs
are accepted.
It validates captured definition/FX digests, run/snapshot binding, units and the
reported bundle/FX policy references. Supported aggregation and maturity are
derived from the captured context, overriding unverified template labels.
Without it, aggregation remains declared and maturity/meaning remain unknown.

Row keys are canonical JSON grouping objects. The other comparison input must
use the same key convention. Money and ratio scales are retained; counts use
scale zero. Undefined money without declared units is rejected, not assigned
an invented currency; captured definition units may supply undefined money's
otherwise absent units. Duplicate runs/groupings are rejected, not aggregated.
Inputs have the same 4 MiB / 10,000-row limits as the comparison tool.

Converted inputs include optional `provenance`: a SHA-256 of the canonical
report after sorting by run ID, and a row-key/run-ID/input-snapshot-ID mapping.
Comparison hashes bind this metadata. Keep the report and template with the
snapshot: hashes are reproducibility references, not authentication proofs.
`comparison_contexts` bind each available context to its row and provenance.
Legacy snapshots without that optional field still parse; their meaning does
not become definition-backed just because declarations or hashes match.

## Save from the dashboard

Sign in, open an application, and select one metric in **Analyze metrics**.
Set a start date and exclusive end date, an attribution-status filter when the
saved grouping includes that dimension, and **Watermark at most** equal to the
saved runs' watermark. Select **Latest runs** and choose **Save comparison JSON**.
The ordinary screen limit becomes the acquisition batch size (up to 1,000), not
the total exported row limit. The GET form keeps
the filters and watermark; it uses the existing dashboard session and reader
role, not the API bearer key. No raw events or private replay manifests enter
the file. Save it outside this public repository.

The download reads all matching keyset pages in a single PostgreSQL
`REPEATABLE READ READ ONLY` transaction. New runs or supersessions committed
between pages do not change that selection. Ordinary paged reports and CSV
exports remain fresh reads; they are not replaced with this acquisition mode.
Incoming page cursors, mixed definitions/watermarks, affected evidence, empty
selection, or missing conditions are refused instead of downloaded as a valid
comparison input. Bounds are 10,000 rows, 4 MiB and 30 seconds including
acquisition/validation. The response is buffered: overflow, cancellation,
timeout or database failure produces no successful partial file.
The watermark search compares UTC instants and accepts the contract's zero to
six fractional digits; equivalent spellings do not exclude a matching run.
The watermark is still an upper-bound filter, so every selected run must also
match the chosen cutoff exactly. Do not pick a later time merely to admit rows.

Supported aggregation and maturity come from the saved definition. For legacy
or unsupported definitions, explicitly select an aggregation declaration in
the save form; calculation meaning and maturity remain unknown. Download
success does not establish comparability, population completeness, or upstream
delivery. Missing dates are not synthesized as zero.
Two saved files can be used directly by the existing comparison CLI/HTML
commands below; no network request is needed after saving them.

Downloaded inputs add an `acquisition` receipt: `state=complete`, the consistent
read method, tenant/app scope, definition/grouping filters, selected row count,
selection and query SHA-256 values, and `upstream_completeness=unknown`. It is
bound to the normalized conditions and row-key/run/snapshot provenance. Page
batch size and wall-clock read time do not enter the digest. The parser rejects
incomplete or count/digest-mismatched receipts, and the JSON/HTML comparison
shows acquisition separately from calculation meaning. Older saved inputs
without a receipt show `not_recorded`, not complete acquisition.

The existing tenant privacy fence is held before establishing the read
snapshot. A pending tenant deletion pauses acquisition conservatively using
the existing safe backlog function; reader access to private deletion jobs is
not expanded. Deleted, purged or missing source references stop the export.
Only lifecycle metadata is read; no payload is decrypted or reconstructed.
Privacy changes completed before the read are visible. Like any private export,
an already saved file cannot be revoked automatically after a later deletion;
operators remain responsible for downstream custody and deletion.
No persistent export snapshot, temporary server file, database or service is
added. Keep the downloaded file to reproduce its exact original selection;
a later fresh download can legitimately differ after a committed revision.

## Human-readable report

Use `npm run --silent compare:cohorts -- --html left.json right.json > comparison.html`
to create a standalone report. Open the file locally in a browser. The report
uses no scripts, external assets, or network access and includes exact decimal
values, comparison states, declared conditions, and input hashes. `--silent`
keeps npm's command banner out of the HTML. On older shells that change output
encoding, save stdout as UTF-8. Reports contain aggregate values: do not commit
private reports to this public repository or share them unintentionally.
Use `--html --declared` only for an intentionally declaration-only report; the
warning and unknown basis are retained in the HTML.
