# Explicit selected-cost coverage

This scenario reuses fixture63's ten immutable synthetic events, attributions,
logical identity, privacy state, fraud state, corrections and metric definitions.
Eleven output families are unchanged relative to that immutable fixture. No
provider response, actual ad identifier or external data is used.

Three independent imported costs all refer to 2026-08-06:

| Cost | As-of | Coverage | Amount |
| --- | --- | --- | --- |
| Creative A | Aug12 | matching_detail_only | USD10 |
| Group A | Aug13 | matching_detail_only | USD15 |
| Campaign | Aug14 | historical full/unspecified | USD30 |

The new coverage field is metadata, not a dimension. Each cost dimension digest
is SHA-256 of the canonical object containing its present network/campaign/group/
creative/country fields. Its report digest hashes the synthetic source label and
explicit record identifier. No existing fixture or metric definition is changed.

Independent recorded outcomes are: A has one install, USD20 advertising revenue
and USD6 purchase net; B has one install, USD40 advertising revenue and USD12
purchase net. Campaign ad revenue is 60, purchase net is 18, total net is 78,
and ad LTV is 60/2 = 30.

| Evaluation | Installs | Ad LTV | Purchase net | Total-net ROAS | Ad ROAS |
| --- | --- | --- | --- | --- | --- |
| A creative, Aug12 | 1 | 20 | 6 | 26/10 = 2.6 | 20/10 = 2 |
| B creative, Aug12 | 1 | 40 | 12 | undefined | undefined |
| Campaign, Aug12 | 2 | 30 | 18 | undefined | undefined |
| Group A, Aug12 | 1 | 20 | 6 | undefined | undefined |
| Group A, Aug13 | 1 | 20 | 6 | 26/15 = 1.733333 | 20/15 = 1.333333 |
| Campaign, Aug14 | 2 | 30 | 18 | 78/30 = 2.6 | 60/30 = 2 |
| A creative with parent, Aug14 | 1 | 20 | 6 | 26/10 = 2.6 | 20/10 = 2 |

Money and ratios use scale6. Group ratios are rounded half-even from exact
integers. Undefined values omit value_unscaled and retain no_attributed_cost.
A selected creative is not an ad-group rollup; selected child spend cannot
become campaign or sibling spend. The later full parent remains independently
eligible for its own grain and is not added to either selected child.

All35 run headers start from immutable fixture63 policy/type declarations,
with explicit new run IDs, dates and grouping digests. Snapshot rows concatenate
the ten recorded (receipt,record,available,policy) tuples and only the cost IDs
named in each row above, sorted by as-of/identifier. The snapshot root then hashes
that list and immutable selected-attribution proof tuples. Evidence references
contain exactly the ten record references and the eligible costs, in canonical
reference order. The input ledger position remains the last event receipt/ID,
not a database sequence or a cost receipt. Counts, strings, FX metadata, empty
families and every digest are constructed independently from these inputs.

Candidate TypeScript and independent Python matched all13 manually constructed
families and35 runs before promotion. Evaluator outputs were not copied into
expected files. The complete change inventory is this new input and13 expected
files; all earlier73 inputs and949 goldens are unchanged.

