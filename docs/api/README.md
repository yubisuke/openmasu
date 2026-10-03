# Backend event and report HTTP contract

[openapi.json](openapi.json) is a limited OpenAPI 3.1.1 description of four
existing endpoints. It is not a new API or a claim of complete API coverage:

| Use | Method/path | Authentication |
| --- | --- | --- |
| First-party backend receipt | POST `/v1/events/server` | Dedicated app/producer server key, raw-body HMAC and replay-bound headers |
| Persisted metric runs | GET `/v1/reports/metrics` | Operator bearer with read capability |
| Aggregate evidence counts | GET `/v1/reports/records` | Same bearer; explicit watermark required |
| Stored difference audit | GET `/v1/audit/differences` | Same bearer; no cause inference/recomputation |

Administration/key issuance, SDK enrollment/batches, privacy requests, platform
callbacks, outbound delivery and dashboard sessions are outside this document.
`/v1` never treats cookies as credentials. Use separate signing and read keys;
never put either in query parameters, logs or public examples. Unknown/missing/
cross-tenant app requests return the same 404. Reader capability never grants
mutation rights or private replay-manifest access.

## Source relationships

Generate the JSON with `npm run api:contract`. Two narrow existing-unit-suite
tests require the committed JSON to match the builder, route auth/methods and
report query allowlist. The builder reads contract field/enumeration schemas,
uses the exported runtime event/query allowlists and CSV columns, and retains
relative references to the normative event payload schemas. Keep this document
with `schemas/` when resolving those references. Contract fields and payload
enums are not another hand-maintained domain model. HTTP projection/parameter/
status rules live in `tools/http-api-contract.ts`; update it in the same change
as a transport rule. HMAC's single source is
`apps/api/src/server-auth.ts:serverCanonicalString/signServerRequest`.

The description is JSON-parser checked and exercised against existing real
local HTTP routes. It is not separately certified by a third-party OpenAPI
validator or code generator. No Swagger UI, JS frontend, SDK product, dependency
or CI job is added. Relative payload schemas use the existing contract compiler.

## Receipt, retries and calculation are different gates

The default body limit is 262144 raw bytes and 100 events; operators may change
`OPENMASU_SERVER_INGEST_MAX_BYTES/MAX_EVENTS`. Every event has a stable producer-
scoped `event_id`, version, event name, canonical millisecond UTC `occurred_at`,
nonnegative safe-integer processing sequence and event payload. Server-assigned
tenant/app/producer/receipt fields are not authority granted to the caller.
The full payload schema is checked by the worker **after** inbox admission.

Sign exactly the bytes sent. The canonical UTF-8 string joins the scheme,
uppercase method, pathname, app ID, key ID, Unix millisecond timestamp, nonce
and lowercase SHA-256 body digest with newlines and no trailing newline. The
signature is HMAC-SHA256 lowercase hex. Refer to the function, not a copied
signature formula. Nonce replay/inactive key/bad signature/time become 401;
default timestamp skew is 300000ms and nonce TTL 900000ms. All records share
one installation anchor or all omit it; authority escalation/privacy refusal
is 403. Invalid envelope/JSON/count is 400; body overflow 413; rate limit 429.

202 means `{ingest_batch_id,status:"pending"}`, not accepted logical events,
finished provider work or computed metrics. Observe the batch through
[measurement health](../measurement-health.md) using the separate operator
surface. Scheduling is described in [Scheduled metrics](../scheduled-metrics.md).
Schema-invalid payloads can be admitted then rejected without worker crash.

Stored metric queries additionally accept `metric_schedule_id` to select an
explicit saved schedule series and its recalculation descendants. Use
`supersession=all` for the replaced series' retained history. This is not a
metric-name/latest heuristic and does not alter existing CSV meanings. Raw-record and
difference-audit endpoints reject the filter because they have no schedule
provenance. The administrative replacement preview/confirmation remains outside
this limited OpenAPI surface; see [Scheduled metrics](../scheduled-metrics.md).

Metric rows also append four aggregate-only [freshness objects](../metric-freshness.md):
`time_window_maturity`, `source_observation`, `import_completion` and
`recalculation_state`. CSV appends the same objects as JSON-text cells. These
are report projections, not changes to the metric-run contract. App-scoped
local receipts do not establish campaign/cohort coverage or provider arrival;
`upstream_freshness` remains `unknown`. Missing legacy evidence stays unknown,
and no viewing/export path makes provider requests.

There is no automatic example-client retry. Correct 400/401/403 configuration
first. Back off on 429, then use a fresh timestamp/nonce/signature. On timeout,
connection loss or 500, the result may be unknown: inspect receipt state before
choosing a retry. Keep `event_id`, producer and payload stable; identical digest
means duplicate delivery and a changed digest conflicts, even across event
types. Do not mint a new ID to bypass a result-unknown delivery. This local
idempotency is not end-to-end exactly-once external delivery.

