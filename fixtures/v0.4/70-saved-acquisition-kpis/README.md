# Independent saved acquisition KPI derivation

All inputs are invented. Two redirector clicks select campaigns `kpi70-a` and
`kpi70-b`; their three and two installs have valid first-party Install Referrers.
One additional install has no referrer and stays organic. Three ad-revenue
events, three settled purchases and two anchored, explicit-target refunds give
16 unique accepted records. No install exists for `kpi70-cost-only`.

The opt-in eight-definition profile is version 0.4.23, bundle
`metric-acquisition-kpis`, hash
`950d30940ef4bee257dfcd8e10e47dccec422dad4fc15d6d15f658d0fb7a04c2`.
It uses UTC install dates and the complete elapsed D7 revenue window; costs
are current, disjoint acquisition-date grains at the same saved cutoff.
The August 16 cutoff exceeds the conservative August 15 window end. Explicit
synthetic USD identity rates for August 6 and 7 are known on August 12.
Amounts use USD micro-units and ratios use scale 6; conversion and division
use exact half-even arithmetic, not floating-point or screen-side calculation.

## Hand arithmetic

| Population | Installs | Cost USD | CPI USD | Ad revenue USD | Purchase net USD | Total net USD | Ad ROAS | Total net ROAS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Campaign a | 3 | 10 | 3.333333 | 6 | 8 - 2 = 6 | 12 | 0.6 | 1.2 |
| Campaign b | 2 | 4 | 2 | 4 | 3 - 1 = 2 | 6 | 1 | 1.5 |
| Organic | 1 | undefined | undefined | 1 | 2 | 3 | undefined | undefined |
| Cost-only campaign | 0 | 2 | undefined | 0 | 0 | 0 | 0 | 0 |

Campaign a CPI is `half_even(10000000 / 3) = 3333333`; the remainder 1
is below half of 3. Campaign b CPI is `4000000 / 2 = 2000000`.
Revenue/cost ratios multiply the numerator by 1000000 before division.
Organic cost, CPI and ROAS are `no_attributed_cost`, not a fake zero price.
Cost-only CPI is `empty_cohort`, while its known positive cost and zero revenue
give a valid zero ROAS. A recorded zero cost gives a present zero cost/CPI
when installs exist, but an undefined ROAS denominator. Missing cost is not
the same observation. Ad revenue and settled purchase net are never confused.

## Every output family

Raw/delivery/logical envelopes follow the independently reviewed fixture-69
admission templates, with each JCS payload digest independently hashed. All
16 records are accepted/unique/protected, available and on-time. IDs remain
in UTF-16 order. The two refunds each emit an explicit-target correction.
Six final attribution artifacts use the unchanged default bundle: five
valid-referrer decisions and one organic `no_referrer` decision. Cost artifacts
copy three declared USD rows. Metric definitions copy three historical
defaults plus eight supplied definitions (11 total). Four evaluations each
select eight runs (32 total). Privacy requests/tombstones, fraud decisions,
rejections and reconciliation are empty.

Each input snapshot hashes the 16 receipt/ID/available/policy tuples followed
by that population's cost/as-of/ID/report-digest/dimension-digest tuples, then
wraps that record/cost digest with all six scoped attribution ID/digest tuples.
All eight metrics of one population share this snapshot. Protected references
are exactly those records and selected costs. FX-sensitive runs, including
undefined ones, capture the complete identity policy; the installation count
does not need FX in its artifact. Runtime saved comparison contexts still bind
every role to the same FX policy, definition, cutoff and privacy/fraud mode.

All 13 expected files were hand-constructed from these templates, identities
and arithmetic, not copied from an evaluator or SQL output. Candidate
TypeScript and independent Python bytes matched their combined RFC 8785
SHA-256 `15df48518a3316738114f7c451bc17feae192e5c75a89f04d11c44b9468176cf`.
The previous 69 inputs and 897 golden output files are unchanged.
