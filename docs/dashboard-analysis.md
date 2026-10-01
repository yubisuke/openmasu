# Reading and filtering metric reports

Sign in to the dashboard, select an application, and use **Analyze metrics**.
Filters select existing persisted runs; they do not trigger a calculation.
Leave optional fields blank to clear them. Add metric names in the extra blank
metric control; clear an existing name to remove it. The resulting GET URL is
shareable with another authorized operator. App authorization is still required.

Date ranges include the start and exclude the end. They filter `metric_date`,
or `cohort_date` when no metric date exists. Campaign, country, attribution status,
network, definition version and watermark retain the API query semantics.
Incompatible platform-aggregate filters are rejected rather than silently ignored.
Choose **Latest runs** or **All runs including superseded** explicitly.

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
