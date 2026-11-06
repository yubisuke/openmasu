# Import Mapping DSL

Runtime import mappings are schema-validated JSON documents. Public files under `examples/mappings/` contain synthetic values only; deployment-specific provider column names and certification evidence remain private. Start with the no-write compatibility report below. Use [Getting started](getting-started.md) for the synthetic runtime and [the optional private checklist](validation/real-data-checklist.md) only when a separate authorization covers real input.

## Private saved CSV mapping revisions

### Dashboard upload, preview and confirmation

From an app overview, choose **Preview and import CSV**. An administrator can
register the same mapping-revision JSON described below; an operator selects
an exact saved revision and uploads a UTF-8 CSV. The existing worker prepares
a counts-only preview. Refresh the result page, review the accepted/rejected
counts and reason codes, then choose **Confirm these exact bytes and mapping**.
Uploading and previewing do not write measurement records or an import run.
Registration, upload and confirmation are separate audited operations.

The browser flow supports the existing `mmp_raw` and `manual_cost` CSV mappings,
not a second mapper. Limits are 4 MiB per file, 10,000 rows, 64 KiB per normalized
row and ten protected uploads per app. Invalid UTF-8, malformed CSV or missing
required header sources are rejected before upload storage. Row-limit and row
validation failures are reported by the worker without importing them. Cost
preview must be execution-ready; an event CSV may contain rejected rows alongside
accepted rows. Raw rows, source filenames, private column names and protected
storage references never appear in the page or response.

Upload bytes use the existing encrypted payload store. They cannot be confirmed
after 24 hours; the worker purges expired and terminal uploads and removes their
summary pages after seven days. Cleanup needs a running worker. App-scoped privacy
requests conservatively invalidate and purge all pending uploads in that app,
because the unimported CSV has no subject index. Tenant erasure covers all apps.
Reader sessions can view summaries but cannot upload, confirm or read protected
bytes. All mutations require the existing role, CSRF and Origin checks.

Confirmation binds the scope, upload ID, source-byte SHA-256 and immutable mapping
digest. A durable source-file receipt fixes the received timestamp before work
starts. Reconfirmation and a new upload of the same file/revision return the
stored result without another import. A different mapping for that same source
and file conflicts; a legacy import without a managed receipt is not silently
reinterpreted. CLI event imports and dashboard confirmation share a source-file
lock, and the CLI cannot bypass an existing managed receipt. Terminal import
metadata and the managed result commit together; event chunks keep their existing
per-record atomicity and idempotency. Transient worker failures receive at most
three attempts, bounded by upload expiry. This is not whole-file atomicity.
Recovery after committed event chunks preserves their append-only delivery-attempt
evidence; a retry can add an attempt without adding another logical measurement.

The result shows its import-run reference, counts and links to saved metric
schedules and reports. **Schema/mapping accepted** does not mean distinct logical
events: existing duplicate/conflict, privacy and attribution rules still apply.
Preview compatibility is not report comparability or provider completeness.
Imports do not automatically compute new metric runs; select a saved schedule
or use the existing metrics CLI, then compare reports separately.

An app can store immutable, sequential mapping revisions for CSV `mmp_raw` and
`manual_cost` inputs. This is an operator configuration registry, not an import
or a provider certification. Existing local-file CLI mappings still support
CSV, JSON and JSONL. Their DSL `version: "1.0.0"`, producer identity and
`producer_version` are unchanged; the registry's `revision` is a separate
configuration number.

The app-scoped admin API has three routes:

| Route | Capability | Request and result |
| --- | --- | --- |
| `POST /v1/admin/apps/:app/import-mappings` | `administer` | Register `{mapping_id, revision, mapping, approved_headers}`; return revision metadata |
| `GET /v1/admin/apps/:app/import-mappings` | `read` | List the newest metadata for each mapping ID; optional `mapping_id` selects that mapping's revision history |
| `POST /v1/admin/apps/:app/import-mappings/preview` | `operate` | Compare `{mapping_id, revision, headers}` against its saved header approval; optional `candidate_mapping` compares changed expectations without saving them |

`mapping` is the existing complete DSL object with `format: "csv"`; its
`tenant_id` and `app_id` must match the authenticated app. `approved_headers` is
the explicitly reviewed ordered array of CSV column names, not sample rows.
Registration rejects missing required expression/filter sources. A `mapping_id`
is an app-local identifier of 1–128 letters, digits or `._:-` characters; use
an operational label, not a source row value or credential.

Start at `revision: 1` and increment by one for the same mapping ID. Repeating
the same revision and canonical definition is idempotent; changing that
revision or skipping the next number returns a conflict. Old revisions remain
immutable and explicitly selectable. The newest-metadata list does not activate
a mapping or make subsequent execution choose the latest revision. For history,
`?mapping_id=synthetic-cost&after_revision=1` returns up to 100 revisions and a
`next_revision` continuation; the unfiltered list returns at most 1,000 mapping
IDs. The app has a total capacity of 1,000 stored revisions across all IDs.

The protected payload store retains one combined
`{mapping, approved_manifest}` definition. Source column names, mapping rules
and the private storage reference are not returned by list or preview.
Metadata is limited to `mapping_id`, `revision`, `kind`, `mapping_digest`,
`definition_digest`, `header_count` and `created_at`. Reader access exposes only
this metadata, not the protected definition. Registration records a scoped
audit entry; header preview returns `persistence: "none"` and writes no ledger,
import run, saved mapping or audit row. It performs no provider request.

