# Imported provider acquisition: independent derivation

All values are synthetic. Fifteen deliveries contain fourteen canonical records:
one redirector click, one native install, three `synthetic-export` installs,
one `synthetic-second` install, six advertising revenue events and two sessions.
The fifteenth delivery exactly repeats the paid imported revenue event.
The missing external click reference is not a first-party candidate.

The paid/organic/unattributed imported populations each have one installation
and USD 2/3/1 explicitly bound revenue. Another provider has USD 9; the native
install has USD 5. A SDK-reported USD 50 event and SDK session claiming the paid
import installation are excluded from that provider profile. D1 retention is
one; D7 retention is zero. Cost is USD 4 at the paid campaign/network/date grain.

The sixteen scalar outcomes in metric-run ID order are:
`1 / 2000000 / 500000 / 1 / 3000000 / no_attributed_cost / 1 / 1000000 / 3 /
1000000 / 0 / empty_cohort / no_attributed_cost / 0 / 1 / 5000000`.
Thus paid ROAS = 2/4 = 0.5 at ratio scale 6. Missing ad-group context has an
empty population and no allocated cost; an early receipt cutoff counts zero.
The same-named native campaign retains only its own one install and USD 5.
The corrected organic test has two installs and USD 5, so LTV is USD 2.5, not 5.

All thirteen golden families were independently constructed, not saved from an
evaluator. Raw payload digests hash specified JCS payloads. Accepted delivery
and logical templates follow the canonical input, with the repeat delivery
pointing to `revenue-paid-67`. Five attribution templates are respectively
valid Install Referrer, imported organic, imported modeled, imported attributed,
and imported unattributed. Four reconciliation templates use each declared
provider's SHA-256(JCS({provider,type,value})) install/click matching keys,
the canonical install candidate, `matched` and `not_applicable` windows. These
are reported import correspondences, not independently verified external clicks.

Sixteen definition outputs contain the unchanged three defaults, eleven
imported definitions and two native definitions. Sixteen metric runs use the
above arithmetic. Cost is the explicit input artifact. Corrections, privacy
requests/tombstones, fraud decisions and rejections are empty.

For each run, independently hash sorted receipt/record-ID/available/
`synthetic-imported-67` tuples and the selected cost snapshot tuples. Include
USD 4 cost in paid, unfiltered-total, retention, early and native snapshot evidence;
organic/unattributed, missing-detail and early runs cannot use it numerically.
Wrap that digest with selected scoped attribution ID/JCS-digest tuples and,
for imported runs, scoped record/producer/import-context JCS-digest tuples.
The total imported snapshot is
`3b9c96a6f51e93169352c1ae815c45bc6e3521041df7acb26ad25d618eeb6f30`.
No ledger sequence contributes to any digest.

The thirteen manually constructed families match both evaluators at combined
SHA-256(JCS(output))
`b2ee5bdcac34a41c91051a99c249f35c9ec2ad72db8a175338bb932b0133ec6a`.
All previous 66 fixture inputs and 858 golden files are unchanged. Separate
synthetic mutation tests cover provider isolation, missing context, legacy
country refusal, event conflicts, saved revisions/cutoff/ties, privacy, net
exclusion and permutations. Expected files are committed separately from
schema/calculation changes; validation remains read-only.
