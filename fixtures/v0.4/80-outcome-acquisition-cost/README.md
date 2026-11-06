# Independent outcome acquisition-cost derivation

All data is synthetic. Fixture 70's sixteen accepted records, six native
attributions, three costs and two refund corrections remain identical. This
fixture adds five custom events, two verified settled purchase transactions on
one installation, and one later delivery retry. No evaluator output was used as
the source of the expected files.

In paid campaign A, two matching events on installation A0 and one on A1 yield
two converted installations, not three events. A2's different key and the event
at its exact D8 boundary do not qualify. Two verified purchases on A0 yield one
paying installation; existing client-claimed purchases do not qualify. Cost is
USD 10, so the two scale-6 results are `10000000 / 2 = 5000000` and
`10000000 / 1 = 10000000`. The later identical delivery is not another logical
event. Receipt order, then record ID, chooses its original canonical record.

| Evaluation | Converter cost | Payer cost | Saved denominators / cost |
| --- | --- | --- | --- |
| A, mature | 5000000 | 10000000 | 2 / 1; cost 10000000 |
| B, mature | no_converted_installations | no_paying_installations | 0 / 0; cost 4000000 |
| Cost only | empty_cohort | empty_cohort | 0 / 0; cost 2000000 |
| Organic | no_attributed_cost | no_attributed_cost | 0 / 0; cost absent |
| A, Aug 14 cutoff | observation_window_not_elapsed | observation_window_not_elapsed | operands absent |

The August 6 daily cohort closes August 15 UTC, since the last possible install
on August 6 has an eight-day elapsed observation window. Maturity is not an
assertion of upstream completeness. The mature receipt cutoff is August 16.

## All thirteen expected families

- Raw records and logical events: 23 each; seven additions reuse reviewed
  admission shapes. Each payload digest is independently `SHA-256(JCS(payload))`.
- Deliveries: 24, including one `duplicate_delivery` referencing the original.
- Attributions: six, byte-identical to fixture 70.
- Costs: three, byte-identical to fixture 70; selected by the explicit group.
- Corrections: two existing refund corrections, byte-identical to fixture 70.
- Definitions: three unchanged defaults plus two closed `0.4.33` definitions.
- Runs: ten, with the hand-derived values above. Record snapshot rows are sorted
  `(received_at, record_id, lifecycle_status, server policy_digest)`. Append
  selected cost rows `(cost, as_of, cost_record_id, report_snapshot_digest,
  dimension_digest)`, then hash JCS. Bind that hash to sorted attribution proof
  rows `(tenant_id, app_id, attribution_id, SHA-256(JCS(attribution)))` and hash
  again. Evidence is sorted by reference; grouping digest hashes exact dimensions.
  Ledger position is recorded but not included as an independent digest input.
- Privacy requests, tombstones, fraud, rejections and reconciliation: empty;
  no corresponding input exists.

All independently constructed families match TypeScript and Python at combined
JCS SHA-256 `9db80bf08db3c948911072a2923a3f31cf7457dacc24111459fc2d05bf28cba7`.
Previous 79 inputs and 1027 expected files are untouched. The shared mutation
vectors additionally test zero cost, missing cost/rate, overlap, exact-key
selection, receipt cutoff, verification authority and a half-even quotient tie.
