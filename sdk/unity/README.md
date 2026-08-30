# OpenMasu Unity SDK

The package in `com.openmasu.sdk` targets Unity 2022.3 LTS (best effort) and Unity 6 LTS. Android `minSdk` is 24.

The standard source package includes the Android core, Google Play Install Referrer, Meta Install Referrer, and MAX modules. `OpenMasuOptions.EnablePlayReferrer` defaults to `true`; set it to `false` to make the bridge emit explicit unavailable Play evidence without reading the provider. Set `OpenMasuOptions.MetaAppId` to the deployment's non-secret Meta application ID to enable the Meta reader. A blank or invalid value disables that reader. Provider modules are discovered defensively so a deliberately reduced local package fails closed instead of crashing. No provider credential or campaign value belongs in the package.

OpenMasu does not publish a Maven or UPM registry artifact. CI and local release tooling generate a versioned Maven-layout directory and `com.openmasu.sdk-<version>.tgz` from one source revision. The generated UPM archive carries the four OpenMasu Android dependency AAR/POM pairs inside its `.androidlib`; its build postprocessor adds a `dev.openmasu`-only repository to generated Gradle settings. Third-party Android dependencies still resolve from the standard Google and Maven Central repositories. See [the release runbook](../../docs/operations/release.md).

The repository's standalone Gradle consumer gate rejects project-level repositories and compiles the generated UPM package with `RepositoriesMode.FAIL_ON_PROJECT_REPOS`. The local probe also imports that archive into a temporary Unity project, exports Android Gradle, validates generated App Links and repository wiring, and builds a synthetic APK. Unity 6.3.11f1 has synthetic package/export evidence; Unity 2022.3, physical-device execution, and live platform signals remain operator checks.

Generate the local bundle after building the five release AARs and SDK SBOMs:

```bash
npm run sbom
./sdk/android/gradlew -p sdk/android :core:assembleRelease :installreferrer:assembleRelease :metareferrer:assembleRelease :max:assembleRelease :unitybridge:assembleRelease verifySdkSbom --no-daemon
python tools/build-sdk-release.py --reproducibility-check
python tools/verify-unity-upm.py
```

Run the actual Unity 6 headless export probe on a machine with the Android
module installed (replace the Editor path for that machine):

```powershell
npm run probe:unity-android-export -- --unity "C:\Program Files\Unity\Hub\Editor\6000.3.11f1\Editor\Unity.exe" --bundle build/sdk-release/openmasu-sdk-0.2.0-rc.4
npm run probe:unity-android-export -- --unity "C:\Program Files\Unity\Hub\Editor\6000.3.11f1\Editor\Unity.exe" --bundle build/sdk-release/openmasu-sdk-0.2.0-rc.4 --without-settings
```

The second invocation proves that packaged Android dependency resolution does
not depend on the optional App Links settings file. Both probes create and
remove a temporary synthetic project. They do not use a
device, account, credential, provider payload, or production identifier.

For configured candidate `v0.2.0-rc.4`, the output under
`build/sdk-release/openmasu-sdk-0.2.0-rc.4/` contains Maven AAR/POM pairs, the
UPM archive, the Swift Package source archive, three CycloneDX SDK SBOMs, a
source/toolchain manifest, and `SHA256SUMS`. It is a local CI artifact, not a
public registry publication. Treat the bundle as release evidence only when the
matching annotated tag names the exact green source commit.

MAX integration must subscribe separately to Interstitial, Rewarded, Banner, and MRec revenue callbacks. The Unity bridge carries the callback's normalized `interstitial`, `rewarded`, `banner`, or `mrec` value into `extensions.ad_format` on both Android and iOS. Unknown formats remain explicit as `unknown`; they are never guessed from placement or ad-unit identifiers. The compile probe keeps the four-format subscription table and Android argument shape closed even when AppLovin is not present in the test environment.

Import the `Android measurement sample` from Package Manager to obtain a small `MonoBehaviour` that initialises the bridge and exposes a synthetic custom-event button. Supply deployment credentials outside source control; the sample intentionally contains no endpoint, key, secret, campaign, or device identifier.

`OpenMasuClient.ResetInstallationId` delegates to the native deletion-first
reset flow. Android and iOS use `POST /v1/privacy/installation`; the server
retains `POST /v1/privacy/on-device` only as an authenticated compatibility
alias.

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

