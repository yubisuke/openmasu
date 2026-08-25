# OpenMasu Unity SDK

The package in `com.openmasu.sdk` targets Unity 2022.3 LTS (best effort) and Unity 6 LTS. Android `minSdk` is 24.

M2 ships source and local build instructions only. It does not publish a Maven or UPM artifact. Build the Android modules in `sdk/android`, publish the resulting dependency to an operator-controlled local Maven repository, and replace the placeholder `dev.openmasu:core:0.1.0` coordinate in `Runtime/OpenMasu.androidlib/build.gradle`.

The `.androidlib` resolution path from a UPM package is not established by Unity's primary documentation. The operator checklist records an actual export on both supported Unity lines. If the package directory is not resolved, use the locally built AAR as the documented fallback; do not download or commit a third-party binary.

MAX integration must subscribe separately to Interstitial, Rewarded, Banner, and MRec revenue callbacks. The compile probe keeps the four-format subscription table closed even when AppLovin is not present in the test environment.

Import the `Android measurement sample` from Package Manager to obtain a small `MonoBehaviour` that initialises the bridge and exposes a synthetic custom-event button. Supply deployment credentials outside source control; the sample intentionally contains no endpoint, key, secret, campaign, or device identifier.

## Settled commerce events

Use `OpenMasuClient.TrackPurchase(transactionId, amountUnscaled, amountScale,
currency)` and `TrackRefund(transactionId, originalTransactionId,
amountUnscaled, amountScale, currency)`. Android and iOS always attach the
current installation and emit settled, nonnegative provider-neutral commerce
events. Their opaque deterministic IDs include every stable commerce field, so
an exact repeat is locally idempotent while a changed amount or currency is not
silently discarded. On iOS, the C bridge calls the anchored Swift
`trackSettledPurchase` and target-free refund helpers; deprecated unanchored
Swift overloads remain compatibility-only. Pending and reversed lifecycle
evidence remains limited to canonical/import fixture surfaces, not these public helpers.

## Deep links

Register `OpenMasuClient.SetDeepLinkListener`, call
`AttachUnityDeepLinkForwarding()` once after creating the client, and continue
calling `PumpCallbacks()` on the Unity main thread. The package forwards both
`Application.absoluteURL` at cold start and `Application.deepLinkActivated`
while running. The typed callback contains the validated destination, source,
status, slug, and declared parameters; the host game remains responsible for
validating the destination again and changing scenes or UI.

For Android, replace `OPENMASU_LINK_HOST` in the generated manifest with the
deployment's registered HTTPS link host. The App Link filter contains only
`http` and `https`; any operator-defined custom scheme must use a separate
intent filter. Teams with a custom Unity activity must forward its incoming URL
to `OpenMasuClient.HandleDeepLink`. For iOS, put `linkHosts` in
`ProjectSettings/OpenMasuIOSSettings.json`; the postprocessor writes both
`OpenMasuLinkHosts` and `com.apple.developer.associated-domains` without a
development-mode query.

Direct delivery is supported on Android and iOS. Deferred delivery is Android
only through Google Play Install Referrer. Actual Unity exports and platform
domain verification remain the operator procedures in
[`docs/validation/deeplink-device-checklist.md`](../../docs/validation/deeplink-device-checklist.md).
