# Bounded Daily Cost Refresh

This later-source feature is not part of the frozen v0.2.0 release evidence.
It joins the Google Ads v25 and Apple Ads Platform v1 adapters to the existing
SecretStore, PostgreSQL scheduler and append-only cost ledger. It adds no OAuth
flow, dependency, queue service or database. Both adapters bound acquisition
before publishing a complete local snapshot.

## Defaults and scope

`OPENMASU_COST_REFRESH_ENABLED=off` means no provider requests or secret-registry
reads. Synthetic integration tests supply fake responses to the actual adapter;
they need no provider account. Enabling it is a separate private operator action.

An administrator can register one active schedule per provider per app with
`POST /v1/admin/apps/<app>/cost-schedules`. Example synthetic configuration:

```json
{
  "provider": "google_ads",
  "customer_id": "4300000000",
  "currency": "USD",
  "lag_days": 1,
  "lookback_days": 7,
  "limits": { "maxRows": 10000, "maxRequests": 8 }
}
```

The closed version-1 definition is normalized, hashed and immutable. Customer
and optional `login_customer_id` are private configuration, not report fields.
For Google Ads, only API v25 is supported. Lag and lookback are each 1–31 days. Acquisition
ceilings are 100,000 rows, 1,000 batches per response, 32 MiB cumulative response
bytes, 1,000 country criteria, 200 criteria per lookup and eight total requests.
An operator may lower these, not raise them. At least three requests are needed
for the disjoint cost partitions; country lookup may need additional allowance.

## Apple Ads campaign cost

Use the same registration endpoint with this synthetic configuration:

```json
{
  "provider": "apple_ads",
  "api_version": "v1",
  "ad_account_id": "23501",
  "app_store_id": "23502",
  "campaign_ids": ["23503", "23504"],
  "account_time_zone": "America/New_York",
  "reporting_time_zone": "UTC",
  "currency": "USD",
  "lag_days": 1,
  "lookback_days": 7,
  "limits": { "pageSize": 100, "maxPages": 20, "maxRows": 10000 }
}
```

Only Platform API v1 `POST /v1/reports/apps/campaigns/query` on the fixed
`api.ads.apple.com` HTTPS host is supported. The adapter sends the account in
`X-AP-Context: adAccountId=...` and scopes reports to the declared campaign set.
It does not use the deprecated Campaign Management v5 response shape or `orgId`
header. The immutable definition retains the account/app/campaign IDs, declared
account timezone and expected currency privately; none are health-report fields.
The account timezone is operator-declared, not verified by an account API call.

Reports explicitly request **UTC**, without geographic/ad-group breakdown.
Account-local dates are never relabeled UTC. The resulting `apple_adservices`
network and campaign/day match the existing verified-platform metrics; they do
not supply deterministic acquisition or fill an unknown campaign. Other report
timezones and detail grains are unsupported. A metric with a different day or
missing campaign cost remains undefined rather than borrowing another day.

The adapter reads daily `granularMetrics[].localSpend` for multi-day ranges and
`totalMetrics.localSpend` only for a single day (which omits granularity). It
never adds daily spend to totals or a summary. Decimal strings are converted
exactly to fixed scale 18, with at most 18 integer and 18 fractional digits;
excess precision, missing spend or a currency mismatch rejects acquisition.
No rounding, FX conversion or tax/credit reconstruction occurs in the adapter.

Limits are 1,000 explicitly selected campaigns, 31 inclusive days, 100 pages,
5,000 campaign rows per page, 100,000 retained daily cost rows and 32 MiB across
all response pages. Default page size is 100. Operators can lower the limits.
Offsets advance by received campaign rows and must reconcile with a stable
`totalCount`; duplicate campaigns/days, mismatched app/account, stalled pages,
partial nonempty campaign coverage or missing daily buckets fail closed before
publication. `EMPTY_METRICS` requests inactive rows, but an omitted bucket is
still not evidence of zero. A wholly empty report records `empty` and preserves
prior cost. Sparse reports must be resolved with the provider or a narrower
explicit selection, not padded by this adapter.

The same publication transaction and correction policy below handle Apple cost
revisions. Google and Apple schedules can coexist, but each provider has only
one active account/campaign-set definition per app. Disable that schedule before
changing its scope; disabling does not delete previously recorded cost.

## Fixed progress, publication and stopping

- Each due run fixes its inclusive UTC day range, `as_of` and definition digest
  in a durable checkpoint before fetching. For a UTC September 1 run with lag 1
  and lookback 7, the requested range is August 25–31. Provider report dates are
  still provider dates: scheduling does not prove the account timezone is UTC.
- A database-clock 120-second per-row lease and opaque token exclude concurrent
  acquisition. No database transaction is held while waiting on the provider.
  The existing tenant scheduler remains an additional work coordinator.
- All cost partitions and country resolutions must validate within one
  60-second acquisition deadline. An incomplete/oversized result publishes no
  cost or completed import. The publication transaction locks and checks the
  current token, unexpired lease, active state and definition digest before
  writing costs, the import completion record and its checkpoint together.
- A crash before commit leaves no partial publication. A crash after commit
  resumes after the completed checkpoint, not a second import. Expired claims
  reuse the pending range and `as_of`; their old response cannot publish.
