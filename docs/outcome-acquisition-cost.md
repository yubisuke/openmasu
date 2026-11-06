# Cost per outcome installation

Calculate acquisition cost per installation that reached one exact custom-event
key, or per installation with a verified settled store purchase. These are not
cost per event, per transaction or per person. Multiple events and purchases on
one installation contribute one denominator member.

The opt-in `metric-outcome-acquisition-cost` profile (`0.4.33`) is deliberately
narrow: native selected-first-party acquisition, UTC, elapsed D7, gross fraud
policy, USD scale 6, and disjoint acquisition-day cost. Platform/imported cohorts,
other horizons, period-unique people and estimated cost allocation are not added.
Existing CPI, revenue, ROAS, converter and payer definitions remain unchanged.

## Run it

The ledger must already contain synthetic native install/click evidence, matching
cost and accepted outcomes. The repository contains only synthetic examples:

```bash
npm run metrics:run -- --date=2026-08-06 --watermark=2026-08-16T00:00:00.000Z --definitions=examples/metrics/synthetic-outcome-acquisition-cost.json
```

The example uses the same population as [fixture 80](../fixtures/v0.4/80-outcome-acquisition-cost/README.md).
`outcomeAcquisitionCostDefinitions(eventKey)` from `@openmasu/contracts/definitions`
produces the two closed definitions. Submit them through the existing advanced
metric-schedule JSON form/API with `date_dimension: cohort_date`, explicit
grouping, and `lag_days >= 9`. Declare the custom key in the existing event
catalog; a deprecated key cannot be put on a new schedule. Definitions keep the
exact selected key even when their permitted display name is an alias.

## Meaning and saved evidence

Outcomes must belong to the same tenant/app/installation cohort and occur in
`[install_at, install_at + 8 days)`, with a receipt no later than the saved
watermark. The complete daily cohort closes at UTC cohort midnight plus nine
days. Refunds do not undo historical payer membership. Client purchase claims
do not establish verified store authority. Organic/unattributed groups cannot
borrow paid cost.

The numerator reuses [safe cost selection](cost-selection.md): latest eligible
acquisition-day revisions, no overlapping parent/breakdown double count, and
per-cost half-even FX conversion before summing. Divide that integer sum by the
distinct denominator with half-even rounding. A known zero cost is a present
zero when the denominator is nonzero.

Saved `outcome_cost_operands` contains `outcome_installation_count` and, only
when known, `cost_unscaled` in USD scale 6. It is part of the metric artifact,
not a division performed in the dashboard. Input snapshot, protected evidence
references, captured definition/key, FX policy and watermark retain provenance.
JSON, the appended CSV column and the HTML table expose those same operands.
Completed privacy invalidation suppresses both saved value and operands from
reports; surviving source history is not permission to republish an invalidated
original.

Undefined precedence is immature window, overlapping cost, missing required FX,
empty cohort, missing cost, then zero outcome denominator. Reasons are
`observation_window_not_elapsed`, `overlapping_cost_grains`, `missing_fx_rate`,
`empty_cohort`, `no_attributed_cost`, `no_converted_installations` or
`no_paying_installations`. An immature run omits operands. Unknown cost omits its
operand rather than storing a fabricated zero.

The existing bounded late-input and cost-recalculation workflow saves successors
with `supersedes_metric_run_id`; previous runs are not rewritten. Exact custom
keys and verified purchase authority also constrain late-input selection.
Automatic correction remains operator opt-in. A successful synthetic result
does not establish live completeness, provider equivalence or production readiness.
