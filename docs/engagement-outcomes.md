# First-party re-engagement outcomes

These opt-in metrics answer what happened after a server-resolved deep-link
open. They do not change original install attribution and are not Apple's
aggregate re-engagement postbacks. An SDK-reported open can be forged; server
link resolution alone does not prove human activity or incremental lift.

## Explicit measurement policy

`engagementMetricDefinitions("tutorial_complete")` from `@openmasu/contracts`
creates the fixed version 0.4.17 definitions:

| Metric | Unit | Meaning |
| --- | --- | --- |
| `engagement_custom_event_converters_24h` | count | Distinct installations with the configured event key after an eligible open |
| `engagement_ad_revenue_24h_usd` | USD, scale 6 | Installation-level advertising revenue after an eligible open |

Use `metric_date` for the **open's UTC date** and optional `campaign_id` for its
server-resolved campaign. The window is `[open, open + 24 hours)`. An outcome
chooses the latest eligible same-scope installation open before any campaign/date
filter; equal-time opens break ties by ascending record ID. This prevents both
campaigns claiming the same revenue event. One installation can convert in two
campaigns; summing campaign converter counts is not a unique-user total.

Both sides must have arrived by the fixed receipt watermark. Unknown/inactive
links and install-click reuse do not qualify. Privacy removal excludes outcomes
and their selected anchor without reallocating credit backwards. Money uses
integer half-even FX per event, then sums. A valid population without outcomes
is zero; no valid population is `undefined/empty_cohort`.

## Implementation status

The opt-in contract, TypeScript/Python reference engines and SQL calculation are
implemented with synthetic input. Fixture 64 records independently calculated
expected results. Stored run definitions and comparison context retain the
credit policy; fixed-watermark reruns preserve artifact identity. The operational
CLI, schedule and separate dashboard workflow are the next integration step.
Do not infer availability in default schedules from this contract support.

No re-engagement ROAS, purchase/refund join, fraud-excluded variant, cross-device
identity, reinstall linking or iOS deferred destination is supplied. These need
separate evidence/window/cost decisions, not allocation of install-acquisition
cost. Real devices, live links and campaign/provider delivery remain unverified.

See the normative [contract](../spec/event-metric-contract-v0.4.md#v0417-patch-release-first-party-engagement-outcomes),
[migration ledger](contract-v0.4-migration.md), and [deep-link design](design/deeplink-baseline.md).
