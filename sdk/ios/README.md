# OpenMasu iOS SDK

The iOS SDK is a source-distributed Swift Package with a deployment floor of
iOS 16. It provides first-party event
delivery, Universal Link routing, AdServices token handoff, Apple conversion-value updates, and MAX
impression-level revenue mapping. It does not read IDFA, request App Tracking
Transparency permission, fingerprint a device, or link installations across
applications.

## Products

- `OpenMasuCore`: excluded SQLite queue, installation credential, HMAC
  transport, consent, collection lifecycle, Universal Link parser, and deletion-first reset.
- `OpenMasuAppleAds`: `AAAttribution.attributionToken()` provider. The token is
  delivered as protected evidence and is interpreted only by the server.
- `OpenMasuApplePostback`: versioned conversion schema and independent
  SKAdNetwork and AdAttributionKit update calls. Callers may target install or
  re-engagement postbacks on iOS 18+ and may pass an opaque conversion tag on
  iOS 18.4+; tags are not written to OpenMasu analytics events or logs.
- `OpenMasuMax`: provider-neutral MAX revenue mapper. The shipping product does
  not depend on the AppLovin SDK; the compile-only probe verifies the adapter
  surface against the exact pinned provider package.
- `OpenMasuObjC`: C ABI used by the Unity iOS source bridge.
- `OpenMasuSample`: synthetic integration sketch compiled by CI.

## Local synthetic gates

Run these commands on macOS with an Xcode toolchain that contains the current
iOS SDK. The package can deploy to iOS 16; baseline AdAttributionKit calls are
runtime-gated to iOS 17.4, conversion-type targeting to iOS 18, and conversion
tags to iOS 18.4. Requested targeting is never silently broadened on an older
OS:

```bash
swift test --package-path sdk/ios
cd sdk/ios
xcodebuild -scheme OpenMasuObjC -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -scheme OpenMasuSample -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The `sdk-ios` workflow also builds `ProviderCompileProbe` against the exact
AppLovin MAX Swift Package version, lints `PrivacyInfo.xcprivacy`, audits built
symbols, checks the dependency-empty CycloneDX SBOM, and compiles the Unity C#
bridge probe.

## AdAttributionKit host-app configuration

The Swift Package cannot edit its host application's Info.plist. To receive
developer copies of re-engagement postbacks, configure the HTTPS
`AttributionCopyEndpoint` and explicitly set
`EligibleForAdAttributionKitReengagementPostbackCopies` to `true` in the host
application. Without that Boolean opt-in, Apple does not deliver those copies.
Set both `AttributionCopyEndpoint` and
`NSAdvertisingAttributionReportEndpoint` to the deployment's HTTPS origin,
without a path, query, or fragment. Apple derives the AdAttributionKit and
SKAdNetwork well-known receiver paths from that origin; do not put `/aak` or
`/skan` in the plist values. Apple documents that SKAdNetwork uses the
registrable part of the configured domain and ignores subdomains, so that
registrable domain must serve the well-known route.

`EligibleForAdAttributionKitOverlappingConversions` remains `false` unless the
application deliberately supports multiple simultaneous re-engagement
conversion windows. Enabling it makes Apple append conversion tags to the
re-engagement URL. The host application owns any protected mapping, persistence,
and later retrieval of those opaque bookmarks; OpenMasu exposes parsing and
targeted update helpers but never writes a tag to its analytics queue or logs.
Do not enable overlapping conversions until that caller-owned lifecycle and the
corresponding device test have been implemented.

`ConversionValueController` commits a signal only after the platform update
succeeds. A failed SKAdNetwork or AdAttributionKit call can therefore be
retried against the same successful signal history. If an explicitly enabled
OpenMasu event sink fails after the platform accepted the update, the platform
state remains committed rather than being rolled back locally. Conversion tags
are accepted only for an explicitly targeted re-engagement update; they never
silently broaden an update to install or every active postback.

## Queue identity

A normal retry is idempotent only when every persisted field is identical. A
deterministic commerce retry may use a new occurrence time and queue sequence,
but its event ID, event name, purpose, and payload must match. Any other
event-ID reuse, or a processing sequence already owned by another event,
raises `queue_event_conflict` before eviction. Android and iOS run the same
synthetic cases from `sdk/queue-semantics-vectors.json`.

## Immutable source bundle

For download and checksum commands, see [SDK distribution](../../docs/sdk-distribution.md).

For configured candidate `v0.3.0-rc.1`, the repository release tool packages the
tracked `sdk/ios` tree as a deterministic source ZIP tied to the same
`0.3.0-rc.1` SDK identity and commit as the Android Maven layout and Unity UPM
archive. Treat it as release evidence only when the matching annotated tag names
the exact green source commit. The tool does not
publish a Swift registry package or binary XCFramework. Run the repository-level commands in
[`docs/operations/release.md`](../../docs/operations/release.md), then verify
the archive through `SHA256SUMS` and `release-manifest.json`. The macOS
`sdk-ios` workflow remains the authoritative Swift test and Simulator-build
evidence for that source revision.

## Settled commerce events

### Verified App Store measurement

Use the separate preparation/submission APIs for installation-linked App Store
measurement. They do not call StoreKit, grant content, finish a transaction, or
create client-reported purchase events. Call `initialize()` successfully first;
both APIs require the current installation credential, enabled collection, no
consent barrier or reset, and explicit `revenueMeasurementConsent: true`.

1. Persist a request UUID in the host application's protected retry state, then
   call `prepareAppStorePurchase(productId:requestId:revenueMeasurementConsent:)`.
   Reuse the same UUID after a timeout. The typed result contains a server-issued
   `appAccountToken`, intent, product and server-selected environment. Preparation
   is not a purchase; never generate a fallback token.
2. Pass `prepared.appAccountToken` to StoreKit's
   `.appAccountToken(...)` purchase option for that product. The host owns the
   StoreKit result, entitlement verification, pending/cancelled purchases and
   `Transaction.finish()` after delivering its content. A measurement failure
   must not be confused with a failed payment or trigger another purchase.
3. For the corresponding verified StoreKit result, call
   `submitAppStorePurchase(prepared:signedTransaction:revenueMeasurementConsent:)`
   with `result.jwsRepresentation`. The server independently verifies the signed
   data, intent and scope before durable admission. Only an exact `202` response
   with the matching intent and `state: pending` is accepted; it is not recognized
   revenue. The existing history worker must complete the financial projection.

`OpenMasuPreparedAppStorePurchase` is `Codable` for a caller-owned protected retry
lifecycle. It includes the installation and credential ID, not a credential
secret. Never log it, the token, or the signed transaction. The SDK does not
persist these values, run a background purchase retry, or put them in its event
queue. Persist and retry the same preparation and signed evidence privately when
appropriate; do not also call `trackSettledPurchase` for the same App Store
transaction. A timeout leaves server admission unknown, not unsuccessful.
Reusing the same evidence is idempotent on the server. Discard host-owned retry
state on withdrawal/deletion; a prepared value cannot be moved to a new
installation after reset. The SDK discards a response if consent, collection or
installation state changed while awaiting it, even if collection was re-enabled
before the response arrived. This does not cancel an already-sent server request;
server withdrawal/deletion and the worker's privacy fence remain authoritative.

The opt-in server configuration and remaining unverified provider boundaries are
documented in [verified commerce](../../docs/design/verified-commerce-lifecycle.md).
No client token, price, account, or environment fallback is inferred when that
configuration is unavailable. The host may continue its independent payment flow
without this measurement binding. Existing custom `OpenMasuTransport`
implementations remain compatible; purchase helpers require the optional
`OpenMasuAppStoreTransport` capability and otherwise throw
`purchaseTransportUnsupported`. Other failures preserve HTTP status without
exposing response bodies. [The compiled sample](Sample/README.md) shows the
StoreKit boundary. These public helpers are Swift APIs; Unity's vendored Swift
is synchronized, but its C# bridge does not expose these purchase helpers.

Primary Apple references checked 2026-10-02:

- [appAccountToken purchase option](https://developer.apple.com/documentation/storekit/product/purchaseoption/appaccounttoken(_:)).
- [Signed transaction representation](https://developer.apple.com/documentation/storekit/verificationresult/jwsrepresentation-21vgo).
- [Finishing a transaction](https://developer.apple.com/documentation/storekit/transaction/finish()).

### Explicit client-reported commerce

`OpenMasuCore` exposes `trackSettledPurchase(transactionId:amountUnscaled:amountScale:currency:)`
and the target-free
`trackRefund(transactionId:originalTransactionId:amountUnscaled:amountScale:currency:)`.
Both helpers accept only nonnegative money, always attach the current
installation, emit `financial_status=settled`, and use an opaque deterministic
event ID over every stable commerce field. New pending and reversed lifecycle
evidence remains limited to canonical/import fixture surfaces. Refund
target resolution is performed by the server from the installation, original
transaction, and currency.
These helpers are a different evidence path, not StoreKit verification. Do not
send the same purchase through both client-reported and verified App Store paths.

The deprecated `trackPurchase(..., financialStatus:)` and explicit-target
`trackRefund(..., correctionTargetRecordId:, ...)` overloads retain their
original unanchored payloads and random event IDs for source and wire
compatibility. The purchase status defaults to `settled`; the explicit-target
refund emits `reversed`.

## Universal Links

Configure `deepLinkHosts` on `OpenMasuConfiguration`, register a listener with
`setDeepLinkListener`, and forward either the UIKit `NSUserActivity` or SwiftUI
`URL` to `handleDeepLink`. Delivery to the listener is synchronous and occurs
before the measurement event is queued. The SDK validates the host and closed
`/r/<slug>/<destination>` grammar, but the host app must validate the typed
destination again before routing its own UI. The SDK never calls
`UIApplication.open` and never uses pasteboard.

The app must carry `applinks:<host>` in Associated Domains and the host must
serve an extensionless `/.well-known/apple-app-site-association` response over
HTTPS without a redirect. OpenMasu does not provide iOS deferred deep linking;
Universal Links cover installed-app delivery only.

## Privacy and collection lifecycle

All SDK-written state is kept below one Application Support directory. The
directory is excluded from backup on every launch and after each write, and
files use `completeUntilFirstUserAuthentication` protection on iOS. SQLite
uses WAL, `synchronous=NORMAL`, and `secure_delete=ON`. Committed pages survive
process death; abrupt power loss between WAL sync points is not guaranteed.

The queue defaults to at most 10,000 records and 16 MiB of logical content;
both values are configurable through `OpenMasuConfiguration`. Logical bytes are
the UTF-8 lengths of the stored event ID, event name, processing purpose,
payload JSON, and occurrence timestamp plus 16 bytes for the sequence and
enqueue timestamp, not the SQLite file size. At capacity the SDK evicts the
oldest analytics evidence first and protects install and revenue evidence over
analytics. The latest `consent_changed` event is always admitted, even when the
queue contains only higher-value measurement evidence. `queueHealth()` exposes
only pending count, logical bytes, cumulative evictions, and cumulative
rejections; it never returns queued payloads or identifiers.

Consent-gated applications must set the Boolean Info.plist key
`OpenMasuCollectionEnabledDefault` to `false` and enable collection only after
their own policy allows it. Unity's postprocessor writes `false` unless the
operator explicitly changes the project setting. Disabling collection performs
no network or AdServices read. Withdrawal or denial persists a local barrier,
purges consent-required queued events, and re-applies the purge before admission
or delivery after restart or installation reset. Only an explicit `granted` or
`not_required` update removes that barrier; `unknown` does not.
Installation reset sends the credential-bound deletion request before creating
a new identifier and does not fetch AdServices again. The SDK uses the canonical
`POST /v1/privacy/installation` route; the server also retains the older
`POST /v1/privacy/on-device` route as an authenticated compatibility alias.

The bundled privacy manifest declares tracking disabled and documents the SDK's
linked device identifier, product interaction, purchase history, and advertising
data categories. Operators must verify the final application manifest and App
Privacy Details against the features they actually enable.

## Validation boundary

All repository fixtures and tests are synthetic. Real devices, App Store
install/reinstall behavior, Apple Ads responses, Apple developer-copy delivery,
live MAX callbacks, and Unity Xcode exports are operator evidence tracked in
[`docs/validation/m4-device-checklist.md`](../../docs/validation/m4-device-checklist.md)
and [`docs/validation/deeplink-device-checklist.md`](../../docs/validation/deeplink-device-checklist.md).
Never commit those values or credentials to this public repository.
