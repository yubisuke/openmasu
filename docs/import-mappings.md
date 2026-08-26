# Import Mapping DSL

Runtime import mappings are schema-validated JSON documents. Public files under `examples/mappings/` contain synthetic values only; deployment-specific provider column names and certification evidence remain private.

## Provider-neutral compatibility report

Evaluate a measurement export before opening a database connection or writing any ledger state:

```bash
npm run import:compatibility -- --source=examples/mappings/synthetic-provider-click.json --file=examples/synthetic/mmp-raw-events.json --lint-directory=examples/mappings
```

The lower-level `npm run import:preview` command retains its original raw-event aggregate-only JSON shape. Compatibility dispatches on the mapping kind, applies the selected mapping, row filters, and import limits, and uses the same event or cost validation as runtime ingestion. The versioned `compatibility` object uses four closed states:

- `compatible`: at least one selected row was accepted, with no rejection or mapping warning;
- `partially_compatible`: at least one row was accepted, but another row was rejected or a mapping warning remains; for manual cost this is not execution-ready because the runtime imports the batch atomically;
- `not_compatible`: rows were selected but none passed the mapping and event-schema gates;
- `not_evaluated`: the row filter selected no rows, so support was not inferred.

The report contains aggregate row counts, closed check results, lint warning codes, rejection reason counts, contract target paths, and per-field `observed`, `absent`, or `unmapped` counts. `observed` and `absent` describe only the supplied artifact. They are not statements about a provider's product capabilities. `unmapped` means that this mapping does not declare the optional contract field; it does not mean the source product cannot supply it. The report never emits source row values, source column names, source identifiers, input paths, record IDs, or payload digests.

`persistence: "none"` means the command did not create a database pool or write import metadata, rejections, deliveries, logical events, or facts. Without `--lint-directory=<mapping-directory>`, cross-route `event_id` namespace safety is reported as `not_evaluated`; the command never guesses from one mapping. The report cannot detect conflicts with identities already persisted in a ledger and does not test live provider connectivity. It does not certify a provider or establish metric equivalence: time range, timezone, currency policy, attribution window, cohort definition, and watermark must match before totals can be compared. A successful report is therefore a safe compatibility check, not production-ingestion proof.

For `manual_cost`, required compatibility fields are `network`, `date`, `as_of`, and the exact `money.amount_unscaled`, `money.amount_scale`, and `money.currency` representation. Country, campaign, and ad-group dimensions remain optional. The report validates calendar dates, canonical mapped timestamps, uppercase currency/country shapes, non-negative integer money, and duplicate retained dimensions before declaring `execution_ready=true`. It reports only target contract paths and never copies source column names or values.

Provider-reported aggregate revenue uses a separate JSON entry point because it is not a mapping-DSL event or cost batch:

```bash
npm run import:revenue:compatibility -- --file=<private-json-path>
```

This no-write report validates rows and retained-dimension uniqueness while fixing `subject_scope=aggregate`, `cohort_eligible=false`, and `separate_from_installation_revenue=true`. Compatibility therefore cannot be interpreted as installation-level revenue, cohort ROAS, or live-provider proof.

## Row selection

The original single equality clause remains valid:

```json
"row_filter": { "source": "event_type", "equals": "click" }
```

An array means logical AND. Every clause must match for the row to be mapped:

```json
"row_filter": [
  { "source": "event_type", "equals": "click" },
  { "source": "row_status", "equals": "accepted" }
]
```

See `examples/mappings/synthetic-and-filter-click.json`.

The import CLI lints only the mapping selected by `--source`; unrelated JSON files beside it are never loaded. To lint a deliberately curated directory of sibling mappings for producer-wide event-ID overlap, add `--lint-directory=<directory>`.

## Conditional source columns

`fallback_column` is read only when the primary `source` is absent, null, or an empty string. It is intentionally one level deep; chained conditional programs are outside this DSL.

```json
{ "source": "primary_event_id", "fallback_column": "legacy_event_id" }
```

See `examples/mappings/synthetic-fallback-install.json`.

## Optional empty columns

`omit_if_empty: true` removes an optional target when its evaluated source is an empty string, `null`, or absent. This permits one mapping to accept mixed rows such as attributed and organic exports without emitting contract-invalid empty strings. Mapping load rejects this option on fields that the selected event schema requires.

```json
{ "source": "network", "omit_if_empty": true }
```

See `examples/mappings/synthetic-optional-columns-click.json`.

## Integer money

An integer source stays a base-10 string and is paired with the declared scale. This avoids binary floating-point conversion and preserves arbitrarily large CSV integers exactly. Negative values, decimal points, exponent notation, and unsafe JSON numbers are rejected.

```json
{ "source": "cost_micros", "money": { "input": "integer", "scale": 6, "currency_source": "currency" } }
```

See `examples/mappings/synthetic-integer-cost.json`.

## Decimal money

A decimal input must be a non-negative base-10 string without exponent notation. The mapper appends zeros up to the declared scale and never passes the value through binary floating point. If the source has more fractional digits than the declared scale, the row is rejected instead of rounded. Numeric JSON values are rejected in decimal mode so their original decimal representation cannot be lost.

```json
{ "source": "cost_decimal", "money": { "input": "decimal", "scale": 6, "currency_source": "currency" } }
```

For example, `1.23` at scale 6 becomes `amount_unscaled=1230000` and `amount_scale=6`. See `examples/mappings/synthetic-decimal-cost.json`.

