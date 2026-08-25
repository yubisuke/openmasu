# Google Play One-Time-Product Verification Checklist

Checked on 2026-08-24. Source and CI use synthetic tokens and provider responses only. Completing this checklist is operator evidence; it is not established by the public repository.

## Configuration

- [ ] Use a dedicated Google Cloud service account with only the Play Console permissions required to read one-time-product purchases and their orders for the registered app.
- [ ] Register the exact Android package name for the OpenMasu app before accepting product events.
- [ ] Store the service-account JSON outside the repository and container image. Prefer `OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_FILE` over the inline environment variable.
- [ ] Keep `OPENMASU_GOOGLE_PLAY_ANDROID_PUBLISHER_BASE_URL` and `OPENMASU_GOOGLE_PLAY_OAUTH_TOKEN_URL` at their documented Google HTTPS defaults.
- [ ] Set `OPENMASU_GOOGLE_PLAY_PRODUCT_VERIFICATION=on` only after the credential and package binding are ready.

## Authorized test

- [ ] Use a Play internal-testing track and a non-production test product under an authorized operator account.
- [ ] Confirm that an actual pending purchase remains pending and emits no `adapter:google-play` settled record.
- [ ] Confirm that a completed purchase emits exactly one settled adapter record whose amount and currency equal the matching processed order line total, and that replaying the same token does not create another record.
- [ ] Confirm that a token, order, product, state, or money mismatch emits no settled adapter record.
- [ ] Confirm that a cancelled, mismatched, malformed, unavailable, or cross-app token creates no settled adapter record.
- [ ] Confirm that the worker can recover from a temporary 429 or 5xx response without promoting the purchase.
- [ ] Confirm that deleting the installation makes the encrypted request and provider response unreadable while retaining only non-identifying audit evidence and the replay-prevention digest.

## Evidence boundary

- [ ] Record package, service-account scope, test timestamp, provider state, queue latency, retry behavior, and cleanup result in a deployment-private evidence system.
- [ ] Verify independently that application logs, reverse-proxy logs, traces, reports, and exported artifacts contain no purchase-token plaintext, order ID, buyer address, product title, or raw Google response.
- [ ] Record that ProductPurchaseV2 establishes purchase state and the order binding, while the matching processed order line total establishes gross customer-paid amount and currency. It does not establish post-fee proceeds or refund synchronization.
- [ ] Keep subscription verification disabled unless the separate initial-subscription checklist is complete. RTDN, renewals, voided purchases, acknowledgement, consumption, entitlements, refunds, and revocation remain outside both slices.
