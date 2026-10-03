# Imported provider acquisition cohorts

Imported reports describe what a provider reported. They are not first-party
click proof or independently verified platform attribution. The opt-in
`selected_imported_provider` profile keeps them separate from recorded,
first-party and verified-platform cohorts, even when campaign IDs are equal.

## Definition and calculation

Use `importedAcquisitionMetricDefinitions("synthetic-export")` from
`@openmasu/contracts/definitions` to obtain eleven closed definitions:
`imported_d0_roas`, `imported_d1_roas`, `imported_d3_roas`, `imported_d7_roas`,
`imported_retention_d1`, `imported_retention_d7`,
`imported_cohort_ltv_d0_usd`, `imported_cohort_ltv_d1_usd`,
`imported_cohort_ltv_d3_usd`, `imported_cohort_ltv_d7_usd` and
`imported_cohort_install_count`. The provider is mandatory and captured with
the definition. Definitions bind `metric-imported-provider-acquisition`
version `0.4.20`; wire/package versions and schema URNs remain v0.4/0.4.0.

Supply these definitions to the existing [metric CLI](scheduled-metrics.md)
configuration's `metric_definitions`, choose their names in `evaluations`, and
declare cohort-date and campaign/network/country/status/ad-group filters.
Run `npm run metrics:run -- --date=2026-08-06 --watermark=2026-08-15T00:00:00.000Z --definitions=<synthetic-config.json>`.
An explicit date and receipt watermark permit backfilled synthetic data.
Explicit schedules use the same definitions; automatic campaign discovery
does **not** support this provider profile and fails closed.

Revenue windows are elapsed, half-open `[install, install + (D+1) days)`.
Retention counts distinct explicitly bound imported `session_start` outcomes
on UTC activity day D. Money uses USD at scale 6 with declared FX, rounding
each event half-even before summation. LTV divides by the selected population;
ROAS uses explicit acquisition-day current costs, with no parent-to-ad-group
allocation. An absent denominator remains undefined with its stored reason.
No imported purchase, total-net commerce or aggregate revenue is included.
Gross remains the default; explicit net definitions exclude selected fraud.

## Evidence and isolation

- An accepted canonical install must have `producer=import:<provider>` and
  matching `payload.import_context.provider`. No installation is inferred from
  an external aggregate, click ID or report dimension.
- At the fixed receipt watermark, select an eligible installation-level
  `method=imported`, `model=provider_reported` revision whose scoped references
  include that canonical install. Supersession and decided/cutoff times matter;
  equal-time ties use the highest attribution ID.
- Paid campaign/network/ad-group dimensions come only from declared canonical
  import context. Country comes from its `provider_country`. Organic and
  unattributed rows cannot inherit a paid campaign. Missing context is unknown,
  not a fallback to device or redirector fields.
- Advertising revenue and activity must have the same import producer and an
  explicit same-tenant/app installation binding. SDK, other-provider and
  aggregate outcomes are not joined, even if they claim an equal ID.
- Exact duplicate deliveries cannot add an outcome; conflicting same-event
  corrections are rejected. A retained attribution revision can change a new
  run; it never rewrites the original saved run.

The existing protected install-fact artifact now retains the closed import
context for row and bulk ingestion. Historical facts without it remain unknown;
there is no inferred backfill. Privacy removal excludes the affected anchor or
outcome. Snapshots bind selected attribution ID/artifact hashes and canonical
context hashes as well as retained record/cost inputs, never `ledger_seq`.

## Comparison and limits

Saved JSON/CSV reports capture provider, definition, gross/net, money/FX,
window, dimension policy and revision-selection meaning. Native and imported
definitions, or different providers, are not automatically comparable or
summed. The older external calculation declaration cannot represent this
provider binding and is deliberately not accepted as equivalent.

Cost records do not authenticate provider budget ownership. Operators must
explicitly provide the intended same-grain cost scope; equal campaign names
do not prove equal attribution, equal spend ownership or a causal explanation.
Reported import reconciliation remains a stored classification, not a proof
that an external click exists. This profile adds no provider connection,
device evidence, predictive attribution or live completeness claim.

Fixture 67 and existing contract/SQL/report gates provide synthetic evidence.
See its [independent derivation](../fixtures/v0.4/67-imported-provider-acquisition/README.md)
and the [migration ledger](contract-v0.4-migration.md#imported-provider-acquisition-0420).
