# Google Play Initial-Subscription Verification Checklist

Checked on 2026-08-24. Source and CI use synthetic tokens and provider responses only. Completing this checklist is private operator evidence; the public repository does not establish live Google Play behavior.

## Configuration

- [ ] Register the exact Android package name and grant a dedicated service account only the Play Console read permissions required for subscription purchases and orders.
- [ ] Store service-account JSON outside the repository and image; prefer `OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_FILE`.
- [ ] Keep the Android Publisher and OAuth endpoints at their documented Google HTTPS defaults.
- [ ] Set `OPENMASU_GOOGLE_PLAY_SUBSCRIPTION_VERIFICATION=on` only after package and credential binding are ready.

## Private validation

- [ ] Submit a licensed-test initial subscription through `trackGooglePlaySubscriptionPurchase` and confirm the client record remains pending.
- [ ] Confirm SubscriptionPurchaseV2 returns exactly one matching product line, a valid start time, and its latest successful order ID.
- [ ] Confirm the processed order binds the same token and one subscription line whose service-period start equals the subscription start.
- [ ] Confirm settled money equals the order line total exactly and does not equal a deliberately different client claim.
- [ ] Confirm a renewal-period order is rejected by the initial-order path.
- [ ] Confirm pending, malformed, mismatched, unavailable, and retry-exhausted provider responses never create settled revenue.
- [ ] Confirm logs, traces, reports, exports, and public artifacts contain no token, order ID, buyer data, title, or raw provider response.
- [ ] Complete a privacy request and confirm encrypted request/provider evidence and pending work are removed.

## Explicit boundary

- [ ] Record that this verifier measures the initial processed order; it does not grant entitlement or acknowledge the purchase.
- [ ] Keep RTDN, renewals, grace/hold/pause/cancel state synchronization, refunds, revocations, and voided-purchase processing disabled until separately implemented and accepted.
