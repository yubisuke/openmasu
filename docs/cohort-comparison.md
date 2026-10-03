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
IDs, raw payload or private replay manifest. Historical one-rate contexts omit
source text. The opt-in [dated FX profile](fx-snapshots.md) instead retains its
bounded, non-identifying source labels, exact currency/date rates, known-as-of
timestamps and full policy digest; different snapshots are not equivalent.
Report-to-snapshot checks that the run and comparison context bind the same FX
policy. It never substitutes a current configuration into an old saved run. Reader JSON
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

JSON `assurance` and HTML distinguish `definition_backed`, `external_declared`, `declared` and
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

Optional `freshness_observations` retain the four closed [metric freshness
objects](metric-freshness.md) for each provenance-bound row key. HTML shows
the same labels as the ordinary metric table. These saved local observations
are not another comparability condition or proof of upstream completeness;
they do not change the value or semantic equivalence calculation. Older files
without the field remain byte-shape compatible and show missing operational
metadata as unknown. Conservative time maturity is still evaluated separately
from the captured definition, including for older definition-backed files.

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

## Convert an aggregate CSV offline

`npm run --silent snapshot:report -- --csv aggregate.csv mapping.json > external.json`
converts **one aggregate CSV format**, not raw events. It never opens a database,
submits events, or calls a provider. Keep the CSV, mapping and result outside
this public repository. The raw-event mapping DSL and importer serve a different
purpose; do not use this command to insert ledger evidence.

The explicit mapping has this shape (all values below are synthetic):

```json
{
  "version": 1,
  "source": "operator-declared-aggregate",
  "conditions": {
    "date_from": "2026-01-01", "date_to": "2026-01-02", "time_zone": "UTC",
    "maturity": "operator-declared-window", "aggregation": "cumulative",
    "attribution_scope": "organic", "metric_definition": "revenue_d7@v1",
    "source_cutoff": "2026-01-10T00:00:00.000Z"
  },
  "grouping": {
    "cohort_date": { "column": "day" },
    "country": { "column": "country" },
    "attribution_status": { "constant": "organic" }
  },
  "value": {
    "column": "amount", "input": "decimal", "scale": 2,
    "currency": { "constant": "USD" },
    "undefined": { "marker": "", "reason": { "constant": "empty_cohort" } }
  }
}
```

For that mapping the columns are `day,country,amount`; a synthetic row is
`2026-01-01,JP,1.23`. No column names or calculation semantics are inferred.
Bindings use exactly one `column` or `constant`. Header names are trimmed and
must be unique and nonempty. CSV quoting supports commas, doubled quotes and
embedded newlines; malformed quotes and record widths are refused. Row numbers
are logical CSV records, including the header as record 1, not physical lines.
UTF-8 input must be valid. Unmapped columns are ignored and are never copied to
output; do not put identifiers in the grouping.

`grouping` uses the existing closed report dimensions. Choose exactly one of
`cohort_date` and `metric_date`; all dates and attribution statuses must agree
with the declared half-open conditions. Other optional dimensions can use
`{"column":"optional_campaign","omit_if_empty":true}` to omit an empty cell.
Dates and attribution status cannot use omission. A missing column is an error,
not a missing row. Duplicate canonical groupings are rejected, never summed.

`integer` means an already unscaled signed base-10 integer. `decimal` converts
an exact signed base-10 decimal at the declared scale, reusing the strict money
conversion; exponent notation and any fractional digits beyond the scale are
rejected without rounding. Leading zeros and negative zero normalize to exact
integers. Scale is 0-18 and unscaled values are at most 100 digits. Use an
explicit uppercase currency for money, or `none` for ratios/counts (counts use
scale 0). A currency may also come from an explicitly named column. Units are
declarations, not inferred from a metric name. Raw-cost imports remain
non-negative; this aggregate converter allows signed corrected aggregates.

Only the exact configured `undefined.marker` produces an undefined row, whose
reason may be a constant or column. Without that declaration, an empty amount
is rejected. A literal zero remains a present zero. Absent groupings remain
missing; the converter creates no calendar fillers or population totals.
Limits are 4 MiB input/output and 10,000 rows. No partial snapshot is printed
on failure. Error output is JSON containing only a constant `code` and
`row_number` (or `null` for a file/mapping error), never source values, column
names, file paths or an exception stack.

