# Same-set acquisition KPIs

Read install count, acquisition-day cost, CPI, advertising revenue, settled
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

## Select a native D0 or D30 horizon

The native first-party panel supports explicit D0, D7 and D30 sets. D0 and D30
use `acquisition_d0_*` and `acquisition_d30_*`, respectively: definition version
`0.4.31`, bundle `metric-horizon-acquisition-kpis`. The existing D7 definitions,
hashes and keys are unchanged. No existing schedule changes its horizon.

Code constructing a private definitions file or schedule request can use
`horizonAcquisitionKpiDefinitions(0)` or `horizonAcquisitionKpiDefinitions(30)` from
`@openmasu/contracts/definitions`. Select all eight roles from that returned
family and keep the same explicit cohort grouping, cutoff and FX policy. These
profiles are native first-party click acquisition, UTC install cohorts and USD
scale 6 only; they do not introduce platform/imported D0 or D30, arbitrary
windows, calendar-zone or re-engagement calculations.

Each elapsed window begins at the installation's timestamp and ends before
`install_at + (horizon + 1) days`. Thus D0 is the first 24 hours, not an install
calendar day. D30 includes elapsed day 30, but excludes the exact 31-day endpoint.
The final possible installation on a cohort date makes the conservative maturity
bound `cohort_date + (horizon + 2) UTC days`: two days for D0, nine for D7 and
32 for D30. New D0/D30 schedules require `cohort_date` and lag at least 2/32.
An immature new-horizon calculation does not become a decision-ready set.

The typed KPI set includes `horizon: 0 | 7 | 30`. The panel labels every row D0,
D7 or D30 and uses horizon-neutral column names. New D0/D30 keys use
`saved-acquisition-horizon-v1` and bind the window; they cannot fill a missing
D7 role or each other's roles. Period/daily presentation dimensions add
`acquisition_horizon: D0 | D30` only for the new profiles. Native D7 and the
existing platform/imported D7 dimensions and keys remain unchanged.

## Select a separate platform or imported-provider set

The same eight roles also have two explicit, opt-in definition families:

| Population | Metric names | Definition version / bundle | Required selection |
| --- | --- | --- | --- |
| Native first-party click | `acquisition_d7_*` | `0.4.23` / `metric-acquisition-kpis` | Existing native profile |
| Verified platform | `platform_acquisition_d7_*` | `0.4.30` / `metric-basis-acquisition-kpis` | `acquisition_basis: selected_verified_platform` |
| Imported provider | `imported_acquisition_d7_*` | `0.4.30` / `metric-basis-acquisition-kpis` | `acquisition_basis: selected_imported_provider` and one exact `import_provider` |

Select all eight definitions from the same family. Code constructing a private
schedule can use `basisAcquisitionKpiDefinitions("selected_verified_platform")`
or `basisAcquisitionKpiDefinitions("selected_imported_provider", "synthetic-alpha")`
from `@openmasu/contracts/definitions`; the latter provider is an invented example.
The factory returns the closed definitions, not a scheduled job or an import.
Supply them to the existing metric definitions file or schedule API, with the
same explicit cohort grouping, cutoff and FX policy as the native profile. Keep
private provider configuration outside this public checkout. There is no
automatic provider discovery and no implicit switch of existing schedules.

These profiles remain **UTC install cohorts and elapsed D7 only**. The panel
labels the acquisition basis and, for imported evidence, the exact provider.
Provider-reported attribution is not native attribution or independent evidence
of provider completeness. A platform set does not include Apple aggregate
postbacks. Identical campaign names do not make these populations equivalent:
the same installation can be represented in different evidence bases, so do not
sum the panels into a cross-basis installation or revenue total.

The new calculation-set identity binds basis and exact provider even when no
population or cost was found. Provider A cannot supply missing roles for provider
B. A missing role, unmatched definition/context, partial page, inconsistent
snapshot or different cutoff does not produce a joined set. Undefined cost or
overlapping-cost refusal remains visible in its saved cell; it is not filled from
another population. Pending corrections and immature windows stay blocked.
Native `saved-acquisition-d7-v1` keys remain byte-identical. New profiles use
`saved-acquisition-d7-v2`; JSON and CSV still use the same
`acquisition_kpi_set_key` field without reordering existing columns.

## Period totals and weighted ratios

