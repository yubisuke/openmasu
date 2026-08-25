# M4 device and Apple-provider validation checklist

This checklist holds operator evidence that cannot be established by synthetic
CI. Store all results outside this public repository. Never paste an Apple
credential, SDK secret, attribution token, device identifier, postback, revenue
value, campaign value, application name, or derived production value into an
issue, pull request, log artifact, fixture, or document here.

## Code-gate baseline

Before operator testing, record the merged commit and verify that the contract,
runtime, Android, and iOS workflows are green. The iOS workflow must include:

- Swift unit tests and an iOS Simulator build of shipping products and sample;
- a compile-only probe against the pinned AppLovin MAX Swift Package;
- the built-product privacy-manifest, Required Reason API, and forbidden-symbol audits;
- the Unity C# callback and generated-plist probe; and
- a CycloneDX iOS SDK SBOM with no runtime dependency components.

CI is synthetic evidence. It is not proof of a real device, provider account,
campaign, App Store build, Unity export, or privacy-review outcome.

## M4-V-1: first-party SDK delivery

- Install a development build on a designated test device.
- With collection disabled in Info.plist, confirm that first launch performs no
  SDK network call and no AdServices token request.
- Enable collection through the application's consent flow and confirm one
  installation anchor, session, custom event, purchase/refund pair, and MAX
  callback reach the deployment-private test ledger.
- Confirm that MAX reuses one UUIDv7 as both `impression_id` and `event_id`, and
  that invalid `revenue == -1` is dropped and counted locally.
- Confirm consent withdrawal purges queued consent-required events and retains
  only the control event.

## M4-V-2: AdServices and reset

- Observe the exact live AdServices response shape and the semantics of
  `attribution=false`; these remain unverified until recorded here externally.
- Confirm the raw token is never logged or exposed as a claim and is removed by
  the privacy path.
- Exercise deletion-first installation reset. Confirm the old credential can no
  longer deliver, a new installation identifier is created, and AdServices is
  not fetched a second time.

## M4-V-3: storage, reinstall, and transfer

- After repeated queue writes and credential rewrites, inspect the SDK directory
  and verify backup exclusion and file protection remain applied.
- Verify normal app deletion and reinstall creates a fresh installation anchor.
- Verify Quick Start/device-transfer and backup restore do not restore the SDK
  anchor. This platform behavior remains unverified until tested.
- Force-quit with queued events and confirm the same queue drains on the next
  launch without duplicates. Do not claim abrupt-power-loss durability.

## M4-V-4: Apple developer-copy postbacks

- Configure `NSAdvertisingAttributionReportEndpoint` and
  `AttributionCopyEndpoint` only in the deployment-private test application.
- Confirm registered and unregistered application handling is non-enumerating.
- Confirm transaction replay is idempotent and conflicting payloads fail closed.
- Confirm deterministic installation metrics, SKAdNetwork aggregate metrics,
  and AdAttributionKit aggregate metrics remain separate in API, CSV, and dashboard.
- Record whether second and third SKAdNetwork developer-copy postbacks arrive.
  Their delivery remains unverified.

## M4-V-5: Unity export and MAX

- Export the Unity iOS sample with the supported Unity version.
- Confirm Swift sources, `PrivacyInfo.xcprivacy`, conversion schema, sqlite3
  linker setting, both Apple endpoint keys, and collection-default key reach the
  generated Xcode project.
- Build and run the exported application, then exercise all four MAX formats.
- Confirm callbacks raised off the Unity thread are delivered once on the Unity
  main thread and no callback allocation remains after completion.

## M4-V-6: privacy review

- Compare the final built application's privacy manifest and App Privacy Details
  with the enabled event, purchase, advertising, and identifier features.
- Confirm IDFA, ATT, `identifierForVendor`, pasteboard, and location APIs are absent.
- Complete App Store privacy review. Its outcome remains unverified until Apple
  returns it; a local manifest or green CI job does not predict approval.

## Evidence record

For each procedure, retain outside this repository: date, operator, app build,
device/OS or Unity/Xcode version, configuration class (never a secret), expected
outcome, observed outcome, redacted artifact location, and pass/fail disposition.
