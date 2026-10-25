# Verified payer fixture: independent derivation

All values are synthetic. This fixture reuses the seven immutable financial
vectors of fixture 55, with each record in its own server-context batch.
The five purchase/refund records use `adapter:synthetic-verified-store` and the trusted
synthetic server policy `verified-commerce-v1`. Other producer/policy values,
all payloads, receipt/occurrence times, consent-purpose policies and source IDs
are unchanged. This models internal post-verification projections; it does not
prove store verification or use real store evidence.

## Twelve independently calculated values

Definition order below is transaction count, paying installations, payer rate,
ARPPU. The Aug 1 install is the sole cohort member. EUR 8 settled purchase is
USD 10 at the fixed synthetic EUR/USD 1.25 rate. EUR 3.2 settled partial refund
is USD 4. EUR 5.6 ad revenue is independently USD 7 and is excluded. Pending
EUR 50 purchase, reversed EUR 30 purchase and pending EUR 99 refund contribute
neither purchases nor net payer money.

| Evaluation | Cutoff / cohort date | Count / payers / rate / ARPPU unscaled |
| --- | --- | --- |
| `payer73-full` | Aug 10 / Aug 1 | `1`, `1`, `1000000`, `6000000` |
| `payer73-cutoff` | Aug 1 03:00 UTC / Aug 1 | `0`, `0`, `0`, `undefined/no_paying_installations` |
| `payer73-empty` | Aug 10 / July 31 | `0`, `0`, `undefined/empty_cohort`, `undefined/no_paying_installations` |

The occurrence window is install-relative `[0,8 days)`; receipt cutoff is
inclusive. Every evaluation uses current privacy state, with no deletion in
this fixture. Counts use no FX. A present ratio uses scale 6; a present money
run uses USD/scale 6 and the unchanged explicit legacy rate metadata. Undefined
money has no numeric, currency, scale or FX fields. Present state is omitted
as historically permitted; undefined state is explicit.

## Artifact-by-artifact construction

- Raw records: reuse the seven immutable fixture-55 raw artifacts and change
  only the five financial producers. Their payload hashes are unchanged because
  no payload changes. Raw order is record-ID UTF-16 order.
- Logical events: the same seven accepted events, with financial producers and
  `logical:tenant-a:app-a:adapter:synthetic-verified-store:<event_id>` IDs updated and sorted.
- Deliveries, attribution, correction, costs, fraud, privacy requests,
  tombstones, rejections and reconciliation: unchanged fixture-55 artifacts.
  The same settled refund corrects the same purchase. No new authority claim
  changes that old attribution or creates a separate consent decision.
- Definitions: reuse only the three immutable `metric-default` definitions;
  add the four explicitly declared payer definitions, sorted by metric name.
  The bundle's JCS SHA-256 is
  `a9574eb2d767e0fe816b5861f7dd88e885c30aa799b0d0511ce115d6f81e3b52`.
- Metric runs: construct the twelve headers, values and absent-field cases
  from the table above. No evaluator output was copied into an expected file.
  Each snapshot first hashes ordered `[received_at,record_id,"available",server
  policy_digest]` rows. It then hashes
  `{record_and_cost_snapshot_id:<row hash>,acquisition_attributions:<rows>}`.
  Attribution rows are `[tenant_id,app_id,attribution_id,SHA256(JCS(artifact))]`;
  the unchanged install attribution is included only at/after its Aug 10
  decision cutoff. Grouping digest is `SHA256(JCS({cohort_date:<date>}))`.
  The ledger position is the latest included receipt plus record ID. Protected
  evidence references enumerate included records in UTF-16 ref order.

Candidate input was prepared separately; the hand-constructed output families
were compared to independent TS and Python canonical bytes before promotion.
Earlier 72 inputs and 936 golden files are unchanged. Additional shared
synthetic vectors independently specify multiple purchases, two payers in
three installations, multiple partial refunds, exact cancellation, full refund,
client spoof/wrong policy, retry, empty population and missing dated FX.
