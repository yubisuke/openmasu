# Apple conversion meanings

The opt-in `event_revenue_v1` profile connects local SDK evaluation and an
operator-selected postback explanation to one registered canonical SHA-256
digest. It does **not** establish which schema Apple used. Existing count-based
schemas and the bundled default are unchanged and are not reinterpreted.

## Register and deploy

Post `schema_version` and `definition` to the existing administrator endpoint
`/v1/admin/apps/<app>/conversion-schemas`. Versions are immutable and app/tenant
scoped. Readers cannot register them. The new profile returns
`canonical_definition` (a JSON string), `schema_version` and `schema_digest`;
save all three for the SDK. This complete definition is synthetic:

```json
{
  "profile": "event_revenue_v1",
  "schema_version": "2.0.0",
  "effective_from": "2026-01-01T00:00:00.000Z",
  "effective_to": "2027-01-01T00:00:00.000Z",
  "event_keys": ["onboarding_complete", "purchase"],
  "revenue": { "event_key": "purchase", "currency": "USD", "amount_scale": 2, "thresholds": ["0", "100", "500"] },
  "coarse": { "medium_from": 4, "high_from": 8 },
  "lock_at_maximum": true
}
```

Array order defines bits for one to three distinct event keys. Each key means
observed at least once, not an event count. Only the revenue key accepts an
optional nonnegative integer amount in the declared currency/scale, without FX
or floating-point conversion. Two to eight strictly increasing boundaries start
at zero; integers have at most 15 digits. Unknown fields/keys, invalid dates and
overlapping boundaries are rejected. There must be at most 64 states.

For each explicitly selected local window:

```text
fine = observed_event_bitmask + 2^(number_of_event_keys) * revenue_bucket_index
```

Medium/high start at the specified fine values. Optional locking happens only
at the maximum state: every key and the highest revenue bucket. This monotonic
encoding is a profile policy, not an Apple-wide rule; modern SKAN permits
decreasing values too. Purchase `100` alone means fine 6/medium in the example;
adding onboarding means 7. Purchase total `500` plus onboarding means 11/high,
locked. Fine 7 declares `[100,500)` minor units, not an exact sale. Coarse medium
leaves possible fine states 6 and 7. Null stays unknown, not zero revenue.

## Swift controller

Load UTF-8 `canonical_definition` with
`ConversionMeaningSchema.load(data:registeredVersion:registeredDigest:)`.
Use the same version/digest in `OpenMasuConfiguration`, then construct
`MeaningConversionController(schema:sdk:updater:)` with that SDK and
`SystemAppleConversionUpdater()`. A mismatch is refused. Do not also use the
legacy `ConversionValueController` for the same conversion.

```swift
let update = try await controller.record(
  eventID: "synthetic-purchase-operation-1", eventKey: "purchase",
  revenueUnscaled: "100", windowSequence: 0, consentGranted: true
)
```

Use a stable host-owned local operation key, never a user/device/transaction
identifier. Its hash is kept locally, not uploaded. Identical retries do not
sum revenue again; changed payloads under the same key fail. Up to 512 operations
per window are retained; overflow fails rather than evicting dedupe evidence.
Stored revenue saturates at the last boundary because higher sums have the same
bucket. One SDK instance must own its storage directory.

Successful state survives restart in the existing backup-excluded SQLite
metadata. The SDK serializes updates and checks collection, consent and reset
state. Denial/withdrawal removes this state, preserves the consent barrier across
restart, and prevents in-flight state from being resurrected. Reset also clears
it. Platform failure does not advance state. Lock is window-local, not permanent.

This profile is **install-only, iOS 18+ with the system updater** and host-declared
windows 0/1/2. The host retains the correct window across restarts; the SDK does
not discover Apple's hidden window state or handle re-engagement tags. Deployment
dates are half-open midnight-UTC declarations checked before SDK operations,
not inferred installation or receipt dates. A definition cannot be replaced
mid-measurement while its stored state remains. Legacy APIs remain available.
Swift is mirrored into the Unity iOS sources; no new C# configuration facade or
published SDK asset is implied.

Apple APIs and SQLite are not one transaction. A crash after OS acceptance but
before persistence, or one-framework success followed by another-framework
failure, may retry the same update. An already-started call cannot be withdrawn.
Successful completion is not exactly-once submission, OS-state or delivery proof.

## Explain without inventing a binding

The [postback report](apple-postback-observations.md) lists candidate versions,
digests and deployment periods. Multiple candidates are ambiguous. Even one
active candidate is not automatically selected. No latest-version or receipt-
date inference is performed. At most 64 active candidates are read.

Supply **both** `schema_version` and `schema_digest` in the reader API, or use
the report's explicit-selection form. Unknown pairs fail with 404. The selected
definition's stored digest is verified before decoding each retained bucket.
Legacy definitions, failed verification, absent values, unsupported windows/types
and impossible values remain unverified without fabricated numbers.

Every explanation keeps `state: unverified`; a selected definition has reason
`operator_selected_definition_not_postback_bound`. Digest equality proves
definition identity only. `conversion_schema: not_recorded` still describes the
missing postback binding. Coarse output lists possible meanings and open-ended
ranges, never midpoints, revenue totals or ROAS. Current privacy filtering applies
even to old cutoffs. Qualified-postback metrics are unchanged.

## Evidence and boundaries

Shared Swift/server vectors specify fine 0/1/6/7/11 and independent expected
ranges. Swift tests cover reversed order, duplicate, restart, window lock,
failure/conflict and in-flight withdrawal. The existing receiver integration
checks conflicting definitions, digest/permissions, unknown/legacy selection,
API/SSR agreement and privacy. No contract, old golden, dependency or CI job
changes are required. Real devices, deployment mapping, Apple delivery and
platform approvals remain unverified.

Apple primary sources checked **2026-10-11**:

- [Conversion windows and current-window locks](https://developer.apple.com/documentation/adattributionkit/receiving-postbacks-in-multiple-conversion-windows)
- [SKAdNetwork version-specific updates](https://developer.apple.com/documentation/storekit/skadnetwork/updatepostbackconversionvalue(_:completionhandler:))
- [Framework interoperability and ignored calls without pending postbacks](https://developer.apple.com/documentation/adattributionkit/adattributionkit-skadnetwork-interoperability)
- [Conversion types](https://developer.apple.com/documentation/adattributionkit/receiving-ad-attributions-and-postbacks)

ATT is not required for these Apple aggregate APIs. That does not remove the
application's own consent policy. No IDFA, ATT prompt, fingerprinting or real
identifier/key is added.
