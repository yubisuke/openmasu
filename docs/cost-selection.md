# Safe cost denominators

ROAS is misleading when a campaign total and its breakdowns are summed twice.
New explicit definitions can opt into `cost_selection_policy=reject_overlapping_grains`.
This policy is bound to `metric-disjoint-cost` version `0.4.12`. Existing saved
definitions, runs and cost digests are not upgraded or rewritten.

The [native acquisition example](../examples/metrics/synthetic-selected-acquisition.json)
uses this policy for D0 advertising ROAS. Run it through the existing CLI or
submit its explicit definitions to an existing metric schedule:

```bash
npm run metrics:run -- --date=2026-08-06 --watermark=2026-08-12T00:00:00.000Z --definitions=examples/metrics/synthetic-selected-acquisition.json
```

These are synthetic configuration values, not an instruction to import real
data into the repository. Configure your deployment privately. The scoped
ledger must already contain the source events and imported cost observations.
`DISJOINT_COST_METRIC_DEFINITIONS` also exports D1/D3/D7 advertising ROAS and
D30/D90 total-net ROAS definitions. Total-net retains recorded acquisition
dimensions until its separately scoped native-commerce connection is delivered.

## Selection, ambiguity and corrections

1. Apply tenant/app, explicit grouping and input watermark first. Organic and
   unattributed groups do not inherit non-organic acquisition cost.
2. Select the latest visible `(as_of, cost_record_id)` revision for the explicit
   tuple `(tenant, app, network, acquisition date, campaign, ad group, country)`.
   Do not infer this tuple from provider-specific or legacy dimension digests.
3. Compare current grains within each tenant/app/network/date. An absent
   campaign, ad group or country leaves its coverage unknown. Two rows are
   disjoint only if a shared known dimension differs. Do not use amount
   equality, import source, or an arbitrary parent/child preference as proof.
4. If any current grains overlap, emit `value_state=undefined` with
   `undefined_reason=overlapping_cost_grains` and no `value_unscaled`. Keep all
   current candidate references. This is not zero cost, zero ROAS, or fraud.
5. Otherwise apply existing per-cost scale conversion and half-even ratio
   arithmetic. Disjoint 40+60 is 100; the matching campaign parent100 plus those
   details is ambiguous, not 200. Intersecting ad-group and country cuts are
   also ambiguous unless their known dimensions prove separation.

Snapshots include the selected dated revisions, including candidates that
cause an undefined result. Replay manifests save the exact definition and
watermark; comparison meaning includes the selection policy. Identical metric
names or snapshot hashes do not equate legacy and safe definitions. Later cost
corrections can produce a new run but never change an earlier saved artifact.
No estimated allocation, new provider requests or additional service is used.

## Synthetic evidence

[Fixture 59](../fixtures/v0.4/59-disjoint-cost-grains/input.json) and its
[derivation](../fixtures/v0.4/README.md#fixture-59-disjoint-cost-grains) cover
dated revisions, disjoint siblings, overlapping totals, another acquisition
date, and retained legacy behavior. The existing SQL parity suite exercises
both one-import and separate-import overlap, saved comparison meaning and
immutable earlier runs. This is synthetic evidence, not live cost completeness.
