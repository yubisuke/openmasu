# Bounded Daily Cost Refresh

This later-source feature is not part of the frozen v0.2.0 release evidence.
It joins the existing Google Ads v25 cost adapter, SecretStore, PostgreSQL
scheduler and append-only cost ledger. It adds no provider, OAuth flow,
dependency, queue service or database. This adapter was selected because it
already bounds cumulative rows, requests, bytes and country resolution.

## Defaults and scope

`OPENMASU_COST_REFRESH_ENABLED=off` means no provider requests or secret-registry
reads. Synthetic integration tests supply fake responses to the actual adapter;
they need no provider account. Enabling it is a separate private operator action.

An administrator can register one active schedule per app with
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
Only API v25 is supported. Lag and lookback are each 1–31 days. Acquisition
ceilings are 100,000 rows, 1,000 batches per response, 32 MiB cumulative response
bytes, 1,000 country criteria, 200 criteria per lookup and eight total requests.
An operator may lower these, not raise them. At least three requests are needed
for the disjoint cost partitions; country lookup may need additional allowance.

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
recalculation is a separate [bounded request workflow](metric-corrections.md); refreshing cost alone does not update a
previously saved metric.

## Private secrets

`OPENMASU_COST_REFRESH_SECRETS_FILE` points to a bounded operator-owned JSON
registry outside the public repository. Entries use the existing SecretStore
shape: exactly one of `{ "file": "<private mounted token path>" }` or
`{ "value": "<private token>" }`. Prefer file entries. No credential or source
response is submitted via the schedule API or committed to this repository.

The two names are obtained with the exported runtime helper:
`costRefreshSecretName(tenantId, appId, "access_token")` and
`costRefreshSecretName(tenantId, appId, "developer_token")`. They contain the
SHA-256 digest of the scope tuple, preventing delimiter collisions and
cross-app secret selection. The registry itself is at most 1 MiB. An invalid
registry produces only `cost_refresh_secret_registry_invalid`, not its path
or contents. Missing app credentials leave a visible `source_rejected` state.

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