## Privacy changes do not rewrite a saved number

Deletion recognition immediately withdraws a saved run whose available input
evidence intersects the deletion scope. Its report projection uses
`value_state: unavailable`, omits `value_unscaled`, sets `undefined_reason` to
null, and carries `unavailable_reason: privacy_deletion`. The appended
`privacy_update_state` is `recalculation_pending` while the durable item waits
or retries, `completed` once its actual successor commits, or `unavailable`
when replay is not possible. Unaffected rows use `not_affected`. These are
HTTP-report fields, not additions to the normative metric-run artifact enum.

A legacy run with neither saved evidence references nor a replay manifest
cannot prove that it is unaffected. It is conservatively withdrawn in the
requested app/tenant scope and remains unavailable without a copied successor.
A valid saved empty-input calculation is not withdrawn solely for having no
input references. The report marks withdrawn runs as `redaction_affected`
without changing their stored reproducibility metadata.

An old run remains unavailable even after its successor completes and even
when a caller requests an earlier watermark or `supersession=all`. Its stored
artifact and original `data_freshness` remain immutable; they do not certify
the old value as usable after deletion. Only an actual manifest replay can
publish a successor with `data_freshness: recalculated`. Missing replay inputs
never produce a copied value labeled recalculated.

CSV appends `privacy_update_state` and `unavailable_reason` and leaves the
unavailable number's cell empty. The dashboard and saved-detail view use the
same withdrawal rule, and charts show a gap rather than zero. Read clients
must handle the additive `unavailable` report state separately from a metric's
mathematical `undefined` state. Fixed comparisons reject unavailable values.

## Read selections and continue pages

Use declared grouping keys only; identifying grouping, unknown keys and duplicate
single-value filters are rejected. `metric_name` may repeat. Dates are inclusive
`date_from` / exclusive `date_to`, using metric_date then cohort_date. Preserve
app, metric/definition/grouping selection, dates, watermark and supersession on
continuation. Pass `next_cursor` unchanged as `after` to the **same endpoint**.
Normal default limit is 200, maximum 1000 by default. There is no offset.

Normal pages are individually read-consistent, not a frozen multi-request export.
For a fixed all-page comparison selection, use the existing dashboard comparison
download instead of claiming cursor iteration alone supplies one snapshot.
`supersession=latest` excludes replaced runs; `all` exposes immutable history.
Deterministic and Apple aggregate series remain distinct. Saved unknown meaning,
missing results and undefined values are not zero. JSON omits `value_unscaled`
for undefined; CSV uses an empty cell and retains `undefined_reason`. Rows also
carry `measurement_series` (`cohort_or_activity`, `first_party_engagement`, or
`apple_aggregate`). The [engagement profile](../engagement-outcomes.md) has
`engagement_evidence_trust: device_reported_forgeable`; other rows have `null`,
which is not a verification claim. Both fields are appended to CSV without
moving existing columns. CSV carries
continuation in `x-next-cursor`; bounded `export=true` requires CSV and refuses
truncation beyond the configured export limit (default 200000).

## Minimal client example

[examples/backend-http-client.ts](../../examples/backend-http-client.ts) uses
Node fetch and the existing signature helper. It accepts an explicitly supplied
origin and separately supplied keys, refuses redirects and times out after five
seconds. It never prints keys, response bodies or events. There are no embedded
credentials, external calls on import, hidden retries or unbounded all-page reads.

```typescript
const client = backendHttpClient(privateConfiguration);
const receipt = await client.sendEvents([syntheticEvent]);
// receipt.status === "pending"; no claim that a calculation exists yet.
const selection = new URLSearchParams("limit=200&date_from=2026-08-20&date_to=2026-08-21");
const first = await client.reportPage("/v1/reports/metrics", selection);
if (first.next_cursor) {
  const next = new URLSearchParams(selection);
  next.set("after", first.next_cursor);
  await client.reportPage("/v1/reports/metrics", next);
}
```

The existing server-event integration harness exercises this client against
loopback HTTP: valid synthetic admission/pending, malformed envelope, invalid
authentication, empty-not-computed report, then two real SQL-calculated saved
rows and cursor continuation. It does not seed/reset the test database or touch
a provider. Real deployment keys, domains and network reliability remain
unverified. See [the full backend guide](../server-to-server-events.md).

Primary format reference checked on 2026-10-02:
https://spec.openapis.org/oas/v3.1.1.html (the chosen format, not a claim to the
latest OpenAPI version).
