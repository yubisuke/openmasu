# Separate-basis acquisition KPI sets

This synthetic fixture exercises the eight saved D7 acquisition KPI roles for
`selected_imported_provider` and `selected_verified_platform`. Neither basis
borrows first-party attribution or changes existing definitions. The imported
provider is the fictional `synthetic-export`. Wire version remains `0.4.0`.

## Evidence and independent arithmetic

The 15 input deliveries from reviewed fixture 67 are unchanged. Its retry is
still a duplicate, leaving 14 canonical records. Two additional deliveries from
`import:synthetic-export` refer to `installation:paid-67`:

- `purchase-77`: settled USD 8, occurred August 6 at 13:00 UTC.
- `refund-77`: settled USD 3, occurred August 7 at 12:00 UTC, explicitly corrects
  `purchase-77` and references its transaction.

Both receipts are August 14 at 00:00 UTC, like the original records. There are
17 accepted deliveries, 16 canonical raw records and 16 logical events. All
evaluations use the August 15 at 00:00 UTC receipt cutoff, beyond the August 6
cohort's D7 observation window. The USD identity rate and four-dollar cost row
are unchanged from fixture 67. All money and ratio scales are six.

| Evaluation | Installs | Cost | CPI | Ad revenue | Purchase net | Total net | Ad ROAS | Total ROAS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Imported paid | 1 | 4 | 4 | 2 | 5 | 7 | 0.5 | 1.75 |
| Imported organic | 1 | absent | absent | 3 | 0 | 3 | absent | absent |
| Imported unattributed | 1 | absent | absent | 1 | 0 | 1 | absent | absent |
| Imported missing campaign | 0 | absent | undefined | 0 | 0 | 0 | absent | absent |
| Verified platform, same paid grouping | 0 | 4 | undefined | 0 | 0 | 0 | 0 | 0 |

For the paid imported set: `8 - 3 = 5` purchase net, `2 + 5 = 7` total net,
`4 / 1 = 4` CPI, `2 / 4 = 0.5` ad ROAS, and `7 / 4 = 1.75` total ROAS.
Thus its eight unscaled values are respectively
`1, 4000000, 4000000, 2000000, 5000000, 7000000, 500000, 1750000`.
No rounding tie occurs. Count values are integers, not money micros.

An absent cost or ROAS has `value_state: undefined` and
`undefined_reason: no_attributed_cost`; an empty cohort's CPI has reason
`empty_cohort`. Undefined runs omit money values and currency fields. A matching
cost row is not evidence of a verified platform installation: the platform set
has zero installs and zero revenue, four dollars of reported cost, undefined
CPI, and two present zero ROAS values. Organic and unattributed remain distinct.

The nine-dollar ad revenue from a different provider, the native installation's
five-dollar ad revenue, and the SDK's fifty-dollar claim against the imported
installation do not contribute to the imported paid set. The exact same receipt
cutoff, snapshot, grouping, definitions and bundle apply across its eight roles.

## All 13 independently derived expected families

Expected files were assembled before evaluating the candidate. Evaluator output
was used only for comparison, never copied into expected files.

| Family | Count | Derivation |
| --- | ---: | --- |
| raw_records | 16 | Fixture 67's 14 rows unchanged; add two admitted import envelopes, protected payload references, and independently calculated payload SHA-256 values. |
| deliveries | 17 | Fixture 67's 15 rows unchanged; add two unique accepted deliveries with the same consent-not-required policy. The original retry remains a duplicate. |
| logical_events | 16 | Fixture 67's 14 rows unchanged; add purchase/refund identities under the exact tenant/app/producer/event-id tuple. |
| corrections | 1 | `correction:refund-77` corrects `purchase-77`, reason `refund`, effective at the refund's occurrence time. |
| attributions | 5 | Exact reviewed fixture 67 artifacts. Commerce creates no new install attribution. |
| reconciliation | 4 | Exact reviewed fixture 67 provider reconciliation artifacts. No new imported install or external matching key is introduced. |
| cost_records | 1 | Exact reviewed fixture 67 cost artifact; no inferred cost source or duplicate denominator. |
| metric_definitions | 19 | Three unchanged reference definitions plus independently declared eight-role definitions for each new basis. See the operation table below. |
| metric_runs | 40 | Five evaluations times eight roles, using the arithmetic and snapshot construction below. |
| fraud_decisions | 0 | No new fraud signal; fixture 67's empty array remains empty. |
| rejections | 0 | All original and new payloads satisfy admission. |
| privacy_requests | 0 | No request is supplied. |
| privacy_tombstones | 0 | No privacy transition occurs. |

