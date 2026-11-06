# Subscription observations

Open the app dashboard's **Subscription observations** link, or read
`GET /v1/admin/apps/{app_id}/subscriptions` with an app-scoped read-capable
bearer key. The dashboard uses its existing session, never the bearer key.
Both surfaces use the same read-only aggregate projection and reader pool.

Required query parameters:

- `date_from`: inclusive UTC day, for example `2026-08-01`.
- `date_to`: exclusive UTC day, for example `2026-08-03`; maximum 31 days.
- `watermark_at_most`: fixed canonical UTC evidence cutoff, for example
  `2026-08-05T00:00:00.000Z`.

Unknown/duplicate parameters and identifying filters are rejected. Reads are
limited to 10,000 retained source rows across the app's history through the
cutoff and a five-second database statement timeout. Oversized reads fail with
413; unavailable reads fail with 503. Neither returns a partial report.

## Meaning

This is Google Play observation analysis, **not an entitlement service**.

| Output | Evidence and meaning |
| --- | --- |
| `last_observed_states` | Counts of uniquely bound token series by last retained read-back state, with the oldest/newest observation time in each group. No series identifiers are exported. The daily date range does not truncate state history. |
| `daily.verified_renewals` | Distinct accepted, verified renewal purchase records on their UTC service-period start day. Notifications do not supply money or count as verified renewals. |
| `daily.observed_expiries` | The latest verified expired boundary per uniquely bound, single-item token series. Repeated deliveries do not add expiries. A newer expired read-back correcting the boundary moves its date rather than adding a second expiry. Conflicting equal-order boundaries are omitted. This is not a churn count. |
| `daily.notification_signals` | Distinct token/kind/provider-event-time observations, including unknown series. Different Pub/Sub messages repeating the same signal count once. |
| `daily.unknown_series_signals` / `unknown_series_observations` | Unbound signals/read-backs, not unique subscribers. Missing historical metadata, multiple items and replacement-token chains remain unknown. |
| `evidence_times` | Latest notification occurrence, notification receipt and successful read-back observation are separate timestamps. |

The protected binding reuses the existing verified initial subscription result
and its retained source/settled raw records. There is no new table, provider
poller, SDK identifier or inferred cross-token identity. A successful state
read-back alone cannot invent a verified purchase binding. Replacement chains
are not merged by product, order prefix, installation or account name.

Canceled and expired are distinct. Old observations never become current
entitlement or period-end subscriber counts. State ordering uses read-back
request start, so an older request completing later cannot overwrite a newer
one. Conflicting equal-start states are unknown. The recorded observation time
is still disclosed; the provider does not supply a snapshot-version guarantee.
Only bounded state names are rendered. A newer non-expired observation does not
erase an earlier observed expiry; neither observation proves continuous access.

## Cutoffs, corrections and privacy

The cutoff applies to received/decided evidence, not just the provider event
date. A late verified renewal or expired boundary can appear in a later-cutoff
report for an earlier day. The projection reads existing retained evidence;
it does not rewrite immutable metric runs or maintain a second state cache.

Every read holds the existing privacy read fence and a repeatable-read snapshot.
Pending privacy work returns 409. Current raw-record lifecycle and completed
app/tenant deletions apply even to an earlier cutoff. Installation deletion
removes the bound source and all its observations from the projection; the same
rules apply after backup restore and privacy reapplication. Unknown series
cannot be assigned to an installation without evidence, but remain subject to
app/tenant deletion. Digests, tokens, orders, installation IDs and raw payloads
are not response fields. The service performs no provider calls during a read.

Zero means no qualifying retained evidence, not zero provider activity.
Completeness remains unknown. Apple analytics projection, cross-token renewal
chains, trial conversion, MRR, entitlement, future churn and live-provider
qualification are outside this slice. No published SDK release is changed.

## Primary sources

Checked 2026-11-06:

- [Google Play subscription lifecycle](https://developer.android.com/google/play/billing/lifecycle/subscriptions): notifications prompt authoritative read-back; cancellation and expiration are distinct.
- [SubscriptionPurchaseV2](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2): subscription states, item expiry timestamps and linked-purchase-token relationships. Those relationships are deliberately not inferred as one analytical series here.

Synthetic evidence belongs to the existing subscription RTDN/read-back,
privacy backup/restore and unit suites. It does not establish real store
delivery, notification completeness, device behavior or entitlement correctness.
