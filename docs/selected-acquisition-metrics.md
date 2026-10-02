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

The checked-in definitions cover D0/D1/D3/D7 ad-revenue ROAS and LTV, D1/D7
retention, and installation count. Purchase-net/total-net definitions, platform
assigned acquisition, daily event counts, creative granularity, and Apple
aggregate metrics are not expanded by this change. No live provider, real-device,
or production-delivery evidence is claimed.

## Synthetic evidence

Fixture 58 proves one selected installation, USD 20 advertising revenue, USD 10
cost, USD 20 D0 LTV, and ROAS 2 with TypeScript/Python contract parity. Runtime
tests exercise normalized ledger reads and the actual inbox/SDK worker before
SQL calculation. `npm run validate`, `npm run test:metric-parity`, and
`npm run test:integration` cover the respective gates.
