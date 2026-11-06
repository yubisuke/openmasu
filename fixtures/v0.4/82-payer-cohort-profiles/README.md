# Payer cohort profiles: independent derivation

This fixture uses fixture 73's exact seven source records, server contexts,
fixed EUR/USD 1.25 rate, attribution and correction. No source evidence changes.
Only the definitions and evaluations change: all twelve independent 0.4.35
profiles are evaluated at the August 10 cutoff for the August 1 cohort.

In transaction / payer / rate / ARPPU order:

| Profile | Independently derived unscaled values |
| --- | --- |
| Native fraud-net | `1`, `1`, `1000000`, `6000000` |
| Platform gross | `0`, `0`, `empty_cohort`, `no_paying_installations` |
| Platform fraud-net | `0`, `0`, `empty_cohort`, `no_paying_installations` |

The one native payer bought EUR 8 and refunded EUR 3.2: USD 10 minus USD 4
is USD 6. There is no excluding fraud decision, so native net retains the one
installation. Pending/reversed purchases and advertising revenue do not enter
these operands. No verified platform projection exists; native purchase money
cannot populate either platform series. Undefined values omit numeric money
and FX fields; the undefined ratio retains ratio scale 6.

## All thirteen expected families

Eleven families are unchanged copies of the reviewed fixture 73 artifacts:
raw records, deliveries, logical events, corrections, attributions, costs,
fraud, rejections, reconciliation, privacy requests and tombstones. Admission
and their exact source inputs are unchanged. Definitions retain the three
reference defaults and add the twelve explicit declarations (15 total).

The twelve runs reuse only fixture 73's independently reviewed full-cutoff
header/evidence templates. Their names, definition versions, fraud policy and
registered bundle binding follow the new declarations. The bundle JCS hash is
`d2072d075d3c89f840d182979a0380d5921ef3afc2bcd08ef2fd1bf275a02c26`.
Native snapshot bytes are unchanged. Platform snapshot hashes the same ordered
`[received_at, record_id, available, server policy_digest]` tuple digest and
scoped attribution-ID/artifact-digest rows, adding `platform_acquisition_inputs: []`.
Grouping, fixed cutoff, computed time and last input position are unchanged.

No evaluator output was saved as an expected artifact. These correspondences,
empty-platform populations and hand arithmetic constructed all expected fields;
TS and independent Python candidate bytes were compared before promotion.
All earlier 81 inputs and 1053 golden artifacts remain unchanged.

Shared synthetic cases separately exercise a 3-installation/2-payer native
population with one excluded USD20 payer (gross rate 2/3, ARPPU USD13; net rate
1/2, ARPPU USD6), positive verified-platform populations, platform separation,
full refunds, unverified purchases, missing dated FX and current-privacy replay.
