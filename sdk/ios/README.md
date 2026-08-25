# OpenMasu iOS SDK

The iOS SDK is a source-distributed Swift Package for first-party event
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
  SKAdNetwork and AdAttributionKit update calls.
- `OpenMasuMax`: provider-neutral MAX revenue mapper. The shipping product does
  not depend on the AppLovin SDK; the compile-only probe verifies the adapter
  surface against the exact pinned provider package.
- `OpenMasuObjC`: C ABI used by the Unity iOS source bridge.
- `OpenMasuSample`: synthetic integration sketch compiled by CI.

## Local synthetic gates

Run these commands on macOS with an Xcode toolchain that contains the iOS 17.4
or later SDK:

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

## Settled commerce events

`OpenMasuCore` exposes `trackSettledPurchase(transactionId:amountUnscaled:amountScale:currency:)`
and the target-free
`trackRefund(transactionId:originalTransactionId:amountUnscaled:amountScale:currency:)`.
Both helpers accept only nonnegative money, always attach the current
installation, emit `financial_status=settled`, and use an opaque deterministic
event ID over every stable commerce field. New pending and reversed lifecycle
evidence remains limited to canonical/import fixture surfaces. Refund
target resolution is performed by the server from the installation, original
transaction, and currency.

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

Consent-gated applications must set the Boolean Info.plist key
`OpenMasuCollectionEnabledDefault` to `false` and enable collection only after
their own policy allows it. Unity's postprocessor writes `false` unless the
operator explicitly changes the project setting. Disabling collection performs
no network or AdServices read. Withdrawal purges consent-required queued events.
Installation reset sends the credential-bound deletion request before creating
a new identifier and does not fetch AdServices again.

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
