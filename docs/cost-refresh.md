# Bounded Daily Cost Refresh

This later-source feature is not part of the frozen v0.2.0 release evidence.
It joins the Google Ads v25 and Apple Ads Platform v1 adapters to the existing
SecretStore, PostgreSQL scheduler and append-only cost ledger. The daily worker
can renew Google access tokens from privately supplied refresh credentials;
Apple access tokens can be renewed using a privately supplied P-256 signing key.
There is no interactive OAuth
authorization flow, new dependency, queue service or database. Both adapters
bound acquisition before publishing a complete local snapshot.

## Cost dimensions and row identity

New runtime cost artifacts use the contract's `dimension_digest`: the JCS SHA-256
of retained `network`, `campaign_id`, `ad_group_id`, `creative_id`, `country` and
`reporting_time_zone` fields only. Only fields present in the emitted artifact
are hashed; an omitted field is not an inserted null. Scope and date belong to
the separate database revision key, not this
public grain digest. Equal public dimensions on two dates still occupy two
internal row keys; latest-revision selection must not collapse them together.
Cost record IDs and the internal scoped/date key keep their earlier derivation.

SQL input snapshots use the recorded artifact's public dimension digest rather
than aliasing the internal key. Stored artifacts, import receipts and metric
runs are never rewritten by this correction. Older runtime artifacts can still
contain the earlier internal digest: SQL replay preserves that recorded identity,
but a strict contract consumer will reject those old wire objects. Reimporting
the identical report retains its existing ID and artifact; a new reported
revision needs its own `as_of`. Do not silently relabel an old object as a newly
validated contract artifact. Reviewed fixture artifacts are unaffected.

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

## Explicit Google ad-group and ad costs

The Google v25 adapter optionally accepts `detail` using the synthetic selection
in [this example](../examples/synthetic/google-cost-detail.json). Add that object
to the ordinary Google cost-schedule registration above. `grain` is `ad_group`
or `ad`; `coverage` must be `explicit_selection`, with 1–100 bounded selections.
Each entry declares a campaign and ad group. Ad grain also requires a provider
ad ID and an explicit first-party `creative_id`; names, assets and coincidental
ID equality never infer this binding. Duplicate provider keys and ambiguous
many-ad-to-one-creative mappings inside a group are refused. Different ad groups
remain separately scoped even if an operator reuses a creative label.

`country_scope: all` requests unsegmented spend and emits no country. Country
filters therefore do not borrow it. Ad-group grain also supports explicit
`geo_country`: select `segments.geo_target_country`, resolve every criterion with
the existing bounded country lookup, and retain that declared provider segment.
This does not attest an equivalence to first-party location or billing geography.
The v25 reference does not list this segment for `ad_group_ad`; ad grain plus
`geo_country` is unsupported and rejected before credentials or network access.
Other grains, automatic hierarchy discovery and creative assets are not provided.

The CLI can use the same mapping without a schedule:

```bash
npm run import:cost:google -- --tenant=tenant-synthetic --app=app-synthetic --customer=4300000000 --currency=USD --since=2026-08-06 --until=2026-08-06 --detail-mapping=examples/synthetic/google-cost-detail.json
```

All values above are synthetic. The command requires separately configured
operator credentials to contact a provider; this repository's acceptance uses
fake responses only. Real selection files and credentials belong outside this
public checkout. The mapping file is capped at 64 KiB and unknown fields are
rejected. Existing CLI behavior without a mapping and schedules without `detail`
retain their historical campaign partitions unchanged.

Each selected report is bounded before publication: exact integer cost micros,
currency/date checks, one explicit binding per returned key, duplicate rejection,
bounded response bytes/batches/rows/requests and complete country resolution.
Malformed/truncated streams, unexpected parent/unknown ad rows, an error tail or
unread page token fail the refresh; a valid response prefix is never committed.
Empty or omitted observations are not filled with zero or a parent allocation.
Acquisition limits and live upstream completeness remain independent questions.

Selected costs carry contract patch 0.4.27's optional
`coverage_scope=matching_detail_only`. A matching explicit detail profile fixes
the ad group and, for ad costs, creative. It may not roll selected children into
a campaign or ad-group denominator. A full parent remains independently eligible
at its own grain, and ordinary overlap rejection remains. Missing coverage is
`undefined/no_attributed_cost`. Current watermark, revision and saved-manifest
recalculation keep this same policy; prior runs are never overwritten.
Latest revisions are selected before coverage eligibility: a newly restricted
revision cannot revive an older, apparently full-coverage cost as a denominator.

