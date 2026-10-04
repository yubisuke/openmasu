# Standard retained-installation horizons

The opt-in `metric-standard-retention` / `0.4.24` definitions add D3, D14 and
D30 to saved acquisition cohorts. They reuse the current installation selection,
session projection, SQL worker, privacy fence and gross/net fraud populations.
They do not add a new calculation engine or change historical D1/D7 definitions.
An installation is not a unique person: reinstallations and different devices
are not deduplicated into people. Uninstall and cross-device return inference
are not provided.

## Meaning and maturity

- The denominator is the same eligible installation set used by the selected
  acquisition basis at the saved received-evidence watermark.
- An installation contributes at most once to the numerator, regardless of
  how many accepted `session_start` events it has on the activity day.
- Dn is the elapsed, half-open interval `[install + n*24h, install + (n+1)*24h)`.
  This is not local-calendar retention or cumulative return by day n.
- `retention_maturity_policy=complete_activity_window` requires an explicit UTC
  `cohort_date`. Its conservative end is that date's midnight plus `n+2` days:
  the cohort's exclusive date end, followed by the complete activity window.
  At a watermark strictly before that end, the saved value is
  `undefined / observation_window_not_elapsed`, without `value_unscaled`.
- At or after the end, a nonempty cohort with no visible activity is genuinely
  zero; an empty cohort stays `undefined / empty_cohort`. Temporal maturity is
  not a guarantee that a provider has finished delivery. Late receipts require
  an explicit saved-run correction; existing results are never rewritten.

First-party, verified-platform and explicitly named imported-provider bases
remain independent. Imported sessions must come from the same import producer
and bind an explicit eligible installation. Device campaign text, matching
campaign strings and Apple aggregate postbacks cannot supply that binding.
`net` excludes the same fraud-filtered installations from numerator and
denominator; deletion-aware runs use current lawful evidence without reviving
redacted payloads.

## Schedule without new infrastructure

Log into the dashboard with an authorized administrator key, open the app's
metric schedules and use **Schedule D3 / D14 / D30 retention**. Select activity
days, acquisition basis and gross or net. Supply a synthetic provider code only
for the imported basis. The form submits the same complete request accepted by
the existing admin API, under the same CSRF, tenant and role boundary.

The minimum `lag_days` is the largest selected activity day plus two: D3 = 5,
D14 = 16, D30 = 32. The form defaults to 32. Shorter lag or `metric_date`-based
scheduling is rejected; the worker does not manufacture a premature value.
Each app still has one active schedule owner per metric name. Disable or use
the explicit replacement workflow when changing an existing owner.

For an advanced API/CLI definition, import
`standardRetentionMetricDefinitions(basis, provider?)` from
`@openmasu/contracts/definitions`. It returns only the three registered horizons.
The native names are `retention_d3`, `retention_d14`, `retention_d30`;
platform and imported names have `platform_` / `imported_` prefixes. Defaults
are gross. Select the desired definitions, declare `fraud_policy` explicitly if
needed, and use the existing [metric schedule](scheduled-metrics.md) or
`npm run metrics:run` input envelope. A manual run must supply `cohort_date`;
the saved watermark, not the wall clock or occurrence timestamp, gates maturity.

## Read and compare

The existing retention matrix uses saved definition meaning, not name guessing,
and aligns D3/D14/D30 without mixing acquisition bases, providers, privacy/fraud
populations, bundle hashes or cutoffs. JSON omits an immature number; CSV leaves
its value cell empty and keeps the reason; HTML shows an em dash and the reason;
charts have a gap. A missing saved run remains missing, not zero. Comparison
context and replay preserve the explicit maturity policy and conservative end.

Synthetic evidence is fixture 71 and the shared retention cases in the existing
contract/SQL suites: both boundaries, repeated sessions, excluded installs,
delayed receipt and explicit correction, maturity cutoffs, privacy removal and
separate platform/imported populations. No live-provider completeness, real
device delivery or human-level uniqueness is established.
