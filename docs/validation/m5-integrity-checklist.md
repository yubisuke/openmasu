# M5 Play Integrity and App Attest Operator Checklist

Contract v0.3.5 reserves optional `integrity_verdict` evidence only. Open MMP
does not ship a live Play Integrity or App Attest integration and never treats
one verdict as deterministic attribution or as a complete fraud decision.

## Shared requirements

- Use an operator-owned test project and synthetic account. Never commit app
  identifiers, key identifiers, assertions, tokens, challenges, verdicts, or
  screenshots.
- Bind the provider request to the exact sensitive application request and
  enforce a one-time server challenge or request hash. Reject replay.
- Verify provider, app, environment, freshness, and challenge on the server.
- Store raw tokens/attestations only as protected deployment evidence. The
  public event may contain only the normalized verdict and opaque
  `evidence_ref`.
- Start in observation mode, measure false positives and service outages, and
  combine integrity evidence with other documented signals. Never make it the
  sole anti-abuse control.
- Record policy version, rollout cohort, failure handling, expiration, key
  rotation, and rollback outside this repository.

## Google Play Integrity

1. Enable an approved Play/Cloud project and select Standard or Classic
   requests intentionally.
2. For Standard requests, bind all relevant request values in `requestHash`.
   For Classic requests, generate and consume a one-time server nonce.
3. Verify request details and recognized app identity before interpreting
   device or account verdicts.
4. Handle unavailable, throttled, and service-error outcomes without silently
   labeling them verified or failed.
5. Confirm the normalized event uses provider `play_integrity`; raw responses
   and enforcement thresholds remain private.

Primary reference checked on 2026-08-20:
https://developer.android.com/google/play/integrity/overview

## Apple App Attest

1. Enable App Attest for an operator-owned App ID and confirm the intended
   development/production environment.
2. Generate the device key, issue a unique server challenge, validate the
   attestation object on the server, and retain the verified public key in a
   protected store.
3. Verify assertion objects for sensitive requests and consume each challenge
   once. Handle reinstall/device-transfer key loss as a new registration.
4. Confirm the normalized event uses provider `app_attest`; key identifiers,
   assertions, attestation objects, and challenges remain private.
5. Roll out gradually and retain an outage/fallback plan.

Primary references checked on 2026-08-20:

- https://developer.apple.com/documentation/devicecheck
- https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server

## Evidence record

Record date, application version, platform version, test environment, policy
version, request count, normalized outcome counts, false-positive review, and
rollback result. Keep the record outside the public repository. Until this
checklist is completed, integrity support remains **unverified**.
