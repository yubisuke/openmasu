# Selected ad-group and creative outcomes

An explicit `metric-acquisition-detail` version `0.4.16` profile reuses the
existing install-cohort engine with two additional dimensions. They come from
the uniquely selected native first-party click, never from a later unrelated
click or from a provider-name guess. Missing detail remains unknown. This is
not automatic discovery of all media hierarchies or cross-device attribution.

## Calculate a synthetic example

On an isolated synthetic ledger containing the fixture-63 events but no cost
rows, the existing commands accept provider-neutral creative-grain cost and
explicit metric definitions. Save this synthetic CSV to the ignored path
`build/synthetic-creative-cost.csv` (create `build` if necessary):

```csv
network,campaign_id,ad_group_id,creative_id,date,cost_decimal,currency,as_of
synthetic-network,campaign-a,synthetic-group-a,synthetic-creative-a,2026-08-06,10.00,USD,2026-08-12T00:00:00.000Z
synthetic-network,campaign-a,synthetic-group-b,synthetic-creative-b,2026-08-06,20.00,USD,2026-08-12T00:00:00.000Z
```

```bash
npm run import:cost -- --file=build/synthetic-creative-cost.csv --mapping=examples/mappings/synthetic-creative-cost.json
npm run metrics:run -- --date=2026-08-06 --watermark=2026-08-12T00:00:00.000Z --definitions=examples/metrics/synthetic-acquisition-detail.json
```

These values are synthetic and must not be used as real campaign identifiers.
The ordinary seed already has fixture cost evidence: use a fresh isolated test ledger
containing the corresponding events but no prior cost rows for the combined
CSV-to-metric demonstration. Importing equivalent cost from a second source
does not itself establish that its coverage is disjoint or authoritative.

The exported `ACQUISITION_DETAIL_METRIC_DEFINITIONS` contain install count,
existing D0/D1/D3/D7 advertising LTV/ROAS, existing purchase-net windows and
D30/D90 total-net revenue/LTV/ROAS. Commerce uses exact refund cancellation.
Current custom-conversion and retention profiles remain separate; they do not
silently acquire the new dimensions.

## Read and operate the same grain

In **Measurement links**, the existing create-link form accepts optional
**Ad group ID** and **Creative ID**. The link list shows these values. They
describe the link, not a guessed mapping of a provider's naming hierarchy.
Use the same explicit values in the cost mapping and metric evaluation.

In **Analyze metrics**, use the corresponding two filters. The API equivalents
are `grouping_ad_group_id` and `grouping_creative_id` on
`GET /v1/reports/metrics?app_id=<app>`. Filters select saved runs; they do not
calculate a breakdown from a campaign-only result. The selection is retained
in HTML navigation and CSV export, and the API and dashboard use the same CSV
encoder. Existing raw daily record counts do not support these two dimensions
and reject them with `raw_metric_unsupported`; use the explicitly calculated
`cohort_install_count` for selected-acquisition populations.

For [scheduled metrics](scheduled-metrics.md), supply the explicit v0.4.16
`metric_definitions`, `fx_policy`, and `evaluations` from the example above.
Each schedule evaluation has `date_dimension: "cohort_date"`; remove its
static `cohort_date` from `grouping` and retain the desired ad-group/creative
selection. Register through the existing application **Metric schedules** form
or `POST /v1/admin/apps/<app>/metric-schedules`. A detail filter with a legacy
definition is rejected, not silently promoted. Detail schedules require
explicit selections; campaign discovery does not discover creative hierarchies.

The existing bounded [recalculation workflow](metric-corrections.md) retains
the saved detail policy. A corrected cost row selects only matching detail
grains and their campaign aggregates. A late revenue or settled commerce input
uses the installation's selected click to find the same grains. Unrelated
creatives are not recalculated. Each replacement supersedes a saved run;
original artifacts and definitions remain unchanged. This connection does not
add automatic all-history recalculation or broaden the supported cost adapters.

## Meaning and limitations

- Select explicit ad-group/creative values inside `evaluation.grouping`.
  A campaign-only grouping includes known and unknown detail within that campaign.
- Cost must match every requested detail dimension. Parent-only cost gives
  undefined detail ROAS, not an estimated allocation. At campaign grain,
  disjoint detail siblings may be summed; parent-plus-child overlap is undefined.
- Revisions, input watermarks, per-event FX, fraud population and privacy rules
  retain their existing meanings. Saved definitions include the new policy;
  an older definition/run is not automatically upgraded.
- Previously persisted click facts without detail remain unknown. Existing
  provider adapters do not promise creative-level cost or automatic metadata
  discovery. Only provider-neutral manual CSV gains creative input here.
- Reporting, schedules and bounded cost/late-input correction use this same
  explicit profile. An operator must still import the relevant cost grain and
  choose the definitions; absence of detail is not a zero-valued creative.

## Evidence

[Fixture 63](../fixtures/v0.4/63-selected-acquisition-detail/input.json) and its
[derivation](../fixtures/v0.4/README.md#fixture-63-selected-ad-group-and-creative-acquisition)
state the independent values. `npm run validate` compares full TS/Python output;
`npm run test:metric-parity` exercises SQL including manual CSV, unknown detail,
overlap, revisions, duplicate deliveries, refund cancellation and deletion.
The runtime integration suite's `selected acquisition detail operator workflow`
connects link creation, API/HTML/CSV filtering, registration, scheduled SQL runs,
cost correction and late revenue while checking immutable original results.
These are synthetic code gates, not live-provider or production evidence.
