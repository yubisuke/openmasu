# Fixed, dated FX snapshots

An explicit `fx_policy` with `policy_version: "0.4.22"` and
`rate_selection: "utc_event_date_and_cost_date"` converts mixed-currency money
through one bounded, saved rate snapshot. It is opt-in: the historical one-rate
profile, existing definitions, schedules and saved results are not upgraded.
No provider lookup, live FX feed, new service or accounting policy is supplied.

## Select and save rates

Each rate records an uppercase source `currency`, exact `effective_date`,
positive integer `rate_unscaled`, `rate_scale`, non-identifying `source` label,
and canonical millisecond UTC `as_of`. The coefficient means **target major
units per source major unit**. The policy declares one `target_currency`,
`target_scale` and `rounding_mode: "half_even"`.

- Accepted revenue, purchase, refund and credited engagement money select the
  exact **UTC occurrence date of that money event**, not its receipt date,
  installation date, deep-link open date or local cohort date.
- A selected cost row uses its declared report `date`. Its existing qualified
  reporting zone still controls cost/cohort compatibility, not FX date inference.
- A rate must have `as_of <= input_received_at_watermark`. A future-known rate
  remains in the captured policy but cannot contribute at that earlier cutoff.
- The snapshot contains 1–128 unique `(currency, effective_date)` rows. Rate
  integer strings have at most 78 digits and scale 0–18; `source` is 1–128
  characters. Malformed, duplicate, zero, negative or extra policy fields fail
  admission. An explicit same-currency row must represent exactly 1.
- There is no implicit identity rate, nearest date, previous-day carry-forward,
  newest-rate lookup or fallback to the old one-rate profile. Required money
  definitions must declare the same target currency and scale as the policy.

Use only synthetic labels in public examples. A rate label is operator-declared
provenance, not external verification of a market rate or financial settlement.

## Exact arithmetic and missing money

For source integer `a` at scale `s`, rate integer `r` at scale `q`, and target
scale `t`, each event or selected cost row contributes:

```text
half_even(a * r * 10^t / 10^(s + q))
```

Round each row before summation, then half-even round the final ratio or
per-installation division. No binary floating point participates in money.
Refunds use their own occurrence-date rate and deduct their converted amount;
they do not retroactively reuse the purchase-date rate. An explicit refund
cancellation retains its already-defined target and policy semantics.

A missing applicable rate makes the affected money/ROAS/LTV result
`value_state: "undefined", undefined_reason: "missing_fx_rate"`, with no
`value_unscaled`. It never publishes a partially converted total. Counts and
retention do not need FX. A missing cost rate affects ROAS, not a cost-free LTV
or revenue total; irrelevant revenue types do not poison a different numerator.
The safe-cost profile still refuses overlapping grains before applying FX: no
currency conversion makes a parent total and its breakdown disjoint. Eligible
zero cost remains `no_attributed_cost`, not a fabricated rate or infinity.

## Reports, replay and comparison

FX-sensitive metric artifacts retain `fx_conversion_snapshot: { policy,
snapshot_id }`, including undefined results. The policy is a closed projection
sorted by currency/date; `snapshot_id` is SHA-256 of its RFC 8785 canonical JSON.
Mixed-currency artifacts do not claim the first rate as their sole provenance.
Historical singular FX fields remain readable in the historical profile.

The same saved policy and digest are retained in SQL replay manifests,
aggregate-only comparison context, report JSON, the appended CSV column and
saved-run HTML. Supported ROAS operands also retain source/date/as-of rates.
A saved-run replay or bounded cost correction uses the captured policy, never
today's configuration. Changing a rate, date or source label changes its
snapshot and comparison meaning; it does not overwrite old results. A changed
FX policy is a new explicit schedule, not an edit of an immutable schedule.
Privacy-invalidated values remain unavailable under existing report rules.

## Synthetic example and evidence boundary

[This explicit schedule](../examples/synthetic/metric-dated-fx-schedule.json)
matches [fixture 69](../fixtures/v0.4/69-dated-fx-cohorts/README.md). Register it
through the existing [schedule API or dashboard](scheduled-metrics.md); its
five rates cover only the declared synthetic August 6/7 dates. The scoped
ledger must already hold the synthetic fixture's accepted events and costs.
It is not an instruction to import real source data into this public repository.

The fixture independently derives JPY/USD/EUR date selection, half-even ties,
an earlier missing rate, D0/D7 ROAS, LTV and unchanged retention/count. The
existing contract and SQL suites additionally exercise huge integers, identity
rates, missing dates/cost, per-cost rounding, overlap, purchase/refund dates,
engagement outcome dates, reorder stability, saved replay, corrections and
JSON/CSV/HTML binding. These are synthetic tests, not live FX-rate coverage,
provider reconciliation, tax advice or production acceptance.