Open [Saved daily analyses](dashboard-analysis.md#saved-daily-analyses-and-previous-periods)
with all eight acquisition metrics, a date range and explicit receipt cutoff.
Alongside the original daily rows, the same complete, privacy-fenced read produces
current and preceding equal-length period summaries. No new calculation job or
persisted metric run is created.

Each campaign and all other non-date dimensions stay separate. A period needs
exactly one complete eight-role set per selected date, identical role-specific
meaning (including currency, FX, basis, definition/bundle, fraud/privacy, window
and grain), and each date's horizon-specific conservative maturity. Snapshot IDs and
watermarks may differ across dates. Missing/duplicate dates or roles,
correction-pending, superseded and privacy-unavailable evidence block the side.
Missing cost or FX is not zero; there is no partial sum.
Platform and each exact imported provider also remain separate in daily alignment,
period summaries, HTML and CSV, even with identical campaign/date labels. Their
presentation dimensions include `acquisition_basis` and, where applicable,
`import_provider`; these are report labels, not new event-contract grouping fields.
Legacy native daily/period identity is unchanged. Incomplete or unverified new
contexts cannot borrow native rows or another provider's operands.
Native D0 and D30 also remain separate: even identical campaign labels, input
snapshots and costs do not authorize summing or comparing different horizons.

Sum the integer operands first, then use the existing half-even arithmetic:

- Installs, cost, advertising revenue, purchase net and total net: integer sums.
- CPI: `half_even(sum(cost_micro_units) / sum(installs))`.
- Advertising ROAS: `half_even(sum(ad_revenue_micro_units) * 10^6 / sum(cost_micro_units))`.
- Total ROAS: `half_even(sum(total_net_micro_units) * 10^6 / sum(cost_micro_units))`.

For example, synthetic days with 1 install / USD 100 cost / USD 100 revenue and
9 installs / USD 90 cost / USD 180 revenue yield **USD 19 CPI and 1.473684 ROAS**.
Averaging the daily CPI values into USD 55 or daily ROAS into 1.5 would be wrong.
Zero denominators remain undefined (`empty_cohort` for CPI,
`no_attributed_cost` for ROAS). A daily undefined ratio can still contribute its
present operands to a defined period result.

Current and previous sides are validated separately. Incompatible cross-period
meaning suppresses the delta, not each independently valid total. JSON, HTML and
CSV share values/reasons and source run/snapshot/watermark/set/digest provenance.
CSV identifies summary rows explicitly without reordering existing daily columns.
Retention, daily distinct installation counts and re-engagement are not period
aggregates. Saved-source completeness remains **unknown**, even for ready sums.

## Meaning and refusal boundaries

- The native set uses **selected native first-party click** acquisition; the
  explicit platform and imported-provider sets use their separately selected
  evidence populations. All use UTC install dates, their explicit elapsed horizon and current
  disjoint acquisition-day costs. Apple aggregate, re-engagement, calendar-zone
  and detail-grain profiles are not included in this KPI panel.
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
- The set key binds authenticated tenant/app scope, grouping, acquisition basis,
  exact imported provider when applicable, shared input snapshot, cutoff, full captured FX
  digest, registered definition/bundle version, window and privacy/fraud mode.
  Counts deliberately retain the same cost snapshot even though count arithmetic
  needs no FX. Different keys, duplicate/missing roles and partial keyset pages
  are not joined. Unknown saved context remains only in the ordinary report.
- Cohort date plus horizon + 2 UTC days conservatively closes the window. Immature,
  superseded, privacy-unavailable and recorded pending/revised sets are blocked.
  A ready set means saved meaning agrees, **not** that all provider inputs have
  arrived or that a campaign is profitable. [Freshness observations](metric-freshness.md)
  retain that distinction; current deletion state is used throughout.

## Bounded saved corrections

New platform/imported D7 and native D0/D30 sets use the existing cost and late-input correction jobs.
Selecting one new-profile metric expands to its fixed eight roles within the
same captured selection. The set key, replay definition, FX, source snapshot,
privacy mode and cutoff must agree; missing or ambiguous companions are
`unsupported_definition`, not a partially updated decision panel. Jobs retain
the existing 31-date and 100-run bounds. Automatic correction only uses its
captured page: it does not fetch companions from another page or scan history.
Select a smaller complete date range when a set cannot fit those bounds.
Current deletion/retention and unavailable replay evidence remain authoritative.
The historical native correction behavior is unchanged.
The new native horizon is part of companion selection. A D0 selection never
adds D30 runs, and a late event or refund outside D0 can affect D30 without
rewriting D0. A cost revision can affect both only when both horizons were
selected. The old native D7 correction behavior is not silently expanded.

The [native independent oracle](../fixtures/v0.4/70-saved-acquisition-kpis/README.md)
hand-calculates two campaigns, organic and cost-only rows. TS/Python/SQL share
the input and exact arithmetic; the existing Runtime CI supplies SQL evidence.
The [basis-separated oracle](../fixtures/v0.4/77-basis-acquisition-kpis/README.md)
adds exact-provider commerce, organic/unattributed/missing populations and an
empty platform control without borrowing the imported installations.
No dependency, service, table, provider connection, impression-derived CTR or
CVR is added.
