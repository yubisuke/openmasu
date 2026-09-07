# Offline cohort comparison

Run `npm run compare:cohorts -- left.json right.json` after `npm ci`.
The command reads two aggregate snapshots without database or network access.
Inputs are limited to 4 MiB and 10,000 rows each. Keep private data outside this
public repository; checked-in examples and tests must be synthetic.

Minimal synthetic input (save two copies, then change a value to see a delta):

```json
{
  "source": "synthetic-example",
  "conditions": {
    "date_from": "2026-01-01",
    "date_to": "2026-01-02",
    "time_zone": "UTC",
    "maturity": "fully_elapsed_d7",
    "aggregation": "cumulative",
    "attribution_scope": "organic",
    "metric_definition": "revenue_d7_v1",
    "source_cutoff": "2026-01-10T00:00:00.000Z"
  },
  "rows": [{ "key": "total", "currency": "USD", "scale": 2,
    "state": "present", "value": "100" }]
}
```

Date ranges are half-open. Cutoffs use canonical UTC timestamps including
milliseconds. All condition strings must match exactly: this tool checks
declared agreement, not the truth of a producer's declarations. Coordinate
metric-definition, maturity, attribution, and row-key conventions beforehand.
Aggregation is `cumulative` or `on_day`. Currency is an uppercase three-letter
code, or `none` for non-monetary metrics. Scale is 0 through 18.

Values are signed integer strings (up to 100 digits), never floating point.
For undefined values replace `value` with `reason` and set `state` to
`undefined`. Missing rows, undefined values, zero, and currency mismatches are
distinct. Duplicate keys and unknown fields are rejected.

Output uses canonical JSON. Each input has a SHA-256 digest after row sorting;
retain the original snapshots to reproduce a comparison. Deltas are right minus
left at the larger input scale. Incompatible conditions produce no deltas.
No causal explanation is inferred. Successful execution exits 0 even when
values differ or conditions are incomparable; malformed input exits 1.

This is an offline tooling format, not a new measurement contract artifact.
Database persistence and dashboard integration are not implemented here.

## Human-readable report

Use `npm run --silent compare:cohorts -- --html left.json right.json > comparison.html`
to create a standalone report. Open the file locally in a browser. The report
uses no scripts, external assets, or network access and includes exact decimal
values, comparison states, declared conditions, and input hashes. `--silent`
keeps npm's command banner out of the HTML. On older shells that change output
encoding, save stdout as UTF-8. Reports contain aggregate values: do not commit
private reports to this public repository or share them unintentionally.