The result uses the ordinary canonical JSON grouping keys and retains normalized
conditions and values. `mapping_provenance` contains the exact input-byte hash,
normalized mapping hash, row count and `interpretation=operator_declared`.
Retain the original mapping and input to reproduce it. Neither those hashes nor
successful conversion establish completeness or equivalent implementation.
No database-acquisition receipt, saved-run provenance, or definition-backed
context is invented. The ordinary comparison therefore remains `incomparable`
against an input without established meaning. The existing `--declared` flag
can compare two intentionally declaration-only snapshots and labels the JSON
and HTML `declared_comparison`; it cannot bypass captured runtime contexts.
An external aggregate does not become a verified comparison merely by sharing
a definition label with OpenMasu.

## Compare a saved ROAS with explicit external calculation conditions

For installation-anchored **elapsed-window ad-revenue ROAS only**, add an
`external_calculation` object to the aggregate CSV mapping. This is a separate
operator declaration, not a fabricated OpenMasu execution context. No provider
or database call is made, and no ledger evidence is inserted.

The following complete synthetic mapping matches the historical D3 ROAS
definition and FX policy in fixture 33. It is an example, **not** a default to
copy onto a different provider calculation. Select all fields from the external
calculation's documented meaning; unknown required conditions must remain
unresolved rather than borrowed from current OpenMasu settings.

```json
{
  "version": 1,
  "source": "synthetic-external-claim",
  "conditions": {
    "date_from": "2026-08-01", "date_to": "2026-08-02", "time_zone": "UTC",
    "maturity": "operator-declared", "aggregation": "cumulative",
    "attribution_scope": "non_organic", "metric_definition": "external-d3-ad-roas",
    "source_cutoff": "2026-08-09T00:00:00.000Z"
  },
  "grouping": {
    "cohort_date": { "column": "day" },
    "campaign_id": { "constant": "provider-campaign-33" },
    "network": { "constant": "synthetic-network" },
    "country": { "constant": "JP" },
    "attribution_status": { "constant": "non_organic" }
  },
  "value": {
    "column": "roas", "input": "decimal", "scale": 6,
    "currency": { "constant": "none" },
    "undefined": { "marker": "", "reason": { "constant": "no_attributed_cost" } }
  },
  "external_calculation": {
    "version": 1, "profile": "external-elapsed-ad-roas-v1",
    "anchor_event": "install", "calculation": "revenue_over_cost",
    "numerator": "revenue", "denominator": "cost", "aggregation": "cumulative",
    "time_zone": "UTC", "window": { "type": "elapsed", "day": 3, "boundary": "half_open" },
    "population": "accepted_installation_cohort", "acquisition_basis": "recorded_dimensions",
    "cost_basis": "cohort_acquisition_day_current_snapshot",
    "cost_selection_policy": "legacy_dimension_digest_latest",
    "grouping_dimensions": ["campaign_id", "network", "country", "cohort_date", "attribution_status"],
    "fraud_policy": "gross", "privacy_state": "after", "value_type": "ratio", "ratio_scale": 6,
    "fx": {
      "target_currency": "USD", "target_scale": 6, "conversion": "per_event_round_then_sum",
      "rounding_mode": "half_even",
      "rates": [{ "currency": "EUR", "rate_unscaled": "5", "rate_scale": 1, "as_of": "2026-08-01T00:00:00.000Z" }]
    },
    "final_rounding": "half_even"
  }
}
```

Synthetic CSV: `day,roas` followed by `2026-08-01,1.25`. Save the mapping and
CSV outside the repository, convert it with the existing command, and explicitly
opt in when comparing to a saved OpenMasu report:

```bash
npm run --silent snapshot:report -- --csv aggregate.csv mapping.json > external.json
npm run --silent compare:cohorts -- --external-declared saved.json external.json
npm run --silent compare:cohorts -- --external-declared --html saved.json external.json > comparison.html
```

Exactly one input must have complete supported captured contexts; the other must
have the closed external declaration. The same pure comparator is used with
either input order. Every supported meaning must agree: install anchor,
half-open elapsed window, cumulative population, acquisition basis, cost basis
and cost-grain selection policy, permitted grouping axes, gross/net policy,
privacy interpretation, ratio units/precision, FX rate/as-of/target precision,
conversion order and final half-even rounding. Different display names and
internal policy identifiers are not semantic differences.

