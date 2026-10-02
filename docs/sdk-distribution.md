# SDK Downloads and Installation

The configured candidate is `v0.3.0-rc.1`. A candidate is downloadable release
evidence only after its matching annotated tag and GitHub prerelease identify
one green full-gate source revision. A prepared file or CI artifact alone is not
publication. Until that gate is met, use source locally and do not invent a
download receipt. Historical `v0.2.0` tags and records are not modified.

## Obtain and verify the exact assets

Use a new empty local directory. These commands download public artifacts; they
do not contact a measurement endpoint or need a provider account:

```bash
gh release download v0.3.0-rc.1 --repo yubisuke/openmasu --dir build/sdk-download
cd build/sdk-download
sha256sum --check SHA256SUMS
unzip openmasu-sdk-0.3.0-rc.1.zip
cat release-manifest.json
```

On macOS use `shasum -a 256 --check SHA256SUMS`. On PowerShell use
`Get-FileHash -Algorithm SHA256` for each listed basename and compare its hex
digest; `Expand-Archive` extracts the SDK ZIP. Do not proceed on any missing,
extra, mismatched or unverified file. Checksums detect byte corruption; they are
not a distribution signature or independent publisher authentication.

The eight assets are:

| Asset | Purpose |
| --- | --- |
| `openmasu-sdk-0.3.0-rc.1.zip` | Entire verified bundle, five compiled Android AAR/POM pairs, legal files, internal checksums and original manifest |
| `com.openmasu.sdk-0.3.0-rc.1.tgz` | Standalone Unity UPM package with packaged Android dependencies and vendored Swift source |
| `OpenMasuIOS-0.3.0-rc.1-source.zip` | Swift Package source, not a binary XCFramework |
| `release-manifest.json` | Original SDK version, source revision and complete inner artifact inventory |
| `sdk-android.cdx.json`, `sdk-ios.cdx.json`, `sdk-unity.cdx.json` | Version-bound CycloneDX component inventories |
| `SHA256SUMS` | Checksums of the seven other downloadable assets |

The manifest `version` must be `0.3.0-rc.1`; `source_revision` must equal
`git rev-parse 'v0.3.0-rc.1^{commit}'` in a source checkout with that annotated
tag. The manifest inside the whole SDK ZIP must be byte-identical to the separate
asset. Its internal `SHA256SUMS` verifies every contained file. Release notes
link the full Contract, Runtime, Android JVM/emulator and iOS runs at that SHA.
PR no-op checks and an unrelated successful run are not release evidence.

## Android: consume the compiled Maven layout

Use an existing Android host project with minimum API 24 and the pinned SDK
toolchain described in [Android setup](../sdk/android/README.md). Point a local
Maven repository at the extracted `openmasu-sdk-0.3.0-rc.1/maven` directory:

```kotlin
repositories {
    google()
    mavenCentral()
    maven { url = uri("/absolute/local/path/openmasu-sdk-0.3.0-rc.1/maven") }
}
dependencies {
    implementation("dev.openmasu:core:0.3.0-rc.1")
    implementation("dev.openmasu:installreferrer:0.3.0-rc.1") // optional module
}
```

Use the same SDK version for all OpenMasu modules. Third-party dependencies
retain their independent pins; enabling a mediation module still requires its
provider SDK in the host. Compile with `./gradlew :app:assembleDebug` before
configuring a private measurement endpoint. Downloading an AAR does not prove
device delivery, store signing or live provider permissions.

## Unity: add the generated package, not a repository reference

In Package Manager choose **Add package from tarball** and select the verified
`com.openmasu.sdk-0.3.0-rc.1.tgz`. The tarball includes the local Android Maven
modules, so it does not require a separately published Maven registry. Follow
[Unity host setup](../sdk/unity/README.md) for platform settings, link-host
validation, the optional sample and callback pumping. Keep real endpoints and
keys outside source control.

The existing `npm run test:unity-upm` gate resolves this generated package in a
standalone Gradle consumer, not by referencing the repository project. A
synthetic Unity 6 Android export probe also exists. Neither gate establishes
physical-device operation, Unity 2022.3 or Unity iOS export acceptance.

## iOS: consume Swift source

Extract `OpenMasuIOS-0.3.0-rc.1-source.zip` and add its
`OpenMasuIOS-0.3.0-rc.1/sdk/ios` directory as a local Swift Package in Xcode.
Select only the products required by the host; follow
[iOS host setup](../sdk/ios/README.md) for the privacy manifest and provider
integration. `swift test --package-path <extracted-package-directory>` tests
the source package on a supported macOS toolchain. The exact-SHA macOS CI also
builds the shipping products and sample on the iOS Simulator.

This is source distribution: no signed binary, Swift registry publication,
physical device, App Store acceptance or live attribution signal is provided.

## Producing a release

Maintain one source/SDK version and reuse the existing
[release runbook](operations/release.md). Create assets from the full-gate
same-commit CI bundle, not from stale local build outputs. No new registry,
service, distribution signing key or SDK API is introduced. Contract wire and
package identity remains `0.4.0` through the additive v0.4.10 ledger.
