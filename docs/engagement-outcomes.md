# First-party re-engagement outcomes

These opt-in metrics answer what happened after a server-resolved deep-link
open. They do not change original install attribution and are not Apple's
aggregate re-engagement postbacks. An SDK-reported open can be forged; server
link resolution alone does not prove human activity or incremental lift.

## Historical 24-hour measurement policy

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

## Explicit outcome window and recorded inactivity

`engagementPolicyMetricDefinitions({ windowDays: 3, minimumInactivityDays: 7,
eventKey: "tutorial_complete" })` opts into the independent `metric-engagement-policy`
0.4.28 bundle. It does not upgrade the historical definitions above.

| Metric | Unit | Meaning |
| --- | --- | --- |
| `engagement_policy_custom_event_converters` | count | Distinct installations reaching the declared event after a qualifying open |
| `engagement_policy_ad_revenue_usd` | USD, scale 6 | Installation-level ad revenue after a qualifying open |
| `engagement_policy_purchase_net_usd` | USD, scale 6 | Verified settled purchase net, including qualifying partial refunds |

Declare an integer window of 1–30 days. Its half-open interval is `[open,
open + windowDays)`; the existing definition's elapsed `day` is `windowDays - 1`.
Declare `engagement_inactivity_days` explicitly: 0 disables this gate, while
1–90 requires no **recorded SDK activity**, not proof of actual human inactivity
or complete SDK delivery. Only same-tenant/app/installation `sdk-android` or
`sdk-ios` evidence known at the saved receipt cutoff is considered:

1. An available session start, custom event or deep-link open in `[open - N
   days, open)` proves recorded activity; that open is ineligible.
2. Otherwise, removed activity in that interval or no available SDK install at
   or before its start makes the history unknown.
3. Otherwise, the open qualifies under the declared recorded-inactivity policy.

Any unknown open in the selected available population makes the whole selected
result `undefined/insufficient_activity_history`, not a partial numeric total.
All-active/empty populations remain `empty_cohort`; a qualifying population
with no outcomes is known zero. Equal-time opens use ascending record ID; they
are not strictly earlier history for each other. Latest-open selection happens
before campaign/date, inactivity and privacy filters. An ineligible or removed
winner suppresses earlier opens rather than transferring credit backwards.

Purchase net accepts only existing settled, installation-bound server store
projections with an `adapter:` producer and `verified-commerce-v1` or
`google-play-product-verification-v1` server policy. These markers retain the
existing verifier's authority; SDK claims cannot create it. A partial refund
follows its original purchase's selected open, not a later open at refund time.
Both purchase and refund must occur within that original window; the refund
cannot precede its purchase. Exact verified target-refund cancellation is
recognized at the saved receipt cutoff, even after the outcome window closes.
Money is converted/half-even rounded per event before netting. No acquisition
cost or Apple aggregate is joined.

The new profile also hashes the exact definition into `input_snapshot_id`.
Changing window or inactivity cannot silently reuse the same meaning proof.
Historical snapshots and results retain their existing bytes.

## Calculate and schedule the separate series

The existing CLI accepts explicit engagement definitions; no new worker or
metric engine is required. In the disposable, seeded synthetic environment:

```bash
npm run metrics:run -- --date=2026-08-21 --watermark=2026-08-23T00:00:00.000Z --definitions=examples/metrics/synthetic-engagement.json
```

The example selects campaign `synthetic-engagement-a` and the synthetic
`tutorial_complete` event. Replace its tenant/app, event key, campaign and FX
policy only in a private operator configuration, never with live data in this
public repository. `--date` supplies a missing `metric_date`; an explicit date
in each evaluation is preserved. Engagement evaluations must not include
install-cohort metrics or dimensions. With no explicit watermark this profile
uses `--date + 2 days` at UTC midnight, covering the complete 24-hour window
for opens throughout that date. Legacy CLI definitions keep their existing
`--date + 1 day` default. A later receipt watermark is necessary for backfills;
it does not prove all expected events were delivered.

For the new three-day/seven-day policy, use the separate synthetic example:

```bash
npm run metrics:run -- --date=2026-08-21 --definitions=examples/metrics/synthetic-engagement-policy.json
```

Its default watermark is August 25 at midnight: open date + window days + 1.
For a daily schedule use the same explicit definitions, `metric_date`, and a
lag of at least window days + 1 (four days here). An explicit later
`--watermark` remains available for backfills. Campaign discovery is not added.

Register [the synthetic schedule](../examples/synthetic/engagement-schedule.json)
through the existing dashboard daily-schedule form or
`POST /v1/admin/apps/<app>/metric-schedules`. It uses `date_dimension: metric_date`,
explicit campaign selection and at least two lag days. Campaign discovery is
not supported for this profile. Schedules record the definition and fixed
watermark and safely retry a completed date without duplicating saved runs.
They do not replace default install schedules or automatically revisit old
dates after late delivery.

## Read, compare and recalculate

Use the same filters for the API, dashboard and CSV, for example:

```text
/v1/reports/metrics?app_id=app-a&metric_definition_version=0.4.17&grouping_metric_date=2026-08-21&grouping_campaign_id=synthetic-engagement-a
/dashboard/apps/app-a?metric_definition_version=0.4.17&grouping_metric_date=2026-08-21&grouping_campaign_id=synthetic-engagement-a
```

The dashboard puts these rows and charts in **First-party re-engagement
outcomes**, separately from install/activity metrics and Apple aggregate
postbacks. API/CSV rows append `measurement_series: first_party_engagement` and
`engagement_evidence_trust: device_reported_forgeable`. These are presentation
labels, not new evidence or an assertion that other series are verified.
Existing CSV column positions are unchanged, and dashboard/API CSV encoders
are shared. Empty populations remain undefined with a reason; zero outcomes
remain numeric zero. The raw daily-record-count endpoint rejects these metric
names rather than returning unrelated counts.

Stored definitions and comparison context retain the exact engagement credit
policy. Do not compare this series as if it were install-cohort revenue or a
provider aggregate. Re-run with a later explicit watermark to include late
receipts or recalculate after deletion. Operational engagement calculations use
`privacy_state: after`; deleted anchors and outcomes do not return. New runs
are appended, not substitutions for historical runs. Automatic privacy/late-
event supersession is not wired to this new series: explicitly select the new
watermark when reading the report, and retain old runs only as historical
evidence. Repeating a manual command with the same run IDs refuses an overwrite;
the schedule's checkpoint handles operational retry.

## Synthetic evidence and limits

Fixture 64 records independent arithmetic and selected anchors, with
TypeScript/Python/SQL parity. The `first-party engagement SQL parity` suite
checks duplicate delivery, latest-open overlap/ties, boundaries, late inputs,
unknown links, deleted sources and per-event half-even money. The `first-party
engagement operator workflow` integration suite connects CLI and schedule
registration to saved runs, API/HTML/CSV separation, immutable original
acquisition results and recalculation after the actual privacy-request path.
The privacy integration uses a synthetic payload-store stub; encryption and
purge mechanisms retain their separate existing tests.

Fixture [75](../fixtures/v0.4/75-engagement-policy/README.md) independently
derives the explicit-window, recorded-inactivity and verified purchase/refund
profile. Shared cases exercise inactive/active/unknown, consecutive and tied
opens, receipt/window boundaries, per-event rounding, partial refunds, exact
cancellation and deletion in TS/Python/SQL. The existing operator suite also
covers saved definitions, CLI, API/HTML/CSV and actual privacy requests.

No re-engagement ROAS, fraud-excluded variant, cross-device
identity, reinstall linking or iOS deferred destination is supplied. These need
separate evidence/window/cost decisions, not allocation of install-acquisition
cost. Real devices, live links and campaign/provider delivery remain unverified.

See the normative [contract](../spec/event-metric-contract-v0.4.md#v0417-patch-release-first-party-engagement-outcomes),
[migration ledger](contract-v0.4-migration.md), and [deep-link design](design/deeplink-baseline.md).