`day=3` means `[install, install + 4 days)`; `day=7` means eight elapsed days,
not a calendar-week label. Conservatively, a D7 cohort date is mature at that
date's exclusive end plus eight days. The external maturity is calculated from
its declaration and cutoff, and remains `external_declared`, never proof of
delivery completeness. Supported time zones are UTC and Asia/Tokyo. A mapping
must use `cohort_date`, and row keys may use only declared non-identifying axes.
Unknown campaigns remain absent axes, not invented identifiers or totals.

Ratios are multiples, not percentages: `1.25` is 125%, encoded as `1250000` at
scale 6. Percentage normalization is not inferred. `currency` must be `none`,
and each row scale must equal `ratio_scale`. Zero, absent rows and explicitly
undefined values remain distinct. A completely empty selection stays
incomparable. Purchase/total-net ROAS, retention, calendar windows and platform
aggregate series are outside this bridge. FX uses the currently supported
single explicit conversion rate; a multi-rate policy is not approximated.

All declaration fields are required and unknown fields are refused. The
`half_up`/`truncate` rounding and `round_after_sum` conversion declarations can
be represented to explain a mismatch, but are never treated as equivalent to
the captured half-even/per-event implementation. No opt-in or any incompatible
condition produces `incomparable` with empty rows and named mismatches. Malformed
or missing declaration fields fail conversion with a safe error code. Neither
`--declared` nor removing one context is a compatibility bypass; combining
`--declared` and `--external-declared` is an argument error.

Successful matching produces `external_declared_comparison`, **not** `compared`.
The saved side remains `definition_backed`; the external side remains
`external_declared`. JSON and standalone HTML retain both snapshot hashes,
saved report/run references, CSV byte and normalized mapping hashes, and the
external declaration plus its independent SHA-256. That digest is over JCS of
the complete declaration. Saved snapshots with changed declarations and stale
digests are refused. External declarations cannot carry captured contexts,
saved-run provenance or a database-acquisition receipt.

This is an additive change to the offline `cohort-comparison-v2` format: the
snapshot gains optional `external_calculation: { declaration, declaration_sha256 }`,
and output gains an additional status/assurance value and optional provenance
details. Existing declaration-only and captured-to-captured commands keep their
semantics. Older readers do not support the new optional field; use a current
reader rather than stripping it to force a comparison. The measurement wire
contract, schemas, goldens and historical execution profiles are unchanged.
Agreement proves only consistency with the operator's claim. It does not
authenticate an external producer, prove population completeness, validate the
external implementation, or explain the cause of a numerical difference.

## Compare through the dashboard

Open an app and choose **Compare saved measurements** next to the comparison
JSON download. The same session and app read permission used by reports are
required; an API bearer key is not a dashboard session.

1. Save the app's comparison JSON using the existing fixed-watermark download.
2. Select that JSON, an external aggregate CSV, and its mapping JSON. Use the
   explicit calculation declaration above when comparing elapsed ad-revenue
   ROAS. Do not upload identifiers or raw events.
3. Choose **Review conditions**. This step shows each side's conditions,
   provenance, missing meaning and evidence level; it does not calculate deltas.
4. Read the conditions and explicitly opt in to the external operator's
   declaration if appropriate. Choose **Compare**, then save the comparison
   JSON or standalone HTML. Unknown or mismatched conditions remain
   incomparable; opting in cannot override them.

The browser flow calls the same pure CSV converter, comparator and HTML
renderer as the CLI, without launching a subprocess. Identical normalized
inputs and opt-in produce byte-identical JSON/standalone HTML and hashes.
The external side does not acquire an authenticated producer, app or run
receipt. If an input already has an app-scoped acquisition receipt, its tenant
and app must match the selected app; receipt-less inputs remain uncertified.

This is a server-rendered, no-JavaScript form, including a read-only POST that
requires the session, matching Origin and CSRF token. Files are handled in
bounded memory, not saved in a payload store, temporary file or comparison
history. Only normalized aggregate snapshots are carried in the next form,
and every submission revalidates them. Unused CSV columns and uploaded file
names are not reflected in results or application logs. Responses are
`no-store`; download or close the page when finished and treat saved aggregate
files as private operator material.

Limits are 4 MiB per input/snapshot and 10,000 aggregate rows, 12 MiB plus
16 KiB of multipart overhead per request, 32 MiB per completed response, and
a 30-second request deadline. A failed, interrupted, oversized or timed-out
operation does not publish a partial success download. These limits do not
certify upstream completeness, validate an external implementation or explain
the cause of a difference. No comparison is persisted as a measurement run.

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