For Android, add `ProjectSettings/OpenMasuAndroidSettings.json` to the host
project and use only hosts registered for the application. The postprocessor
writes one verified App Link filter per
host into the generated Unity activity and records the same normalized host set
as non-identifying manifest metadata:

```json
{
  "linkHosts": ["links-a.synthetic.example", "links-b.synthetic.example"],
  "activityName": "com.unity3d.player.UnityPlayerActivity"
}
```

Pass the same list to `OpenMasuOptions.DeepLinkHosts`. Android initialization
fails closed with `deep_link_hosts_manifest_mismatch` when the runtime list and
generated manifest differ. If the settings file is absent, the package adds no
OpenMasu App Link filter; it never ships a synthetic default route. The App
Link filters contain only `http` and `https`; any operator-defined custom scheme
must use a separate intent filter. Teams with a custom Unity activity must name
that activity in the settings file and forward its incoming URL to
`OpenMasuClient.HandleDeepLink`. For iOS, put `linkHosts` in
`ProjectSettings/OpenMasuIOSSettings.json`; the postprocessor writes both
`OpenMasuLinkHosts` and `com.apple.developer.associated-domains` without a
development-mode query.

The same iOS settings file controls Apple's explicit re-engagement opt-ins. Both
flags default to `false`:

```json
{
  "skanEndpoint": "https://measurement.invalid",
  "attributionCopyEndpoint": "https://measurement.invalid",
  "collectionEnabledByDefault": false,
  "linkHosts": ["links.synthetic.invalid"],
  "linkSchemes": [],
  "reengagementPostbackCopiesEnabled": false,
  "overlappingConversionsEnabled": false
}
```

Both endpoint values are HTTPS origins, not receiver paths. Apple derives
`/.well-known/skadnetwork/report-attribution/` and
`/.well-known/appattribution/report-attribution/` from those origins. The
postprocessor rejects path, query, fragment, user-info, non-default port, and
non-HTTPS values so the generated plist cannot silently disagree with the
OpenMasu receivers.

For SKAdNetwork, Apple documents that it uses the registrable part of the
configured domain and ignores subdomains. The deployment must therefore serve
the SKAdNetwork well-known route on that registrable domain; a convenient API
subdomain in the plist is not sufficient by itself.

The example preserves both safe defaults. Enable
`reengagementPostbackCopiesEnabled` only when the deployment-private
`AttributionCopyEndpoint` is ready to receive and verify those copies. Keep
`overlappingConversionsEnabled` off unless the host application securely owns
the conversion-tag mapping and retrieval lifecycle; OpenMasu does not persist
the opaque tag in analytics or logs.

## Apple conversion updates

On iOS, `OpenMasuClient.RecordAppleConversion` reaches the bundled
SKAdNetwork and AdAttributionKit updater through the C bridge. The caller must
always choose `OpenMasuAppleConversionTarget.Install`,
`OpenMasuAppleConversionTarget.Reengagement`, or both. Omitting the target is
not supported, so a Unity integration cannot accidentally broaden an update to
every active postback.

An opaque conversion tag is accepted only with the re-engagement target:

```csharp
client.RecordAppleConversion(
    "purchase",
    OpenMasuAppleConversionTarget.Reengagement,
    conversionTag,
    updated => Debug.Log($"Apple conversion updated: {updated}"));
```

The application obtains and protects `conversionTag`; the SDK passes it to
Apple transiently and does not put it in the OpenMasu queue or logs. Without a
tag, use the overload whose third argument is the completion callback. A
platform update failure does not advance the local conversion signal set, so a
retry evaluates the same successful history. The callback is marshalled to the
Unity dispatcher and runs when the application calls `PumpCallbacks()`.

These APIs have synthetic bridge and Apple-SDK compile evidence only. The
Android UPM package has a synthetic Unity 6 export/build gate, but a physical
device conversion window, iOS Unity export, App Store build, and Apple postback
delivery remain operator checks.

Direct delivery is supported on Android and iOS. Deferred delivery is Android
only through Google Play Install Referrer. Unity 2022.3, physical-device
exports, and platform domain verification remain the operator procedures in
[`docs/validation/deeplink-device-checklist.md`](../../docs/validation/deeplink-device-checklist.md).
