# Reading and filtering metric reports

Sign in to the dashboard, select an application, and use **Analyze metrics**.
Filters select existing persisted runs; they do not trigger a calculation.
Leave optional fields blank to clear them. Add metric names in the extra blank
metric control; clear an existing name to remove it. The resulting GET URL is
shareable with another authorized operator. App authorization is still required.

Date ranges include the start and exclude the end. They filter `metric_date`,
or `cohort_date` when no metric date exists. Campaign, ad group, creative, country, attribution status,
network, definition version and watermark retain the API query semantics.
Incompatible platform-aggregate filters are rejected rather than silently ignored.
Choose **Latest runs** or **All runs including superseded** explicitly.
Ad-group/creative filters require previously calculated
[selected acquisition detail runs](acquisition-detail-metrics.md); they do not
split campaign totals or extend the raw daily record-count projection.

## Saved daily analyses and previous periods

From an app's cohort page, open **Saved daily analyses and previous-period
comparison**. An operator or administrator can save a name, the existing safe
report filters and either all observations or incomparable observations only.
Readers can open and export shared views. Views are tenant/app scoped, protected
by row-level security; saving/deleting requires the existing session, capability,
CSRF and origin checks. Only filters/settings are stored, never values, credentials,
private evidence or SQL. Deleting a view deletes those filters, not metric runs.

Enter an inclusive start, exclusive end and explicit UTC receipt cutoff. With
no metric filter, the view selects the eight standard native D7 acquisition KPIs
and D1/D3/D7/D14/D30 retention. Only already-calculated observations exist: this
does not enable a schedule or invent missing dates/metrics. Use a schedule-series
filter when multiple independent definitions are saved. Cohort/metric-date equality
filters are not accepted here; the period is the date selection.

Both the selected period and the immediately preceding equal-length period are
read across **all keyset pages in one privacy-fenced, repeatable-read transaction**.
The combined limit is 10,000 runs, 4 MiB and 30 seconds, with a 4 MiB rendered
response limit; exceeded limits fail without a partial report. Views are limited
to 100 per app and periods to 366 days. Adjust dates/cutoff on the read page without
changing the saved filters. Each GET, including CSV, acquires a new database
snapshot; its selection digest changes when its saved rows change. This is not
durable cross-request snapshot storage or proof of source completeness.

Rows align the same metric and non-date dimensions by cohort-day offset. Their
captured definition, population, acquisition basis, window, currency/scales, FX,
policy and bundle must match, and both conservative windows must have elapsed.
Acquisition rows also require complete, compatible eight-role saved calculation
sets. Duplicates, missing runs, undefined/privacy-withdrawn values, pending
corrections, unknown meaning/maturity or incompatible sets remain explicit.
HTML and CSV use the same model, reasons, run/snapshot IDs and unscaled values.
No campaign/currency totals or period ratio averages are inferred. In particular,
retention remains a saved cohort observation because general denominator operands
are not exposed. A valid row difference is current minus previous at the stored
scale, not growth percent or a weighted period aggregate.

The existing two-campaign schedule integration journey owns persistence, session
authorization, cross-scope isolation, pagination/concurrent-insert and export
evidence. Pure model cases own incompatible FX/basis, maturity and undefined
behavior; no new service, dependency or dedicated CI job is required.

## Values and provenance

- Money displays its currency and exact decimal scale: `1250000` at scale 6
  becomes `USD 1.25`.
- Ratios display exact multipliers: `1.25 ×` means 125%. This applies to every
  stored ratio; a metric's name is never used to infer a percentage convention.
- Counts remain integers, including values larger than JavaScript's safe integer
  range. No floating-point conversion or display rounding is used in the table.
- Undefined values display a dash and the stored reason, never zero.
- Each row retains grouping, run watermark, definition version, freshness and
  supersession evidence. Freshness does not prove cohort maturity.

The main table does not infer maturity from metric names or freshness.
Its four [freshness observations](metric-freshness.md) separately show the
definition-backed conservative window, local app receipt state, import
completion and recorded recalculation state. Missing evidence stays unknown;
an empty receipt is not a zero cohort. JSON, CSV and saved comparisons preserve
the same objects. Local receipt counts are not the report's population, and
upstream completeness remains unknown.
Follow **Saved run details** for [recorded ROAS operands and windows](metric-explanations.md).
New elapsed-window ad-revenue ROAS runs record their window boundary and whether
the watermark reached it. Legacy and unsupported runs show unavailable evidence;
private replay manifests remain outside reader access. An elapsed window still
does not establish complete arrival of delayed inputs.

## Charts and exports

### Saved retention matrix

The same bounded report page also aligns definition-backed retention as cohort
dates by activity-day horizons. Days come from the saved `activity_day` definition,
not the metric name. Only exact-day active-installations/cohort-size ratios are
eligible. Population, acquisition basis, activity, time zone, dimensions other
than cohort date, fraud/privacy meaning, policy/bundle, definition version,
freshness and exact input watermark must match; only the date and window day vary.
Legacy, inconsistent, superseded or affected runs remain in the ordinary table.

Each observation shows its exact stored multiplier and links to saved run details.
Zero is a value; undefined retains its reason. Multiple snapshots in one cell
remain separate and are never summed, averaged or silently selected. A missing
cell means no saved run in the current filtered selection **only when that selection
fits on this page**. When either a preceding or following keyset page exists,
it means not fetched on this page. Only observed dates/horizons are displayed.
The matrix never fetches additional pages or recalculates retention; its expansion
is limited to 2,000 cells, after which the ordinary bounded table remains available.

Maturity is separate from the value: the saved definition and watermark establish
whether the conservative window end has been reached. Unknown maturity is explicit.
The bound uses the exclusive end of the cohort date plus the complete activity-day
window, because individual install times are not exposed here. Neither reaching
that bound nor `complete` freshness proves all delayed inputs have arrived.

### Trends and downloads

Charts separate dimensions, currencies/scales, definitions, policies, rule bundles,
time zones, freshness and historical runs. Duplicate snapshots for one date are
not connected. Missing dates, undefined values and integers outside safe chart
precision produce gaps; exact values remain available in the table. Points use
equal observation spacing, not a proportional calendar axis. No cross-row ratio
sum or unweighted average is calculated. Platform aggregate series remain separate
from deterministic metrics, and organic/unattributed dimensions remain distinct.

**Export aggregate CSV** preserves the current selection and watermark, removes
page cursors and uses the existing export row limit. It exports the original
unscaled integers, scales and run IDs—not formatted labels. A result over the
configured limit is rejected. This is a fresh read of matching persisted runs,
not a frozen cross-request snapshot; later supersessions may change the selection.

**Save comparison JSON** preserves the current filters and explicit watermark
and uses the same pure converter as the offline CLI. It reads all matching
keyset pages in one fixed read-only transaction, bounded to 10,000 rows, 4 MiB
and 30 seconds; the screen limit is the batch size. A completion receipt binds
scope, filters, row count and selection digests. Partial or unavailable evidence
is not downloaded. It accepts one metric and a complete latest-run selection. Supported
meaning/maturity are taken from the saved definition; legacy or unsupported
meaning stays unknown. See [Cohort comparison](cohort-comparison.md#save-from-the-dashboard)
for required conditions and refusal behavior. A download is not proof of
comparability or complete upstream arrival.

The interface remains server-rendered HTML without JavaScript or new dependencies.
Synthetic unit tests cover formatting, filter round trips and chart separation;
the existing eight-case database consistency gate also compares selected CSV rows.
