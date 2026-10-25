# Verified purchase and payer metrics

The opt-in `metric-verified-payers` / `0.4.26` profile uses the existing native,
selected-first-party installation cohort. It adds four independent D7 metrics;
historical purchase-net and advertising-revenue definitions do not change.

| Metric | Meaning |
| --- | --- |
| `cohort_purchase_count_d7` | Accepted canonical settled purchase transactions |
| `cohort_paying_installations_d7` | Distinct `(tenant, app, installation_id)` with at least one qualifying purchase |
| `cohort_payer_rate_d7` | Paying installations divided by eligible cohort installations; ratio scale 6 |
| `cohort_arppu_d7_usd` | Purchase-net USD revenue divided by those paying installations; money scale 6 |

These are **installations, not people**. Several purchases by one installation
increase transaction count, not payer count. Zero-price settled purchases count
as transactions and historical payers; a fully refunded payer remains a payer.
Refunds affect net money, never erase the historical purchase population.
There is no entitlement, user merging, subscription churn or tax/revenue
recognition function here. Advertising revenue is never part of ARPPU.

## Authority, window and refunds

Only accepted canonical `financial_status=settled` purchases with an installation
in the selected cohort qualify. The source must be an internal `adapter:`
producer with the reserved `google-play-product-verification-v1` or
`verified-commerce-v1` server policy. The existing App Store and Google Play
verified workers issue these contexts; synthetic fixtures use synthetic aliases.
These are captured provenance qualifiers, not cryptographic store proofs by
the metric engine. Store signature/read-back, intent/installation binding,
consent and privacy checks remain owned by the existing
[verified-commerce pipeline](design/verified-commerce-lifecycle.md). Privileged
operators must not forge internal producer/policy provenance. Client payload
extensions, SDK-reported amounts, pending purchases, unbound store observations
and arbitrary imports cannot qualify themselves as verified purchases.

The fixed UTC elapsed window is `[installation time, installation time + 8 days)`
(D0 through D7). Both purchases and refunds must occur in this window; each
receipt must be at or before the saved inclusive watermark. A refund targets
one qualifying settled purchase under the existing exact-target rules. Several
partial refunds each deduct once. A valid `reverses_refund_record_id` cancels
only its linked deduction at the watermark. A reversal received later cannot
silently change an earlier saved run. The profile is gross; net/fraud-filtered,
imported, platform-assigned, calendar-zone and alternative-window variants are
not inferred from these definitions.

Counts remain zero when there is no qualifying purchase. With a nonempty
cohort, payer rate is zero. Empty-cohort rate is `undefined/empty_cohort`;
zero-payer ARPPU is `undefined/no_paying_installations`, never zero money.
FX converts and half-even rounds each contributing purchase/refund first,
then sums purchase-net and half-even divides by payer count. Explicit dated
FX snapshots and legacy single-rate inputs remain supported. Missing dated
rates make ARPPU `undefined/missing_fx_rate`, without invalidating counts.
No current-rate lookup or client fallback is used.

## Calculate, schedule and read

Apply the normal database migrations before enabling this profile. Migration
072 adds the new undefined reason to the existing metric-run storage constraint;
it changes no historical values or tables.

Import `payerMetricDefinitions()` from `@openmasu/contracts/definitions` for the
four closed definitions. [The synthetic schedule request](../examples/synthetic/payer-metrics.json)
can be pasted into **Register a schedule** on the app's metric-schedule page.
Its example FX rate is synthetic, not a live rate feed. Choose and preserve an
operator-owned FX policy. `date_dimension=cohort_date` and a nine-day lag close
the possible D7 occurrence window; they do not prove all sources have delivered.
The original recommended acquisition schedule is not changed.

For `npm run metrics:run`, make a private copy of the example, add the explicit
`tenant_id` and `app_id`, and use `--date=<cohort date> --definitions=<file>
--watermark=<canonical UTC timestamp>`. Without `--watermark`, the historical
CLI default remains the next day, which is not a complete D7 observation.
Omitted grouping date defaults to `--date`; an explicit cohort date is retained.

Saved JSON/CSV retain the definition, rule binding, cohort date, watermark,
FX snapshot and privacy context. The dashboard labels transaction counts,
paying installations and money per paying installation explicitly. Undefined
money stays absent (empty CSV cell plus reason). Compare compatible saved
rows; do not average payer rates or ARPPU across cohorts. Current-privacy
deletion and saved-manifest replay use the existing correction path.
The bounded late-input selector connects a later qualifying purchase to all
four saved definitions. Refund/cancellation inputs select ARPPU, not transaction
or payer counts. Replacements retain the original definition and leave history
immutable; unverified source claims cannot trigger payer publication.

## Evidence and limits

[Fixture 73](../fixtures/v0.4/73-verified-payers/README.md) independently constructs
all 13 artifact families and 12 saved values. Shared synthetic vectors exercise
multiple transactions/payers, partial/full refunds, targeted cancellation,
pending/unverified observations, retries, receipt cutoff, empty population and
missing FX in TS, Python and SQL. Existing privacy-replay tests cover deletion
and restoration. No service, table or dependency is added. Real store access,
real-device purchase delivery, actual proceeds and operational completeness
remain unverified. This source addition is not in the frozen rc.2 SDK release.
