# Verified platform acquisition: independent derivation

Eight distinct, on-time synthetic records produce eight accepted deliveries and
logical events, three initial installation attributions, and no rejection,
fraud, correction, deletion or reconciliation artifact. The Meta context is a
server-decrypted canonical install and wins over its valid first-party click.
Two trusted server lookup projections supply a negative Apple response and a
later successful Apple attribution revision; they do not rewrite the original
attribution artifacts.

Meta has one install, one D1 session and USD 2 advertising revenue. Against
USD 1 campaign cost, D1 retention is 1, LTV is USD 2, and ROAS is 2.0. Apple
has one install, one D1 session and USD 5 revenue: before the delayed lookup
its selected platform cohort is empty; afterwards retention is 1, LTV is
USD 5, and ROAS against USD 10 cost is 0.5. The negative Apple response
forms one unattributed install without claiming organic certainty. The Meta
ad-group has no explicit cost, so ROAS is undefined/no_attributed_cost, not
a share of its parent cost. Meta priority leaves the original first-party
campaign cohort at zero.

All money uses USD scale 6 and the exact synthetic rate 1; there is no rounding
ambiguity. Empty-cohort retention/LTV are undefined. Early Apple ROAS is zero
against the explicit campaign cost, preserving the existing arithmetic.

The 13 expected families were constructed from these values and the declared
artifact fields without importing either evaluator or SQL. Record payload,
grouping, cost and snapshot digests are independently SHA-256 over JCS. The
snapshot includes the selected attribution tuples and trusted context tuples;
the late revision appears only at the later cutoff. TypeScript and independent
Python matched all 13 families at JCS output digest
`5a97c353d0479a9fd0b288dcb269f493869cb744277698abd3c752911ea0491a`
before promotion. Earlier 65 fixtures and their 845 goldens are unchanged.