`mapping_digest` hashes the parsed mapping's RFC 8785 canonical JSON;
`definition_digest` hashes the combined canonical definition. Object-key order
and insignificant JSON whitespace therefore do not create a new definition;
array order, including rule and approved-header order, remains significant.
These are **not** the CLI import-session confirmation token below, which binds
the exact mapping-file and source-file bytes.

### Header drift preview

Preview returns counts and one closed `comparison.status`, never header names
or row values:

| Status | Meaning |
| --- | --- |
| `unchanged` | The same columns in the same order, with required sources present |
| `order_only` | The same column set in a different order |
| `unknown_columns` | Added columns exist; this takes precedence over removed-column reporting when both occur |
| `columns_changed` | Columns were removed without additions, but required sources remain available |
| `required_sources_missing` | At least one mapping expression or filter requirement is unsatisfied; this takes precedence over other drift states |

`approved_count`, `current_count`, `added_count`, `removed_count` and
`required_sources_missing` describe the submitted headers. The last count is
unsatisfied requirements, not necessarily distinct column names. Existing
fallback/default/optional-empty rules are considered, but a present column does
not prove a usable value in every row.

`expectation_changed` is independent of the header status: supplying a
`candidate_mapping` can change rule/filter expectations even when headers are
unchanged. It does not register or approve that candidate. Every result includes
`header_only_no_value_types_or_empty_distribution`: header checks cannot detect
value-type changes or a different empty-value distribution. Use the existing
row compatibility report for actual synthetic input; neither check establishes
metric comparability or live-provider completeness.

The default decoded HTTP body limit is 32 KiB; managed request objects and the
combined canonical definition also have a fixed 32 KiB limit. Header lists are
bounded to 256 unique, nonempty columns of at most 256 UTF-8 bytes each, without
surrounding whitespace or control characters. Managed JSON rejects excessive
nesting and prototype-related keys; event-schema selection cannot be used as a
filesystem path. These are HTTP admission guards, not a new DSL version.

There is no browser CSV upload/execute screen in this registry slice. Registering
or previewing a revision does not ingest any rows; continue using the explicit
local-file CLI workflow below for execution.

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

## Confirmation-bound runtime import

Use one command to preview the exact `mmp_raw` mapping and source bytes without a database connection:

```bash
npm run import:session -- --source=examples/mappings/synthetic-provider-click.json --file=examples/synthetic/mmp-raw-events.json
```

After reviewing the aggregate-only output, pass its token with the same inputs to use the existing runtime importer:

```bash
npm run import:session -- --source=examples/mappings/synthetic-provider-click.json --file=examples/synthetic/mmp-raw-events.json --confirm=<confirmation_token>
```

The SHA-256 confirmation token binds the exact mapping and source bytes; it is not a secret or an authentication credential. Changing whitespace or any other byte invalidates the prior token, and validation happens before a database pool is created. A confirmed run retains the existing contract validation, row-level rejection artifacts, producer-scoped event identity, and content-addressed idempotency. Repeating the same confirmed bytes records a skipped import instead of duplicating ledger state. Output remains aggregate-only. If `OPENMASU_PUBLIC_BASE_URL` is configured as an HTTP(S) origin, a committed result also returns dashboard, stored-difference, and aggregate-CSV links.

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

This is executable provider wiring with synthetic tests only. It is not live proof for a particular Google Ads account, token, developer-token access level, manager hierarchy, API version, date range, field combination, quota, or permission set. OAuth token refresh remains operator-owned. This one-shot command does not retry or schedule itself; the separate default-off [bounded daily cost refresh](cost-refresh.md) reuses the same adapter with durable range/configuration checkpoints and atomic publication.

## Cost grain safety

Manual cost mappings can retain optional `creative_id`; see
`examples/mappings/synthetic-creative-cost.json` and the inline synthetic CSV in
[the detail guide](acquisition-detail-metrics.md). Use `omit_if_empty` for an absent optional
ID, not an invented value. Explicit [detail definitions](acquisition-detail-metrics.md)
include creative in revision selection and overlap checks. Old metric profiles
exclude creative-grain cost, so importing it does not silently change their
denominator. Provider adapters' existing dimension coverage is unchanged.

Cost import keeps append-only observations; successful import does not prove
that rows form a disjoint denominator. Do not combine campaign totals with
their ad-group or country breakdowns and expect automatic allocation. Explicit
safe-cost metric definitions select the latest visible revision for each
tenant/app/network/date/campaign/ad-group/country tuple. Missing dimensions
mean unknown coverage, not a new disjoint partition. Two grains overlap unless
at least one dimension present in both proves them distinct. Different scopes,
dates, or disjoint siblings remain separate; equal amounts alone prove nothing.

The opt-in `reject_overlapping_grains` policy emits
`undefined/overlapping_cost_grains` instead of silently summing ambiguous rows.
It retains candidate evidence for diagnosis and does not guess which import is
authoritative. Existing disjoint adapter partitions continue to work. Historical
metric definitions retain legacy behavior for reproducibility; create new
explicit definitions using [safe cost selection](cost-selection.md).

## Producer-wide event IDs

The contract idempotency key excludes `event_name`. If multiple mappings for the same tenant, app, and provider reuse one source ID column, give each route a stable, distinct `prefix`. The CLI emits `event_id_source_reused_across_routes` when sibling mappings overlap without disjoint prefixes. See `synthetic-shared-id-click.json` and `synthetic-shared-id-install.json` for the safe pattern.
