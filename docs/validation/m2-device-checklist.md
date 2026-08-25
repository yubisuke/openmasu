# M2 Device and Provider Validation Checklist

This checklist is an operator procedure, not a code gate. Record only a dated pass/fail summary and an opaque private-evidence reference in a deployment-private system. Never commit a provider export, credential, decryption key, device identifier, campaign value, referrer payload, screenshot containing identifiers, or live validation result to this public repository.

## Before testing

- Build the exact reviewed commit and record its SHA privately.
- Use a non-production test app and synthetic or isolated test traffic where the provider permits it.
- Store endpoints, SDK keys, installation credentials, Meta keys, campaign IDs, and device details outside the repository.
- Confirm the operator understands that M2 does not prevent a party holding the APK from fabricating installations; Play Integrity is deferred to M5.

## V-1 — Google Play internal testing

1. Publish the sample through a private internal-testing track.
2. Open one operator-created measurement link and install from Google Play.
3. Confirm first launch produces exactly one non-conflicting install with `valid_install_referrer`.
4. Confirm the observed Play URL parameter name and one-time referrer behavior privately.

Private record: date, app build, device/OS class, pass/fail, opaque ledger references, and any divergence. Do not record the referrer string here.

## V-2 — Meta live campaign and ambiguous fields

1. Run one isolated Meta app-install campaign using the provider's documented test/preview procedure where available.
2. Confirm the protected blob decrypts server-side and yields a campaign ID that reconciles privately with Ads Manager.
3. Observe click-through and view-through examples to determine the `is_ct` 0/1 mapping.
4. Determine the unit and interpretation of `actual_timestamp` from plausible observed magnitudes.
5. Exercise an operator-managed key change and record the observed behavior, without assuming Meta documents rotation.

`is_ct`, `actual_timestamp`, and Meta key-rotation semantics remain **unverified** until this procedure has evidence. Never put the key, payload, campaign ID, or Ads Manager screenshot in the repository.

## V-3 — Auto Backup and device transfer

1. Install and initialise on device A, then complete an Android cloud backup.
2. Restore onto device B and confirm the prior `installation_id`, credential, queue, and referrer-consumed flag are not restored.
3. Repeat with OEM device-to-device transfer.
4. Record OEM and OS versions privately because documented behavior can vary by manufacturer.

## V-4 — MAX live account

1. Confirm all enabled formats emit the client ILRD callback without account-team enablement.
2. Confirm `-1`, non-finite, or invalid-precision observations do not create revenue events.
3. Compare the client callback series with the corresponding S2S/reporting UTC-day total and record precision distribution privately.

Availability to every publisher and equality with reporting/S2S values remain unverified until this procedure is complete.

## V-5 — Play referrer length

Record the longest intact referrer observed privately. M2 carries only `omv=1&cid=<opaque click id>`, so no code or contract gate depends on a provider maximum.

## V-6 — Meta coverage

Over a private observation window, classify installs into provider unavailable, app version unsupported, no campaign data, decryption/authentication failure, and decrypted. Store only aggregate results in the private operator record.

## V-7 — Unity export

1. Import the UPM package and its Android measurement sample into Unity 2022.3 LTS and Unity 6 LTS.
2. Export an Android Gradle project from each.
3. Confirm the `.androidlib` under the UPM package is resolved and that the operator-controlled local Maven coordinates are present.
4. Build and run the sample, then confirm callbacks are marshalled to the Unity main thread.
5. If `.androidlib` resolution fails, use a locally built OpenMasu AAR and record the exact fallback privately.

UPM-package `.androidlib` resolution remains **unverified** until both exports are recorded.

## Completion record

The public repository should contain no results. The private operator record should contain only the minimum evidence needed to reproduce the conclusion: reviewed commit SHA, date, environment class, pass/fail per V-1 through V-7, opaque ledger/audit references, and redacted divergence notes.