Immutable schedule definitions retain the complete private selection and digest.
Registration also saves a reader-safe `adapter_capability`: configured provider,
API version, grain, country scope, selection count, explicit binding class and
`upstream_completeness: unknown`, never account IDs, mapping IDs or credentials.
The existing cost-schedule health endpoint exposes it. Older rows remain null,
not backfilled into a claimed historical capability. New migration 074 appends
the safe column/view projection while the definition remains inaccessible to
readers. CLI imports retain coverage/grain in their cost artifacts; they do not
create or implicitly activate a schedule.

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
- Credential acquisition, all cost partitions and country resolutions must
  validate within one 60-second acquisition deadline. An incomplete/oversized result publishes no
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
  there is no silent retry forever. Credential rejection is terminal
  `reauth_required`, not an endlessly retried expired token.
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
`{ "value": "<private token>" }`. Prefer file entries; the Apple private key
requires a `file` reference. No credential or source
response is submitted via the schedule API or committed to this repository.

Names are obtained with the exported runtime helper
`costRefreshSecretName(tenantId, appId, kind)`. They contain the SHA-256 digest of
the scope tuple, preventing delimiter collisions and cross-app secret selection.
The registry itself is at most 1 MiB. An invalid registry produces only
`cost_refresh_secret_registry_invalid`, not its path or contents. Missing app
credentials leave a visible `source_rejected` state.

For Google daily refresh, supply `developer_token` and all three renewable
credential kinds: `google_client_id`, `google_client_secret` and
`google_refresh_token`. The operator obtains and authorizes these outside
OpenMasu. All three are required together; a partial configuration fails closed
with `reauth_required` even if an `access_token` is also present. Complete
renewable credentials take precedence over that static token. When none of the
three is configured, the existing `access_token` plus `developer_token` setup
continues to work. The standalone import CLI retains its existing static-token
configuration; automatic renewal here belongs to the scheduled worker.

Google credentials are exchanged only at `https://oauth2.googleapis.com/token`
using the refresh-token grant; redirects are refused. Both providers share
bounded exchange and cache handling. Token responses are bounded
to 64 KiB and ten seconds within the overall acquisition deadline. Access tokens
are reused in memory until five minutes before their reported expiry. The cache
holds at most 128 provider/app scopes and stores only hashed scope/credential keys;
tokens and credential material are never persisted in a checkpoint or report.
Concurrent calls for the same scope and exact credentials share an exchange.
One cancelled caller cannot cancel another's exchange. This is a process-local
cache, not a global token service: the existing database claim/lease coordinates
scheduled acquisitions across worker replicas.

File-backed credential contents are read for each acquisition. Changing a
renewable credential invalidates the old cached token; an older in-flight
exchange cannot replace the new credential's cache entry. A report HTTP 401
also invalidates the cache and ends the schedule with `reauth_required`.
Rejected grants/client credentials likewise require operator action. Repair
private credentials, disable the failed schedule and register a new revision.
Token transport errors, timeouts, HTTP 408/429 and temporary server errors use
the existing bounded three-attempt policy without changing the saved report
range or `as_of`. Malformed successful token responses fail closed. Provider
error bodies, tokens, credential values and private file paths are never emitted
in health responses; prior cost revisions remain intact on every failure.

For Apple daily refresh, supply all four kinds: `apple_ads_client_id`,
`apple_ads_team_id`, `apple_ads_key_id` and `apple_ads_private_key`. The private
key must be an unencrypted P-256 PEM file mounted read-only outside the public
repository; it may contain normal PEM newlines. OpenMasu does not generate an
operator key, upload a public key or request account access. The operator obtains
the three identifiers and registers the matching public key with Apple privately.
Complete credentials take precedence over `apple_ads_access_token`; when all
four are absent that static-token configuration remains supported. Any partial
configuration or invalid key fails closed with `reauth_required`.

