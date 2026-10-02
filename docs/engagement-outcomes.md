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

No re-engagement ROAS, purchase/refund join, fraud-excluded variant, cross-device
identity, reinstall linking or iOS deferred destination is supplied. These need
separate evidence/window/cost decisions, not allocation of install-acquisition
cost. Real devices, live links and campaign/provider delivery remain unverified.

See the normative [contract](../spec/event-metric-contract-v0.4.md#v0417-patch-release-first-party-engagement-outcomes),
[migration ledger](contract-v0.4-migration.md), and [deep-link design](design/deeplink-baseline.md).
