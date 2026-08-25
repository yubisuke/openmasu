# Google Play RTDN renewal operator checklist

The repository proves this path only with synthetic OIDC keys, Pub/Sub envelopes, purchase tokens, and Developer API responses. Do not enable it until every applicable operator-owned check below is complete.

- [ ] Register the Android package identity for exactly one OpenMasu app.
- [ ] Complete the initial-subscription verification checklist for the same product and confirm its token is registered.
- [ ] Create a dedicated Pub/Sub push service account with the minimum required permissions.
- [ ] Configure an HTTPS push endpoint at `/v1/google-play/rtdn`, enable push authentication, and set an explicit audience.
- [ ] Set `OPENMASU_GOOGLE_PLAY_RTDN_AUDIENCE` and `OPENMASU_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL` to exact values; do not use wildcards.
- [ ] Mount the Play Developer service-account JSON through the deployment secret manager and keep it out of environment listings, logs, images, and this repository.
- [ ] Enable `OPENMASU_GOOGLE_PLAY_SUBSCRIPTION_VERIFICATION=on` and `OPENMASU_GOOGLE_PLAY_RTDN_RENEWAL_VERIFICATION=on` only after package/API access is proven.
- [ ] Send a licensed-test renewal and confirm one authenticated notification produces one settled renewal from the matching processed order line total.
- [ ] Redeliver the same Pub/Sub message and confirm no additional revenue appears.
- [ ] Deliver a different message for the same renewal order and confirm the order digest prevents additional revenue.
- [ ] Confirm invalid audience, service-account email, signature, package, token, product, order, and service-period bindings produce no revenue.
- [ ] Confirm provider 429/5xx behavior remains deferred and cannot become settled revenue.
- [ ] Complete an app/installation deletion test and confirm encrypted notification/provider evidence and pending work become unreadable while only non-identifying replay digests remain.
- [ ] Monitor Pub/Sub dead-letter delivery and Developer API quota. This slice does not reconstruct renewal orders whose notifications were missed.
- [ ] Keep entitlement, acknowledgement, cancellation, pause/hold/grace handling, refunds, revocation, and voided-purchase processing outside OpenMasu until separately implemented and accepted.
