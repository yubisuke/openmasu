# OpenMasu Android SDK

The Android SDK is a source-distributed Kotlin/Gradle project for first-party
events, Google Play Install Referrer, optional Meta Install Referrer, AppLovin
MAX impression-level revenue, signed delivery, and consent/reset lifecycle. The
minimum Android API level is 24.

## Modules

- `core`: installation identity, bounded SQLite queue, HMAC transport, consent,
  reset, direct deep links, and first-party events;
- `installreferrer`: Google Play Install Referrer reader and typed authority;
- `metareferrer`: optional typed Meta Install Referrer adapter;
- `max`: provider-neutral MAX revenue mapping;
- `unitybridge`: Java surface used by the Unity UPM package;
- `sample`: synthetic native integration sample.

No module contains a deployment credential, campaign value, advertising ID, or
real provider response.

## Local gates

Use the pinned JDK and Android SDK versions from
`.github/workflows/sdk-android.yml`:

```bash
./sdk/android/gradlew -p sdk/android androidAcceptance verifySdkSbom --no-daemon
dotnet run --project sdk/unity/tests/UnityCompileProbe.csproj --configuration Release
```

The authoritative emulator gate runs the sample on API 36 in GitHub Actions.
Building locally without that emulator result is not device-delivery evidence.

## Queue and lifecycle

The queue is bounded by record count and logical UTF-8 bytes. Exact replay of
the same event ID, name, purpose, and payload is idempotent. Reusing an event ID
with changed content is a conflict and must not silently replace or discard the
new meaning. Collection disablement blocks new measurement. Withdrawal purges
consent-required queued records. Installation reset sends the credential-bound
deletion request before generating an unrelated replacement identity.

SDK storage is excluded from backup and transfer where Android supports both
the modern data-extraction rules and legacy backup attributes. SQLite
`secure_delete` is a limited local measure, not a guarantee that every device
storage copy is erased.

## Install Referrer and deep links

Install Referrer preserves Google Play response state and both client and
server timestamps available from the pinned library. Server timestamps are the
authoritative attribution-window evidence; device occurrence time is retained
but does not replace them.

Direct App Links are parsed and returned to the host application. The SDK never
navigates automatically. Android deferred destinations use an OpenMasu click
reference carried through Install Referrer, expire under server policy, and are
consumed once per installation lifecycle.

## Local release artifacts

The release build produces five AARs and a CycloneDX SBOM. The repository
packager assembles them with the Unity and Swift source artifacts into the local
release bundle described by [the release runbook](../../docs/operations/release.md).
OpenMasu does not publish a Maven registry artifact or signing identity.

## Validation boundary

The repository gates are synthetic. Physical devices, Play tracks, background
delivery under real power policies, live Meta/MAX signals, and actual host-app
integration remain private operator evidence in
[the Android checklist](../../docs/validation/m2-device-checklist.md).
