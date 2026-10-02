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