The worker signs a fresh ES256 client-secret JWT only when an exchange is needed.
It sets `kid` to the supplied key ID, `iss` to the team ID, `sub` to the client ID,
`aud` to `https://appleid.apple.com`, and `iat`/`exp` to the current UTC epoch and
five minutes later. This is below Apple's less-than-180-day maximum. It posts
the JWT in the form body to the fixed `https://appleid.apple.com/auth/oauth2/token`
endpoint with `grant_type=client_credentials` and `scope=searchadsorg`; the granted
scope must match. JWTs, private key contents and tokens never enter URLs, saved
schedules, cost artifacts or health output. Apple and Google token caches and
401 invalidation are separate even for the same tenant/app. Replacing the
configured PEM file invalidates Apple's cached token on the next acquisition.
Rejected clients and report 401s are terminal `reauth_required`; transient token
failures use the same durable retry policy. Replacing a revoked key also requires
privately registering its public key and updating its key ID with Apple.

Bootstrap propagates the default-off mode and registry path into runtime.env,
including an existing generated environment. For Compose, mount the private
registry and token files read-only into the **worker**, at the container paths
named in that registry. The repository does not mount host credential paths
automatically. The registry's entry mapping is loaded at startup: restart the
worker after changing registry entries or their paths. Replacing the contents
of an already configured secret file is observed on the next acquisition.

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
Renewal tests additionally cover expiry, next-day scheduled ingestion,
single-flight isolation, file rotation, static compatibility, bounded token
responses/deadlines, terminal reauthorization and saved-range retries. Apple
tests verify JWT claims and P-256 signatures using freshly generated synthetic
keys, reject other curves, and preserve saved history after a report 401 or
rejected client credentials. All
provider responses and credential values in these tests are synthetic.
No new test harness or live account check is required.

## Primary references

Confirmed 2026-10-02, against public first-party documentation:

- [Google Ads REST search and SearchStream](https://developers.google.com/google-ads/api/rest/common/search)
- [Streaming reports](https://developers.google.com/google-ads/api/docs/reporting/streaming)
- [API error handling](https://developers.google.com/google-ads/api/docs/best-practices/understand-api-errors)

Live permissions, quotas, account timezone, token validity/rotation, report
availability and retry snapshot stability remain unverified. Read acceptance
and a complete local snapshot do not prove upstream completeness.

Google OAuth sources confirmed 2026-10-29:

- [Credential management](https://developers.google.com/google-ads/api/docs/oauth/credential-management): access-token expiry and refreshing within five minutes of expiry.
- [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server): refresh-token grant fields and the fixed token endpoint.

Live grant issuance, consent, revocation and provider acceptance remain
unverified; synthetic renewal does not establish an authorized live connection.

Detail-query sources confirmed 2026-10-25:

- [v25 ad-group fields](https://developers.google.com/google-ads/api/fields/v25/ad_group?hl=en): cost micros, date and target-country segmentation.
- [v25 ad fields](https://developers.google.com/google-ads/api/fields/v25/ad_group_ad?hl=en): cost micros and date; target-country segmentation is not declared here.
- [Query structure](https://developers.google.com/google-ads/api/docs/query/structure): fixed resource and validated finite date/ID predicates.
- [Continuous streamed responses](https://developers.google.com/google-ads/api/docs/reporting/streaming): a stream is not a sequence of Search pages; failed acquisition must not publish its prefix.

These references do not establish account access, all campaign-type coverage,
operator mapping correctness, source completeness, first-party geographic
equivalence or agreement with invoices. Those remain unverified.

Apple OAuth sources confirmed 2026-10-29:

- [Implementing OAuth for the Apple Ads Platform API](https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api): P-256, ES256 claims, client-credentials grant, fixed endpoint, scope and token expiry.
- [Managing Ad Accounts and API Access](https://developer.apple.com/documentation/apple-ads-platform-api/access-overview): bearer tokens and account-scoped access.
- [Calling the Apple Ads Platform API](https://developer.apple.com/documentation/apple-ads-platform-api/calling-apple-ads-platform-api): Platform v1 headers and unauthorized/forbidden outcomes.

Live key registration, provider acceptance, key-revocation propagation and
account permissions remain unverified. Synthetic renewal proves local behavior,
not a live authorized connection. Apple documents an access-token lifetime of
one hour; the worker uses the validated response expiry and refreshes early.

Apple report sources confirmed 2026-10-11:

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