The operator entry points are `npm run import:cost -- --file=<csv> --mapping=<json>` and `npm run metrics:run -- --date=<YYYY-MM-DD> --definitions=<json> [--watermark=<ISO8601>]`. The definitions document supplies tenant/app scope, one fixed FX policy, and one or more metric-name/grouping requests. `--date` supplies a default `cohort_date` only when an evaluation does not declare one. The watermark defaults to the following UTC midnight; an explicit canonical UTC watermark permits late-imported historical cohorts to be backfilled. Both commands use the same persistence and cohort-engine functions as the integration tests.

## Meta Insights cost import

An authorized private deployment can fetch one inclusive Meta Insights date range directly into the cost ledger:

```bash
npm run import:cost:meta -- \
  --tenant=<tenant-id> \
  --app=<app-id> \
  --account=<numeric-ad-account-id> \
  --currency=<ISO-4217> \
  --since=<YYYY-MM-DD> \
  --until=<YYYY-MM-DD> \
  [--as-of=<canonical-UTC-timestamp>] \
  [--api-version=v26.0]
```

Set exactly one of `OPENMASU_META_ACCESS_TOKEN` or `OPENMASU_META_ACCESS_TOKEN_FILE`. The file form reads the token from a deployment-private path and keeps it out of process configuration and shell history. Account IDs, provider responses, and imported values must also remain outside this repository.

The command requests synchronous daily country spend at ad-set level, validates the reported account currency against `--currency`, and follows only Meta cursor values on the original fixed Graph API endpoint. It fetches at most 1,000 pages of 500 rows, validates and sorts the complete response, rejects duplicate retained dimensions, and only then starts one append-only database import. A failed or incomplete fetch therefore writes no partial cost snapshot. The output contains only row counts and import-run metadata.

This is executable provider wiring with synthetic tests. It is not evidence that a particular token, account, date range, permission set, account timezone, or live Meta connection works. Asynchronous report jobs, automatic retries, and scheduling remain outside this command; use a smaller date range or an operator-owned workflow if Meta rejects a synchronous request.

## Google Ads cost import

An authorized private deployment can fetch one exact inclusive Google Ads date range through `SearchStream` and import it into the cost ledger:

```bash
npm run import:cost:google -- \
  --tenant=<tenant-id> \
  --app=<app-id> \
  --customer=<10-digit-customer-id-without-hyphens> \
  --currency=<ISO-4217> \
  --since=<YYYY-MM-DD> \
  --until=<YYYY-MM-DD> \
  [--login-customer=<10-digit-manager-id-without-hyphens>] \
  [--as-of=<canonical-UTC-timestamp>] \
  [--api-version=v25]
```

Set exactly one of `OPENMASU_GOOGLE_ADS_ACCESS_TOKEN` or `OPENMASU_GOOGLE_ADS_ACCESS_TOKEN_FILE`, and exactly one of `OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN` or `OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN_FILE`. The access token and developer token are sent on every request to the fixed Google endpoint, and redirects are rejected. `--login-customer` adds the manager-account header only when supplied. Keep customer IDs, tokens, provider responses, and imported values outside this repository.

The command is pinned to Google Ads API v25 because its campaign partition is version-specific. It makes three disjoint bounded cost queries over the same inclusive `segments.date` range. The App query omits `ad_group.id`, accepts only `APP_CAMPAIGN`, `APP_CAMPAIGN_FOR_ENGAGEMENT`, and `APP_CAMPAIGN_FOR_PRE_REGISTRATION`, and requires their channel type to be `MULTI_CHANNEL`. The ad-group query retains `ad_group.id` and uses an explicit v25 channel-type allowlist. A campaign-level residual query omits `ad_group.id` and accepts only `PERFORMANCE_MAX` or `LOCAL_SERVICES`. An unknown, future, or non-App `MULTI_CHANNEL` type returned by these `geographic_view` queries fails closed instead of being silently grouped. This detection covers emitted report rows, not an account-wide inventory of campaign types. App, Performance Max, and Local Services rows remain at campaign/country/date grain with `ad_group_id=null`.

All three queries require `geographic_view.location_type = 'LOCATION_OF_PRESENCE'`, select and validate `customer.currency_code` against `--currency`, and retain the country criterion for a subsequent bounded `geo_target_constant` country-code lookup. Each cost query uses the remaining row allowance plus one as a provider-side overflow sentinel. The default limits are 100,000 cost rows across all three cost queries, 1,000 batches per response, 32 MiB of streamed response bytes cumulatively across the whole run, 1,000 unique country criteria, 200 criteria per lookup chunk, and eight total requests. Invalid or incomplete rows, an unsupported partition, an unresolved or ambiguous country criterion, a currency mismatch, a duplicate retained dimension, or any exceeded bound fails the run. All provider reads and validations finish before one append-only atomic cost import begins, so a fetch failure writes no partial snapshot.

The persisted source identifier contains only a one-way digest derived from the raw customer ID. The command neither persists nor logs the raw customer ID, and its output contains only row counts and import-run metadata.

This is executable provider wiring with synthetic tests only. It is not live proof for a particular Google Ads account, token, developer-token access level, manager hierarchy, API version, date range, field combination, quota, or permission set. OAuth token refresh, automatic retries, and scheduling remain operator-owned and are outside this command.

## Producer-wide event IDs

The contract idempotency key excludes `event_name`. If multiple mappings for the same tenant, app, and provider reuse one source ID column, give each route a stable, distinct `prefix`. The CLI emits `event_id_source_reused_across_routes` when sibling mappings overlap without disjoint prefixes. See `synthetic-shared-id-click.json` and `synthetic-shared-id-install.json` for the safe pattern.
