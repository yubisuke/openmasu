## Independent dated-FX derivation

All values and names are synthetic. Nine accepted, unique records are one
redirector click, its Android install, six ad-revenue events and one D1 session.
Three cost rows have disjoint country grains. The three unchanged default
definitions plus five existing selected/safe-cost definitions give eight
definition artifacts. Each of two evaluations selects five runs.

The opt-in captured policy is 0.4.22, target USD at scale 6. Source-to-target
coefficients are explicit: EUR August 6 = 1.2, EUR August 7 = 1.5, JPY August 6
= 0.0000005, JPY August 7 = 0.00000075, USD August 6 = 1. These are invented
test coefficients, not market rates or an accounting policy. Every rate names
its synthetic source and as-of timestamp. EUR August 7 becomes known only at
the second evaluation's August 13 watermark.

### Hand arithmetic

Conversion is `half_even(amount_unscaled * rate_unscaled * 10^6 /
10^(amount_scale + rate_scale))` for each event or cost row before summing.

| Input | Target USD micro-units |
| --- | ---: |
| August 6 JPY 1 at 0.0000005 | 0 (even 0.5 tie) |
| August 6 JPY 3 at 0.0000005 | 2 (odd 1.5 tie) |
| August 6 EUR 1 at 1.2 | 1200000 |
| August 6 USD 1 at explicit identity 1 | 1000000 |
| August 7 JPY 2 at 0.00000075 | 2 (1.5 tie) |
| August 7 EUR 1 at 1.5 | 1500000 |
| August 6 JP cost JPY 2 | 1 |
| August 6 FR cost EUR 1 | 1200000 |
| August 6 US cost USD 1 | 1000000 |

D0 revenue is 2200002 and the acquisition-day denominator is 2200001.
Thus D0 ROAS is `half_even(2200002 * 1000000 / 2200001) = 1000000`.
At the later watermark D7 revenue is 3700004. Division by 2200001 gives
integer quotient 1681819 and remainder 518181, below the half-denominator:
the scaled ROAS is 1681819. One install gives D1 LTV 3700004; its one D1
session gives retention 1000000. At the earlier watermark EUR August 7 has no
eligible rate: D7 ROAS and D1 LTV are undefined/missing_fx_rate, never partial
sums. D0, installation count and retention remain present.

In run-ID order the ten results are
`1 / missing_fx_rate / 1000000 / missing_fx_rate / 1000000 /
1 / 3700004 / 1000000 / 1681819 / 1000000`.

### Every output family

Raw records copy only the accepted envelope and append independently hashed
JCS payloads, protected references and the declared no-consent-required policy.
Deliveries are accepted/unique/protected, without future-clock suspicion.
Logical IDs are `logical:tenant-a:app-a:<producer>:<event_id>` in UTF-16 order.
The single final attribution uses the earlier same-scope redirector click and
install, valid Install Referrer, the unchanged default bundle, and August 12
decision/cutoff. Costs copy the three declared rows in cost-ID order; definitions
copy the three historical defaults and five explicitly supplied definitions in
metric-name order. Corrections, privacy requests/tombstones, fraud decisions,
rejections and reconciliation are all empty.

The nine receipt/record-ID/available/policy-v0.1 tuples followed by the three
cost/as-of/ID/report-digest/dimension-digest tuples hash to
`326f24a5acbe53b252048b14528083c66591d69421e95139a6ed6d64c4dbd18a`.
The attribution artifact hashes to
`5927337f049c15b2d6fb1ecfbeb35ef4a16ba611d338e8ef1a73d168c94fd562`.
Wrapping the record/cost digest with its scoped attribution ID/digest tuple
gives selected snapshot
`b8364c5af2f0204e58a7fffffc785a4e92601f5b99ff4dcdd5ce6aef51d98dbb`.
The grouping hashes to
`e67b4c18c833aa486b31267dc9f7e6eee42f53cebed8af8240548f0dcc7c5489`;
the last ledger position is `2026-08-12T00:00:00.000Z|fx69-session`.
The complete canonically ordered policy, not its first rate, hashes to
`ece29c0622ad1120ed890725534f4b8d28475f251c8d806211110ab3dd019381`.
This closed snapshot appears on every FX-sensitive run, including undefined
ones, but not count/retention. No singular rate represents this mixed population.

All thirteen expected families were manually constructed using the above
formulas and accepted-artifact templates, not saved from either evaluator.
TypeScript and independent Python match their combined RFC 8785 digest
`7bf8aeaefbaafe0425f5ee96ea4aca7df156a52c680b31b5bf601e81302df091`.
The 68 previous input files and 884 golden artifacts are unchanged.
