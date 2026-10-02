# Explain a saved ROAS result

Select an application in the dashboard and follow **Saved run details** beside
a metric value. The detail page shows the run's definition version, grouping,
watermark, input snapshot, rule bundle, result and revision relationship.

For newly computed installation-anchored, elapsed-window **ad-revenue ROAS**
and the existing **D30 total-net ROAS** (`d30_total_net_roas`),
the page also shows the recorded numerator and denominator, currency/scales,
conversion rates, rounding rules, selected input counts and window boundaries.
Other calculations and older runs retain provenance but show `not_recorded`
for unavailable calculation evidence. Missing operands never become zero.

## What is saved

The existing cohort SQL query returns the same revenue and cost operands it uses
to calculate the ratio. Each accepted ad-revenue event is converted and rounded
half-even before summation. One latest acquisition-day cost row per cost key is
selected at the run watermark; scaling down rounds each selected cost row
half-even. The final ratio is half-even rounded at the definition's ratio scale.
An actual zero cost denominator produces `undefined / no_attributed_cost`.

D30 total-net evidence uses version 2: advertising revenue plus settled
purchase revenue minus settled refund deductions, divided by the selected
cost. Each component is read from the same SQL aggregates used for the result.
Purchases and refunds are independently converted and half-even rounded before
summation, using their own occurrence times inside the half-open window.
Refund deductions are positive operands in the subtraction, not negative inputs.
The evidence includes the accepted ad-event, settled-purchase and settled-refund
counts, selected cost count and eligible cohort size. It is not entitlement,
tax, payout or provider-verification evidence.

Synthetic advertising 100 + purchases 80 - refunds 20 gives numerator 160;
against cost 100 the ratio is 1.6. Two EUR ad events of `100000001`, a EUR
purchase of `160000001`, and a EUR refund of `40000001` (all scale 6), converted
at 0.5, produce the same USD components 100, 80 and 20 after per-event half-even
rounding. Summing unrounded values first would change the numerator and is not
the calculation being explained.

Version 1 ad-revenue evidence remains readable and unchanged. Version 2 is
limited to D30 total-net ROAS, with either its recorded-dimension or explicit
selected-acquisition definition. D90 total-net, purchase-net-only metrics and
other unsupported series retain `not_recorded`. Overlapping cost grains refuse
the metric calculation; they are not presented as a known zero denominator.

These aggregates are inserted into `ledger.metric_calculation_evidence` in the
same transaction as the metric run and its replay manifest. The evidence is
append-only and binds to the run ID, input snapshot and definition version.
It includes a definition digest, cost-selection digest and FX snapshot digest.
No second calculation engine or HTTP-time recalculation is used.

For example, three synthetic EUR inputs of `100000001` at scale 6 converted
at rate 0.5 each round to USD `50000000`. Their numerator is `150000000`, not
the result of rounding the combined EUR total. With USD `100000000` of selected
cost, the stored ratio is `1500000` at scale 6, displayed as **1.5 ×**.

The selected event count excludes duplicate deliveries because the engine reads
accepted logical facts. Aggregate provider revenue is not an installation-level
numerator. Counts are the inputs the existing engine actually selected; detailed
exclusion reasons were not saved and are not reconstructed afterward.

## History, windows and unavailable evidence

A later cost correction creates a replacement run with its own evidence. The
earlier run keeps its original operands and result. Its detail page marks it
superseded; it never substitutes today's cost or inputs into the old explanation.

Elapsed revenue windows are half-open: `[install time, install time + (day + 1) days)`.
The last selected installation's window end is recorded. `open` means that end
is after the run watermark; `elapsed` means the watermark reached it. Neither
state proves every delayed event has arrived. An empty cohort is explicit.

If a source record has since been redacted, the API returns `redaction_affected`
and withholds the operand evidence. Purged or missing sources return
`retention_affected` unless a privacy request explains the removal. The saved
run's aggregate result and safe provenance remain visible under existing contract
policy. Restored backups use the same lifecycle checks after privacy reapplication.
Evidence missing from a legacy or unsupported run is `not_recorded`; mismatched
binding is `binding_mismatch`. None of these states triggers a new calculation.

## HTTP access and role boundary

`GET /v1/admin/apps/<app-id>/metrics/<encoded-metric-run-id>/explanation`
uses an administrator bearer key with read capability. The dashboard URL is
`/dashboard/apps/<app-id>/metrics/<encoded-metric-run-id>/explanation` and uses
the dashboard session. URL-encode the entire run ID as one path segment.

Both paths validate app ownership and use the reader database role. Cross-app,
cross-tenant and unknown runs cannot be returned. JSON contains a closed
aggregate projection: no source event/installation IDs, protected evidence
references, raw payload, input ledger position or provider private reference.
Private replay manifests remain inaccessible to the reader role. The response
uses the existing no-store policy and the HTML has the existing dashboard CSP.

Apply migration `052_metric_calculation_evidence.sql` with `npm run db:migrate`.
It creates only the evidence table, tenant RLS, append-only enforcement and role
grants. It does not backfill old explanations or change metric-run contract
artifacts, schemas, evaluators or golden fixtures.

Migration `060_total_net_calculation_evidence.sql` additionally permits the
version 2 evidence envelope alongside version 1. Existing rows, run artifacts,
RLS, role grants and append-only enforcement are retained; no backfill occurs.
Deploy this migration before a worker capable of writing version 2 evidence.

The SQL parity gate covers exact operands, per-event rounding, one current cost
row, duplicate deliveries, undefined cost, cost history, missing evidence,
privacy removal, determinism and reader tenant/app isolation. D30 total-net
cases add component arithmetic, settled-event counts, duplicate delivery,
per-event FX ties, late refunds and cost revisions with immutable prior evidence.
Existing HTTP and
role tests cover the new paths. All inputs are synthetic.
