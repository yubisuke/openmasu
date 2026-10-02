# Campaign metrics from native SDK acquisition

A native SDK install reports an Install Referrer click reference, not a trusted
campaign claim. To calculate campaign advertising ROAS, OpenMasu connects the
server's selected first-party click to the installation cohort at the report's
fixed input watermark. It never writes campaign metadata into the original SDK
record or changes an earlier saved report.

## Select an explicit definition

Use the definitions in
[`examples/metrics/synthetic-selected-acquisition.json`](../examples/metrics/synthetic-selected-acquisition.json)
with the existing CLI:

```bash
npm run metrics:run -- --date=2026-08-06 --watermark=2026-08-12T00:00:00.000Z --definitions=examples/metrics/synthetic-selected-acquisition.json
```

The file contains synthetic tenant/app/campaign values. Configure a private
copy for your deployment; never commit live identifiers, inputs, or credentials.
Before evaluating, the same scoped ledger must contain a qualified redirector
click, the SDK install, installation-level ad revenue, and the matching cost
snapshot. The command does not synthesize a conversion or fetch live data.
The same explicit definitions can be supplied to a metric schedule. The CLI
and schedule builder use current (`after`) privacy state for these definitions,
including initial runs, so deleted click semantics cannot regain credit.

These definitions opt into `acquisition_basis=selected_first_party_click`.
The example's D0 ROAS also uses [safe cost selection](cost-selection.md) version
`0.4.12`; its LTV and count retain version `0.4.11`. Each includes its exact
checked-in bundle digest. Definitions without acquisition basis keep historical recorded-dimension
semantics. Existing schedules and saved replay manifests are **not** silently
upgraded. Create a new explicit schedule/definition when changing semantics;
compare or supersede prior runs deliberately.

## What is included

- Native campaign/network come only from the click referenced by the selected
  valid Install Referrer attribution. Imported dimensions keep their existing
  precedence. Country stays install/import evidence.
- Attribution and every referenced record must be visible at the fixed
  watermark. Future/late evidence, unknown or ambiguous clicks, other tenants
  or apps, and unselected candidates cannot supply campaign credit.
- Advertising revenue remains installation-level, deduplicated, per-event
  half-even converted, and limited to the half-open installation window.
- Privacy-after recomputation excludes unavailable source semantics. Snapshot
  identity also binds the selected attribution revisions.
- Saved comparison meaning distinguishes this basis from recorded dimensions;
  matching metric names alone do not prove comparable values.

The advertising family covers D0/D1/D3/D7 ROAS and LTV, D1/D7 retention, and
installation count. The explicit commerce family below extends the same source
selection to purchase-net and total-net. Platform-assigned acquisition, daily
event counts, creative granularity and Apple aggregate metrics are not expanded.
No live provider, real-device or production-delivery evidence is claimed.

Retention joins activity back to the same eligible installation set used for
the denominator, after acquisition grouping and the chosen gross/net policy.
A native install does not need to repeat its selected click's campaign in the
SDK payload. A fraud-excluded installation's session cannot enter a net
retention numerator. D1/D7 remain activity-day metrics, not cumulative event
counts. Fixed receipt cutoffs still exclude later session deliveries.

The reference TypeScript evaluator previously joined retention activity to
the recorded-dimension cohort before these filters, which could undercount a
selected campaign or overcount a net cohort. The correction aligns it with
the Python evaluator and SQL cohort calculation. It changes no definition
identity or stored run; previously exported reference results must not be
treated as corrected simply because the source code was upgraded.

## Purchase, refunds and total revenue

Use the separate
[`synthetic-selected-commerce.json`](../examples/metrics/synthetic-selected-commerce.json)
configuration for a native acquisition cohort with installation-bound commerce:

```bash
npm run metrics:run -- --date=2026-08-06 --watermark=2026-08-12T00:00:00.000Z --definitions=examples/metrics/synthetic-selected-commerce.json
```

This example chooses D30 purchase net, total net revenue, total net LTV and
total net ROAS. The checked-in `SELECTED_COMMERCE_METRIC_DEFINITIONS` also covers
purchase net D0/D1/D3/D7/D90 and total net D90. All use independent version
`0.4.13` and the `metric-selected-commerce` bundle. UTC/USD scale 6 and existing
settled purchase, canonical refund target, refund cap, half-open elapsed window,
and per-event half-even conversion rules stay unchanged. ROAS requires safe
cost selection; overlapping cost grains remain undefined, not zero.

The same ledger must already contain eligible installation-bound purchase and
refund facts. This command does not establish a missing store-to-installation
binding, verify a transaction, or credit an unselected click. Pending/reversed,
unbound and other-installation commerce does not become cohort revenue. Earlier
watermarks exclude later receipts; current-privacy recomputation excludes
removed selected acquisition evidence. Stored comparison context and replay
preserve the explicit family rather than silently upgrading old definitions.

Fixture 60's independent arithmetic is ad revenue 20 + purchase 10 - refund 4
= total net 26, purchase net 6, and one-install LTV 26. Cost 10 gives ROAS 2.6.
The example is entirely synthetic and does not establish live-store coverage.

## Synthetic evidence

Fixture 58 proves one selected installation, USD 20 advertising revenue, USD 10
cost, USD 20 D0 LTV, and ROAS 2 with TypeScript/Python contract parity. Runtime
tests exercise normalized ledger reads and the actual inbox/SDK worker before
SQL calculation. `npm run validate`, `npm run test:metric-parity`, and
`npm run test:integration` cover the respective gates.
Shared synthetic retention cases additionally prove selected-source D1 1/1,
gross 1/2 versus net 0/1 when only the excluded install returns, unchanged
recorded-dimension support, and exclusion of a session beyond the watermark.
The expected values are hand-derived, with full TypeScript/Python artifact
parity and SQL metric-run byte parity; existing fixture goldens are unchanged.