- Transient source errors and timeout have at most three attempts, five minutes
  apart. Invalid results and permanent rejection fail closed. Exhaustion is a
  terminal state, including a process killed during its third claim. An operator
  fixes configuration and registers a new revision after disabling the old one;
  there is no silent retry forever or automatic token refresh.
- `POST /v1/admin/apps/<app>/cost-schedules/<id>/disable` records append-only
  stop history and clears the token under the publication lock. A late response
  is fenced. If publication committed first, the stop observes that completed
  run; it does not remove history. The `operate` capability permits stopping;
  registration requires `administer`.

A valid empty acquisition has its own `empty` outcome and row count zero. It
creates **no** cost snapshot and does not replace old cost with zero. A later
nonempty correction appends a new cost revision; earlier facts and their
snapshot digest remain readable. Missing dimensions in a later response are
not interpreted as deletion. This is local atomic publication, not an immutable
provider snapshot or an end-to-end exactly-once promise. A retry may observe
changed upstream data even with the same query. Correction-driven metric
recalculation is a separate [bounded request workflow](metric-corrections.md), or
an explicitly configured [automatic correction policy](automatic-metric-corrections.md);
without that opt-in policy, refreshing cost alone does not update a
previously saved metric.

## Private secrets

`OPENMASU_COST_REFRESH_SECRETS_FILE` points to a bounded operator-owned JSON
registry outside the public repository. Entries use the existing SecretStore
shape: exactly one of `{ "file": "<private mounted token path>" }` or
`{ "value": "<private token>" }`. Prefer file entries. No credential or source
response is submitted via the schedule API or committed to this repository.

Google's two names are obtained with the exported runtime helper:
`costRefreshSecretName(tenantId, appId, "access_token")` and
`costRefreshSecretName(tenantId, appId, "developer_token")`. They contain the
SHA-256 digest of the scope tuple, preventing delimiter collisions and
cross-app secret selection. The registry itself is at most 1 MiB. An invalid
registry produces only `cost_refresh_secret_registry_invalid`, not its path
or contents. Missing app credentials leave a visible `source_rejected` state.

Apple uses the separate `costRefreshSecretName(tenantId, appId,
"apple_ads_access_token")` entry. The operator supplies an access token through
the private registry, not through API JSON. This implementation neither issues
client-secret JWTs nor refreshes OAuth tokens. Token expiry/401 is a terminal
source rejection; 429/temporary server failures use the bounded retry policy.

Bootstrap propagates the default-off mode and registry path into runtime.env,
including an existing generated environment. For Compose, mount the private
registry and token files read-only into the **worker**, at the container paths
named in that registry. The repository does not mount host credential paths
automatically. Restart the worker after replacing credentials; this feature
does not implement OAuth refresh or hot-reload.

## Aggregate health and acceptance

`GET /v1/admin/apps/<app>/cost-schedules` uses the reader pool and `read`
capability. It returns at most 100 schedules with status, processing/failed/stop
state, fixed pending/last range, last successful acquisition time, next run and
retry, row count and safe failure code. Empty acquisition is shown as empty,
not as a newly available denominator. It exposes no customer IDs, definition
body, credentials, secret names, raw payload or lease token. The reader role
cannot select private definition columns; tenant RLS applies independently.

The existing `npm test`, `npm run test:integration`, environment coverage,
schema snapshot and full-table role-matrix gates cover definition bounds,
default-off behavior, complete lookback, crash/lease recovery, concurrent
workers, late-response fencing, stop, retry exhaustion, acquisition timeout,
empty-versus-zero, correction history, rollback and reader/API isolation.
No new test harness or live account check is required.

## Primary references

Confirmed 2026-10-02, against public first-party documentation:

- [Google Ads REST search and SearchStream](https://developers.google.com/google-ads/api/rest/common/search)
- [Streaming reports](https://developers.google.com/google-ads/api/docs/reporting/streaming)
- [API error handling](https://developers.google.com/google-ads/api/docs/best-practices/understand-api-errors)

Live permissions, quotas, account timezone, token validity/rotation, report
availability and retry snapshot stability remain unverified. Read acceptance
and a complete local snapshot do not prove upstream completeness.

Apple sources confirmed 2026-10-11:

- [Campaign report endpoint and response](https://developer.apple.com/documentation/apple-ads-platform-api/get-app-campaign-reports)
- [Report granularity, pagination and empty metrics](https://developer.apple.com/documentation/apple-ads-platform-api/reports)
- [Filter cardinality](https://developer.apple.com/documentation/apple-ads-platform-api/filter/value-data.dictionary)
- [API headers](https://developer.apple.com/documentation/apple-ads-platform-api/calling-apple-ads-platform-api)
- [Money](https://developer.apple.com/documentation/apple-ads-platform-api/money)
- [Legacy API deprecation](https://developer.apple.com/documentation/apple_ads/reports)

The legacy API sunset is January 26, 2027; this adapter targets its replacement.
Live Platform API permission, token validity, report latency/completeness,
cross-page snapshot consistency and spend-to-billing/tax/credit agreement remain
unverified. Synthetic pagination/401/429/partial/duplicate/empty/revision tests
and saved AdServices ROAS corrections are local evidence, not those guarantees.
