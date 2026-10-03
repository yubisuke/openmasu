# Reading metric freshness without guessing completeness

A saved value can be zero, undefined or unavailable. Those are value states,
not import or delivery states. The metric table, JSON/CSV report and saved
comparison show four independent observations alongside the original value.
They use stored definitions, receipts and recalculation jobs only: viewing or
exporting a report never calls a provider, imports data or starts a calculation.

| Report field | What it establishes | What it does not establish |
| --- | --- | --- |
| `time_window_maturity` | Whether the saved watermark reached a conservative end derived from the captured definition and grouping | Complete arrival, an actual individual install time, or a provider SLA |
| `source_observation` | Observed, known-empty, absent or unknown **local retained app import receipts**, and whether the saved read snapshot had evidence references | A complete cohort, a zero-cost denominator, or provider-wide coverage |
| `import_completion` | Completed, in-progress, partly rejected, failed, absent or unknown local acquisition receipts | That every expected source, date or event was imported |
| `recalculation_state` | Existing cost, late-input and privacy revision/request state | A corrected value before its successor actually commits |

## Time and saved inputs

For supported definitions, the temporal bound uses the exclusive end of the
cohort date plus the full elapsed/activity window, in its declared time zone.
Ordinary daily counts and cohort size use the date's exclusive end. This is
the same conservative calculation used by the comparison and retention views.
`window_not_elapsed` means that this **bound** has not been reached at the saved
watermark; it does not establish that every actual install's window is still
open. A missing, unsupported or digest-inconsistent captured definition stays
`unknown`. Metric names and the legacy `data_freshness: complete` label never
supply missing maturity evidence.

`source_observation.input_snapshot` is `observed` when the saved artifact has
evidence references, `empty` for an explicitly empty reference array and
`unknown` when the array is unavailable. The read snapshot can cover more than
the selected cohort. Its state is not the cohort numerator or denominator;
protected evidence references are not returned in this metadata.

## Local receipts and their limits

Both local receipt objects declare `scope: app_retained_import_receipts`.
For each retained import source, the query uses its latest run and the stored
file receipt. A duplicate/skipped run uses the original file's row count and
row-rejection record. A completed zero-row file is known-empty; an app with
no retained acquisition is not-observed. Completed runs with rejected rows
are partial failures, not silently complete. Running takes precedence; failed
and completed acquisition channels together also produce partial failure.

Existing cost-acquisition checkpoints add their recorded acquisition outcome.
A configured schedule with no attempt/outcome is not an observation. A pending
cost refresh remains in-progress even if a previous result was empty.
The counts are **receipt channels**, not unique providers, events or cohorts;
a cost acquisition may also have an import-file receipt. Retained history can
be partial. `latest_receipt_at` is recorded receipt time, not report-view time.
`upstream_freshness` is always `unknown`: no source SLA or unobserved upstream
completion is invented. These observations are app-wide, not filtered by a
metric's campaign, date or input watermark.

## Recalculation and exports

Recalculation metadata preserves the separate cost, late-input and privacy
channels. Pending takes precedence, followed by unavailable, revised input
and completed. If a required observation is missing it remains unknown.
No recorded request is not evidence of complete input arrival. Old values are
not rewritten; privacy invalidation still withholds the old number.

JSON adds the four closed objects; CSV appends four columns containing the
same objects as JSON text. Existing column positions, numeric units, golden
artifacts and contract identity are unchanged. HTML uses shared labels for
the same objects, including on each side of a comparison.

Saved comparison files optionally retain `freshness_observations` bound to
their row keys and provenance. Their hashes bind that metadata, but the
observations do **not** establish producer authentication, completeness or
numeric equivalence. Missing operational metadata in older files stays
unknown; parsing an older file does not add fields or reinterpret its bytes.
A new download reads current local receipts; an existing download is a saved
observation, not a live monitor.

Synthetic gates cover the same zero under absent acquisition, known-empty
acquisition, partial rejection, an unelapsed bound and a pending job; reader
SQL, JSON, CSV and HTML agree. Real-provider arrival and operational acceptance
remain unverified.
