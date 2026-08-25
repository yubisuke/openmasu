# Import Mapping DSL

Runtime import mappings are schema-validated JSON documents. Public files under `examples/mappings/` contain synthetic values only; deployment-specific provider column names and certification evidence remain private.

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

## Conditional source columns

`fallback_column` is read only when the primary `source` is absent, null, or an empty string. It is intentionally one level deep; chained conditional programs are outside this DSL.

```json
{ "source": "primary_event_id", "fallback_column": "legacy_event_id" }
```

See `examples/mappings/synthetic-fallback-install.json`.

## Integer money

An integer source stays a base-10 string and is paired with the declared scale. This avoids binary floating-point conversion and preserves arbitrarily large CSV integers exactly. Negative values, decimal points, exponent notation, and unsafe JSON numbers are rejected.

```json
{ "source": "cost_micros", "money": { "input": "integer", "scale": 6, "currency_source": "currency" } }
```

See `examples/mappings/synthetic-integer-cost.json`.

The operator entry points are `npm run import:cost -- --file=<csv> --mapping=<json>` and `npm run metrics:run -- --date=<YYYY-MM-DD> --definitions=<json>`. The definitions document supplies tenant/app scope, one fixed FX policy, and one or more metric-name/grouping requests; the CLI supplies the cohort date and next-day UTC watermark. Both commands use the same persistence and cohort-engine functions as the integration tests.

## Producer-wide event IDs

The contract idempotency key excludes `event_name`. If multiple mappings for the same tenant, app, and provider reuse one source ID column, give each route a stable, distinct `prefix`. The CLI emits `event_id_source_reused_across_routes` when sibling mappings overlap without disjoint prefixes. See `synthetic-shared-id-click.json` and `synthetic-shared-id-install.json` for the safe pattern.
