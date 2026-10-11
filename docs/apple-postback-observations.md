# Apple postback observations

Use **Apple postback observations** from an app's dashboard to inspect retained
SKAdNetwork and AdAttributionKit notifications. This is a receipt report, not a
unique-install counter, conversion-value decoder, revenue model or win rate.
Existing qualified-postback metrics, including historical `*_installs` aliases,
keep their names and values. First-party acquisition and engagement remain
separate series.

## Select and read

The form requires an inclusive `date_from`, exclusive `date_to` and fixed
`watermark_at_most` UTC timestamp. Dates always mean **server receipt in UTC**,
not installation date or completion of a conversion window. No count is fetched
until the selection is complete. The equivalent reader API is:

```text
GET /v1/admin/apps/<app>/apple-postbacks?date_from=2026-08-22&date_to=2026-08-23&watermark_at_most=2026-08-22T23%3A59%3A59.999999Z
```

Use an operator bearer with `read` capability for the API and a dashboard
session for `/dashboard/apps/<app>/apple-postbacks`. Cookies do not authenticate
the API; bearer keys do not authenticate the dashboard. Missing/unknown/
cross-tenant apps share a 404. Unknown, duplicate and identifying filters fail
with 400; there is no arbitrary grouping, pagination, export or unbounded query.
This administration report is outside the [limited OpenAPI surface](api/README.md).

The JSON has `selection`, `privacy: current`, `coverage:
retained_receiver_ledger_only`, `conversion_schema: not_recorded`,
`maximum_source_rows` and four independently grouped arrays:

| Array / unit | Counted population | Important boundary |
| --- | --- | --- |
| `observations` / postbacks | One retained logical Apple fact after event-id deduplication | Signature failures and nonwinners remain visible; not only qualified metric inputs |
| `receipts` / batches | Durably admitted Apple batches, including pending/retried inputs | One event per receiver batch; processing state is current, not frozen at the receipt cutoff |
| `deliveries` / worker attempts | Stored attempts with exact Apple producer lineage or retained raw fallback | Accepted unique, duplicate, event-id conflict and other rejection are separate; signature failure can still be accepted unique |
| `quota_rejections` / audit attempts | Verification failures above the receiver's invalid-ledger quota | Count audit rows, not the process-local cumulative counter; these have no durable postback |

**Never add the four arrays together.** Their populations overlap. Each row
contains receipt date, platform and decimal-string count. Observation rows add
closed protocol, sequence, winner, conversion type, source precision,
conversion-value state/coverage and verification reason. No raw identifiers,
source values, signatures, free-form extensions or payloads are returned.

Malformed/oversized/rate-limited requests, unknown-app public audits and records
without recoverable producer lineage do not form a complete per-app HTTP log.
Pending or unlinked receipts describe operational metadata, not proof that a
payload is still available. The report neither invokes Apple nor writes the ledger.

## Unknown does not mean zero or suppressed

- `sequence` is `0`, `1`, `2`, `not_provided` or `not_recorded`. SKAdNetwork 3
  does not supply the multi-window index; it is not silently changed to 0.
- `source_state` reports `digits_2`, `digits_3`, `digits_4`, `absent`,
  `not_applicable` or `not_recorded`. SKAdNetwork 3 uses a campaign field rather
  than the later source-identifier field; its source state is not applicable.
- `conversion_value_state` is `fine`, `coarse_low`, `coarse_medium`,
  `coarse_high`, `absent` or `not_recorded`. Fine zero is present, not absent.
  Absence does not prove a specific privacy tier, suppression cause or value.
- `conversion_value_coverage` is `unsigned`, `not_applicable` (no value) or
  `not_recorded`. A verified postback signature does **not** authenticate an
  outer unsigned conversion value. Unknown coverage is never upgraded to verified.
- Download, redownload and re-engagement stay separate. A missing optional
  value is `not_provided`; older facts without the new metadata are
  `not_recorded`, without an inferred historical backfill.
- A registered current conversion schema is not evidence of which schema was
  used for a specific postback. Decoding/binding is not performed here.

For multi-window protocols, the conversion windows cover days 0–2, 3–7 and
8–35 after first launch. Randomized delays are 24–48 hours for the first and
24–144 hours for later postbacks; windows can lock early. Delivery may be limited
or absent. There is no synthetic join across windows, inferred install date,
suppression reconstruction, win-rate denominator or claim of completeness.

## Bounds and current privacy

A query is limited to 366 days and 100,000 source rows **per population**, with
a 5-second database statement timeout. The reader takes the tenant privacy fence
and groups all four populations in one statement. Pending deletion returns
409 `apple_privacy_pending`; overflow returns 413 `apple_source_limit`;
database failure/timeout returns 503 `apple_report_unavailable`. No partial
counts or private database diagnostics are published.

Logical facts require currently available raw evidence. Linked unavailable
own/canonical evidence removes delivery retries and their batch receipts.
Completed app/tenant deletion boundaries exclude earlier scoped observations,
receipts and audit attempts even with a pre-deletion cutoff. Therefore the
selection is not an immutable historical snapshot: current deletion and current
worker state still apply.

## Evidence and references

The existing Apple receiver integration harness sends signed synthetic windows
0/1/2, fine/coarse/absent values, source absence, nonwinner, three conversion
types, failed signatures, retries, conflict and a pending receipt. Literal
expectations distinguish 10 logical postbacks, 14 admitted batches, 13 worker
attempts and one quota audit. It checks reader API/SSR equality, auth/scope,
receipt cutoff and current deletion. Focused unit cases cover older protocol
metadata, unsigned values, parser limits and failure-without-partial-output.
Existing SQL/contract parity owns the unchanged qualified metric values.

Apple primary references checked **2026-10-11** (the official Markdown views
were read where HTML required JavaScript):

- [Multiple conversion windows](https://developer.apple.com/documentation/adattributionkit/receiving-postbacks-in-multiple-conversion-windows)
- [AdAttributionKit postback delivery](https://developer.apple.com/documentation/adattributionkit/receiving-ad-attributions-and-postbacks)
- [Signed parameters and unsigned observations](https://developer.apple.com/documentation/adattributionkit/identifying-the-parameters-in-a-postback)
- [SKAdNetwork postback delivery](https://developer.apple.com/documentation/storekit/receiving-ad-attributions-and-postbacks)

Live delivery, platform permissions, real campaigns/devices, suppressed-value
semantics and upstream completeness remain unverified. No new provider access,
contract vocabulary, schema, golden, database migration or dependency is required.
