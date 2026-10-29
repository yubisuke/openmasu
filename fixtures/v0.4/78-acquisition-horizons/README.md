# Native acquisition KPI horizons: independent derivation

This synthetic fixture compares D0, the unchanged D7 profile, and the new D30
profile for one native first-party paid cohort. The population, acquisition-date
cost, USD conversion policy and receipt cutoff are identical; only the elapsed
revenue window changes. It does not infer imported or platform attribution.
Wire version remains `0.4.0`. All values and identifiers are invented.

## Evidence and arithmetic

The 16 reviewed input records, six attribution artifacts and three cost records
from fixture 70 are unchanged. The selected `kpi70-a` cohort has three installs
on August 6, USD 10 acquisition cost, USD 6 ad revenue and a settled USD 8
purchase in the first installation's first day. Its settled USD 2 refund occurs
on August 7 and is outside that installation's D0 window, but inside D7.

Three records are added to `installation:kpi70-install-a-0`:

| Record | Occurrence UTC | Amount USD | Receipt UTC |
| --- | --- | ---: | --- |
| kpi78-later-ad | August 20, 12:00 | 4 | September 8, 00:00 |
| kpi78-later-purchase | August 20, 13:00 | 6 | September 8, 00:00 |
| kpi78-later-refund | August 21, 12:00 | 3 | September 8, 00:00 |

The new refund explicitly targets the new purchase and its transaction. Both
are settled. These receipts arrive after D30 maturity, so saved replay must
distinguish observation maturity from what had actually been received.
The input does not set the separate transport `late` flag; this does not change
its occurrence-time window or receipt-time inclusion rule.

The mature evaluations all use September 9 at 00:00 UTC:

| Horizon | Installs | Cost USD | CPI USD | Ad USD | Purchase net USD | Total net USD | Ad ROAS | Total ROAS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| D0 | 3 | 10 | 3.333333 | 6 | 8 | 14 | 0.6 | 1.4 |
| D7 | 3 | 10 | 3.333333 | 6 | 8 - 2 = 6 | 12 | 0.6 | 1.2 |
| D30 | 3 | 10 | 3.333333 | 6 + 4 = 10 | 8 - 2 + 6 - 3 = 9 | 19 | 1 | 1.9 |

Money and ratios use scale 6. CPI is
`half_even(10000000 / 3) = 3333333`; its remainder is less than half, so this
is not a rounding tie. Ratios multiply target money by `1000000` before
dividing by the same `10000000` cost. Count values are not money micros.

For the new horizons, the complete cohort-date observation bound is
`cohort_date + day + 2 UTC days`: D0 matures August 8 at 00:00, D30 September 7
at 00:00. The fourth evaluation uses September 6 at 23:59:59.999. All eight D30
runs are therefore `value_state: undefined` with
`undefined_reason: observation_window_not_elapsed`. None claims a zero, even
though the earlier cost and installs are already received. Existing D7 behavior
and every earlier fixture remain unchanged.

## Definitions and all 13 expected families

The D0/D30 definitions are independently declared copies of the reviewed native
D7 operation table with only name, elapsed day and bundle identity changed.
Their names are `acquisition_d0_<role>` and `acquisition_d30_<role>` for
`installs`, `cost`, `cpi`, `ad_revenue`, `purchase_net`, `total_net`, `ad_roas`,
and `total_roas`. They use UTC, USD/scale 6 where applicable, the same five
acquisition dimensions, and `reject_overlapping_grains`. The new bundle is
`metric-horizon-acquisition-kpis`, version `0.4.31`, hash
`80d2d996192549069189e77812566f2805c6f22a5f427ba86ce863b91ccd7447`.
The eight D7 definitions retain their reviewed version, bundle and hash.

Expected files were assembled before either evaluator ran; candidate evaluator
outputs were compared with those files and were not copied into them.

