# Primary References

Checked on 2026-08-17.

## Apple

- [AdAttributionKit](https://developer.apple.com/documentation/AdAttributionKit)
- [Measuring ad performance with AdAttributionKit](https://developer.apple.com/app-store/ad-attribution/)
- [SKAdNetwork](https://developer.apple.com/documentation/storekit/skadnetwork)
- [App Tracking Transparency](https://developer.apple.com/documentation/apptrackingtransparency)

Apple attribution and SDK references confirmed on 2026-08-20:

- [Verifying an SKAdNetwork install-validation postback](https://developer.apple.com/documentation/StoreKit/verifying-an-install-validation-postback) defines the P-256 signature check and signed field order.
- [Identifying SKAdNetwork postback parameters](https://developer.apple.com/documentation/storekit/identifying-the-parameters-in-install-validation-postbacks) defines version 3 and 4 fields.
- [Verifying an AdAttributionKit postback](https://developer.apple.com/documentation/adattributionkit/verifying-a-postback) defines ES256 compact JWS verification, production/development `kid` values, permanent postback identifiers, success/retry behavior, and the literal `AttributionCopyEndpoint` configuration property.
- [Configuring an AdAttributionKit advertised app](https://developer.apple.com/documentation/adattributionkit/configuring-an-advertised-app) defines the advertised-app developer copy endpoint.
- [AdServices attribution token](https://developer.apple.com/documentation/AdServices/AAAttribution/attributionToken%28%29) defines raw token acquisition; the server sends that token to Apple's attribution endpoint.
- [Adding a privacy manifest to an SDK](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk) defines Swift Package placement and resource declaration.
- [Optimizing data for iCloud backup](https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup) defines the backup-exclusion resource value used by the iOS SDK storage subtree.
- [AdAttributionKit Postback](https://developer.apple.com/documentation/adattributionkit/postback) and its [conversion-value update method](https://developer.apple.com/documentation/adattributionkit/postback/updateconversionvalue%28_%3Acoarseconversionvalue%3Alockpostback%3A%29) define the exact async Swift API used by the SDK.
- [Privacy collected-data type](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype) and [collection purposes](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatypepurposes) define the exact manifest vocabulary used by the SDK.
- [AppLovin MAX iOS advanced settings](https://developers.applovin.com/en/max/ios/overview/advanced-settings/) and the [pinned 13.6.4 Swift Package manifest](https://raw.githubusercontent.com/AppLovin/AppLovin-MAX-Swift-Package/13.6.4/Package.swift) define the impression-revenue fields and exact compile-only provider dependency.

AdAttributionKit re-engagement references confirmed on 2026-08-30:

- [Postback parameters](https://developer.apple.com/documentation/adattributionkit/identifying-the-parameters-in-a-postback) defines the signed wire value `re-engagement` and the postback sequence.
- [Receiving ad attributions and postbacks](https://developer.apple.com/documentation/adattributionkit/receiving-ad-attributions-and-postbacks) defines re-engagement as click-only with no nonwinning postbacks.
- [PostbackUpdate](https://developer.apple.com/documentation/adattributionkit/postbackupdate) and [conversion types](https://developer.apple.com/documentation/adattributionkit/postbackupdate/conversiontypes) define iOS 18 conversion targeting and the all-types `nil` default.
- [Conversion tags](https://developer.apple.com/documentation/adattributionkit/conversion-tags) defines the iOS 18.4 opaque bookmark and caller-owned persistence boundary.
- [Re-engagement postback copies](https://developer.apple.com/documentation/bundleresources/information-property-list/eligibleforadattributionkitreengagementpostbackcopies) defines the separate developer-copy Info.plist opt-in.
- [WWDC25: What's new in AdAttributionKit](https://developer.apple.com/videos/play/wwdc2025/221/) defines the `EligibleForAdAttributionKitOverlappingConversions` opt-in for simultaneous conversion windows.

Universal Links references confirmed on 2026-08-21:

- [Supporting associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains) defines the extensionless AASA path, HTTPS/no-redirect requirement, `applinks:` entitlement shape, Apple CDN behavior, and the prohibition on path/query/trailing-slash components in the entitlement.
- [Debugging Universal Links](https://developer.apple.com/documentation/technotes/tn3155-debugging-universal-links) records same-domain Safari behavior and development-mode diagnostics.

App Attest references confirmed on 2026-08-20:

- [Apple DeviceCheck](https://developer.apple.com/documentation/devicecheck) defines App Attest as app-integrity evidence and cautions that no single policy eliminates fraud.
- [Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server) defines server challenge, attestation, and assertion verification. The public repository reserves evidence fields only; live key/project setup remains an operator task.

Design implications:

- Use AdAttributionKit as the primary direction for Apple privacy-preserving app attribution while accounting for SKAdNetwork interoperability.
- Never present privacy-preserving aggregate results as deterministic installation-level attribution.
- Distinguish tracking that requires ATT from AdAttributionKit measurement that does not require ATT by itself.
- Device fingerprinting is outside the project scope.
- The iOS SDK does not collect IDFA, request ATT permission, or infer an identifier from device signals.

## Google

- [Google Play Install Referrer](https://developer.android.com/google/play/installreferrer)
- [Install Referrer API fields](https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice)
- [Android Auto Backup](https://developer.android.com/identity/data/autobackup)
- [Update on plans for Privacy Sandbox technologies](https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies)
- [Privacy Sandbox enrollment](https://privacysandbox.google.com/private-advertising/enrollment)
- [Advertising ID policy](https://support.google.com/googleplay/android-developer/answer/6048248)
- [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)

Design implications:

- The Android SDK, Unity bridge, and redirector use the referrer URL and timing evidence from Install Referrer.
- Google announced the retirement of Attribution Reporting (Android) on 2025-10-17 and no longer accepts enrollment; this project does not adopt it.
- The initial MVP does not collect Advertising ID.
- SDK providers and app developers remain responsible for identifier and user-data policy compliance.

Android measurement references confirmed on 2026-08-19:

- [Install Referrer AIDL response bundle](https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice) lists the server click/install timestamps and install-version fields used by the v0.3 contract.
- [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) requires operators to account for SDK collection and location derived from IP; the default redirector does not derive location.
- [Meta Install Referrer](https://developers.facebook.com/documentation/app-ads/meta-install-referrer) exposes `install_referrer`, `is_ct`, and `actual_timestamp`. Live value semantics remain operator-verified, and synthetic crypto vectors do not establish campaign behavior.

Play Integrity references confirmed on 2026-08-20:

- [Play Integrity overview](https://developer.android.com/google/play/integrity/overview) defines app/device verdicts, request-hash or nonce binding, replay considerations, gradual enforcement, and the requirement to combine integrity evidence with other anti-abuse signals. Live Play project setup remains outside the code gate.

Fraud and platform-integrity references confirmed on 2026-08-21:

- [Install Referrer AIDL response bundle](https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice) defines `referrer_click_timestamp_server_seconds` as the server-side time when the referrer click happened and `install_begin_timestamp_server_seconds` as the server-side time when installation began. Both are seconds on Google's server clock. For a genuine referrer path, the click therefore precedes or shares the one-second bucket with install begin; a server click timestamp at least one second later is temporally inconsistent. The shipped rule remains observe-only until an operator records the timestamp-sign distribution on authorized traffic.
- [Play Integrity standard requests](https://developer.android.com/google/play/integrity/standard) bind frequent requests with `requestHash`, receive an encrypted token on the device, and require the backend to send it to Google's `decodeIntegrityToken` endpoint. [Classic requests](https://developer.android.com/google/play/integrity/classic) use a server-checked nonce and are intended for infrequent high-value operations. [Integrity verdicts](https://developer.android.com/google/play/integrity/verdicts) require package, request binding, and freshness checks before verdict use. [Setup and quotas](https://developer.android.com/google/play/integrity/setup) records a default 10,000 token-request and 10,000 server-decryption daily quota per linked Cloud project; quota exhaustion and provider errors are treated as `unavailable`, never as fraud.
- [Apple DeviceCheck](https://developer.apple.com/documentation/devicecheck), [Establishing your app's integrity](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity), [Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server), and the [Attestation Object Validation Guide](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide) define a one-time server challenge, key attestation bound to the App ID and key identifier, certificate-chain and nonce verification, persisted public-key state, and later assertion verification with a monotonic counter. Unsupported clients bypass gracefully, reinstall starts a new registration, and no App Attest result is sufficient on its own to classify fraud.

Primary Google Play one-time-product verification recorded on 2026-08-24:

- [Fight fraud and abuse](https://developer.android.com/google/play/billing/security) recommends sending the globally unique purchase token to a secure backend and verifying it with the Google Play Developer API before granting value.
- [`purchases.productsv2.getproductpurchasev2`](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2/getproductpurchasev2) identifies an in-app product purchase by package name and token and returns purchase state, completion time, order ID, and product line items.
- [`orders.get`](https://developers.google.com/android-publisher/api-ref/rest/v3/orders/get) retrieves a package-scoped order by order ID. The [Order resource](https://developers.google.com/android-publisher/api-ref/rest/v3/orders) defines `PROCESSED` state and the line-item `total` as the amount paid by the customer after discounts and tax; OpenMasu converts that `Money` value exactly and does not use listing price or post-fee developer revenue.
- [Integrate the Google Play Billing Library](https://developer.android.com/google/play/billing/integrate) requires pending transactions to remain ungranted until the state becomes `PURCHASED` and notes that order IDs are not present for every purchase.
- [Integrate Google Play with your server backend](https://developer.android.com/google/play/billing/backend) defines service-account access through the Google Play Developer API and recommends RTDN for lifecycle synchronization. Subscriptions, RTDN, acknowledgement, consumption, refunds, and revocation are outside this one-time-product slice.

Primary Google Play initial-subscription verification recorded on 2026-08-24:

- [`purchases.subscriptionsv2.get`](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get) returns the current subscription state and typed line items for a package-scoped purchase token. The [SubscriptionPurchaseV2 resource](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2) defines `startTime`, `productId`, and `latestSuccessfulOrderId`.
- The [Order resource](https://developers.google.com/android-publisher/api-ref/rest/v3/orders) defines subscription service-period start/end fields and the exact customer-paid line total. OpenMasu requires the order period start to equal SubscriptionPurchaseV2 `startTime`, so this slice cannot silently classify a later renewal as the initial order.
- [Subscription lifecycle](https://developer.android.com/google/play/billing/subscriptions) and the [backend integration guide](https://developer.android.com/google/play/billing/backend) require lifecycle synchronization for renewals and state changes. Acknowledgement, entitlement, cancellation, hold, refund, and revocation behavior remain unimplemented and unverified.

Primary Google Play RTDN renewal verification recorded on 2026-08-24:

- The [RTDN reference](https://developer.android.com/google/play/billing/rtdn-reference) defines the base64 Pub/Sub envelope and `SUBSCRIPTION_RENEWED` notification, states that a notification contains incomplete state, and requires a subsequent Google Play Developer API read. It also states that each auto-renewal has a new order ID.
- [Authenticated Pub/Sub push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions) requires validation of the Google-signed OIDC JWT and its audience and verified service-account email claims.

Primary verified-commerce lifecycle references confirmed on 2026-08-25:

- The [Google RTDN reference](https://developer.android.com/google/play/billing/rtdn-reference) defines subscription, one-time-product, voided-purchase, pending-refund-review, and test notification arms and requires a Developer API read because the notification is incomplete state.
- [`purchases.subscriptionsv2.get`](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get) and the [SubscriptionPurchaseV2 resource](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2) provide current authoritative subscription state and line-item identity.
- The [Google Orders resource](https://developers.google.com/android-publisher/api-ref/rest/v3/orders) defines order states plus exact full and processed partial refund amounts under order history. OpenMasu does not infer refund money from the RTDN arm.
- [`purchases.voidedpurchases.list`](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases/list) is the provider source for bounded historical voided-purchase reconciliation; live account behavior and quota remain operator evidence.
- The [Google subscription lifecycle guide](https://developer.android.com/google/play/billing/lifecycle/subscriptions) documents pause, hold, grace, cancellation, recovery, expiry, and renewal state transitions.
- [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi/) defines authenticated transaction/refund history reads. [Get Transaction History](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-history) and [Get Refund History](https://developer.apple.com/documentation/appstoreserverapi/get-refund-history) use ascending revision pagination.
- [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/app-store-server-notifications-v2) and [Receiving App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications/receiving-app-store-server-notifications) define the signed notification delivery boundary.
- [`signedPayload`](https://developer.apple.com/documentation/appstoreservernotifications/signedpayload) and [`JWSTransactionDecodedPayload`](https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload) define the outer and nested signed material. OpenMasu verifies ES256, certificate trust/validity, app/environment scope, and every nested transaction before retaining a safe fact.
- Apple's official [App Store Server Library for Node](https://github.com/apple/app-store-server-library-node) and [`SignedDataVerifier`](https://apple.github.io/app-store-server-library-node/classes/SignedDataVerifier.html) were reviewed as the reference verification behavior. OpenMasu uses the Node cryptography API to avoid adding a runtime dependency.
- [`purchases.subscriptionsv2.get`](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get) supplies the current product line and latest successful order ID. The [Orders resource](https://developers.google.com/android-publisher/api-ref/rest/v3/orders) supplies processed state, token binding, service period, and exact line money. Its published methods provide get and batch-get by known order ID, not arbitrary order-history listing; therefore OpenMasu does not claim missed-notification historical renewal backfill.

Android App Links references confirmed on 2026-08-21:

- [About App Links](https://developer.android.com/training/app-links/about), [Add intent filters](https://developer.android.com/training/app-links/add-applinks), and [Verify App Links](https://developer.android.com/training/app-links/verify-applinks) define verified HTTP/HTTPS intents, `autoVerify`, Android 11 all-host behavior, Android 12+ per-host verification, and the Digital Asset Links fetch path.
- [Configure website associations](https://developer.android.com/training/app-links/configure-assetlinks) defines the public `assetlinks.json` fields, uppercase signing fingerprints, Play App Signing distinction, HTTPS/content-type/no-redirect requirements, and one file per host.

## Operations

Operations references confirmed on 2026-08-20:

- [PostgreSQL 17 SQL dump](https://www.postgresql.org/docs/17/backup-dump.html) defines custom-format `pg_dump` archives and restoration with `pg_restore`.
- [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) documents restore into a new database, `--exit-on-error`, archive portability, and the security boundary of executing dump contents.
- [Prometheus exposition formats](https://prometheus.io/docs/instrumenting/exposition_formats/) defines the UTF-8 line-oriented `text/plain; version=0.0.4` format used by the authenticated `/metrics` route.

## Licensing and consent

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt)
- [GDPR Article 7](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)

Design implications:

- Keep the official Apache-2.0 text unchanged and maintain attribution separately in `NOTICE`.
- Withdrawal does not invalidate processing completed before withdrawal. For a consent-required purpose, new server processing after withdrawal recognition requires a documented legal basis; `occurred_at` alone does not authorize ingestion.

## Contract standards and reference libraries

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [Trail of Bits rfc8785 for Python](https://pypi.org/project/rfc8785/0.1.4/)

Design implications:

- Contract schemas declare Draft 2020-12 explicitly.
- Both reference evaluators must produce the same RFC 8785 UTF-8 bytes for shared conformance vectors.
- The Python dependency is version- and hash-pinned; fixture validation does not contact a live provider.

## Optional Cloudflare redirector

- [Workers](https://developers.cloudflare.com/workers/)

Design implications:

- The default deployment uses Docker Compose, Node.js, and PostgreSQL without Cloudflare services.
- A Cloudflare Worker is a future optional redirector adapter, not a shipped integration. The portable Node.js redirector is the implemented path, and no contract behavior depends on Workers.
- Cloudflare Queues, R2 object storage, and D1 are not part of the current deployment. Adopting one requires measured evidence, an explicit runtime port, and contract-equivalence tests.
- Recheck Workers product status, limits, data-location behavior, and pricing immediately before implementing the optional adapter.

## Media integration

- [Google Ads App Conversion Tracking API](https://developers.google.com/app-conversion-tracking/api)
- [AppLovin MAX S2S Impression Revenue API](https://support.applovin.com/en/max/advanced-features/s2s-impression-level-api/)

These references demonstrate possible integration paths, not completed approval or production support.

Before implementing the Google Ads third-party provider flow, verify whether a provider ID/Link ID and partner approval are required and whether self-service configuration is sufficient. Before extending Apple privacy-preserving measurement, verify that developer postback copies available without ad-network registration are adequate for the intended tests. Record the primary-source result in the active adapter design and update [project status](STATUS.md) before claiming support.

## Change warning

Google announced the retirement of Attribution Reporting (Android) on 2025-10-17 and no longer accepts enrollment; this project does not adopt it. Recheck the cited retirement and enrollment pages before changing this decision.
