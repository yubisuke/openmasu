# Same-set acquisition KPIs

Read install count, acquisition-day cost, CPI, D7 advertising revenue, settled
purchase net, their total, advertising ROAS and total-net ROAS together. Each
value is saved by the existing cohort engine. The dashboard never divides
unrelated rows or fetches a second dataset to fill a cell.

## Run and read the set

After synthetic seed, or after your private scoped ledger contains the required
evidence, use the [synthetic CLI configuration](../examples/metrics/synthetic-acquisition-kpis.json):

```bash
npm run metrics:run -- --date=2026-08-06 --watermark=2026-08-16T00:00:00.000Z --definitions=examples/metrics/synthetic-acquisition-kpis.json
```

It selects all eight `acquisition_d7_*` definitions, version `0.4.23`, bundle
`metric-acquisition-kpis`. It contains invented identifiers and explicit USD
identity FX rates; it does not import data or contact a provider. Keep real
inputs, rates and configuration outside the public repository. The existing
schedule API/dashboard also accepts the [synthetic daily schedule request](../examples/synthetic/metric-acquisition-kpi-schedule.json),
with a conservative nine-day lag. See [schedule controls](scheduled-metrics.md).
Select all eight roles for the same target and correction cutoff, not only a
ratio or one revised operand.

In the app report, filter definition version `0.4.23` and retain a complete
selection of all eight metrics. **Saved acquisition KPIs** appears above the
ordinary metric table. Money uses USD scale 6; ratios use scale 6 multipliers.
Numerator/denominator and summand links point to the actual saved run details.
JSON/CSV append `acquisition_kpi_set_key`; old CSV columns keep their order.
Legacy reports, definitions and results remain readable without relabeling.

## Meaning and refusal boundaries

- The initial set uses **selected native first-party click** acquisition, UTC
  install dates, elapsed D7 revenue and current disjoint acquisition-day costs.
  Imported-provider, verified-platform, Apple aggregate, re-engagement,
  calendar-zone and detail-grain profiles stay separate; this table does not
  claim their populations are covered or blend them into native acquisition.
- Cost sums individually converted rows. CPI is
  `half_even(cost_micro_units / distinct_installations)`. Each ROAS is saved
  `half_even(revenue_micro_units * 10^6 / cost_micro_units)`. Purchase net is
  settled purchases less qualifying settled refunds. Tax, store fees, proceeds
  and targeted refund-cancellation semantics are not invented by this profile.
- Missing cost gives `undefined/no_attributed_cost`, never free acquisition.
  Recorded zero cost is present; with installs its CPI is zero, but its ROAS
  denominator remains undefined. Empty-cohort CPI is `empty_cohort`. Cost-only
  campaigns retain their cost and zero installs. Organic cost/ROAS stay
  undefined, separate from paid acquisition.
- Overlapping grains make cost/CPI/ROAS undefined. Missing exact-date FX gives
  `missing_fx_rate`, never a partial sum. The captured policy can be historical
  single-rate FX or an explicit [dated snapshot](fx-snapshots.md).
- The set key binds authenticated tenant/app scope, grouping, shared input snapshot, cutoff, full captured FX
  digest, registered definition/bundle version, window and privacy/fraud mode.
  Counts deliberately retain the same cost snapshot even though count arithmetic
  needs no FX. Different keys, duplicate/missing roles and partial keyset pages
  are not joined. Unknown saved context remains only in the ordinary report.
- Cohort date plus nine UTC days conservatively closes D7. Immature,
  superseded, privacy-unavailable and recorded pending/revised sets are blocked.
  A ready set means saved meaning agrees, **not** that all provider inputs have
  arrived or that a campaign is profitable. [Freshness observations](metric-freshness.md)
  retain that distinction; current deletion state is used throughout.

The [independent oracle](../fixtures/v0.4/70-saved-acquisition-kpis/README.md)
hand-calculates two campaigns, organic and cost-only rows. TS/Python/SQL share
the input and exact arithmetic; the existing Runtime CI supplies SQL evidence.
No dependency, service, table, provider connection, impression-derived CTR or
CVR is added.