| Family | Count | Independent construction |
| --- | ---: | --- |
| raw_records | 19 | The 16 reviewed rows plus three matching event-type envelope templates, new IDs, occurrence/receipt times and independently hashed payloads. |
| deliveries | 19 | The 16 reviewed rows plus three unique accepted/protected deliveries under the existing consent-not-required policy. |
| logical_events | 19 | The 16 reviewed identities plus three tenant/app/producer/event-id identities; no duplicate or replacement. |
| corrections | 3 | The two reviewed refunds plus `correction:kpi78-later-refund`, targeting `kpi78-later-purchase`, effective August 21 at 12:00 UTC. |
| attributions | 6 | Exactly fixture 70's six reviewed artifacts; no new install or click exists. |
| cost_records | 3 | Exactly fixture 70's three acquisition-date costs; only the paid campaign-a grain matches these evaluations. |
| metric_definitions | 27 | Fixture 70's three reference and eight D7 definitions, plus 16 explicitly constructed horizon definitions. |
| metric_runs | 32 | Three mature eight-role sets plus one immature D30 set, using the arithmetic above. |
| privacy_requests | 0 | No privacy request. |
| privacy_tombstones | 0 | No privacy transition. |
| fraud_decisions | 0 | No added fraud signal. |
| rejections | 0 | The three new synthetically valid records are admitted. |
| reconciliation | 0 | No external comparison rows or imported installs. |

## Payload and input digests

Hashes use SHA-256 of canonical JSON with UTF-16-sorted keys; all identifiers are
ASCII and numeric JSON values are exact small integers. Payload hashes are
calculated from the declared input payloads, independently of evaluator output.

| New payload | SHA-256 |
| --- | --- |
| kpi78-later-ad | `4be3eebbd417dc519580980f17f200b7c677cc54d03f400a1c1f0f790b94a262` |
| kpi78-later-purchase | `566d3c60bf703198183be12408dada49e638bbaf15f1715d4e4a9455190f8093` |
| kpi78-later-refund | `c2af67ef83109b2a86d14de90e6986b477a1a9babb4842f28642505e3a1ba7a5` |

For each evaluation, include canonical records received no later than its
cutoff; sort by receipt and record ID. Construct
`[received_at, record_id, "available", "policy-v0.1"]` tuples, append the
unchanged campaign-a cost tuple
`["cost", as_of, cost_record_id, report_snapshot_digest, dimension_digest]`,
and hash that array. Wrap this digest as `record_and_cost_snapshot_id` with
the six reviewed `[tenant_id, app_id, attribution_id, SHA256(attribution)]`
tuples in `acquisition_attributions`, then hash the object.

| Set | Canonical records | Snapshot SHA-256 |
| --- | ---: | --- |
| Mature D0, D7 and D30 | 19 | `1a8689653d8321f22c64c5c65002815b40229ba260384fafd3b66be6e292ab9a` |
| Immature D30 | 16 | `f5b226b3d3f71be7b4569913cb170375d61d026ed70856eea0bf3e5d4de15099` |

The immature snapshot equals the reviewed fixture-70 campaign-a snapshot:
future receipts cannot change its evidence. The corresponding ledger positions
are `2026-09-08T00:00:00.000Z|kpi78-later-refund` and
`2026-08-12T00:00:00.000Z|kpi70-refund-b`. Evidence references contain exactly
the included records and selected cost, sorted by ID, all available/protected.
Grouping digests hash the unchanged campaign-a grouping object.

The dated USD identity policy adds August 20/21 entries, both known September 8,
to the reviewed August 6/7 rates. Its canonical digest is
`5baa26b6118818c756c0a0a6208e884ab5a1d468cf037c66dabf572e4c111cc4`.
FX-sensitive artifacts bind this same complete policy, including undefined
ones; installation-count artifacts do not invent money fields. Undefined money
runs omit `value_unscaled`, `currency` and `amount_scale`.

## Focused boundary and SQL cases

`tools/synthetic-acquisition-horizon-cases.ts` contains four shared cases:

1. This fixture: exact D0/D7/D30 scalar values and immature D30.
2. Early synthetic base receipts make D0's one-millisecond-before/exact maturity
   observable. At exact D30 maturity, September 8 receipts are still absent, so
   D30 retains the earlier USD 12 total rather than borrowing its future USD 19.
3. USD 1/2 ads immediately before/at D0's revenue upper bound, and USD 3/4 ads
   immediately before/at D30's bound. Half-open selection yields ad revenue
   D0/D7/D30 = USD 7/9/16, and total net = USD 15/15/25.
4. Removing costs preserves each revenue numerator and maturity state; mature
   cost/CPI/ROAS become `no_attributed_cost`, not zero.

Both reference evaluators matched all 13 independently constructed families and
all four case vectors. The existing SQL parity owner runs the same cases,
compares canonical bytes, and checks that each horizon's eight roles share one
snapshot. Database execution is a CI gate; no live provider or production
financial verification is claimed.
