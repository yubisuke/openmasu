# OpenMasu Unity SDK

The package in `com.openmasu.sdk` targets Unity 2022.3 LTS (best effort) and Unity 6 LTS. Android `minSdk` is 24.

M2 ships source and local build instructions only. It does not publish a Maven or UPM artifact. Build the Android modules in `sdk/android`, publish the resulting dependency to an operator-controlled local Maven repository, and replace the placeholder `dev.openmasu:core:0.1.0` coordinate in `Runtime/OpenMasu.androidlib/build.gradle`.

The `.androidlib` resolution path from a UPM package is not established by Unity's primary documentation. The operator checklist records an actual export on both supported Unity lines. If the package directory is not resolved, use the locally built AAR as the documented fallback; do not download or commit a third-party binary.

MAX integration must subscribe separately to Interstitial, Rewarded, Banner, and MRec revenue callbacks. The compile probe keeps the four-format subscription table closed even when AppLovin is not present in the test environment.

Import the `Android measurement sample` from Package Manager to obtain a small `MonoBehaviour` that initialises the bridge and exposes a synthetic custom-event button. Supply deployment credentials outside source control; the sample intentionally contains no endpoint, key, secret, campaign, or device identifier.
