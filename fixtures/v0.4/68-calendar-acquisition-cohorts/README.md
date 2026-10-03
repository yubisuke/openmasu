# Calendar cohorts: independent derivation

All inputs are synthetic. One first-party, one server-decrypted platform and
one explicitly imported installation occur at August 6 23:59 UTC. Their
campaign/network namespaces differ. Forty accepted records comprise one click,
three installs, 27 advertising outcomes and nine sessions. No population is
inferred from an aggregate. The receipt is August 16 midnight; all runs fix
August 17 midnight as the receipt watermark. Nine explicit same-zone USD 2
acquisition-day costs cover the three populations and three qualified zones.

Per installation, revenue is USD 100 one minute before installation, then
USD 1/2/4/8 at August 7 00:00/04:00/15:00/23:58 UTC, then USD 16/32/64/128
at August 14 00:00/04:00/15:00/23:59 UTC. The pre-install USD100 is always
excluded. The last USD128 is exactly the elapsed D7 exclusive end.

The independent local-date memberships and arithmetic are:

| Zone | Cohort date | D0 revenue | D1 / D3 revenue | D7 revenue | D7 exclusive end (UTC) | D1 / D7 retention |
| --- | --- | ---: | ---: | ---: | --- | --- |
| UTC | August 6 | 0 | 15 | 15 | August 14 00:00 | 1 / 0 |
| Asia/Tokyo | August 7 | 1+2=3 | 1+2+4+8=15 | 1+2+4+8+16+32=63 | August 14 15:00 | 1 / 1 |
| America/New_York | August 6 | 1 | 1+2+4+8=15 | 1+2+4+8+16=31 | August 14 04:00 | 1 / 1 |

Each cohort has one installation. Money is the listed sum times 1,000,000;
LTV divides by one, and ROAS divides by the explicit USD2 denominator at ratio
scale 6. Sessions at August 7 00:00 and August 8 03:59 supply D1 membership;
August 14 00:00 supplies Tokyo/New York D7, but not UTC D7. Distinct-install
retention never adds multiple sessions. Historical elapsed native D7 LTV is
USD127 and D7 retention is one. These two controls make the meaning difference
visible without editing any earlier definition or golden.

All thirteen golden families were constructed independently, not saved from
either evaluator. The raw/delivery/logical templates project the declared
accepted records; SHA-256(JCS(payload)) supplies each raw digest. Three
attribution templates follow fixtures 67/66's first-party, verified Meta and
imported reported evidence, with new IDs and receipt/effective times. The single
reported import reconciliation hashes its synthetic provider install/click
references using the declared matching-key type and provider; it does not invent
an independently observed external click. Cost artifacts equal the nine declared
inputs, with `reporting_time_zone` in each dimension hash. Correction, privacy,
fraud and rejection families are empty. Definitions contain the unchanged three
defaults, 99 explicit calendar definitions and two elapsed controls: 104 total.
There are 101 runs.

For each run, hash the forty receipt/record-ID/available/`synthetic-calendar-68`
tuples, sorted by receipt and ID, followed by its matching same-zone cost tuple.
The elapsed controls retain both matching same-date native cost tuples in their
snapshot, although LTV/retention do not numerically use cost. Wrap this record/cost
digest with ordered scoped attribution-ID/JCS-artifact hashes. The native wrapper
contains all three eligible installation attributions; the platform wrapper
contains the two native attributions and the canonical platform proof hash;
the imported wrapper contains only its provider attribution and canonical import
context hash. Hash each declared grouping separately. The last input position is
`2026-08-16T00:00:00.000Z|session-68-native-2`; no ledger sequence contributes.
Money runs retain the independently hashed declared FX rate snapshot.

Both evaluator candidates matched these thirteen-family JCS bytes at SHA-256
`84800e44dcd47d150e7234d08078fb08206b7573dd706c60850ef82a66ff95d2`.
Existing 67 inputs and 871 golden files remain unchanged. Expected files are
committed separately from calculation/schema changes; validation is read-only.

Shared cases additionally specify local midnight ends by hand for New York's
23-hour spring day and 25-hour fall day, a repeated fall 01:30 hour with only one
active installation, and month rollover. USD1 at day start plus USD2 at the last
millisecond is USD3; USD4 exactly at the exclusive end and pre-install USD100
are excluded. LTV/ROAS/retention are 3000000/1500000/1000000. Other cases cover
missing/different cost zones, permutations and one late USD1 per population.
