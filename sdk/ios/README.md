# Open MMP iOS SDK

The iOS SDK is a source-distributed Swift Package for first-party event
delivery, AdServices token handoff, Apple conversion-value updates, and MAX
impression-level revenue mapping. It does not read IDFA, request App Tracking
Transparency permission, fingerprint a device, or link installations across
applications.

## Products

- `OpenMmpCore`: excluded SQLite queue, installation credential, HMAC
  transport, consent, collection lifecycle, and deletion-first reset.
- `OpenMmpAppleAds`: `AAAttribution.attributionToken()` provider. The token is
  delivered as protected evidence and is interpreted only by the server.
- `OpenMmpApplePostback`: versioned conversion schema and independent
  SKAdNetwork and AdAttributionKit update calls.
- `OpenMmpMax`: provider-neutral MAX revenue mapper. The shipping product does
  not depend on the AppLovin SDK; the compile-only probe verifies the adapter
  surface against the exact pinned provider package.
- `OpenMmpObjC`: C ABI used by the Unity iOS source bridge.
- `OpenMmpSample`: synthetic integration sketch compiled by CI.

## Local synthetic gates

Run these commands on macOS with an Xcode toolchain that contains the iOS 17.4
or later SDK:

```bash
swift test --package-path sdk/ios
cd sdk/ios
xcodebuild -scheme OpenMmpObjC -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -scheme OpenMmpSample -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The `sdk-ios` workflow also builds `ProviderCompileProbe` against the exact
AppLovin MAX Swift Package version, lints `PrivacyInfo.xcprivacy`, audits built
symbols, checks the dependency-empty CycloneDX SBOM, and compiles the Unity C#
bridge probe.

## Privacy and collection lifecycle

All SDK-written state is kept below one Application Support directory. The
directory is excluded from backup on every launch and after each write, and
files use `completeUntilFirstUserAuthentication` protection on iOS. SQLite
uses WAL, `synchronous=NORMAL`, and `secure_delete=ON`. Committed pages survive
process death; abrupt power loss between WAL sync points is not guaranteed.

Consent-gated applications must set the Boolean Info.plist key
`OpenMmpCollectionEnabledDefault` to `false` and enable collection only after
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
[`docs/validation/m4-device-checklist.md`](../../docs/validation/m4-device-checklist.md).
Never commit those values or credentials to this public repository.
