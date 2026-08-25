# Verified Commerce Operator Checklist

The repository and CI use synthetic keys, provider bodies, and identifiers only. Complete this checklist in an authorized private environment. Do not commit outputs, credentials, tokens, signed payloads, order IDs, transaction IDs, or screenshots containing real values.

## Google Play

1. Register the exact Android package in OpenMasu.
2. Configure an authenticated Pub/Sub push subscription with the exact audience and a dedicated verified service-account email.
3. Mount the Android Publisher service-account JSON through `OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_FILE`.
4. Enable `OPENMASU_COMMERCE_READBACKS=on` and the applicable purchase verifier flags.
5. Exercise purchase, renewal, cancellation, grace, hold, expiry, full refund, partial refund, and redelivery in a Play test track.
6. Confirm provider state facts do not change money, while a processed Orders refund subtracts the exact amount once.
7. Confirm 429/5xx leaves bounded retry work and that recovery processes it once.
8. If an authorized recovery is necessary, keep the provider subject outside the repository and use `npm run commerce:backfill`; confirm its checkpoint advances and becomes complete without exposing the subject.

## App Store

1. Register the exact bundle ID and App Apple ID in OpenMasu.
2. Configure App Store Server Notifications V2 at `/v1/apple/app-store/notifications`.
3. Configure the current trusted Apple root SHA-256 fingerprint through `OPENMASU_APPLE_ROOT_SHA256` and mount the App Store Server API private key file.
4. Set the issuer/key IDs, enable `OPENMASU_APPLE_STORE_NOTIFICATIONS=on` and `OPENMASU_COMMERCE_READBACKS=on`, and keep the endpoint on HTTPS.
5. Exercise a sandbox transaction, renewal, refund, redelivery, wrong-environment payload, invalid signature, and a multi-page history response.
6. Confirm no signed payload or transaction identifier appears in logs, API responses, database artifacts, or exported reports.

## Operations

1. Verify the `commerce_readback_cycle` counts are visible to the deployment's log/alert pipeline without high-cardinality provider values.
2. Run installation-, app-, and tenant-scope deletion against disposable test subjects and confirm ciphertext and cursor objects become unreadable.
3. Re-run affected net-revenue metrics and confirm the refund changes the run once.
4. Record provider quotas, retry ownership, credential rotation, certificate-root rotation, retention, and incident procedures outside this public repository.