Definition names are `{imported,platform}_acquisition_d7_<role>`, version
`0.4.30`. Each uses an elapsed D7 window, UTC, the five declared acquisition
grouping dimensions, and `reject_overlapping_grains` cost selection. Only
imported definitions declare `import_provider: synthetic-export`.

| Role | Calculation | Numerator | Value type | Denominator |
| --- | --- | --- | --- | --- |
| installs | cohort_size | cohort_size | count | none |
| cost | cost_sum | cost | money | none |
| cpi | cost_over_cohort | cost | money | cohort_size |
| ad_revenue | revenue_sum | revenue | money | none |
| purchase_net | revenue_sum | purchase_net_revenue | money | none |
| total_net | revenue_sum | total_net_revenue | money | none |
| ad_roas | revenue_over_cost | revenue | ratio | cost |
| total_roas | revenue_over_cost | total_net_revenue | ratio | cost |

Cost/CPI/ROAS use the `cohort_acquisition_day_current_snapshot` cost basis.
The bundle is `metric-basis-acquisition-kpis`, version `0.4.30`, hash
`bbf1ff5c2a48479fb5eb593334a0f71f693ae351be58f41b8a1a2a4457ce54b8`.

## Independent digest construction

Hashes below use SHA-256 of canonical JSON, with UTF-16-sorted object keys. All
strings here are ASCII; JSON numbers remain exact small integers. Digest
construction uses reviewed fixture 67 artifacts and the two declared new
payloads, not computed evaluator artifacts.

| Payload | SHA-256 |
| --- | --- |
| purchase-77 | `c5dc157990935b2a33c33fec8f2585393d0751942879f87a9c93df843d9e4a85` |
| refund-77 | `e08d354ff699ae636e41771e90e637c23304d83ab4254552259e4a12cc3351ed` |

1. Sort the 16 canonical records by receipt and record ID. Emit tuples
   `[received_at, record_id, "available", "synthetic-imported-67"]`.
2. For paid imported and platform-empty evaluations append the unchanged cost
   tuple `["cost", as_of, cost_record_id, report_snapshot_digest,
   dimension_digest]`. Other evaluations have no matching cost tuple.
3. Hash these record/cost tuples as `record_and_cost_snapshot_id`.
4. For imported runs, append selected attribution tuples
   `[tenant_id, app_id, attribution_id, SHA256(attribution)]` for
   `attr:organic-67`, `attr:paid-67`, `attr:unknown-67`, plus imported-context
   tuples `[tenant_id, app_id, record_id, producer, SHA256(import_context)]`
   for the corresponding three installs. Hash the object containing the base
   digest, `acquisition_attributions`, and `imported_acquisition_contexts`.
5. For the platform-empty runs, the existing selection snapshot includes the
   native install's selected `attr:native-67` tuple and an empty
   `platform_acquisition_inputs` array. The native attribution has no verified
   platform proof, so it establishes neither a platform install nor revenue.
   Snapshot provenance and eligible cohort membership are different concepts.
6. Grouping digests hash the literal grouping objects. Evidence references are
   the 16 canonical record IDs plus the selected cost ID, sorted by ID; all are
   available/protected. The ledger position is
   `2026-08-14T00:00:00.000Z|unknown-67`, never a sequence number.

| Evaluation | Input snapshot SHA-256 |
| --- | --- |
| kpi77-paid | `9b63b47c4bbe5fb4f828e7737e14edb3c42633dfb712d6e049c8ed471c1adde6` |
| kpi77-organic, kpi77-unattributed, kpi77-empty | `75f579f6ef25bb6b90c9ef1cced505f6e393d3d45ded8e389f4ac96d77788284` |
| kpi77-platform-empty | `20bfde7993d1df7dba69ab7680172c88ce9f23ba619d8351d66fdbd6cbf298e7` |

## Focused runtime cases

`tools/synthetic-basis-acquisition-kpi-cases.ts` adds independent scalar oracles
for other-provider commerce, native commerce, a foreign refund, missing and zero
cost, and nonempty verified-platform cohorts from reviewed fixture 66. The last
case retains fixture 66's actual protected platform proofs: its two separate
source-local sets have respectively `(installs, cost, ad revenue) = (1, 1, 2)`
and `(1, 10, 5)` dollars, no commerce, and ROAS `2` and `0.5`. Their cutoff is
October 7, after both September 28 D7 windows. No provider connection is made.

The TS and Python evaluators are compared against all 13 independent files and
the seven scalar cases. SQL tests reuse these cases, check canonical-byte
parity, and assert one snapshot/cutoff across every eight-role set. Database
execution remains a runtime CI gate, not a claim of real-provider validation.
